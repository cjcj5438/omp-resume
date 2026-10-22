/**
 * 模型草稿状态条：模型列表状态 + 加载失败横幅 + 兜底关闭警告。
 * ModelsTab 与 AgentsTab 共用（状态来自 useModelDraft）；组件测试在
 * ModelSections.test.tsx / AgentsTab.test.tsx。
 * 注意：刷新按钮不在这里——各页头已有自己的刷新按钮。
 */
import type { ReactNode } from "react";
import type { ModelDraftState } from "../modelDraft";

export function ModelDraftStatus(props: { state: ModelDraftState }): ReactNode {
  const s = props.state;
  const { models, modelsLoading, modelsError, retry, retryEnabledText } = s;
  // 自带 .models-agents 作用域：ma-status 样式挂在这个类下，两个 Tab 直接渲染即可。
  return (
    <div className="models-agents">
      <div className="muted ma-status">
        <span>
          模型列表：
          {models !== null
            ? `${models.length} 个模型${modelsLoading ? "（重新加载中…）" : ""}`
            : modelsError !== null
              ? "加载失败"
              : "加载中…"}
        </span>
        <span>
          兜底：{retryEnabledText} · {retry.trigger} · {retry.revert}
        </span>
      </div>
      {modelsError !== null ? (
        <div className="banner banner-warn">
          模型列表加载失败：{modelsError}（仍可查看与保存配置，但无法选择模型）
          <button type="button" className="btn btn-small" onClick={() => void s.loadModels(true)}>
            重试
          </button>
        </div>
      ) : null}
      {models === null && modelsError === null ? (
        <div className="muted">模型列表加载中（首次加载可能需要几秒）…</div>
      ) : null}
      {retry.enabled === false ? (
        <div className="banner banner-warn" role="alert">
          兜底已关闭，下面的兜底配置不会生效。如需使用，请在 omp 的配置中重新打开总开关。
        </div>
      ) : null}
    </div>
  );
}
