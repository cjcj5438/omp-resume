/** SuperagentServiceView：开关/重启门禁、Finder 按钮只在文件行、日志刷新。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SuperagentStatus } from "../../types";
import { SuperagentServiceView } from "./SuperagentServiceView";

const statusMock = vi.fn<() => Promise<SuperagentStatus>>();
const setEnabledMock = vi.fn<(enabled: boolean) => Promise<SuperagentStatus>>();
const restartMock = vi.fn<() => Promise<SuperagentStatus>>();
const logMock = vi.fn<(lines: number) => Promise<string[]>>();
const revealMock = vi.fn<(path: string) => Promise<void>>();

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    superagentStatus: () => statusMock(),
    superagentSetEnabled: (enabled: boolean) => setEnabledMock(enabled),
    superagentRestart: () => restartMock(),
    superagentLogTail: (lines: number) => logMock(lines),
    revealFile: (path: string) => revealMock(path),
  };
});

function statusOf(enabled: boolean, restarts = 0): SuperagentStatus {
  return {
    state: enabled ? "running" : "disabled", enabled, pid: enabled ? 42 : null,
    startedAt: enabled ? "2026-11-02T09:00:00.000Z" : null, restarts, lastError: null,
    stateDir: "/mock/superagent", socketPath: "/mock/superagent/daemon.sock",
    logPath: "/mock/superagent/logs/daemon.log", assetsDir: "/mock/assets", ompBin: "/mock/omp",
  };
}

beforeEach(() => {
  statusMock.mockReset();
  setEnabledMock.mockReset();
  restartMock.mockReset();
  logMock.mockReset();
  revealMock.mockReset();
  logMock.mockResolvedValue(["line1", "line2"]);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("SuperagentServiceView", () => {
  it("开关调用 superagentSetEnabled 并 toast 成功", async () => {
    statusMock.mockResolvedValue(statusOf(false));
    setEnabledMock.mockResolvedValue(statusOf(true));
    const onToast = vi.fn();
    render(<SuperagentServiceView onToast={onToast} />);
    const sw = await screen.findByRole("switch", { name: "启用 Superagent" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(setEnabledMock).toHaveBeenCalledWith(true);
    expect(await screen.findByText("运行中")).toBeInTheDocument();
    expect(onToast).toHaveBeenCalledWith("启用成功", "info");
  });

  it("未启用时重启按钮禁用；启用后可用且调用 restart", async () => {
    statusMock.mockResolvedValue(statusOf(false));
    restartMock.mockResolvedValue(statusOf(true, 1));
    render(<SuperagentServiceView onToast={() => {}} />);
    const restart = await screen.findByRole("button", { name: "重启" });
    expect(restart).toBeDisabled();
    // 启用后按钮放行。
    statusMock.mockResolvedValue(statusOf(true));
    setEnabledMock.mockResolvedValue(statusOf(true));
    fireEvent.click(await screen.findByRole("switch", { name: "启用 Superagent" }));
    const enabled = await screen.findByRole("button", { name: "重启" });
    expect(enabled).toBeEnabled();
    fireEvent.click(enabled);
    expect(restartMock).toHaveBeenCalledTimes(1);
  });

  it("只有文件行带 Finder 按钮；点击透传完整路径", async () => {
    statusMock.mockResolvedValue(statusOf(true));
    revealMock.mockResolvedValue(undefined);
    render(<SuperagentServiceView onToast={() => {}} />);
    const buttons = await screen.findAllByRole("button", { name: "在 Finder 中显示" });
    // socket / 日志 / omp 三个文件行；状态目录与资源目录是目录行，无按钮。
    expect(buttons.length).toBe(3);
    const logRow = buttons[1].closest(".detail-row");
    expect(logRow?.textContent).toContain("日志文件");
    fireEvent.click(buttons[1]);
    expect(revealMock).toHaveBeenCalledWith("/mock/superagent/logs/daemon.log");
    // 目录行确实没有按钮。
    const rows = document.querySelectorAll(".detail-row");
    const dirRow = [...rows].find((r) => r.textContent?.includes("状态目录"));
    expect(dirRow?.querySelector("button")).toBeNull();
  });

  it("日志面板显示 tail 结果；刷新重新拉取", async () => {
    statusMock.mockResolvedValue(statusOf(true));
    render(<SuperagentServiceView onToast={() => {}} />);
    const pre = await screen.findByText((_, el) => el?.tagName === "PRE" && el.textContent === "line1\nline2");
    expect(pre).toHaveClass("sa-log");
    expect(logMock).toHaveBeenCalledWith(200);
    logMock.mockResolvedValue(["line3"]);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("line3")).toBeInTheDocument();
    expect(logMock).toHaveBeenCalledTimes(2);
  });

  it("操作失败 toast 错误", async () => {
    statusMock.mockResolvedValue(statusOf(false));
    setEnabledMock.mockRejectedValue({ code: "IO", message: "写设置失败" });
    const onToast = vi.fn();
    render(<SuperagentServiceView onToast={onToast} />);
    fireEvent.click(await screen.findByRole("switch", { name: "启用 Superagent" }));
    await screen.findByRole("switch", { name: "启用 Superagent" });
    expect(onToast).toHaveBeenCalledWith("启用失败：写设置失败", "error");
  });
});
