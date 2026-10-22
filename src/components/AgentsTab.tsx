/**
 * 「Agent」标签页：编排主代理与子代理——谁干活、用哪个模型、出错怎么换。
 * 状态走 useModelDraft（与「模型」页各持一份草稿），列表与保存条复用 AgentsSection。
 * 主对话模型在「模型」页修改，这里只读展示编排器当前模型。
 * 流程图可交互：点节点滚动到对应配置行并短暂高亮。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./AgentsTab.css";
import { configFromDraft, useModelDraft, type ModelDraftState } from "../modelDraft";
import { resolveAgentEffective } from "../roleCards";
import { AgentFlow } from "./AgentFlow";
import { AgentsSection, agentFlowNodes } from "./AgentsSection";
import { ModelDraftStatus } from "./ModelDraftStatus";
import type { ToastFn } from "./useOmpOp";

const VIBE_TIERS = [
  { label: "Vibe 快速", name: "sonic" },
  { label: "Vibe 强力", name: "task" },
] as const;

/** 高亮停留时长（ms）：足够眼睛跟上滚动，又不至于赖着不走。 */
const FLASH_MS = 1600;

function AgentsTabReady(props: { state: ModelDraftState }): ReactNode {
  const s = props.state;
  const { config, draft, modelsList } = s;
  const [selected, setSelected] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const view = configFromDraft(config, draft);
  const advisorCount = [...draft.advisor.values()].filter((a) => a !== "default").length;
  const vibeNames: Record<string, string> = {};
  for (const { name } of VIBE_TIERS) {
    const def =
      config.agents.find((a) => a.name === name) ??
      { name, description: "", source: "builtin", defaultModel: [], defaultThinkingLevel: null };
    vibeNames[name] = resolveAgentEffective(
      def,
      view.agentOverrides[name],
      view.roles,
      modelsList,
    ).modelText;
  }

  const selectAgent = (name: string): void => {
    setSelected(name);
    const row = document.querySelector(`[data-testid="agent-row-${name}"]`);
    if (row === null) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("agent-row-flash");
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      row.classList.remove("agent-row-flash");
      flashTimer.current = null;
    }, FLASH_MS);
  };

  // 刷新会重载配置并丢弃草稿：有未保存修改时禁用，避免误触丢编辑。
  const hasUnsaved = s.dirty.roles || s.dirty.agents || s.dirty.others;
  const handleRefresh = (): void => {
    void s.loadModels(true);
    void s.loadConfig();
  };

  return (
    <div className="manage-section models-agents agents-tab">
      <div className="agents-tab-head">
        <p className="muted agents-tab-intro">编排主代理与子代理：谁干活、用哪个模型、出错怎么换</p>
        <button
          type="button"
          className="btn btn-small"
          disabled={hasUnsaved || s.modelsLoading}
          title={hasUnsaved ? "有未保存修改，先保存或还原" : undefined}
          onClick={handleRefresh}
        >
          {s.modelsLoading ? <span className="spinner" aria-hidden="true" /> : null}
          刷新
        </button>
      </div>
      <div className="agents-tab-chips" role="status" aria-label="Agent 状态">
        <span className="badge badge-grey">编排器 {s.orchestratorText}</span>
        <span className="badge badge-grey">子代理 {config.agents.length}</span>
        <span className="badge badge-grey">停用 {draft.disabled.size}</span>
        <span className="badge badge-grey">顾问 {advisorCount}</span>
        {VIBE_TIERS.map(({ label, name }) => (
          <span key={name} className="badge badge-grey">
            {label} {vibeNames[name]}
          </span>
        ))}
      </div>
      <p className="muted agents-tab-hint">主对话模型在『模型』页修改</p>
      <ModelDraftStatus state={s} />

      {config.agents.length > 0 ? (
        <AgentFlow
          nodes={agentFlowNodes(s)}
          orchestratorText={s.orchestratorText}
          onSelect={selectAgent}
          selected={selected}
        />
      ) : null}
      <AgentsSection state={s} showFlow={false} />

      <div className="pane-note">新开的 omp 会话使用新配置；已运行的会话可能需重启后生效。</div>
    </div>
  );
}

export function AgentsTab(props: { onToast: ToastFn }): ReactNode {
  const { onToast } = props;
  const loaded = useModelDraft(onToast);

  if (loaded.status === "loading") {
    return <div className="pane-note">正在读取模型配置…</div>;
  }
  if (loaded.status === "error") {
    return (
      <div className="manage-section">
        <div className="banner banner-error" role="alert">
          <div>{loaded.loadError ?? "读取模型配置失败"}</div>
          <button type="button" className="btn btn-small" onClick={() => void loaded.loadConfig()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return <AgentsTabReady state={loaded.state} />;
}
