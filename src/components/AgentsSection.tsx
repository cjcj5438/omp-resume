/**
 * 「Agent」区块：VibeCard（指挥者 + fast/good 两档）、AgentRow 列表与保存条。
 * 纯渲染组件，状态全部来自 ModelDraftState。编排图（AgentFlow）由 AgentsTab
 * 直接渲染（可交互），这里不渲染，只保留 agentNodes 供 AgentRow 列表使用。
 * 与 ModelsSection 同源（见 modelDraft.ts 头注）；组件测试在
 * ModelSections.test.tsx / AgentsTab.test.tsx。
 */
import "./ModelsAgentsPanel.css";
import type { AgentDefinition, ModelConfig, ModelInfo } from "../types";
import { rawValueText } from "../modelConfig";
import {
  AGENT_INFO,
  VIBE_TIERS,
  attachedChainKeys,
  describeRoleFallback,
  friendlyModelName,
  modelProvider,
  resolveAgentEffective,
  rowAfterModelChange,
  selectorBase,
  selectorThinking,
  type AdvisorState,
  type AgentEffective,
  type ChainDraft,
  type SelectorRow,
} from "../roleCards";
import type { ModelDraftState } from "../modelDraft";
import { attachedTitle, configFromDraft } from "../modelDraft";
import { agentFlowNodes } from "./AgentFlow";
import { ModelPicker } from "./ModelPicker";
import { ChainChip, ThinkingSegment } from "./ModelDraftWidgets";

export function AgentsSection(props: { state: ModelDraftState }) {
  const s = props.state;
  const { config, draft, modelsList } = s;
  // 「当前使用」按草稿视角重算：picker 一改就更新，不必等保存。
  const view = configFromDraft(config, draft);

  const agentNodes = agentFlowNodes(s).map((node) => ({
    ...node,
    row: draft.overrides.get(node.agent.name) ?? { selector: null, thinking: "", touched: false },
  }));

  return (
    <>
      <section className="block-section" aria-label="Agent">
        <div className="block-head">
          <h3 className="manage-sub">Agent</h3>
          <span className="muted">每行先看「当前使用」，再决定改不改</span>
        </div>
        {s.blockErrors.agents !== null ? (
          <div className="banner banner-error" role="alert">
            {s.blockErrors.agents}
          </div>
        ) : null}
        <VibeCard
          config={view}
          overrides={draft.overrides}
          chains={draft.chains}
          models={modelsList}
          busy={s.busyBlock !== null}
          onRow={(agentName, next) => s.setRow("overrides", agentName, next)}
        />
        {config.agents.length === 0 ? (
          <div className="pane-note">没有可配置的 Agent。</div>
        ) : null}
        {agentNodes.map(({ agent, row, effective, disabled, advisor }) => (
          <AgentRow
            key={agent.name}
            agent={agent}
            row={row}
            effectiveModel={effective.modelText}
            effectiveProvider={effective.provider}
            effectiveUnknown={effective.modelUnknown}
            effectiveThinking={effective.thinking}
            effectiveSource={effective.sourceText}
            disabledChecked={disabled}
            advisor={advisor}
            models={modelsList}
            busy={s.busyBlock !== null}
            onRow={(next) => s.setRow("overrides", agent.name, next)}
            onDisabled={(checked) => {
              s.setDraft((prev) => {
                if (!prev) return prev;
                const disabledNames = new Set(prev.disabled);
                if (checked) disabledNames.add(agent.name);
                else disabledNames.delete(agent.name);
                return { ...prev, disabled: disabledNames };
              });
            }}
            onAdvisor={(state) => {
              s.setDraft((prev) => {
                if (!prev) return prev;
                const advisorState = new Map(prev.advisor);
                advisorState.set(agent.name, state);
                const advisorTouched = new Set(prev.advisorTouched);
                advisorTouched.add(agent.name);
                return { ...prev, advisor: advisorState, advisorTouched };
              });
            }}
          />
        ))}
        {s.dirty.agents ? (
          <div className="save-bar" role="status">
            <span>{s.agentsChangeCount} 处未保存修改</span>
            <button
              type="button"
              className="btn"
              disabled={s.busyBlock !== null}
              onClick={() => s.revert("agents")}
            >
              还原
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={s.busyBlock !== null}
              onClick={s.saveAgents}
            >
              {s.busyBlock === "agents" ? <span className="spinner" aria-hidden="true" /> : null}
              保存
            </button>
          </div>
        ) : null}
      </section>


    </>
  );
}

