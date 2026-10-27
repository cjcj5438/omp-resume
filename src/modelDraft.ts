/**
 * 「模型」/「Agent」两页的状态核心：useModelDraft hook + 纯派生 helpers。
 * 渲染层是 ModelsSection / AgentsSection（流程图 AgentFlow、状态条
 * ModelDraftStatus）；组件测试在 ModelSections.test.tsx / AgentsTab.test.tsx。
 * 未知值保留、读-比-写保存语义见 docs/CONTRACT.md §4.36–§4.38。
 *
 * `revert(block)` 只还原该区块的草稿（见 revertBlock）；只读展示走
 * configFromDraft 的草稿视角，未触碰的键与值原样保留。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getModelConfig, getModelSpecs, listModels, normalizeError, updateModelConfig } from "./api";
import { useAlive, type ToastFn } from "./components/useOmpOp";
import { errorText } from "./format";
import { deepEqual, rawValueText } from "./modelConfig";
import { emitModelConfigChanged, onModelConfigChanged } from "./modelPresets";
import type { ModelConfig, ModelInfo } from "./types";
import {
  SAVE_KEY_LABELS,
  attachedChainKeys,
  buildAdvisor,
  buildChains,
  buildDisabled,
  buildRecord,
  classifyChainKey,
  describeRetryStatus,
  draftFromConfig,
  friendlyModelName,
  roleInfo,
  selectorBase,
  wildcardTitle,
  type ChainDraft,
  type ModelDrafts,
  type RetryStatusText,
  type SelectorRow,
} from "./roleCards";

const CONFIG_KEYS = {
  roles: "modelRoles",
  overrides: "task.agentModelOverrides",
  disabled: "task.disabledAgents",
  advisor: "task.agentAdvisor",
  chains: "retry.fallbackChains",
} as const;

const CONFLICT_TEXT = "配置已被外部修改，请刷新（下方已重新载入最新配置）（草稿已保留）";

/**
 * 进程内模型缓存：`omp models --json` 较慢，不能每次挂载都重跑。
 * `source` 是读取时 models.yml 的 revision（字节 SHA256）：文件被外部改动
 * （手动加模型/provider）后 revision 不同，下次校验即重载；刷新按钮仍强制重载。
 */
let modelsCache: { list: ModelInfo[]; source: string | null } | null = null;

/** models.yml 当前 revision；读不到返回 null（此时沿用缓存，不因探测失败打断列表）。 */
async function modelsSource(): Promise<string | null> {
  try {
    return (await getModelSpecs()).revision;
  } catch {
    return null;
  }
}

export interface SavePair {
  key: string;
  value: unknown;
  expected: unknown;
}

function pairLabel(key: string): string {
  return SAVE_KEY_LABELS[key] ?? key;
}

export function attachedTitle(key: string, models: ModelInfo[]): string {
  const kind = classifyChainKey(key);
  if (kind === "wildcard") return wildcardTitle(key);
  const base = selectorBase(key);
  const name = friendlyModelName(base, models);
  return `「${name ?? base}」的兜底`;
}

/**
 * 草稿视角的配置：只读展示（「当前使用」/指挥者/兜底吸附）按草稿重算，
 * 未触碰的键与值原样保留。保存载荷仍由各 save 函数按 block 组装，这里只读。
 */
export function configFromDraft(config: ModelConfig, draft: ModelDrafts): ModelConfig {
  return {
    ...config,
    roles: buildRecord(config.roles, draft.roles),
    agentOverrides: buildRecord(config.agentOverrides, draft.overrides),
    disabledAgents: buildDisabled(config, draft.disabled),
    agentAdvisor: buildAdvisor(config.agentAdvisor, draft.advisor, draft.advisorTouched),
    fallbackChains: buildChains(config, draft.chains),
  };
}

/**
 * 「其他模型的兜底」的 key 集合：没被任何展示中角色卡收走的 chain——
 * 没吸附的按模型/通配 key、未展示角色的按角色 key。`revertBlock('others')`
 * 与 hook 内派生共用，保证还原与展示对「谁是 others」永远一致。
 * `roles` 取展示中角色的 selector（角色自己的 key 也属于角色块）。
 */
