/**
 * 「模型与 Agent」面板：模型角色 / Agent 表 / 回退链三块，
 * 每块独立「保存 / 还原」，保存走白名单 update_model_config（读-比-写）。
 * 语义见 docs/CONTRACT.md §4.36–§4.38。
 *
 * 未知值保留原则：当前值不在模型列表（别名 `@smol`、已下线模型）原样显示；
 * 未被用户触碰的键与值（含不认识的角色 / agent / 回退链键）一律原样写回。
 */
import { useCallback, useEffect, useState } from "react";
import "./ModelsAgentsPanel.css";
import { getModelConfig, listModels, normalizeError, updateModelConfig } from "../api";
import { errorText } from "../format";
import {
  composeSelectorValue,
  deepEqual,
  parseSelectorValue,
  rawValueText,
} from "../modelConfig";
import type { ModelConfig, ModelInfo } from "../types";
import { ModelPicker } from "./ModelPicker";
import { useAlive } from "./useOmpOp";

/** 常见角色：已有角色之外补充展示的固定集合（default 永远排最前）。 */
const COMMON_ROLES = [
  "default",
  "task",
  "plan",
  "judge",
  "commit",
  "advisor",
  "slow",
  "smol",
  "tiny",
  "memory",
];

const CONFIG_KEYS = {
  roles: "modelRoles",
  overrides: "task.agentModelOverrides",
  disabled: "task.disabledAgents",
  advisor: "task.agentAdvisor",
  chains: "retry.fallbackChains",
} as const;

const CONFLICT_TEXT = "配置已被外部修改，请刷新（下方已重新载入最新配置）";

/** 进程内模型缓存：`omp models --json` 较慢（实测约 10 秒），刷新按钮才重跑。 */
let modelsCache: ModelInfo[] | null = null;

interface SelectorRow {
  /** null = 未设置 / 不覆盖（保存时删除该条目）。 */
  selector: string | null;
  /** 空字符串 = 默认（不带 `:thinking` 后缀）。 */
  thinking: string;
  touched: boolean;
}

type AdvisorState = "default" | "on" | "off";

interface ChainDraft {
  key: string;
  /** 原始条目（非字符串值原样保留），编辑只增/删/移。 */
  entries: unknown[];
  touched: boolean;
  input: string;
}

interface Drafts {
  roles: Map<string, SelectorRow>;
  overrides: Map<string, SelectorRow>;
  disabled: Set<string>;
  advisor: Map<string, AdvisorState>;
  advisorTouched: Set<string>;
  chains: ChainDraft[];
}

function rowFrom(raw: unknown): SelectorRow {
  const parsed = parseSelectorValue(rawValueText(raw));
  return { selector: parsed.selector, thinking: parsed.thinking, touched: false };
}

function draftFromConfig(config: ModelConfig): Drafts {
  const roles = new Map<string, SelectorRow>();
  const roleOrder = [
    ...COMMON_ROLES,
    ...Object.keys(config.roles).filter((role) => !COMMON_ROLES.includes(role)),
  ];
  for (const role of roleOrder) {
    const raw = config.roles[role];
    roles.set(
      role,
      raw === undefined
        ? { selector: null, thinking: "", touched: false }
        : rowFrom(raw),
    );
  }
  const overrides = new Map<string, SelectorRow>();
  for (const agent of config.agents) {
    const raw = config.agentOverrides[agent.name];
    overrides.set(
      agent.name,
      raw === undefined
        ? { selector: null, thinking: "", touched: false }
        : rowFrom(raw),
    );
  }
  const disabled = new Set<string>();
  for (const agent of config.agents) {
    if (config.disabledAgents.some((name) => rawValueText(name) === agent.name)) {
      disabled.add(agent.name);
    }
  }
  const advisor = new Map<string, AdvisorState>();
  for (const agent of config.agents) {
    const raw = config.agentAdvisor[agent.name];
    advisor.set(agent.name, raw === "on" ? "on" : raw === "off" ? "off" : "default");
  }
  const chains: ChainDraft[] = Object.entries(config.fallbackChains).map(
    ([key, entries]) => ({
      key,
      entries: Array.isArray(entries) ? [...entries] : [entries],
      touched: false,
      input: "",
    }),
  );
  return {
    roles,
    overrides,
    disabled,
    advisor,
    advisorTouched: new Set(),
    chains,
  };
}