/** 「当前使用」行：Agent 行与 Vibe 档位行共用，保证两处展示完全一致。 */
function EffectiveLine(props: {
  testId: string;
  modelText: string;
  provider: string | null;
  unknown: boolean;
  thinking: string;
  source: string;
}) {
  const { testId, modelText, provider, unknown, thinking, source } = props;
  return (
    <div className="agent-effective" data-testid={testId}>
      <span className="muted">当前使用：</span>
      <strong>{modelText}</strong>
      {provider !== null && provider !== "" ? (
        <span className="badge badge-grey" title="供应商">
          {provider}
        </span>
      ) : null}
      {unknown ? <span className="badge badge-grey">未知值 · 保留</span> : null}
      {thinking !== "" ? <span className="muted"> · 思考强度 {thinking}</span> : null}
      <div className="muted">{source}</div>
    </div>
  );
}

/** Agent 行：当前实际使用的模型 + 改用/停用/顾问。 */
function AgentRow(props: {
  agent: AgentDefinition;
  row: SelectorRow;
  effectiveModel: string;
  effectiveProvider: string | null;
  effectiveUnknown: boolean;
  effectiveThinking: string;
  effectiveSource: string;
  disabledChecked: boolean;
  advisor: AdvisorState;
  models: ModelInfo[];
  busy: boolean;
  onRow: (row: SelectorRow) => void;
  onDisabled: (checked: boolean) => void;
  onAdvisor: (state: AdvisorState) => void;
}) {
  const {
    agent,
    row,
    effectiveModel,
    effectiveProvider,
    effectiveUnknown,
    effectiveThinking,
    effectiveSource,
    disabledChecked,
    advisor,
    models,
    busy,
    onRow,
    onDisabled,
    onAdvisor,
  } = props;
  const levels =
    row.selector !== null
      ? (models.find((m) => m.selector === row.selector)?.thinkingLevels ?? [])
      : [];
  return (
    <div className="agent-row" data-testid={`agent-row-${agent.name}`}>
      <div>
        <div className="agent-head">
          <span className="mono">{agent.name}</span>
          {agent.source === "user" ? <span className="badge badge-fork">自定义</span> : null}
          {disabledChecked ? <span className="badge badge-danger">已停用</span> : null}
        </div>
        <div className="muted" title={agent.description}>
          {AGENT_INFO[agent.name]?.duty ?? agent.description}
        </div>
        <EffectiveLine
          testId={`agent-effective-${agent.name}`}
          modelText={effectiveModel}
          provider={effectiveProvider}
          unknown={effectiveUnknown}
          thinking={effectiveThinking}
          source={effectiveSource}
        />
      </div>
      <div className="agent-controls">
        <div className="field">
          <span className="field-label">改用模型</span>
          <ModelPicker
            models={models}
            value={row.selector}
            allowUnset
            unsetLabel="不改用"
            disabled={busy}
            label={`${agent.name} 改用的模型`}
            onChange={(selector) => onRow(rowAfterModelChange(row, selector, models))}
          />
        </div>
        <ThinkingSegment
          levels={levels}
          value={row.selector !== null ? row.thinking : effectiveThinking}
          disabled={busy || row.selector === null}
          label={`${agent.name} 改用模型的思考强度`}
          onChange={(thinking) => onRow({ ...row, thinking, touched: true })}
        />
        <label className="check">
          <input
            type="checkbox"
            aria-label={`停用 ${agent.name}`}
            disabled={busy}
            checked={disabledChecked}
            onChange={(e) => onDisabled(e.target.checked)}
          />
          停用
        </label>
        <label className="field">
          <span className="field-label">顾问</span>
          <select
            aria-label={`${agent.name} 的顾问`}
            disabled={busy}
            value={advisor}
            onChange={(e) => onAdvisor(e.target.value as AdvisorState)}
          >
            <option value="default">默认（跟随会话）</option>
            <option value="on">开</option>
            <option value="off">关</option>
          </select>
        </label>
      </div>
    </div>
  );
}


/**
 * 按名取 Agent 定义；缺失时托底为空默认（只读展示走覆盖或跟随会话，
 * 编辑与保存不受影响——覆盖本就是按 agent 名写的 record）。
 */
