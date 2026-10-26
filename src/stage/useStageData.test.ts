import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentStage } from "../types";
import { ENDED_INTERVAL_MS, STAGE_INTERVAL_MS, useStagePoll } from "./useStageData";

const getAgentStage = vi.fn<(path: string) => Promise<AgentStage>>();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentStage: (path: string) => getAgentStage(path),
    listRunningSessions: () => Promise.resolve([]),
  };
});

function stage(inUse: boolean): AgentStage {
  return {
    path: "/mock/s.jsonl",
    sessionId: "s1",
    title: "t",
    cwd: "/mock",
    inUse,
    probeOk: true,
    updatedAt: "2026-10-21T01:06:00.000Z",
    omitted: 0,
    actors: [],
  };
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  getAgentStage.mockReset();
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useStagePoll", () => {
  test("隐藏期间恢复可见不会产生第二条轮询链", async () => {
    const first = Promise.withResolvers<AgentStage>();
    getAgentStage.mockImplementationOnce(() => first.promise);
    getAgentStage.mockResolvedValue(stage(true));

    renderHook(() => useStagePoll("/mock/s.jsonl"));
    // 首个请求还在飞：隐藏再恢复。
    setVisibility("hidden");
    setVisibility("visible");
    expect(getAgentStage).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(stage(true));
      await Promise.resolve();
    });
    expect(getAgentStage).toHaveBeenCalledTimes(1);

    // 单链：每 1.5s 恰好一次。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_INTERVAL_MS);
    });
    expect(getAgentStage).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_INTERVAL_MS * 2);
    });
    expect(getAgentStage).toHaveBeenCalledTimes(4);
  });

  test("已结束的会话降频到 10s", async () => {
    getAgentStage.mockResolvedValue(stage(false));
    renderHook(() => useStagePoll("/mock/s.jsonl"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getAgentStage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_INTERVAL_MS);
    });
    expect(getAgentStage, "1.5s 内不该再拉").toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENDED_INTERVAL_MS);
    });
    expect(getAgentStage).toHaveBeenCalledTimes(2);
  });

  test("重新在用的会话回到 1.5s", async () => {
    getAgentStage.mockResolvedValueOnce(stage(false)).mockResolvedValue(stage(true));
    renderHook(() => useStagePoll("/mock/s.jsonl"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENDED_INTERVAL_MS);
    });
    expect(getAgentStage).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_INTERVAL_MS);
    });
    expect(getAgentStage).toHaveBeenCalledTimes(3);
  });

  test("连续 2 次失败才置错误", async () => {
    getAgentStage.mockRejectedValue({ code: "IO", message: "读取失败" });
    const { result } = renderHook(() => useStagePoll("/mock/s.jsonl"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
    // 第二轮失败后置错误（偶发一次失败不闪错误）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_INTERVAL_MS);
    });
    expect(result.current.error?.message).toBe("读取失败");
  });
});