/** record 整体读-改-写：未触碰的键/值原样保留，触碰的键按行状态写回或删除。 */
function buildRecord(
  base: Record<string, unknown>,
  rows: Map<string, SelectorRow>,
): Record<string, unknown> {
  const value: Record<string, unknown> = { ...base };
  for (const [key, row] of rows) {
    if (!row.touched) continue;
    if (row.selector === null) delete value[key];
    else {
      value[key] = composeSelectorValue({ selector: row.selector, thinking: row.thinking });
    }
  }
  return value;
}

function buildDisabled(config: ModelConfig, disabled: Set<string>): unknown[] {
  const known = new Set(config.agents.map((agent) => agent.name));
  // 保持原数组顺序：原成员按现状保留，新禁用的 agent 追加在后。
  const value = config.disabledAgents.filter((name) => {
    const text = rawValueText(name);
    return !known.has(text) || disabled.has(text);
  });
  for (const agent of config.agents) {
    if (
      disabled.has(agent.name) &&
      !value.some((name) => rawValueText(name) === agent.name)
    ) {
      value.push(agent.name);
    }
  }
  return value;
}

function buildAdvisor(
  base: Record<string, unknown>,
  advisor: Map<string, AdvisorState>,
  touched: Set<string>,
): Record<string, unknown> {
  const value: Record<string, unknown> = { ...base };
  for (const [key, state] of advisor) {
    if (!touched.has(key)) continue;
    if (state === "default") delete value[key];
    else value[key] = state;
  }
  return value;
}

function buildChains(config: ModelConfig, chains: ChainDraft[]): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const chain of chains) {
    value[chain.key] = chain.touched ? chain.entries : config.fallbackChains[chain.key];
  }
  return value;
}

type BlockKey = "roles" | "agents" | "chains";

interface SavePair {
  key: string;
  value: unknown;
  expected: unknown;
}

