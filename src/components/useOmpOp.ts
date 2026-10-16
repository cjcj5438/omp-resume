/**
 * 管理视图的单操作模型：整个管理视图同时只运行一个 omp 写操作
 * （后端有全局忙门禁），运行时所有变更按钮禁用，日志逐行流入。
 * 由 ManageView 创建一份，经 props 传入各面板。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { normalizeError } from "../api";
import type { AppError } from "../types";

export type ToastFn = (text: string, kind: "info" | "error") => void;

export type OmpOpOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

export interface OmpOpController {
  /** 正在执行的操作标签；null 表示空闲。 */
  running: string | null;
  /** 当前（或上次）操作的逐行日志。 */
  lines: string[];
  /**
   * 独占执行一个流式操作：永不抛错（失败包在 outcome 里），
   * finally 中必清 running；卸载后不再 setState。
   */
  run: <T>(
    label: string,
    task: (onLine: (line: string) => void) => Promise<T>,
  ) => Promise<OmpOpOutcome<T>>;
}

export function useOmpOp(): OmpOpController {
  const [running, setRunning] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const runningRef = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async <T>(
      label: string,
      task: (onLine: (line: string) => void) => Promise<T>,
    ): Promise<OmpOpOutcome<T>> => {
      // 按钮禁用是第一道防线；这里防重入调用（如测试中连续触发）。
      if (runningRef.current !== null)
        return {
          ok: false,
          error: { code: "BUSY", message: "另一个 omp 操作正在进行" },
        };
      runningRef.current = label;
      if (alive.current) {
        setRunning(label);
        setLines([]);
      }
      const onLine = (line: string) => {
        if (alive.current) setLines((prev) => [...prev, line]);
      };
      try {
        return { ok: true, value: await task(onLine) };
      } catch (e: unknown) {
        return { ok: false, error: normalizeError(e) };
      } finally {
        runningRef.current = null;
        if (alive.current) setRunning(null);
      }
    },
    [],
  );

  return { running, lines, run };
}

/** 卸载后为 false：await 之后 setState 前检查，避免卸载后写状态。 */
export function useAlive(): RefObject<boolean> {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}