export function othersKeysOf(chainKeys: string[], roles: Map<string, SelectorRow>): string[] {
  const attachedToCards = new Set<string>();
  for (const { selector: primary } of roles.values()) {
    for (const key of attachedChainKeys(primary, chainKeys)) attachedToCards.add(key);
  }
  return chainKeys.filter((key) => {
    if (roles.has(key)) return false;
    if (classifyChainKey(key) === "role") return true;
    return !attachedToCards.has(key);
  });
}

/**
 * 还原单个区块的草稿（纯函数）：只恢复该区块的编辑，其他区块草稿原样保留。
 * - roles：角色行（含展示顺序）+ 全部 chain 草稿（保存时两者一起写）；
 * - agents：覆盖 + 停用 + 顾问；
 * - others：union(当前 others 列表, 配置里应归 others 的 key)——删掉的 chain
 *   还原即恢复，新增的 key 还原即删除；角色卡/展示顺序不动。
 */
export type DirtyState = Record<BlockKey, boolean>;

/** 草稿组装后的写入值（保存载荷与 dirty 比较共用，避免重复 build）。 */
export interface DraftWriteValues {
  roles: Record<string, unknown>;
  overrides: Record<string, unknown>;
  disabled: unknown[];
  advisor: Record<string, unknown>;
  chains: Record<string, unknown>;
}

export function draftWriteValues(config: ModelConfig, draft: ModelDrafts): DraftWriteValues {
  return {
    roles: buildRecord(config.roles, draft.roles),
    overrides: buildRecord(config.agentOverrides, draft.overrides),
    disabled: buildDisabled(config, draft.disabled),
    advisor: buildAdvisor(config.agentAdvisor, draft.advisor, draft.advisorTouched),
    chains: buildChains(config, draft.chains),
  };
}

/**
 * 各区块脏标记（保存条显隐用，与 hook 共用）。roles 与 others 都观察
 * fallbackChains：角色卡里改兜底、others 块会联动变脏——两处保存按钮
 * 写的是同一个 `retry.fallbackChains`（见 CONTRACT §4.36）。
 */
export function deriveDirty(
  config: ModelConfig,
  draft: ModelDrafts,
  values: DraftWriteValues = draftWriteValues(config, draft),
): DirtyState {
  const rolesDirty = !deepEqual(values.roles, config.roles);
  const overridesDirty = !deepEqual(values.overrides, config.agentOverrides);
  const disabledDirty = !deepEqual(values.disabled, config.disabledAgents);
  const advisorDirty = !deepEqual(values.advisor, config.agentAdvisor);
  const chainsDirty = !deepEqual(values.chains, config.fallbackChains);
  return {
    roles: rolesDirty || chainsDirty,
    agents: overridesDirty || disabledDirty || advisorDirty,
    others: chainsDirty,
  };
}

/** 未保存修改计数（保存条用，与 hook 共用）。 */
export interface DraftChangeCounts {
  roles: number;
  agents: number;
  chains: number;
}

export function deriveChangeCounts(config: ModelConfig, draft: ModelDrafts): DraftChangeCounts {
  const baseChainKeys = new Set(Object.keys(config.fallbackChains));
  const chains =
    [...draft.chains.values()].filter((c) => c.touched || !baseChainKeys.has(c.key)).length +
    [...baseChainKeys].filter((key) => !draft.chains.has(key)).length;
  const roles = [...draft.roles.values()].filter((r) => r.touched).length + chains;
  const knownAgents = new Set(config.agents.map((a) => a.name));
  const configDisabledKnown = new Set(
    config.disabledAgents.map((n) => rawValueText(n)).filter((n) => knownAgents.has(n)),
  );
  const agents =
    [...draft.overrides.values()].filter((r) => r.touched).length +
    draft.advisorTouched.size +
    [...draft.disabled].filter((a) => !configDisabledKnown.has(a)).length +
    [...configDisabledKnown].filter((a) => !draft.disabled.has(a)).length;
  return { roles, agents, chains };
}