function vibeAgentDef(name: string, agents: AgentDefinition[]): AgentDefinition {
  return (
    agents.find((a) => a.name === name) ?? {
      name,
      description: AGENT_INFO[name]?.duty ?? "",
      source: "builtin",
      defaultModel: [],
      defaultThinkingLevel: null,
    }
  );
}

/** Vibe 行的一条兜底来源：角色链或吸附到生效模型的链（标题注明 key 归属）。 */
interface VibeFallbackGroup {
  key: string;
  title: string;
  draft: ChainDraft;
}

/**
 * 某行生效的兜底：可选的按角色链 + 吸附到生效模型的链（与 RoleCard 同规则）。
 * roleKey 为 null 时不读角色链（见 VIBE_TIERS）。
 */
function vibeFallbackGroups(
  roleKey: string | null,
  primary: string | null,
  chains: Map<string, ChainDraft>,
  models: ModelInfo[],
): VibeFallbackGroup[] {
  const groups: VibeFallbackGroup[] = [];
  if (roleKey !== null) {
    const roleChain = chains.get(roleKey);
    // 零条目的链视同无链：删光条目后 key 仍在草稿里，不展示空标题。
    if (roleChain !== undefined && roleChain.entries.length > 0) {
      groups.push({ key: roleKey, title: "兜底模型", draft: roleChain });
    }
  }
  for (const key of attachedChainKeys(primary, [...chains.keys()])) {
    const draft = chains.get(key);
    if (draft !== undefined && draft.entries.length > 0)
      groups.push({ key, title: attachedTitle(key, models), draft });
  }
  return groups;
}

