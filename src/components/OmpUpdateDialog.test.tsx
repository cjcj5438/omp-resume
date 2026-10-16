import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Channel } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { OmpUpdateCheck, OmpUpdateResult } from "../types";
import { OmpUpdateDialog } from "./OmpUpdateDialog";

const check: OmpUpdateCheck = {
  current: "18.11.1",
  latest: "18.12.0",
  upToDate: false,
  raw: "Current version: 18.11.1\nNew version available: 18.12.0\n",
};

beforeEach(() => clearMocks());

describe("omp 更新对话框", () => {
  it("新版可用→实时日志与关闭门禁→版本变化", async () => {
    const pending = Promise.withResolvers<OmpUpdateResult>();
    let channel: Channel<unknown> | undefined;
    mockIPC((cmd, args) => {
      expect(cmd).toBe("omp_update_run");
      if (!args || typeof args !== "object" || !("onLine" in args) || !(args.onLine instanceof Channel)) {
        throw new Error("未传入 onLine Channel");
      }
      channel = args.onLine;
      return pending.promise;
    });
    const onClose = vi.fn();
    const onUpdated = vi.fn();
    render(<OmpUpdateDialog check={check} onClose={onClose} onUpdated={onUpdated} />);
    expect(screen.getByText("当前 omp 18.11.1")).toBeInTheDocument();
    expect(screen.getByText("可更新到 18.12.0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新 omp" }));
    expect(screen.getByRole("button", { name: "更新中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const overlay = screen.getByRole("dialog").parentElement;
    if (!overlay) throw new Error("未找到 modal overlay");
    fireEvent.mouseDown(overlay);
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      channel?.onmessage("Downloading ...");
      channel?.onmessage("Installing update...");
    });
    expect(screen.getByLabelText("omp 更新日志").textContent).toBe("Downloading ...\nInstalling update...");
    await act(async () => {
      pending.resolve({ before: "18.11.1", after: "18.12.0", changed: true, output: "Updated\n" });
      await pending.promise;
    });
    expect(await screen.findByText("已更新到 18.12.0。已打开的 omp 会话需重启后才使用新版本。")).toBeInTheDocument();
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith("18.12.0");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("退出成功但版本未变化时不宣称成功", async () => {
    const output = "/opt/homebrew/bin/omp is installed and kept up to date by Homebrew; update it from Homebrew.\n";
    mockIPC(() => ({ before: "18.11.1", after: "18.11.1", changed: false, output }));
    const onUpdated = vi.fn();
    render(<OmpUpdateDialog check={check} onClose={vi.fn()} onUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: "更新 omp" }));
    expect(await screen.findByText("版本未变化")).toBeInTheDocument();
    expect(screen.getByText(/is installed and kept up to date/).textContent).toBe(output);
    expect(screen.queryByText(/已更新到/)).toBeNull();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it.each([
    ["BUSY", "另一个 omp 操作正在进行"],
    ["TIMEOUT", "omp 操作超时：Downloading ..."],
    ["OMP_FAILED", "更新 omp 失败（退出码 1）：Update failed: network"],
  ])("显示 %s 错误且允许关闭", async (code, message) => {
    mockIPC(() => { throw { code, message }; });
    const onUpdated = vi.fn();
    render(<OmpUpdateDialog check={check} onClose={vi.fn()} onUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: "更新 omp" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "关闭" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "更新 omp" })).toBeNull();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("未识别输出原样展示且无更新按钮", () => {
    const raw = "managed by brew\n  请保留缩进\n";
    render(<OmpUpdateDialog check={{ current: null, latest: null, upToDate: false, raw }} onClose={vi.fn()} onUpdated={vi.fn()} />);
    expect(screen.getByText("未识别的输出，可能由包管理器托管；请在其管理器中更新")).toBeInTheDocument();
    expect(screen.getByText(/managed by brew/).textContent).toBe(raw);
    expect(screen.queryByRole("button", { name: "更新 omp" })).toBeNull();
  });

  it("已是最新版本时不提供更新按钮", () => {
    render(<OmpUpdateDialog check={{ ...check, latest: null, upToDate: true }} onClose={vi.fn()} onUpdated={vi.fn()} />);
    expect(screen.getByText("已是最新版本")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更新 omp" })).toBeNull();
  });

  it("双击更新只调用一次 omp_update_run", async () => {
    let calls = 0;
    const pending = Promise.withResolvers<OmpUpdateResult>();
    mockIPC(() => {
      calls += 1;
      return pending.promise;
    });
    render(<OmpUpdateDialog check={check} onClose={vi.fn()} onUpdated={vi.fn()} />);
    const button = screen.getByRole("button", { name: "更新 omp" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(calls).toBe(1);
    await act(async () => {
      pending.resolve({ before: "18.11.1", after: "18.12.0", changed: true, output: "Updated\n" });
      await pending.promise;
    });
    expect(await screen.findByText(/已更新到 18.12.0/)).toBeInTheDocument();
    expect(calls).toBe(1);
  });
});
