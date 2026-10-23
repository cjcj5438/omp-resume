import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { normalizeError } from "../api";
import type { AppError } from "../types";

export interface AsyncData<T> {
  data: T | null;
  loading: boolean;
  error: AppError | null;
  reload: () => void;
}

/** 最新请求获胜 + 卸载安全。enabled=false 进入空闲（不发请求、loading=false）；keepPrevious=false 时换参即清空旧数据。错误经 normalizeError。 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  opts?: { enabled?: boolean; keepPrevious?: boolean },
): AsyncData<T> {
  const { enabled = true, keepPrevious = false } = opts ?? {};
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<AppError | null>(null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const seq = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      seq.current += 1;
      if (!keepPrevious) setData(null);
      setError(null);
      setLoading(false);
      return () => {
        alive.current = false;
      };
    }
    const id = (seq.current += 1);
    if (!keepPrevious) setData(null);
    setLoading(true);
    setError(null);
    void loaderRef
      .current()
      .then((d) => {
        if (alive.current && seq.current === id) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive.current && seq.current === id) {
          if (!keepPrevious) setData(null);
          setError(normalizeError(e));
          setLoading(false);
        }
      });
    return () => {
      alive.current = false;
    };
  }, [...deps, nonce, enabled]);

  return { data, loading, error, reload };
}