export function revertBlock(
  config: ModelConfig,
  draft: ModelDrafts,
  block: BlockKey,
  othersKeys: string[],
): ModelDrafts {
  const fresh = draftFromConfig(config);
  if (block === "agents") {
    return {
      ...draft,
      overrides: fresh.overrides,
      disabled: fresh.disabled,
      advisor: fresh.advisor,
      advisorTouched: fresh.advisorTouched,
    };
  }
  if (block === "others") {
    const keys = new Set([...othersKeys, ...othersKeysOf(Object.keys(config.fallbackChains), draft.roles)]);
    const chains = new Map(draft.chains);
    for (const key of keys) {
      const base = fresh.chains.get(key);
      if (base === undefined) chains.delete(key);
      else chains.set(key, { key, entries: [...base.entries], touched: false });
    }
    return { ...draft, chains };
  }
  return { ...draft, roles: fresh.roles, shownRoles: fresh.shownRoles, chains: fresh.chains };
}

export type BlockKey = "roles" | "agents" | "others";
/** 两个渲染 section 共用的完整草稿状态（ready 后非空，由 useModelDraft 提供）。 */
export interface ModelDraftState {
  models: ModelInfo[] | null;
  modelsList: ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  loadModels: (force: boolean) => Promise<void>;
  config: ModelConfig;
  draft: ModelDrafts;
  loadConfig: () => Promise<boolean>;
  busyBlock: BlockKey | null;
  blockErrors: Record<BlockKey, string | null>;
  dirty: Record<BlockKey, boolean>;
  saveBlock: (block: BlockKey, pairs: SavePair[]) => Promise<void>;
  saveRoles: () => void;
  saveAgents: () => void;
  saveOthers: () => void;
  /** 只还原该区块的草稿，其他区块不动；同时清掉该区块的错误条。 */
  revert: (block: BlockKey) => void;
  setRow: (which: "roles" | "overrides", key: string, row: SelectorRow) => void;
  setDraft: Dispatch<SetStateAction<ModelDrafts | null>>;
  expandRole: (role: string) => void;
  collapseRole: (role: string) => void;
  ensureChain: (key: string) => void;
  deleteChain: (key: string) => void;
  updateChain: (key: string, patch: (chain: ChainDraft) => ChainDraft) => void;
  validateChains: () => string | null;
  chainLabel: (key: string) => string;
  othersKeys: string[];
  rolesChangeCount: number;
  agentsChangeCount: number;
  chainsChangeCount: number;
  retry: RetryStatusText;
  retryEnabledText: string;
  rolesSaveLabel: string;
  roleCardVisible: (role: string) => boolean;
  orchestratorText: string;
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  othersOpen: boolean;
  setOthersOpen: Dispatch<SetStateAction<boolean>>;
  newModelKey: string | null;
  setNewModelKey: Dispatch<SetStateAction<string | null>>;
  newCustomKey: string;
  setNewCustomKey: Dispatch<SetStateAction<string>>;
  newKeyError: string | null;
  setNewKeyError: Dispatch<SetStateAction<string | null>>;
  addChain: (key: string) => void;
}

export type ModelDraftLoad =
  | { status: "loading" }
  | { status: "error"; loadError: string | null; loadConfig: () => Promise<boolean> }
  | { status: "ready"; state: ModelDraftState };

