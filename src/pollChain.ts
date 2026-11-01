/**
 * 链式轮询：同一时刻至多一个请求；页面隐藏时不排期、恢复可见立即拉一次。
 * 从 useStageData.ts 移出，供舞台、托盘预览等所有轮询复用。
 */

/** 同 useStageData 的 hidden()：document 不存在（SSR 之类）时视为可见。 */
function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * 链式轮询：同一时刻至多一个请求；隐藏时不排期；恢复可见立即拉一次。
 *
 * `run` 永不 reject，返回下一轮延迟（ms）。返回停止函数。
 */
export function startChain(run: () => Promise<number>): () => void {
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
