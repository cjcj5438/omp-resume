/**
 * 自动更新测试（mock updater/process IPC）：
 * 有更新→弹窗展示版本→下载安装→提供重启；无更新→无弹窗；检查失败→静默。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import App from "./App";
import { installMockBackend } from "./dev/mockBackend";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const mockCheck = vi.mocked(check);
const mockRelaunch = vi.mocked(relaunch);

function fakeUpdate(): Update {
  return {
    version: "0.2.0",
    currentVersion: "0.1.0",
    date: "2026-10-01T00:00:00Z",
    body: "修复了一些问题",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Update;
}

beforeEach(() => {
  clearMocks();
  vi.clearAllMocks();
  // 生产行为：允许启动检查联网（默认 DEV 下会跳过）。
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("自动更新", () => {
  it("有更新→弹窗展示版本→下载并安装→可重启", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);
    await installMockBackend();
    render(<App />);

    // 弹窗出现并展示新版本号。
    await screen.findByText("发现新版本 0.2.0");

    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);

    // 安装成功后提供重启。
    await screen.findByRole("button", { name: "立即重启" });
    fireEvent.click(screen.getByRole("button", { name: "立即重启" }));
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("无更新→不弹窗，列表正常", async () => {
    mockCheck.mockResolvedValue(null);
    await installMockBackend();
    render(<App />);

    await screen.findByRole("searchbox", { name: "过滤会话" });
    expect(screen.queryByText(/发现新版本/)).toBeNull();
  });

  it("检查失败→静默，列表照常渲染", async () => {
    mockCheck.mockRejectedValue(new Error("offline"));
    await installMockBackend();
    render(<App />);

    await screen.findByRole("searchbox", { name: "过滤会话" });
    expect(screen.queryByText(/发现新版本/)).toBeNull();
    // 无错误 toast，无异常冒泡。
    expect(screen.queryByText(/offline/)).toBeNull();
  });
});