export function useModelDraft(onToast: ToastFn): ModelDraftLoad {
  const [models, setModels] = useState<ModelInfo[] | null>(modelsCache?.list ?? null);
  const [modelsLoading, setModelsLoading] = useState(modelsCache === null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [draft, setDraft] = useState<ModelDrafts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyBlock, setBusyBlock] = useState<BlockKey | null>(null);
  // 双击竞态守卫：state 更新异步，两次同步调用会读到同一个 stale busyBlock；
  // ref 同步占位，渲染仍看 busyBlock。
  const busyRef = useRef<BlockKey | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
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

  /** 只重读基线、保留草稿：saveBlock 部分失败后用（草稿不清、touched 按 saved 逐 key 清）。 */
  const reloadBaseline = useCallback(async (): Promise<boolean> => {
    try {
      const loaded = await getModelConfig();
      if (!alive.current) return false;
      setConfig(loaded);
      setLoadError(null);
      return true;
    } catch (e: unknown) {
      if (alive.current) setLoadError(errorText(normalizeError(e)));
      return false;
    }
  }, [alive]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // 模式切换会整体改写 modelRoles / agentModelOverrides / thinking：有草稿时只换基线
  // （草稿保留，用户改动不丢），无草稿时整页重载。
  const dirtyRef = useRef(false);
  dirtyRef.current =
    config !== null &&
    draft !== null &&
    Object.values(deriveDirty(config, draft)).some(Boolean);

  useEffect(
    () =>
      onModelConfigChanged((origin) => {
        if (origin === "presets") {
          void (dirtyRef.current ? reloadBaseline() : loadConfig());
        }
      }),
    [loadConfig, reloadBaseline],
  );

  // 非强制校验互斥：窗口聚焦与挂载同时触发时只跑一次，避免重复启动慢速 omp。
  const modelsBusy = useRef(false);

  const loadModels = useCallback(async (force: boolean) => {
    if (!force && modelsBusy.current) return;
    modelsBusy.current = true;
    if (force) {
      setModelsError(null);
      setModelsLoading(true);
    }
    try {
      // 先于 omp 取 revision：列表读取期间文件再变，下次校验会发现不一致并重载。
      const source = await modelsSource();
      if (!alive.current) return;
      if (!force && modelsCache !== null && (source === null || source === modelsCache.source)) return;
      setModelsError(null);
      setModelsLoading(true);
      try {
        const list = await listModels();
        if (!alive.current) return;
        modelsCache = { list, source };
        setModels(list);
      } catch (e: unknown) {
        if (!alive.current) return;
        setModelsError(errorText(normalizeError(e)));
      } finally {
        if (alive.current) setModelsLoading(false);
      }
    } finally {
      modelsBusy.current = false;
    }
  }, []);

  // 挂载与窗口重新聚焦都对照 models.yml revision：外部编辑后回到应用即更新模型库。
  useEffect(() => {
    void loadModels(false);
    const onFocus = (): void => {
      void loadModels(false);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadModels]);

  async function saveBlock(block: BlockKey, pairs: SavePair[]) {
    if (busyRef.current !== null || config === null || draft === null) return;
    busyRef.current = block;
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
      // 草稿写出的是同一份 omp 配置：通知模式弹层重拉，避免它持过期基线。
      if (saved.length > 0) emitModelConfigChanged("draft");
      onToast(saved.length > 0 ? `已保存（${saved.join("、")}）` : "没有变化", "info");
    } catch (e: unknown) {
      // 失败只重读基线、草稿保留：已写成功的 key 只清其切片的 touched，重试只写失败的 key。
      await reloadBaseline();
      const savedKeys = new Set(saved);
      if (savedKeys.size > 0) {
        setDraft((prev) => {
          if (prev === null) return prev;
          const next: ModelDrafts = { ...prev };
          if (savedKeys.has(pairLabel(CONFIG_KEYS.roles))) {
            next.roles = new Map([...prev.roles].map(([k, row]) => [k, { ...row, touched: false }]));
          }
          if (savedKeys.has(pairLabel(CONFIG_KEYS.chains))) {
            next.chains = new Map([...prev.chains].map(([k, chain]) => [k, { ...chain, touched: false }]));
          }
          if (savedKeys.has(pairLabel(CONFIG_KEYS.overrides))) {
            next.overrides = new Map([...prev.overrides].map(([k, row]) => [k, { ...row, touched: false }]));
          }
          if (savedKeys.has(pairLabel(CONFIG_KEYS.advisor))) {
            next.advisorTouched = new Set();
          }
          return next;
        });
      }
      const failure = e as { failed?: unknown; message?: string };
      const err = normalizeError(failure.failed ?? e);
      if (err.code === "CONFLICT") {
        setBlockErrors((prev) => ({
          ...prev,
          [block]: saved.length > 0
            ? `「${saved.join("、")}」已保存，但「${failure.message ?? ""}」失败：${CONFLICT_TEXT}`
            : CONFLICT_TEXT,
        }));
      } else if (saved.length > 0) {
        setBlockErrors((prev) => ({
          ...prev,
          [block]: `「${saved.join("、")}」已保存，但「${failure.message ?? ""}」失败：${errorText(err)}（草稿已保留，检查后重试）`,
        }));
      } else {
        setBlockErrors((prev) => ({ ...prev, [block]: `保存失败：${errorText(err)}（草稿已保留）` }));
      }
    } finally {
      busyRef.current = null;
      if (alive.current) setBusyBlock(null);
    }
  }

  if (config === null || draft === null) {
    if (loading) return { status: "loading" };
    return { status: "error", loadError, loadConfig };
  }

  const modelsList = models ?? [];
  const writeValues = draftWriteValues(config, draft);
  const rolesValue = writeValues.roles;
  const overridesValue = writeValues.overrides;
  const disabledValue = writeValues.disabled;
  const advisorValue = writeValues.advisor;
  const chainsValue = writeValues.chains;
  const rolesDirty = !deepEqual(rolesValue, config.roles);
  const chainsDirty = !deepEqual(chainsValue, config.fallbackChains);
  const dirty: DirtyState = deriveDirty(config, draft, writeValues);

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

  const expandRole = (role: string) => {
    setDraft((prev) => {
      if (!prev || prev.roles.has(role)) return prev;
      const roles = new Map(prev.roles);
      roles.set(role, { selector: null, thinking: "", touched: false });
      return { ...prev, roles, shownRoles: [...prev.shownRoles, role] };
    });
    setExpandedRoles((prev) => new Set(prev).add(role));
  };

  const collapseRole = (role: string) => {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      next.delete(role);
      return next;
    });
    setDraft((prev) => {
      if (!prev) return prev;
      const roles = new Map(prev.roles);
      roles.delete(role);
      return { ...prev, roles, shownRoles: prev.shownRoles.filter((r) => r !== role) };
    });
  };

  const revert = (block: BlockKey) => {
    setDraft((prev) => (prev === null ? prev : revertBlock(config, prev, block, othersKeys)));
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

  // 「其他模型的兜底」= 没被任何角色卡收走的 chain（见 othersKeysOf）。
  // 顺序沿用草稿链顺序（= 配置原顺序 + 新增）。
  const othersKeys = othersKeysOf([...draft.chains.keys()], draft.roles);

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

  // 未保存修改计数（吸底保存条用）。
  const counts = deriveChangeCounts(config, draft);
  const chainsChangeCount = counts.chains;
  const rolesChangeCount = counts.roles;
  const agentsChangeCount = counts.agents;
  const retry = describeRetryStatus(config.retryStatus);
  const retryEnabledText = retry.enabled === null ? "未知" : retry.enabled ? "开" : "关";

  const rolesSaveLabel =
    rolesDirty && chainsDirty ? "保存主模型与兜底" : chainsDirty ? "保存兜底" : "保存主模型";

  /** 某角色用卡还是紧凑行：已配置 / 有兜底 / 已点开 → 卡，否则紧凑行。 */
  const roleCardVisible = (role: string): boolean => {
    if (!draft.shownRoles.includes(role)) return false;
    if (config.roles[role] !== undefined) return true;
    if (draft.chains.has(role)) return true;
    return expandedRoles.has(role);
  };

  const defaultRow = draft.roles.get("default") ?? null;
  const orchestratorText =
    defaultRow !== null && defaultRow.selector !== null
      ? `${friendlyModelName(defaultRow.selector, modelsList) ?? defaultRow.selector}${
          defaultRow.thinking !== "" ? ` · ${defaultRow.thinking}` : ""
        }`
      : "omp 内置默认";

  return {
    status: "ready",
    state: {
      models,
      modelsList,
      modelsLoading,
      modelsError,
      loadModels,
      config,
      draft,
      loadConfig,
      busyBlock,
      blockErrors,
      dirty,
      saveBlock,
      saveRoles,
      saveAgents,
      saveOthers,
      revert,
      setRow,
      setDraft,
      expandRole,
      collapseRole,
      ensureChain,
      deleteChain,
      updateChain,
      validateChains,
      chainLabel,
      othersKeys,
      rolesChangeCount,
      agentsChangeCount,
      chainsChangeCount,
      retry,
      retryEnabledText,
      rolesSaveLabel,
      roleCardVisible,
      orchestratorText,
      moreOpen,
      setMoreOpen,
      othersOpen,
      setOthersOpen,
      newModelKey,
      setNewModelKey,
      newCustomKey,
      setNewCustomKey,
      newKeyError,
      setNewKeyError,
      addChain,
    },
  };
}
