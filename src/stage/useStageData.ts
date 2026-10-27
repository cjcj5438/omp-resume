/**
 * 舞台轮询：链式 `setTimeout`（上一次返回后再排下一次，绝不并发），
 * 页面隐藏时不排期、恢复可见立即拉一次；`path` 变化立即重拉。
 *
 * 连续 2 次失败才置 `error`（偶发读超时不该让界面闪错误），成功即清。
 * 已结束的会话降频轮询（内容不会再变，但要能感知「被重新打开」）。
 */
import { useEffect, useRef, useState } from "react";
import { getAgentStage, listRunningSessions, normalizeError } from "../api";
import type { AgentStage, AppError, RunningSession } from "../types";

/** 舞台数据的轮询间隔（ms）：后端每轮只读增量，1.5s 足够平滑。 */
export const STAGE_INTERVAL_MS = 1500;
/** 已结束会话的轮询间隔（ms）：只等它被重新打开。 */
export const ENDED_INTERVAL_MS = 10_000;
/** 运行中会话列表的轮询间隔（菜单栏自身 3s 一轮）。 */
export const RUNNING_INTERVAL_MS = 3000;

export interface StageData {
  stage: AgentStage | null;
  error: AppError | null;
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * 链式轮询：同一时刻至多一个请求；隐藏时不排期；恢复可见立即拉一次。
 *
 * `run` 永不 reject，返回下一轮延迟（ms）。返回停止函数。
 */
function startChain(run: () => Promise<number>): () => void {
  let timer: number | undefined;
  let inFlight = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight || hidden()) return;
    inFlight = true;
    let next = 0;
    try {
      next = await run();
    } finally {
      inFlight = false;
    }
    if (stopped || hidden()) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void tick(), next);
  };

  void tick();

  const onVisibility = (): void => {
    if (hidden()) {
      window.clearTimeout(timer);
      return;
    }
    if (stopped) return;
    // 请求还在飞时由 `inFlight` 挡住，等它返回后排期，不会出现第二条链。
    window.clearTimeout(timer);
    void tick();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** 轮询单个会话的舞台。`path === null` 时清空并停止。 */
export function useStagePoll(path: string | null, intervalMs = STAGE_INTERVAL_MS): StageData {
  const [stage, setStage] = useState<AgentStage | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    failures.current = 0;
    setStage(null);
    setError(null);
    if (path === null) return;
    let alive = true;

    const stop = startChain(async () => {
      try {
        const data = await getAgentStage(path);
        if (!alive) return intervalMs;
        failures.current = 0;
        setStage(data);
        setError(null);
        return data.inUse ? intervalMs : ENDED_INTERVAL_MS;
      } catch (e: unknown) {
        if (alive) {
          failures.current += 1;
          if (failures.current >= 2) setError(normalizeError(e));
        }
        return intervalMs;
      }
    });

    return () => {
      alive = false;
      stop();
    };
  }, [path, intervalMs]);

  return { stage, error };
}

/** 轮询运行中会话列表（左栏「运行中」分组）。 */
export function useRunningSessions(intervalMs = RUNNING_INTERVAL_MS): RunningSession[] {
  const [list, setList] = useState<RunningSession[]>([]);

  useEffect(() => {
    const stop = startChain(async () => {
      try {
        setList(await listRunningSessions());
      } catch {
        // 快照不可用不致命：保留上一次结果（菜单栏会持续刷新）。
      }
      return intervalMs;
    });
    return stop;
  }, [intervalMs]);

  return list;
}
