/**
 * 「模型与 Agent」面板：每个角色一张卡（主模型 + 兜底在一起改），往下是
 * Agent 行与「其他模型的兜底」。保存走白名单 update_model_config（读-比-写），
 * 语义见 docs/CONTRACT.md §4.36–§4.38。
 *
 * 未知值保留原则：当前值不在模型列表（别名 `@smol`、已下线模型）原样显示；
 * 未被用户触碰的键与值（含不认识的角色 / agent / 兜底 key）一律原样写回。
 */
import { useCallback, useEffect, useState } from "react";
import "./ModelsAgentsPanel.css";
import { getModelConfig, listModels, normalizeError, updateModelConfig } from "../api";
import { errorText } from "../format";
import { deepEqual } from "../modelConfig";
import type { AgentDefinition, ModelConfig, ModelInfo } from "../types";
import {
  attachedChainKeys,
  buildAdvisor,
  buildChains,
  buildDisabled,
  buildRecord,
  classifyChainKey,
  COMMON_ROLES,
  describeRetryStatus,
  draftFromConfig,
  friendlyModelName,
  orderNumeral,
  resolveAgentEffective,
  roleInfo,
  SAVE_KEY_LABELS,
  selectorBase,
  selectorThinking,
  wildcardTitle,
  type AdvisorState,
  type ChainDraft,
  type ModelDrafts,
  type SelectorRow,
} from "../roleCards";
import { ModelPicker } from "./ModelPicker";
import { useAlive } from "./useOmpOp";

const CONFIG_KEYS = {
  roles: "modelRoles",
  overrides: "task.agentModelOverrides",
  disabled: "task.disabledAgents",
  advisor: "task.agentAdvisor",
  chains: "retry.fallbackChains",
} as const;

const CONFLICT_TEXT = "配置已被外部修改，请刷新（下方已重新载入最新配置）";

/** 进程内模型缓存：`omp models --json` 较慢，刷新按钮才重跑。 */
let modelsCache: ModelInfo[] | null = null;

interface SavePair {
  key: string;
  value: unknown;
  expected: unknown;
}

function pairLabel(key: string): string {
  return SAVE_KEY_LABELS[key] ?? key;
}

