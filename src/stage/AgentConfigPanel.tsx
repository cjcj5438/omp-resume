/**
 * Agent 配置（只读）：职责、来源、生效模型、本次模型、顾问、工具、可派生、
 * 系统提示词。数据全部来自只读命令（`get_model_config` / `list_models` /
 * `list_agent_details`），这里没有任何保存/修改入口。
 */
import { EffectiveLine } from "../components/AgentsSection";
import { errorText } from "../format";
import { rawValueText } from "../modelConfig";
import {
  AGENT_INFO,
  friendlyModelName,
  modelProvider,
  resolveAgentEffective,
  resolveRoleFallback,
} from "../roleCards";
import type { AgentDetail, StageActor } from "../types";
import type { AgentCatalog } from "./agentCatalog";
import { ADVISOR_KEY, MAIN_KEY } from "./prefs";

export interface AgentConfigPanelProps {
  entryKey: string;
  /** 舞台上的角色（「本次运行模型」用）；Agent 库场景为 null。 */
  actor: StageActor | null;
  catalog: AgentCatalog;
}

/** 本次运行用的模型：友好名 + 原始 selector。 */
function runModel(actor: StageActor | null, models: AgentCatalog["models"]): string | null {
  if (actor === null || actor.model === null) return null;
  return friendlyModelName(actor.model, models) ?? actor.model;
}

function ChipList({ items }: { items: string[] }) {
  return (
    <span className="stage-agent-chips">
      {items.map((item) => (
        <span key={item} className="stage-chip">
          {item}
        </span>
      ))}
    </span>
  );
}

export function AgentConfigPanel({ entryKey, actor, catalog }: AgentConfigPanelProps) {
  const { config, models, details, loading, error } = catalog;
  const run = runModel(actor, models);

  if (loading) return <p className="pane-note">读取 omp agent 配置…</p>;

  const header = (
    <>
      {error !== null ? (
        <p className="pane-note">读取 omp 配置失败：{errorText(error)}</p>
      ) : null}
      {run !== null ? <p className="stage-agent-run">本次运行模型：{run}</p> : null}
    </>
  );

  if (entryKey === MAIN_KEY) {
    const fallback = config === null ? null : resolveRoleFallback("default", config.roles);
    const roleName = fallback === null ? null : (friendlyModelName(fallback.selector, models) ?? fallback.selector);
    return (
      <div className="stage-agent-conf">
        <p className="stage-agent-title">
          管理员 · 主会话
          <span className="badge badge-grey">主会话</span>
        </p>
        {header}
        {roleName !== null ? (
          <p className="stage-agent-row">
            <span className="muted">default 角色：</span>
            <strong>{roleName}</strong>
            {modelProvider(fallback?.selector ?? "", models) !== null ? (
              <span className="badge badge-grey">{modelProvider(fallback?.selector ?? "", models)}</span>
            ) : null}
            {fallback?.via !== null && fallback?.via !== undefined ? (
              <span className="muted">（经 @{fallback.via}）</span>
            ) : null}
          </p>
        ) : null}
        <p className="stage-agent-row muted">主会话不是我定义，没有工具/提示词可读。</p>
      </div>
    );
  }

  if (entryKey === ADVISOR_KEY) {
    const advisors = Object.entries(config?.agentAdvisor ?? {})
      .filter(([, value]) => rawValueText(value) === "on")
      .map(([name]) => name);
    return (
      <div className="stage-agent-conf">
        <p className="stage-agent-title">
          顾问 · advisor
          <span className="badge badge-grey">顾问会话</span>
        </p>
        {header}
        <p className="stage-agent-row muted">
          顾问会话不是 omp agent 定义，按各 agent 的顾问开关附着。
        </p>
        <p className="stage-agent-row">
          <span className="muted">已开启顾问：</span>
          {advisors.length === 0 ? <span>无</span> : <ChipList items={advisors} />}
        </p>
      </div>
    );
  }

  const detail: AgentDetail | undefined = details.find((d) => d.name === entryKey);
  const def = detail ?? config?.agents.find((a) => a.name === entryKey) ?? null;
  if (def === null) {
    return (
      <div className="stage-agent-conf">
        <p className="stage-agent-title">{entryKey}</p>
        {header}
        <p className="stage-agent-row muted">
          未找到该 agent 的定义（只读取 omp 内置与 ~/.omp/agent/agents/*.md）。
        </p>
      </div>
    );
  }

  const info = AGENT_INFO[entryKey];
  const disabled = (config?.disabledAgents ?? []).some((value) => rawValueText(value) === entryKey);
  const effective = resolveAgentEffective(
    def,
    config?.agentOverrides[entryKey],
    config?.roles ?? {},
    models,
  );
  const advisorRaw = config === null ? undefined : config.agentAdvisor[entryKey];
  const advisorText =
    advisorRaw === undefined ? "跟随默认" : rawValueText(advisorRaw) === "on" ? "开" : rawValueText(advisorRaw) === "off" ? "关" : "跟随默认";
  const tools = detail?.tools ?? null;
  const spawns = detail?.spawns ?? null;

  return (
    <div className="stage-agent-conf">
      <p className="stage-agent-title">
        <span className="mono">{entryKey}</span>
        {info !== undefined ? <span className="badge badge-grey">{info.label}</span> : null}
        <span className="badge badge-grey">{def.source === "user" ? "自定义" : "内置"}</span>
        {disabled ? <span className="badge badge-danger">已停用</span> : null}
      </p>
      {header}
      {info !== undefined ? <p className="stage-agent-row">{info.duty}</p> : null}
      {def.description !== "" ? <p className="stage-agent-row muted">{def.description}</p> : null}
      <div className="stage-agent-row">
        <EffectiveLine
          testId="stage-agent-effective"
          modelText={effective.modelText}
          provider={effective.provider}
          unknown={effective.modelUnknown}
          thinking={effective.thinking}
          source={effective.sourceText}
        />
      </div>
      <p className="stage-agent-row">
        <span className="muted">顾问：</span>
        {advisorText}
      </p>
      <p className="stage-agent-row">
        <span className="muted">工具：</span>
        {tools === null ? (
          <span>默认工具集</span>
        ) : tools.length === 0 ? (
          <span>无</span>
        ) : (
          <ChipList items={tools} />
        )}
      </p>
      <p className="stage-agent-row">
        <span className="muted">可派生：</span>
        {spawns === null ? (
          <span>未声明</span>
        ) : spawns.includes("*") ? (
          <span>任意 agent</span>
        ) : spawns.length === 0 ? (
          <span>无</span>
        ) : (
          <ChipList items={spawns} />
        )}
      </p>
      {detail !== undefined ? (
        <details className="stage-agent-prompt-box">
          <summary>系统提示词（{detail.systemPrompt.length} 字）</summary>
          <pre className="stage-agent-prompt">{detail.systemPrompt}</pre>
        </details>
      ) : (
        <p className="stage-agent-row muted">未读取到系统提示词。</p>
      )}
    </div>
  );
}