/** 模型 + thinking 两个控件共用的行编辑单元。 */
function SelectorCell(props: {
  models: ModelInfo[];
  row: SelectorRow;
  unsetLabel: string;
  label: string;
  disabled: boolean;
  onChange: (row: SelectorRow) => void;
}) {
  const { models, row, unsetLabel, label, disabled, onChange } = props;
  const levels = row.selector
    ? models.find((m) => m.selector === row.selector)?.thinkingLevels ?? []
    : [];
  const options = row.thinking && !levels.includes(row.thinking) ? [...levels, row.thinking] : levels;
  return (
    <div className="selector-cell">
      <ModelPicker
        models={models}
        value={row.selector}
        allowUnset
        unsetLabel={unsetLabel}
        disabled={disabled}
        label={label}
        onChange={(selector) => {
          const levels = selector
            ? models.find((m) => m.selector === selector)?.thinkingLevels ?? []
            : [];
          const thinking =
            row.thinking && levels.includes(row.thinking) ? row.thinking : "";
          onChange({ selector, thinking, touched: true });
        }}
      />
      <select
        className="thinking-select"
        aria-label={`${label} thinking 档位`}
        disabled={disabled || row.selector === null}
        value={row.thinking}
        onChange={(e) => onChange({ ...row, thinking: e.target.value, touched: true })}
      >
        <option value="">默认</option>
        {options.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ModelsAgentsPanel(props: {
  onToast: (text: string, kind: "info" | "error") => void;
}) {
  const { onToast } = props;
  const [models, setModels] = useState<ModelInfo[] | null>(modelsCache);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [draft, setDraft] = useState<Drafts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyBlock, setBusyBlock] = useState<BlockKey | null>(null);
  const [blockErrors, setBlockErrors] = useState<Record<BlockKey, string | null>>({
    roles: null,
    agents: null,
    chains: null,
  });
  const [newChainKey, setNewChainKey] = useState("");
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
    try {
      for (const pair of pairs) {
        if (deepEqual(pair.value, pair.expected)) continue;
        await updateModelConfig(pair);
      }
      await loadConfig();
      onToast("已保存", "info");
    } catch (e: unknown) {
      const err = normalizeError(e);
      if (err.code === "CONFLICT") {
        setBlockErrors((prev) => ({ ...prev, [block]: CONFLICT_TEXT }));
        await loadConfig();
      } else {
        setBlockErrors((prev) => ({ ...prev, [block]: errorText(err) }));
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
  const dirty: Record<BlockKey, boolean> = {
    roles: !deepEqual(rolesValue, config.roles),
    agents:
      !deepEqual(overridesValue, config.agentOverrides) ||
      !deepEqual(disabledValue, config.disabledAgents) ||
      !deepEqual(advisorValue, config.agentAdvisor),
    chains: !deepEqual(chainsValue, config.fallbackChains),
  };

  const setRow = (
    which: "roles" | "overrides",
    key: string,
    row: SelectorRow,
  ) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next: Drafts = {
        ...prev,
        roles: new Map(prev.roles),
        overrides: new Map(prev.overrides),
      };
      (which === "roles" ? next.roles : next.overrides).set(key, row);
      return next;
    });
  };

  const revert = (block: BlockKey) => {
    setDraft(draftFromConfig(config));
    setBlockErrors((prev) => ({ ...prev, [block]: null }));
  };

  const saveRoles = () =>
    void saveBlock("roles", [
      { key: CONFIG_KEYS.roles, value: rolesValue, expected: config.roles },
    ]);

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

  const saveChains = () => {
    const empty = draft.chains.find((chain) => chain.entries.length === 0);
    if (empty) {
      setBlockErrors((prev) => ({
        ...prev,
        chains: `回退链「${empty.key}」还没有模型：请添加或删除该链`,
      }));
      return;
    }
    void saveBlock("chains", [
      {
        key: CONFIG_KEYS.chains,
        value: chainsValue,
        expected: config.fallbackChains,
      },
    ]);
  };

  const updateChain = (key: string, patch: (chain: ChainDraft) => ChainDraft) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        chains: prev.chains.map((chain) =>
          chain.key === key ? patch({ ...chain, touched: true }) : chain,
        ),
      };
    });
  };

  const moveEntry = (key: string, index: number, delta: number) => {
    updateChain(key, (chain) => {
      const entries = [...chain.entries];
      const target = index + delta;
      [entries[index], entries[target]] = [entries[target], entries[index]];
      return { ...chain, entries };
    });
  };

  const chainKeyOptions: { group: string; key: string }[] = [
    ...Object.keys(config.roles).map((key) => ({ group: "角色", key })),
    ...modelsList.map((m) => ({ group: "模型", key: m.selector })),
  ].filter((option) => !draft.chains.some((chain) => chain.key === option.key));

  return (
    <div className="manage-section models-agents">
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

      <section className="block-section" aria-label="模型角色">
        <div className="block-head">
          <h3 className="manage-sub">模型角色</h3>
          <span className="muted">角色 → 模型（provider/model[:thinking]）</span>
          <button
            type="button"
            className="btn btn-small"
            disabled={busyBlock !== null}
            onClick={() => void loadModels(true)}
          >
            刷新模型列表
          </button>
        </div>
        {blockErrors.roles !== null ? (
          <div className="banner banner-error" role="alert">
            {blockErrors.roles}
          </div>
        ) : null}
        <table className="manage-table">
          <thead>
            <tr>
              <th>角色</th>
              <th>模型</th>
              <th>thinking</th>
            </tr>
          </thead>
          <tbody>
            {[...draft.roles.entries()].map(([role, row]) => (
              <tr key={role} data-testid={`role-row-${role}`}>
                <td>
                  <span className="mono">{role}</span>
                  {role === "default" ? (
                    <span className="badge badge-accent">默认</span>
                  ) : null}
                </td>
                <td>
                  <SelectorCell
                    models={modelsList}
                    row={row}
                    unsetLabel="未设置"
                    label={`${role} 的模型`}
                    disabled={busyBlock !== null}
                    onChange={(next) => setRow("roles", role, next)}
                  />
                </td>
                <td className="muted">{row.touched ? "已修改" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="block-actions">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busyBlock !== null || !dirty.roles}
            onClick={saveRoles}
          >
            {busyBlock === "roles" ? <span className="spinner" aria-hidden="true" /> : null}
            保存
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

      <section className="block-section" aria-label="Agent 配置">
        <div className="block-head">
          <h3 className="manage-sub">Agent</h3>
          <span className="muted">内置默认只读；覆盖 / 禁用 / advisor 保存后生效</span>
        </div>
        {blockErrors.agents !== null ? (
          <div className="banner banner-error" role="alert">
            {blockErrors.agents}
          </div>
        ) : null}
        <table className="manage-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>内置默认</th>
              <th>模型覆盖</th>
              <th>禁用</th>
              <th>advisor</th>
            </tr>
          </thead>
          <tbody>
            {config.agents.map((agent) => {
              const row = draft.overrides.get(agent.name) ?? {
                selector: null,
                thinking: "",
                touched: false,
              };
              return (
                <tr key={agent.name} data-testid={`agent-row-${agent.name}`}>
                  <td>
                    <span className="mono">{agent.name}</span>
                    {agent.source === "user" ? (
                      <span className="badge badge-fork">自定义</span>
                    ) : null}
                    <div className="muted agent-desc">{agent.description}</div>
                  </td>
                  <td className="muted mono">
                    {agent.defaultModel.length > 0
                      ? agent.defaultModel.join("、")
                      : "—"}
                    <span className="agent-thinking">
                      {agent.defaultThinkingLevel ?? "默认"}
                    </span>
                  </td>
                  <td>
                    <SelectorCell
                      models={modelsList}
                      row={row}
                      unsetLabel="不覆盖"
                      label={`${agent.name} 的模型覆盖`}
                      disabled={busyBlock !== null}
                      onChange={(next) => setRow("overrides", agent.name, next)}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`禁用 ${agent.name}`}
                      disabled={busyBlock !== null}
                      checked={draft.disabled.has(agent.name)}
                      onChange={(e) => {
                        setDraft((prev) => {
                          if (!prev) return prev;
                          const disabled = new Set(prev.disabled);
                          if (e.target.checked) disabled.add(agent.name);
                          else disabled.delete(agent.name);
                          return { ...prev, disabled };
                        });
                      }}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`${agent.name} 的 advisor`}
                      disabled={busyBlock !== null}
                      value={draft.advisor.get(agent.name) ?? "default"}
                      onChange={(e) => {
                        const state = e.target.value as AdvisorState;
                        setDraft((prev) => {
                          if (!prev) return prev;
                          const advisor = new Map(prev.advisor);
                          advisor.set(agent.name, state);
                          const advisorTouched = new Set(prev.advisorTouched);
                          advisorTouched.add(agent.name);
                          return { ...prev, advisor, advisorTouched };
                        });
                      }}
                    >
                      <option value="default">默认</option>
                      <option value="on">on</option>
                      <option value="off">off</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

      <section className="block-section" aria-label="回退链">
        <div className="block-head">
          <h3 className="manage-sub">回退链</h3>
          <span className="muted">key（角色或模型）→ 有序的备用 selector 列表</span>
        </div>
        {blockErrors.chains !== null ? (
          <div className="banner banner-error" role="alert">
            {blockErrors.chains}
          </div>
        ) : null}
        {draft.chains.length === 0 ? (
          <div className="pane-note">尚未配置回退链</div>
        ) : null}
        {draft.chains.map((chain) => (
          <div key={chain.key} className="chain-row" data-testid={`chain-${chain.key}`}>
            <div className="chain-key">
              <span className="mono">{chain.key}</span>
              <button
                type="button"
                className="btn btn-small btn-danger"
                disabled={busyBlock !== null}
                onClick={() =>
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          chains: prev.chains.filter((c) => c.key !== chain.key),
                        }
                      : prev,
                  )
                }
              >
                删除该链
              </button>
            </div>
            <ol className="chain-entries">
              {chain.entries.map((entry, index) => (
                <li key={`${index}-${rawValueText(entry)}`}>
                  <span className="mono">{rawValueText(entry)}</span>
                  <span className="chain-entry-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busyBlock !== null || index === 0}
                      aria-label={`上移 ${rawValueText(entry)}`}
                      onClick={() => moveEntry(chain.key, index, -1)}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busyBlock !== null || index === chain.entries.length - 1}
                      aria-label={`下移 ${rawValueText(entry)}`}
                      onClick={() => moveEntry(chain.key, index, 1)}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={busyBlock !== null}
                      aria-label={`删除 ${rawValueText(entry)}`}
                      onClick={() =>
                        updateChain(chain.key, (c) => ({
                          ...c,
                          entries: c.entries.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      删除
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="chain-add">
              <input
                className="filter-input"
                placeholder="provider/model[:thinking]"
                aria-label={`添加 ${chain.key} 的备用模型`}
                value={chain.input}
                disabled={busyBlock !== null}
                list="chain-model-options"
                onChange={(e) =>
                  updateChain(chain.key, (c) => ({ ...c, touched: false, input: e.target.value }))
                }
              />
              <button
                type="button"
                className="btn btn-small"
                disabled={busyBlock !== null || chain.input.trim() === ""}
                onClick={() =>
                  updateChain(chain.key, (c) => ({
                    ...c,
                    entries: [...c.entries, c.input.trim()],
                    input: "",
                  }))
                }
              >
                添加
              </button>
            </div>
          </div>
        ))}
        <datalist id="chain-model-options">
          {modelsList.map((m) => (
            <option key={m.selector} value={m.selector} />
          ))}
        </datalist>
        <div className="chain-add">
          <select
            aria-label="新回退链的 key"
            value={newChainKey}
            disabled={busyBlock !== null}
            onChange={(e) => setNewChainKey(e.target.value)}
          >
            <option value="">选择 key（角色或模型）…</option>
            {["角色", "模型"].map((group) => (
              <optgroup key={group} label={group}>
                {chainKeyOptions
                  .filter((option) => option.group === group)
                  .map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.key}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-small"
            disabled={busyBlock !== null || newChainKey === ""}
            onClick={() => {
              setDraft((prev) =>
                prev
                  ? {
                      ...prev,
                      chains: [
                        ...prev.chains,
                        { key: newChainKey, entries: [], touched: true, input: "" },
                      ],
                    }
                  : prev,
              );
              setNewChainKey("");
            }}
          >
            新增一条链
          </button>
        </div>
        <div className="block-actions">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busyBlock !== null || !dirty.chains}
            onClick={saveChains}
          >
            {busyBlock === "chains" ? <span className="spinner" aria-hidden="true" /> : null}
            保存
          </button>
          <button
            type="button"
            className="btn"
            disabled={busyBlock !== null || !dirty.chains}
            onClick={() => revert("chains")}
          >
            还原
          </button>
          {dirty.chains ? <span className="muted">未保存的修改</span> : null}
        </div>
      </section>

      <div className="pane-note">
        新开的 omp 会话使用新配置；已运行的会话可能需重启后生效。
      </div>
    </div>
  );
}