/** 思考强度分段控件：默认 + 所选模型的档位；当前值不在档位表时原样保留。 */
function ThinkingSegment(props: {
  levels: string[];
  value: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
}) {
  const { levels, value, disabled, label, onChange } = props;
  const extra = value !== "" && !levels.includes(value) ? value : null;
  const options = extra !== null ? [...levels, extra] : levels;
  return (
    <div className="field">
      <span className="field-label">思考强度</span>
      <div className="segment" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          aria-checked={value === ""}
          className={value === "" ? "segment-item segment-item-active" : "segment-item"}
          disabled={disabled}
          onClick={() => onChange("")}
        >
          默认
        </button>
        {options.map((level) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={value === level}
            className={value === level ? "segment-item segment-item-active" : "segment-item"}
            disabled={disabled}
            title={level === extra ? "当前值（不在该模型的档位表里，原样保留）" : undefined}
            onClick={() => onChange(level)}
          >
            {level === extra ? `${level} · 保留` : level}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 模型 + 思考强度共用的行编辑单元。 */
function SelectorCell(props: {
  models: ModelInfo[];
  row: SelectorRow;
  unsetLabel: string;
  label: string;
  disabled: boolean;
  onChange: (row: SelectorRow) => void;
}) {
  const { models, row, unsetLabel, label, disabled, onChange } = props;
  const levels =
    row.selector !== null
      ? (models.find((m) => m.selector === row.selector)?.thinkingLevels ?? [])
      : [];
  return (
    <div className="selector-cell">
      <div className="field">
        <span className="field-label">主模型</span>
        <ModelPicker
          models={models}
          value={row.selector}
          allowUnset
          unsetLabel={unsetLabel}
          disabled={disabled}
          label={label}
          onChange={(selector) => {
            const nextLevels =
              selector !== null
                ? (models.find((m) => m.selector === selector)?.thinkingLevels ?? [])
                : [];
            const thinking =
              row.thinking !== "" && nextLevels.includes(row.thinking) ? row.thinking : "";
            onChange({ selector, thinking, touched: true });
          }}
        />
      </div>
      <ThinkingSegment
        levels={levels}
        value={row.thinking}
        disabled={disabled || row.selector === null}
        label={`${label}的思考强度`}
        onChange={(thinking) => onChange({ ...row, thinking, touched: true })}
      />
    </div>
  );
}

/** 单条兜底的编辑器：一行说明 + 有序条目 + 添加。 */
function ChainEditor(props: {
  chainKey: string;
  title: string;
  hint: string;
  note: string | null;
  draft: ChainDraft | null;
  models: ModelInfo[];
  disabled: boolean;
  onEnsure: (key: string) => void;
  onDeleteChain: (key: string) => void;
  onChange: (key: string, patch: (chain: ChainDraft) => ChainDraft) => void;
}) {
  const { chainKey, title, hint, note, draft, models, disabled, onEnsure, onDeleteChain, onChange } =
    props;
  const [addSelector, setAddSelector] = useState<string | null>(null);
  const [addThinking, setAddThinking] = useState("");
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const addLevels =
    addSelector !== null
      ? (models.find((m) => m.selector === addSelector)?.thinkingLevels ?? [])
      : [];

  if (draft === null) {
    return (
      <div className="chain-block" data-testid={`chain-${chainKey}`}>
        <div className="chain-block-head">
          <span className="chain-block-title">{title}</span>
          <span className="muted">{hint}</span>
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => onEnsure(chainKey)}
          >
            添加兜底
          </button>
        </div>
        {note !== null ? <div className="muted chain-note">{note}</div> : null}
      </div>
    );
  }

  const moveEntry = (index: number, delta: number) => {
    onChange(chainKey, (chain) => {
      const entries = [...chain.entries];
      const target = index + delta;
      [entries[index], entries[target]] = [entries[target], entries[index]];
      return { ...chain, entries };
    });
  };

  const addComposed = () => {
    if (addSelector === null) return;
    const composed = addThinking !== "" ? `${addSelector}:${addThinking}` : addSelector;
    onChange(chainKey, (chain) => ({ ...chain, entries: [...chain.entries, composed] }));
    setAddSelector(null);
    setAddThinking("");
  };

  const addManual = () => {
    const text = manual.trim();
    if (text === "") {
      setManualError("先输入一个模型（provider/model，可带 :thinking，或通配如 p1/*）");
      return;
    }
    onChange(chainKey, (chain) => ({ ...chain, entries: [...chain.entries, text] }));
    setManual("");
    setManualError(null);
  };

  return (
    <div className="chain-block" data-testid={`chain-${chainKey}`}>
      <div className="chain-block-head">
        <span className="chain-block-title">{title}</span>
        <span className="muted">{hint}</span>
        <button
          type="button"
          className="btn btn-small btn-quiet-danger"
          disabled={disabled}
          aria-label={`删除${title}（${chainKey}）`}
          onClick={() => onDeleteChain(chainKey)}
        >
          删除这条兜底
        </button>
      </div>
      {note !== null ? <div className="muted chain-note">{note}</div> : null}
      {draft.entries.length === 0 ? (
        <div className="pane-note">还没有兜底模型：在下面添加，或删除这条兜底。</div>
      ) : (
        <ol className="chain-chips">
          {draft.entries.map((entry, index) => (
            <ChainChip
              key={`${index}-${typeof entry === "string" ? entry : JSON.stringify(entry) ?? index}`}
              entry={entry}
              index={index}
              last={index === draft.entries.length - 1}
              models={models}
              disabled={disabled}
              onMove={moveEntry}
              onDelete={() =>
                onChange(chainKey, (chain) => ({
                  ...chain,
                  entries: chain.entries.filter((_, i) => i !== index),
                }))
              }
            />
          ))}
        </ol>
      )}
      <div className="chain-add">
        <ModelPicker
          models={models}
          value={addSelector}
          allowUnset={false}
          unsetLabel="选择模型…"
          disabled={disabled}
          label={`为${title}添加兜底模型`}
          onChange={(selector) => {
            setAddSelector(selector);
            setAddThinking("");
          }}
        />
        {addSelector !== null ? (
          <ThinkingSegment
            levels={addLevels}
            value={addThinking}
            disabled={disabled}
            label={`新兜底模型的思考强度（${chainKey}）`}
            onChange={setAddThinking}
          />
        ) : null}
        <button
          type="button"
          className="btn btn-small"
          disabled={disabled || addSelector === null}
          onClick={addComposed}
        >
          添加
        </button>
      </div>
      <details className="chain-manual">
        <summary className="muted">手动输入（通配或列表里没有的模型）</summary>
        <div className="chain-add">
          <input
            className="filter-input"
            placeholder="provider/model[:thinking]，或 p1/*"
            aria-label={`手动输入${title}的兜底模型`}
            value={manual}
            disabled={disabled}
            onChange={(e) => {
              setManual(e.target.value);
              setManualError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addManual();
            }}
          />
          <button type="button" className="btn btn-small" disabled={disabled} onClick={addManual}>
            添加
          </button>
        </div>
        {manualError !== null ? <div className="muted">{manualError}</div> : null}
      </details>
    </div>
  );
}

/** 兜底条目 chip：顺序号 + 模型名 + 操作。 */
function ChainChip(props: {
  entry: unknown;
  index: number;
  last: boolean;
  models: ModelInfo[];
  disabled: boolean;
  onMove: (index: number, delta: number) => void;
  onDelete: () => void;
}) {
  const { entry, index, last, models, disabled, onMove, onDelete } = props;
  const text = typeof entry === "string" ? entry : null;
  const parsed = text !== null ? { base: selectorBase(text), thinking: selectorThinking(text) } : null;
  const name = parsed !== null ? friendlyModelName(parsed.base, models) : null;
  const label = text ?? (typeof entry === "number" ? String(entry) : JSON.stringify(entry) ?? "?");
  return (
    <li className="chain-chip">
      <span className="chain-order" aria-hidden="true">
        {orderNumeral(index)}
      </span>
      <span className={name !== null ? undefined : "mono"}>
        {name ?? (parsed !== null ? parsed.base : label)}
      </span>
      {parsed !== null && parsed.thinking !== "" ? (
        <span className="badge badge-grey">{parsed.thinking}</span>
      ) : null}
      {text !== null && name === null ? (
        <span className="badge badge-grey">未知值 · 保留</span>
      ) : null}
      {text === null ? <span className="badge badge-grey">原样保留</span> : null}
      <span className="chain-chip-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={disabled || index === 0}
          aria-label={`上移 ${label}`}
          onClick={() => onMove(index, -1)}
        >
          上移
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={disabled || last}
          aria-label={`下移 ${label}`}
          onClick={() => onMove(index, 1)}
        >
          下移
        </button>
        <button
          type="button"
          className="btn btn-small btn-quiet-danger"
          disabled={disabled}
          aria-label={`删除 ${label}`}
          onClick={onDelete}
        >
          删除
        </button>
      </span>
    </li>
  );
}

/** 角色卡：主模型 + 同卡内的兜底。 */
function RoleCard(props: {
  role: string;
  row: SelectorRow;
  roleChain: ChainDraft | null;
  attachedKeys: string[];
  chains: Map<string, ChainDraft>;
  models: ModelInfo[];
  disabled: boolean;
  removable: boolean;
  onRow: (row: SelectorRow) => void;
  onEnsureChain: (key: string) => void;
  onDeleteChain: (key: string) => void;
  onChain: (key: string, patch: (chain: ChainDraft) => ChainDraft) => void;
  onRemove: () => void;
}) {
  const {
    role,
    row,
    roleChain,
    attachedKeys,
    chains,
    models,
    disabled,
    removable,
    onRow,
    onEnsureChain,
    onDeleteChain,
    onChain,
    onRemove,
  } = props;
  const info = roleInfo(role);
  const primary = row.selector !== null ? row.selector : null;
  return (
    <div className="role-card" data-testid={`role-card-${role}`}>
      <div className="role-card-head">
        <div className="role-card-title">
          <strong>{info?.name ?? role}</strong>
          <span className="mono muted">{role}</span>
          {info === null ? <span className="badge badge-grey">自定义角色</span> : null}
          {info?.kind === "capability" ? (
            <span className="badge badge-grey">能力角色</span>
          ) : null}
          {primary === null ? <span className="badge badge-grey">未配置</span> : null}
          {row.touched ? <span className="muted">已修改</span> : null}
        </div>
        <div className="muted">{info?.blurb ?? "此配置里的自定义角色"}</div>
      </div>
      <SelectorCell
        models={models}
        row={row}
        unsetLabel="未设置"
        label={`${info?.name ?? role}的主模型`}
        disabled={disabled}
        onChange={onRow}
      />
      {removable ? (
        <div>
          <button type="button" className="btn btn-small" disabled={disabled} onClick={onRemove}>
            移除此角色
          </button>
        </div>
      ) : null}
      <ChainEditor
        chainKey={role}
        title="兜底模型"
        hint="主模型出错时，按顺序改用"
        note={null}
        draft={roleChain}
        models={models}
        disabled={disabled}
        onEnsure={onEnsureChain}
        onDeleteChain={onDeleteChain}
        onChange={onChain}
      />
      {attachedKeys.map((key) => (
        <ChainEditor
          key={key}
          chainKey={key}
          title={attachedTitle(key, models)}
          hint="不管哪个角色在用这个模型，出错时都按顺序改用（优先于上面的按角色兜底）"
          note={null}
          draft={chains.get(key) ?? null}
          models={models}
          disabled={disabled}
          onEnsure={onEnsureChain}
          onDeleteChain={onDeleteChain}
          onChange={onChain}
        />
      ))}
    </div>
  );
}

function attachedTitle(key: string, models: ModelInfo[]): string {
  const kind = classifyChainKey(key);
  if (kind === "wildcard") return wildcardTitle(key);
  const base = selectorBase(key);
  const name = friendlyModelName(base, models);
  return `「${name ?? base}」的兜底`;
}

/** Agent 行：当前实际使用的模型 + 改用/停用/顾问。 */
function AgentRow(props: {
  agent: AgentDefinition;
  row: SelectorRow;
  effectiveModel: string;
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
      <div className="agent-main">
        <div className="agent-head">
          <span className="mono">{agent.name}</span>
          {agent.source === "user" ? <span className="badge badge-fork">自定义</span> : null}
          {disabledChecked ? <span className="badge badge-danger">已停用</span> : null}
        </div>
        <div className="muted">{agent.description}</div>
        <div className="agent-effective" data-testid={`agent-effective-${agent.name}`}>
          <span className="muted">当前使用：</span>
          <strong>{effectiveModel}</strong>
          {effectiveUnknown ? <span className="badge badge-grey">未知值 · 保留</span> : null}
          {effectiveThinking !== "" ? (
            <span className="muted"> · 思考强度 {effectiveThinking}</span>
          ) : null}
          <div className="muted">{effectiveSource}</div>
        </div>
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
            onChange={(selector) => {
              const nextLevels =
                selector !== null
                  ? (models.find((m) => m.selector === selector)?.thinkingLevels ?? [])
                  : [];
              const thinking =
                row.thinking !== "" && nextLevels.includes(row.thinking) ? row.thinking : "";
              onRow({ selector, thinking, touched: true });
            }}
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

type BlockKey = "roles" | "agents" | "others";

export function ModelsAgentsPanel(props: {
  onToast: (text: string, kind: "info" | "error") => void;
}) {
  const { onToast } = props;
  const [models, setModels] = useState<ModelInfo[] | null>(modelsCache);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [draft, setDraft] = useState<ModelDrafts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyBlock, setBusyBlock] = useState<BlockKey | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [blockErrors, setBlockErrors] = useState<Record<BlockKey, string | null>>({
    roles: null,
    agents: null,
    others: null,
  });
  const [newModelKey, setNewModelKey] = useState<string | null>(null);
  const [newCustomKey, setNewCustomKey] = useState("");
  const [newKeyError, setNewKeyError] = useState<string | null>(null);
  // StrictMode 双挂载下也必须复位为 true（见 useAlive），否则首屏加载被跳过。
  const alive = useAlive();

  const loadConfig = useCallback(async () => {
    try {
      const loaded = await getModelConfig();
      if (!alive.current) return true;
      setConfig(loaded);
      setDraft(draftFromConfig(loaded));
      setLoadError(null);
      setLoading(false);
      return true;
    } catch (e: unknown) {
      if (!alive.current) return false;
      setLoadError(errorText(normalizeError(e)));
      setLoading(false);
      return false;
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadModels = useCallback(async (force: boolean) => {
    if (!force && modelsCache !== null) return;
    setModelsError(null);
    try {
      const list = await listModels();
      if (!alive.current) return;
      modelsCache = list;
      setModels(list);
    } catch (e: unknown) {
      if (!alive.current) return;
      setModelsError(errorText(normalizeError(e)));
    }
  }, []);

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  async function saveBlock(block: BlockKey, pairs: SavePair[]) {
    if (busyBlock !== null || config === null || draft === null) return;
    setBusyBlock(block);
    setBlockErrors((prev) => ({ ...prev, [block]: null }));
    const saved: string[] = [];
    try {
      for (const pair of pairs) {
        if (deepEqual(pair.value, pair.expected)) continue;
        try {
          await updateModelConfig(pair);
        } catch (e: unknown) {
          const rest = pairs
            .slice(pairs.indexOf(pair))
            .map((p) => pairLabel(p.key))
            .join("、");
          throw { failed: e, message: rest };
        }
        saved.push(pairLabel(pair.key));
      }
      await loadConfig();
      onToast(saved.length > 0 ? `已保存（${saved.join("、")}）` : "没有变化", "info");
    } catch (e: unknown) {
      // 无论何种失败都重新载入：前面的 key 可能已写，不能拿着旧草稿假装没事。
      await loadConfig();
      const failure = e as { failed?: unknown; message?: string };
      const err = normalizeError(failure.failed ?? e);
      if (err.code === "CONFLICT") {
        setBlockErrors((prev) => ({ ...prev, [block]: CONFLICT_TEXT }));
      } else if (saved.length > 0) {
        setBlockErrors((prev) => ({
          ...prev,
          [block]: `「${saved.join("、")}」已保存，但「${failure.message ?? ""}」保存失败：${errorText(err)}（已重新载入最新配置，请检查后重试）`,
        }));
      } else {
        setBlockErrors((prev) => ({ ...prev, [block]: `保存失败：${errorText(err)}` }));
      }
    } finally {
      if (alive.current) setBusyBlock(null);
    }
  }

  if (loading && config === null) {
    return <div className="pane-note">正在读取模型配置…</div>;
  }
  if (config === null || draft === null) {
    return (
      <div className="manage-section">
        <div className="banner banner-error" role="alert">
          <div>{loadError ?? "读取模型配置失败"}</div>
          <button type="button" className="btn btn-small" onClick={() => void loadConfig()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const modelsList = models ?? [];
  const rolesValue = buildRecord(config.roles, draft.roles);
  const overridesValue = buildRecord(config.agentOverrides, draft.overrides);
  const disabledValue = buildDisabled(config, draft.disabled);
  const advisorValue = buildAdvisor(config.agentAdvisor, draft.advisor, draft.advisorTouched);
  const chainsValue = buildChains(config, draft.chains);
  const rolesDirty = !deepEqual(rolesValue, config.roles);
  const chainsDirty = !deepEqual(chainsValue, config.fallbackChains);
  const dirty: Record<BlockKey, boolean> = {
    roles: rolesDirty || chainsDirty,
    agents:
      !deepEqual(overridesValue, config.agentOverrides) ||
      !deepEqual(disabledValue, config.disabledAgents) ||
      !deepEqual(advisorValue, config.agentAdvisor),
    others: chainsDirty,
  };

  const setRow = (which: "roles" | "overrides", key: string, row: SelectorRow) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next: ModelDrafts = {
        ...prev,
        roles: new Map(prev.roles),
        overrides: new Map(prev.overrides),
      };
      (which === "roles" ? next.roles : next.overrides).set(key, row);
      return next;
    });
  };

  const updateChain = (key: string, patch: (chain: ChainDraft) => ChainDraft) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const chains = new Map(prev.chains);
      const current = chains.get(key);
      if (!current) return prev;
      chains.set(key, { ...patch({ ...current }), touched: true });
      return { ...prev, chains };
    });
  };

  const ensureChain = (key: string) => {
    setDraft((prev) => {
      if (!prev || prev.chains.has(key)) return prev;
      const chains = new Map(prev.chains);
      chains.set(key, { key, entries: [], touched: true });
      return { ...prev, chains };
    });
  };

  const deleteChain = (key: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const chains = new Map(prev.chains);
      chains.delete(key);
      return { ...prev, chains };
    });
  };

  const revert = (block: BlockKey) => {
    setDraft(draftFromConfig(config));
    setBlockErrors((prev) => ({ ...prev, [block]: null }));
  };

  /** 保存前校验全部兜底：空链与脏值点名报错，不发请求。 */
  const validateChains = (): string | null => {
    for (const chain of draft.chains.values()) {
      const label = chainLabel(chain.key);
      if (chain.entries.length === 0) {
        return `${label}还没有兜底模型：请添加，或删除这条兜底`;
      }
      const dirtyEntry = chain.entries.find((entry) => typeof entry !== "string");
      if (dirtyEntry !== undefined && chain.touched) {
        return `${label}里有 omp 不认识的值，请删除该条目或在 omp 侧手动修复后再保存`;
      }
    }
    return null;
  };

  const saveRoles = () => {
    const problem = validateChains();
    if (problem !== null) {
      setBlockErrors((prev) => ({ ...prev, roles: problem }));
      return;
    }
    void saveBlock("roles", [
      { key: CONFIG_KEYS.roles, value: rolesValue, expected: config.roles },
      { key: CONFIG_KEYS.chains, value: chainsValue, expected: config.fallbackChains },
    ]);
  };

  const saveAgents = () =>
    void saveBlock("agents", [
      {
        key: CONFIG_KEYS.overrides,
        value: overridesValue,
        expected: config.agentOverrides,
      },
      { key: CONFIG_KEYS.disabled, value: disabledValue, expected: config.disabledAgents },
      { key: CONFIG_KEYS.advisor, value: advisorValue, expected: config.agentAdvisor },
    ]);

  const saveOthers = () => {
    const problem = validateChains();
    if (problem !== null) {
      setBlockErrors((prev) => ({ ...prev, others: problem }));
      return;
    }
    void saveBlock("others", [
      {
        key: CONFIG_KEYS.chains,
        value: chainsValue,
        expected: config.fallbackChains,
      },
    ]);
  };

  const chainLabel = (key: string): string => {
    const kind = classifyChainKey(key);
    if (kind === "wildcard") return wildcardTitle(key);
    if (kind === "model") return attachedTitle(key, modelsList);
    return `「${roleInfo(key)?.name ?? key}」的兜底`;
  };

  // 「其他模型的兜底」= 没被任何角色卡收走的 chain：没吸附的按模型 key、
  // 未展示角色的按角色 key。顺序沿用配置原顺序。
  const attachedToCards = new Set<string>();
  for (const role of draft.shownRoles) {
    const primary = draft.roles.get(role)?.selector ?? null;
    for (const key of attachedChainKeys(primary, [...draft.chains.keys()])) {
      attachedToCards.add(key);
    }
  }
  const othersKeys = [...draft.chains.keys()].filter((key) => {
    const kind = classifyChainKey(key);
    if (kind !== "role") return !attachedToCards.has(key);
    return !draft.shownRoles.includes(key);
  });

  const addChain = (key: string) => {
    const trimmed = key.trim();
    if (trimmed === "") {
      setNewKeyError("先输入一个 key（如 p1/*），或从左侧选择一个模型");
      return;
    }
    if (draft.chains.has(trimmed)) {
      setNewKeyError(`${chainLabel(trimmed)}已存在，直接在上面改就行`);
      return;
    }
    ensureChain(trimmed);
    setNewModelKey(null);
    setNewCustomKey("");
    setNewKeyError(null);
    setOthersOpen(true);
  };

  const missingRoles = COMMON_ROLES.filter((role) => !draft.shownRoles.includes(role));
  const retry = describeRetryStatus(config.retryStatus);
  const retryEnabledText =
    retry.enabled === null ? "未知" : retry.enabled ? "开" : "关";

  const rolesSaveLabel =
    rolesDirty && chainsDirty ? "保存主模型与兜底" : chainsDirty ? "保存兜底" : "保存主模型";

  return (
    <div className="manage-section models-agents">
      <div className="ma-top">
        <p className="ma-intro">
          每个角色选一个主模型，再按顺序配几个兜底模型：主模型出错时按顺序切换。
        </p>
        <div className="muted ma-status">
          <span>
            模型列表：
            {models !== null
              ? `${models.length} 个模型`
              : modelsError !== null
                ? "加载失败"
                : "加载中…"}
          </span>
          <button
            type="button"
            className="btn btn-small"
            disabled={busyBlock !== null}
            onClick={() => void loadModels(true)}
          >
            刷新
          </button>
          <span>
            兜底：{retryEnabledText} · {retry.trigger} · {retry.revert}
          </span>
        </div>
      </div>
      {modelsError !== null ? (
        <div className="banner banner-warn">
          模型列表加载失败：{modelsError}（仍可查看与保存配置，但无法选择模型）
          <button type="button" className="btn btn-small" onClick={() => void loadModels(true)}>
            重试
          </button>
        </div>
      ) : null}
      {models === null && modelsError === null ? (
        <div className="muted">模型列表加载中（首次约 10 秒）…</div>
      ) : null}
      {retry.enabled === false ? (
        <div className="banner banner-warn" role="alert">
          兜底已关闭，下面的兜底配置不会生效。如需使用，请在 omp 的配置中重新打开总开关。
        </div>
      ) : null}

      <section className="block-section" aria-label="主要模型">
        <div className="block-head">
          <h3 className="manage-sub">主要模型</h3>
          <span className="muted">每个角色的主模型与兜底在同一张卡里改</span>
        </div>
        {blockErrors.roles !== null ? (
          <div className="banner banner-error" role="alert">
            {blockErrors.roles}
          </div>
        ) : null}
        {draft.shownRoles.map((role) => {
          const row = draft.roles.get(role) ?? { selector: null, thinking: "", touched: false };
          const primary = row.selector;
          const attached =
            primary !== null
              ? attachedChainKeys(primary, [...draft.chains.keys()]).filter((key) =>
                  draft.chains.has(key),
                )
              : [];
          const roleChain = draft.chains.get(role) ?? null;
          // 未配置、没兜底、没改过的卡可以移除（常见角色随时加回来）。
          const removable =
            row.selector === null && !row.touched && roleChain === null && role !== "default";
          return (
            <RoleCard
              key={role}
              role={role}
              row={row}
              roleChain={roleChain}
              attachedKeys={attached}
              chains={draft.chains}
              models={modelsList}
              disabled={busyBlock !== null}
              removable={removable}
              onRow={(next) => setRow("roles", role, next)}
              onEnsureChain={ensureChain}
              onDeleteChain={deleteChain}
              onChain={updateChain}
              onRemove={() =>
                setDraft((prev) => {
                  if (!prev) return prev;
                  const roles = new Map(prev.roles);
                  roles.delete(role);
                  return {
                    ...prev,
                    roles,
                    shownRoles: prev.shownRoles.filter((r) => r !== role),
                  };
                })
              }
            />
          );
        })}
        {missingRoles.length > 0 ? (
          <div className="add-roles">
            <span className="muted">添加角色：</span>
            {missingRoles.map((role) => (
              <button
                key={role}
                type="button"
                className="btn btn-small"
                disabled={busyBlock !== null}
                data-testid={`add-role-${role}`}
                onClick={() =>
                  setDraft((prev) => {
                    if (!prev || prev.roles.has(role)) return prev;
                    const roles = new Map(prev.roles);
                    roles.set(role, { selector: null, thinking: "", touched: false });
                    return { ...prev, roles, shownRoles: [...prev.shownRoles, role] };
                  })
                }
              >
                {roleInfo(role)?.name ?? role}
              </button>
            ))}
          </div>
        ) : null}
        <div className="block-actions">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busyBlock !== null || !dirty.roles}
            onClick={saveRoles}
          >
            {busyBlock === "roles" ? <span className="spinner" aria-hidden="true" /> : null}
            {rolesSaveLabel}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busyBlock !== null || !dirty.roles}
            onClick={() => revert("roles")}
          >
            还原
          </button>
          {dirty.roles ? <span className="muted">未保存的修改</span> : null}
        </div>
      </section>

      <section className="block-section" aria-label="Agent">
        <div className="block-head">
          <h3 className="manage-sub">Agent</h3>
          <span className="muted">每行先看「当前使用」，再决定改不改</span>
        </div>
        {blockErrors.agents !== null ? (
          <div className="banner banner-error" role="alert">
            {blockErrors.agents}
          </div>
        ) : null}
        {config.agents.length === 0 ? (
          <div className="pane-note">没有可配置的 Agent。</div>
        ) : null}
        {config.agents.map((agent) => {
          const row = draft.overrides.get(agent.name) ?? {
            selector: null,
            thinking: "",
            touched: false,
          };
          const effective = resolveAgentEffective(
            agent,
            config.agentOverrides[agent.name],
            config.roles,
            modelsList,
          );
          return (
            <AgentRow
              key={agent.name}
              agent={agent}
              row={row}
              effectiveModel={effective.modelText}
              effectiveUnknown={effective.modelUnknown}
              effectiveThinking={effective.thinking}
              effectiveSource={effective.sourceText}
              disabledChecked={draft.disabled.has(agent.name)}
              advisor={draft.advisor.get(agent.name) ?? "default"}
              models={modelsList}
              busy={busyBlock !== null}
              onRow={(next) => setRow("overrides", agent.name, next)}
                onDisabled={(checked) => {
                  setDraft((prev) => {
                    if (!prev) return prev;
                    const disabled = new Set(prev.disabled);
                    if (checked) disabled.add(agent.name);
                    else disabled.delete(agent.name);
                    return { ...prev, disabled };
                  });
                }}
                onAdvisor={(state) => {
                  setDraft((prev) => {
                    if (!prev) return prev;
                    const advisor = new Map(prev.advisor);
                    advisor.set(agent.name, state);
                    const advisorTouched = new Set(prev.advisorTouched);
                    advisorTouched.add(agent.name);
                    return { ...prev, advisor, advisorTouched };
                  });
              }}
            />
          );
        })}
        <div className="block-actions">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busyBlock !== null || !dirty.agents}
            onClick={saveAgents}
          >
            {busyBlock === "agents" ? <span className="spinner" aria-hidden="true" /> : null}
            保存
          </button>
          <button
            type="button"
            className="btn"
            disabled={busyBlock !== null || !dirty.agents}
            onClick={() => revert("agents")}
          >
            还原
          </button>
          {dirty.agents ? <span className="muted">未保存的修改</span> : null}
        </div>
      </section>

      <section className="block-section" aria-label="其他模型的兜底">
        <div className="block-head">
          <h3 className="manage-sub">其他模型的兜底</h3>
          <span className="muted">当前没有角色在用的模型的兜底（正在用的在上面的角色卡里）</span>
        </div>
        {blockErrors.others !== null ? (
          <div className="banner banner-error" role="alert">
            {blockErrors.others}
          </div>
        ) : null}
        <details className="others-details" open={othersOpen} data-testid="others-details">
          <summary
            onClick={(e) => {
              e.preventDefault();
              setOthersOpen(!othersOpen);
            }}
          >
            {othersKeys.length === 0
              ? "暂无其他兜底（点击展开，可新增）"
              : `共 ${othersKeys.length} 条（点击${othersOpen ? "收起" : "展开"}）`}
            {dirty.others ? <span className="muted"> · 未保存的修改</span> : null}
          </summary>
          <p className="muted">
            这些兜底按模型生效：不管哪个角色在用这个模型，出错时都会按顺序切换。
          </p>
          {othersKeys.length === 0 ? (
            <div className="pane-note">没有其他兜底：所有按模型的兜底都已显示在上面的角色卡里。</div>
          ) : null}
          {othersKeys.map((key) => {
            const kind = classifyChainKey(key);
            const title =
              kind === "role" ? `「${roleInfo(key)?.name ?? key}」的兜底` : chainLabel(key);
            const note =
              kind === "role"
                ? "没有同名的模型角色，omp 可能不会使用这条配置（原样保留，可删除）"
                : null;
            const hint =
              kind === "role"
                ? "该角色的主模型出错时，按顺序改用"
                : "不管哪个角色在用这个模型，出错时都按顺序改用";
            return (
              <ChainEditor
                key={key}
                chainKey={key}
                title={title}
                hint={hint}
                note={note}
                draft={draft.chains.get(key) ?? null}
                models={modelsList}
                disabled={busyBlock !== null}
                onEnsure={ensureChain}
                onDeleteChain={deleteChain}
                onChange={updateChain}
              />
            );
          })}
          <div className="chain-add">
            <ModelPicker
              models={modelsList}
              value={newModelKey}
              allowUnset={false}
              unsetLabel="选择模型…"
              disabled={busyBlock !== null}
              label="为新兜底选择模型"
              onChange={setNewModelKey}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={busyBlock !== null || newModelKey === null}
              onClick={() => newModelKey !== null && addChain(newModelKey)}
            >
              添加该模型的兜底
            </button>
          </div>
          <div className="chain-add">
            <input
              className="filter-input"
              placeholder="或其他 key，如 p1/*、my-role"
              aria-label="新兜底的其他 key"
              value={newCustomKey}
              disabled={busyBlock !== null}
              onChange={(e) => {
                setNewCustomKey(e.target.value);
                setNewKeyError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") addChain(newCustomKey);
              }}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={busyBlock !== null}
              onClick={() => addChain(newCustomKey)}
            >
              添加
            </button>
          </div>
          {newKeyError !== null ? (
            <div className="muted" role="alert">
              {newKeyError}
            </div>
          ) : null}
        </details>
        <div className="block-actions">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busyBlock !== null || !dirty.others}
            onClick={saveOthers}
          >
            {busyBlock === "others" ? <span className="spinner" aria-hidden="true" /> : null}
            保存兜底
          </button>
          <button
            type="button"
            className="btn"
            disabled={busyBlock !== null || !dirty.others}
            onClick={() => revert("others")}
          >
            还原
          </button>
          {dirty.others ? <span className="muted">未保存的修改</span> : null}
        </div>
      </section>

      <div className="pane-note">新开的 omp 会话使用新配置；已运行的会话可能需重启后生效。</div>
    </div>
  );
}
