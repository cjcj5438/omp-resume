/** SuperagentView：running 挂面板；非 running 按状态空态 + 错误 + 跳服务页；读失败可重试。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SuperagentStatus } from "../../types";
import { SuperagentView } from "./SuperagentView";

const statusMock = vi.fn<() => Promise<SuperagentStatus>>();

// 单元级：不断言面板内部，只看挂载点是否拿到 transport/openSession。
const panelSeen: { hasTransport: boolean; hasOpenSession: boolean; lang: unknown }[] = [];
vi.mock("omp-superagent/panel", () => ({
  SuperagentPanel: (props: { transport: unknown; openSession: unknown; lang: unknown }) => {
    panelSeen.push({
      hasTransport: props.transport !== undefined,
      hasOpenSession: props.openSession !== undefined,
      lang: props.lang,
    });
    return <div data-testid="panel-stub" />;
  },
  TransportUnavailable: class TransportUnavailable extends Error {},
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, superagentStatus: () => statusMock() };
});

function statusOf(state: SuperagentStatus["state"], lastError: string | null = null): SuperagentStatus {
  return {
    state, enabled: state === "running", pid: state === "running" ? 42 : null,
    startedAt: state === "running" ? "2026-11-02T09:00:00.000Z" : null, restarts: 0, lastError,
    stateDir: "/mock/superagent", socketPath: "/mock/superagent/daemon.sock",
    logPath: "/mock/superagent/logs/daemon.log", assetsDir: null, ompBin: null,
  };
}

beforeEach(() => {
  statusMock.mockReset();
  panelSeen.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("SuperagentView", () => {
  it("running 时挂载面板并传入 transport/openSession", async () => {
    statusMock.mockResolvedValue(statusOf("running"));
    render(<SuperagentView onOpenSession={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByTestId("panel-stub")).toBeInTheDocument();
    expect(panelSeen).toEqual([{ hasTransport: true, hasOpenSession: true, lang: "zh" }]);
  });

  it.each([
    ["disabled", "Superagent 未启用"],
    ["starting", "正在启动…"],
    ["stopping", "正在停止…"],
    ["stopped", "已停止"],
    ["crashed", "守护进程异常退出"],
  ] as const)("%s 显示对应标题且不挂面板", async (state, title) => {
    statusMock.mockResolvedValue(statusOf(state));
    render(<SuperagentView onOpenSession={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByTestId("panel-stub")).toBeNull();
  });

  it("crashed 显示 lastError，前往服务页触发导航", async () => {
    statusMock.mockResolvedValue(statusOf("crashed", "守护进程退出（1）：boom"));
    const onNavigate = vi.fn();
    render(<SuperagentView onOpenSession={() => {}} onNavigate={onNavigate} />);
    expect(await screen.findByText("守护进程退出（1）：boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "前往服务页" }));
    expect(onNavigate).toHaveBeenCalledWith("superagent-service");
  });

  it("状态读取失败显示重试；重试后下一轮恢复", async () => {
    // fake timers 只包住需要推进轮询的那一段；findBy 的 waitFor 在真实时钟下跑。
    vi.useFakeTimers();
    try {
      statusMock.mockRejectedValueOnce({ code: "IO", message: "读失败" });
      statusMock.mockResolvedValue(statusOf("disabled"));
      render(<SuperagentView onOpenSession={() => {}} onNavigate={() => {}} />);
      // 首轮 promise 在 fake 时钟下仍可 flush：microtask 不受计时器影响。
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("状态读取失败")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      expect(screen.queryByText("状态读取失败")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText("Superagent 未启用")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