/** Vibe 行的兜底只读展示：与角色卡同一份草稿，只看不改（编辑去角色卡/其他兜底）。 */
function VibeFallback(props: {
  testId: string;
  groups: VibeFallbackGroup[];
  models: ModelInfo[];
}) {
  const { testId, groups, models } = props;
  return (
    <div className="vibe-fallback" data-testid={testId}>
      <span className="muted">兜底：</span>
      {groups.length === 0 ? (
        <span className="muted">还没有兜底模型</span>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="vibe-fallback-group">
            <span className="muted">{group.title}</span>
            <ol className="chain-chips">
              {group.draft.entries.map((entry, index) => (
                <ChainChip
                  key={`${index}-${typeof entry === "string" ? entry : JSON.stringify(entry) ?? index}`}
                  entry={entry}
                  index={index}
                  last={index === group.draft.entries.length - 1}
                  models={models}
                  disabled
                  readOnly
                  onMove={() => {}}
                  onDelete={() => {}}
                />
              ))}
            </ol>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Vibe 档位行：展示与「改用模型」编辑都与同名 Agent 行共用同一份草稿
 * （row 与 effective 均由调用方按 agent 名取出），两处天然同步。
 */
function VibeTierRow(props: {
  tier: "fast" | "good";
  title: string;
  agentName: string;
  row: SelectorRow;
  effective: AgentEffective;
  groups: VibeFallbackGroup[];
  models: ModelInfo[];
  busy: boolean;
  onRow: (row: SelectorRow) => void;
}) {
  const { tier, title, agentName, row, effective, groups, models, busy, onRow } = props;
  const levels =
    row.selector !== null
      ? (models.find((m) => m.selector === row.selector)?.thinkingLevels ?? [])
      : [];
  const label = `Vibe ${title}（${tier}）`;
  return (
    <div className="vibe-tier" data-testid={`vibe-tier-${tier}`}>
      <div>
        <div className="agent-head">
          <strong>{title}</strong>
          <span className="badge badge-grey">{tier}</span>
          <span className="mono muted" title={`对应子代理 ${agentName}`}>
            → {agentName}
          </span>
        </div>
        <div className="muted">{AGENT_INFO[agentName]?.duty ?? ""}</div>
        <EffectiveLine
          testId={`vibe-effective-${tier}`}
          modelText={effective.modelText}
          provider={effective.provider}
          unknown={effective.modelUnknown}
          thinking={effective.thinking}
          source={effective.sourceText}
        />
        <VibeFallback testId={`vibe-fallback-${tier}`} groups={groups} models={models} />
      </div>
      <div className="agent-controls">
        <div className="field">
          <span className="field-label">改用模型</span>
          <ModelPicker
            models={models}
            value={row.selector}
            allowUnset
            unsetLabel="不改用"
            disabled={busy}
            label={`${label}改用的模型`}
            onChange={(selector) => onRow(rowAfterModelChange(row, selector, models))}
          />
        </div>
        <ThinkingSegment
          levels={levels}
          value={row.selector !== null ? row.thinking : effective.thinking}
          disabled={busy || row.selector === null}
          label={`${label}改用模型的思考强度`}
          onChange={(thinking) => onRow({ ...row, thinking, touched: true })}
        />
      </div>
    </div>
  );
}

/**
 * 「Vibe 工作会话」卡：fast / good 两档的模型入口。编辑写入的仍是
 * `task.agentModelOverrides.sonic` / `.task`，与 Agent 块共用草稿与保存条。
 */
function VibeCard(props: {
  /** 草稿视角的配置（AgentsSection 已由 configFromDraft 重算）。 */
  config: ModelConfig;
  overrides: Map<string, SelectorRow>;
  chains: Map<string, ChainDraft>;
  models: ModelInfo[];
  busy: boolean;
  onRow: (agentName: string, row: SelectorRow) => void;
}) {
  const { config, overrides, chains, models, busy, onRow } = props;
  // 指挥者模型：「主对话」角色的当前值，只读展示；config 已是草稿视角，
  // 所以在「模型」页的角色卡里改主对话，这里立即跟着变。脏值原样保留展示。
  const defaultRaw = config.roles["default"];
  const defaultText = typeof defaultRaw === "string" ? defaultRaw : null;
  const fallback = describeRoleFallback("default", config.roles, models);
  const selected = defaultText !== null ? selectorBase(defaultText) : null;
  const selectedName = selected !== null ? friendlyModelName(selected, models) : null;
  const selectedThinking = defaultText !== null ? selectorThinking(defaultText) : "";
  const commanderText =
    defaultText !== null
      ? `${selectedName ?? defaultText}${selectedThinking !== "" ? ` · ${selectedThinking}` : ""}`
      : defaultRaw !== undefined
        ? rawValueText(defaultRaw)
        : fallback.modelText;
  const commanderUnknown = defaultText !== null ? selectedName === null : fallback.modelUnknown;
  const commanderProvider = selected !== null ? modelProvider(selected, models) : null;
  const sonicLabel = AGENT_INFO["sonic"]?.label ?? "sonic";
  const taskLabel = AGENT_INFO["task"]?.label ?? "task";
  return (
    <div className="role-card vibe-card" data-testid="vibe-card">
      <div className="role-card-head">
        <div className="role-card-title">
          <strong className="role-card-name">Vibe 工作会话</strong>
          <span className="mono muted role-key">/vibe</span>
        </div>
        <div className="muted role-card-blurb">
          在 omp 中输入 /vibe 进入该模式：指挥者（主会话，只有只读工具）按两档把活派给工作会话。
        </div>
      </div>
      <div className="vibe-conductor" data-testid="vibe-conductor">
        <span className="muted">指挥者模型（「主对话」角色，只读）：</span>
        <strong>{commanderText}</strong>
        {commanderProvider !== null && commanderProvider !== "" ? (
          <span className="badge badge-grey" title="供应商">
            {commanderProvider}
          </span>
        ) : null}
        {commanderUnknown ? <span className="badge badge-grey">未知值 · 保留</span> : null}
      </div>
      <VibeFallback
        testId="vibe-fallback-conductor"
        groups={vibeFallbackGroups("default", selected, chains, models)}
        models={models}
      />
      {VIBE_TIERS.map(({ tier, title, agent, roleKey }) => {
        const tierRow = overrides.get(agent) ?? { selector: null, thinking: "", touched: false };
        const def = vibeAgentDef(agent, config.agents);
        const tierEffective = resolveAgentEffective(
          def,
          config.agentOverrides[agent],
          config.roles,
          models,
        );
        // 吸附查找用的模型：草稿视角的解析结果已展开别名，清掉（不改用）
        // 则按「无覆盖」重算该去哪，不再显示旧模型的链。
        const primary = tierEffective.selector;
        return (
          <VibeTierRow
            key={tier}
            tier={tier}
            title={title}
            agentName={agent}
            row={tierRow}
            effective={tierEffective}
            groups={vibeFallbackGroups(roleKey, primary, chains, models)}
            models={models}
            busy={busy}
            onRow={(next) => onRow(agent, next)}
          />
        );
      })}
      <p className="muted vibe-note">
        这两个档位与『{sonicLabel}』『{taskLabel}』子代理共用模型，修改会同时影响普通子代理。
      </p>
    </div>
  );
}

