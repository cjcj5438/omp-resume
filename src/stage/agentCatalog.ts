/**
 * 舞台用到的 omp agent 目录（只读）：模型角色 / 模型列表 / agent 完整定义。
 *
 * 三个 API 全是只读命令；本模块不 import 任何 `update*`。
 * 首次需要时才加载（拉起 omp 子进程不便宜），在组件生命周期内缓存一次。
 */
import { useEffect, useRef, useState } from "react";
import { getModelConfig, listAgentDetails, listModels, normalizeError } from "../api";
import type { AgentDetail, AppError, ModelConfig, ModelInfo } from "../types";

export interface AgentCatalog {
  loading: boolean;
  config: ModelConfig | null;
  models: ModelInfo[];
  details: AgentDetail[];
  /** 任一读取失败时的第一个错误（其余能显示的照常显示）。 */
  error: AppError | null;
}

const EMPTY: AgentCatalog = {
  loading: false,
  config: null,
  models: [],
  details: [],
  error: null,
};

export function useAgentCatalog(enabled: boolean): AgentCatalog {
  const [catalog, setCatalog] = useState<AgentCatalog>(EMPTY);
  // 加载过一次（成功或失败）就不再重复拉 omp；在途请求跨 enabled 开关继续。
  const started = useRef(false);
  const mounted = useRef(true);

  // 卸载标记：只有真正的卸载才丢弃结果，enabled 开关不影响在途请求。
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    setCatalog((prev) => ({ ...prev, loading: true }));

    void (async () => {
      const [config, models, details] = await Promise.allSettled([
        getModelConfig(),
        listModels(),
        listAgentDetails(),
      ]);
      if (!mounted.current) return;
      const failure = [config, models, details].find((r) => r.status === "rejected");
      setCatalog({
        loading: false,
        config: config.status === "fulfilled" ? config.value : null,
        models: models.status === "fulfilled" ? models.value : [],
        details: details.status === "fulfilled" ? details.value : [],
        error:
          failure !== undefined && failure.status === "rejected"
            ? normalizeError(failure.reason)
            : null,
      });
    })();
  }, [enabled]);

  return catalog;
}
