/** SuperagentServiceView：开关/重启门禁、Finder 按钮只在日志与 omp 行、日志刷新。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SuperagentStatus } from "../../types";
import { SuperagentServiceView } from "./SuperagentServiceView";

const statusMock = vi.fn<() => Promise<SuperagentStatus>>();
const setEnabledMock = vi.fn<(enabled: boolean) => Promise<SuperagentStatus>>();
const restartMock = vi.fn<() => Promise<SuperagentStatus>>();
const resetMock = vi.fn<() => Promise<SuperagentStatus>>();
const logMock = vi.fn<(lines: number) => Promise<string[]>>();
const revealMock = vi.fn<(path: string) => Promise<void>>();

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    superagentStatus: () => statusMock(),
    superagentSetEnabled: (enabled: boolean) => setEnabledMock(enabled),
    superagentRestart: () => restartMock(),
    superagentResetState: () => resetMock(),
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
  resetMock.mockReset();
  logMock.mockReset();
  revealMock.mockReset();
  logMock.mockResolvedValue(["line1", "line2"]);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

function rowOf(label: string): HTMLElement {
  const dt = [...document.querySelectorAll("dt")].find((el) => el.textContent === label);
  const row = dt?.closest(".detail-row");
  if (!(row instanceof HTMLElement)) throw new Error(`找不到「${label}」路径行`);
  return row;
}

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

  it("socket 行只显示路径无按钮；日志与 omp 行带 Finder 按钮并透传完整路径", async () => {
    statusMock.mockResolvedValue(statusOf(true));
    revealMock.mockResolvedValue(undefined);
    render(<SuperagentServiceView onToast={() => {}} />);
    await screen.findByRole("switch", { name: "启用 Superagent" });

    const socketRow = rowOf("socket");
    expect(socketRow.textContent).toContain("/mock/superagent/daemon.sock");
    expect(socketRow.querySelector("button")).toBeNull();

    const logRow = rowOf("日志文件");
    const logButton = logRow.querySelector("button");
    expect(logButton).not.toBeNull();
    fireEvent.click(logButton as HTMLButtonElement);
    expect(revealMock).toHaveBeenCalledWith("/mock/superagent/logs/daemon.log");

    const ompRow = rowOf("omp 可执行文件");
    const ompButton = ompRow.querySelector("button");
    expect(ompButton).not.toBeNull();
    fireEvent.click(ompButton as HTMLButtonElement);
    expect(revealMock).toHaveBeenCalledWith("/mock/omp");

    expect(rowOf("状态目录").querySelector("button")).toBeNull();
    expect(rowOf("资源目录").querySelector("button")).toBeNull();
  });

  it("ompBin 为 null 时 omp 行无 Finder 按钮", async () => {
    statusMock.mockResolvedValue({ ...statusOf(true), ompBin: null });
    render(<SuperagentServiceView onToast={() => {}} />);
    await screen.findByRole("switch", { name: "启用 Superagent" });
    const ompRow = rowOf("omp 可执行文件");
    expect(ompRow.textContent).toContain("—");
    expect(ompRow.querySelector("button")).toBeNull();
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

  it("incompatible 显示版本不匹配横幅与真实版本号", async () => {
    statusMock.mockResolvedValue({
      ...statusOf(true),
      state: "incompatible",
      pid: null,
      startedAt: null,
      lastError: "状态库 schema 13，本版本守护进程支持 10–11",
      schema: { state: 13, oldest: 10, newest: 11 },
    });
    render(<SuperagentServiceView onToast={() => {}} />);
    expect(await screen.findByText("版本不匹配")).toBeInTheDocument();
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("状态库 schema 13，本版本守护进程支持 10–11");
    expect(banner.textContent).toContain("旧目录会改名保留");
    expect(screen.getByRole("button", { name: "改用新状态目录" })).toBeInTheDocument();
  });

  it("schema 为 null 时不显示横幅", async () => {
    statusMock.mockResolvedValue({ ...statusOf(true), schema: null });
    render(<SuperagentServiceView onToast={() => {}} />);
    await screen.findByText("运行中");
    expect(screen.queryByRole("button", { name: "改用新状态目录" })).toBeNull();
  });

  it("确认后调用 superagentResetState，成功后回到运行中", async () => {
    statusMock.mockResolvedValue({
      ...statusOf(true),
      state: "incompatible",
      pid: null,
      startedAt: null,
      schema: { state: 13, oldest: 10, newest: 11 },
    });
    resetMock.mockResolvedValue({ ...statusOf(true), lastError: null, archivedTo: "/mock/superagent.schema-13-20261109-120000" });
    const onToast = vi.fn();
    render(<SuperagentServiceView onToast={onToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "改用新状态目录" }));
    const dialog = await screen.findByRole("dialog", { name: "改用新状态目录？" });
    expect(dialog.textContent).toContain("旧状态目录会改名保留");
    expect(resetMock).not.toHaveBeenCalled();
    const confirm = dialog.querySelectorAll("button");
    fireEvent.click(confirm[confirm.length - 1]);
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("运行中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "改用新状态目录" })).toBeNull();
    expect(onToast).toHaveBeenCalledWith(
      "已改用新状态目录，旧目录保留在 /mock/superagent.schema-13-20261109-120000",
      "info",
    );
  });
});
