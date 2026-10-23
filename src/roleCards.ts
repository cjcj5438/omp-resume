/**
 * 「模型与 Agent」页的视图模型（纯函数）：角色卡合并、兜底归属、Agent 实际模型
 * 解析、兜底状态文案，以及草稿的整形与写回。
 *
 * 语义依据见 CONTRACT §16.8「兜底语义调研」（2026-10-16）：角色清单与别名解析来自
 * omp 二进制字符串反编译 + 沙箱验证；未验证的匹配细节在文案里用保守措辞。
 */
import type { AgentDefinition, ModelConfig, ModelInfo, RetryStatus } from "./types";
import { parseSelectorValue, rawValueText } from "./modelConfig";

/** 角色元信息：中文名 + 一句话用途。 */
export interface RoleInfo {
  id: string;
  name: string;
  blurb: string;
  /** chat：普通对话角色；capability：需专用模型的能力角色。 */
  kind: "chat" | "capability";
}

export const ROLE_INFO: RoleInfo[] = [
  { id: "default", name: "主对话", blurb: "平时聊天、写代码的主力模型", kind: "chat" },
  { id: "smol", name: "轻快任务", blurb: "提交信息、标题等轻量小任务", kind: "chat" },
  { id: "slow", name: "深度思考", blurb: "需要多想一会儿的复杂分析", kind: "chat" },
  { id: "vision", name: "图片理解", blurb: "读懂截图和图片内容", kind: "chat" },
  { id: "plan", name: "方案设计", blurb: "做架构方案、写计划时用", kind: "chat" },
  { id: "commit", name: "提交信息", blurb: "生成 git 提交信息", kind: "chat" },
  { id: "tiny", name: "极简任务", blurb: "标题生成等最轻的活", kind: "chat" },
  { id: "memory", name: "记忆助手", blurb: "记忆、回忆类后台调用", kind: "chat" },
  { id: "task", name: "子任务", blurb: "子代理没指定模型时用它", kind: "chat" },
  { id: "advisor", name: "顾问", blurb: "每轮被动评审并给出备注", kind: "chat" },
  { id: "image", name: "图片生成", blurb: "生成图片，需专用模型", kind: "capability" },
  { id: "web", name: "联网搜索", blurb: "联网搜索，需专用模型", kind: "capability" },
  { id: "speech", name: "语音合成", blurb: "文字转语音，需专用模型", kind: "capability" },
  { id: "dictation", name: "语音听写", blurb: "语音转文字，需专用模型", kind: "capability" },
  { id: "judge", name: "裁判", blurb: "给结果打分、做裁判", kind: "capability" },
];

const ROLE_INFO_MAP: Record<string, RoleInfo> = Object.fromEntries(
  ROLE_INFO.map((info) => [info.id, info]),
);

/** 查角色元信息；自定义角色返回 null。 */
export function roleInfo(role: string): RoleInfo | null {
  return ROLE_INFO_MAP[role] ?? null;
}

/** 常见对话角色（omp 自带模型选择器的 10 个角色）：未配置时作为「添加角色」候选。 */
export const COMMON_ROLES: string[] = ROLE_INFO.filter((info) => info.kind === "chat").map(
  (info) => info.id,
);

/** 能力类角色：默认折叠在「更多角色」里（配置了也会成卡，但收在这里）。 */
export const MORE_ROLES: readonly string[] = ["image", "web", "speech", "dictation", "vision", "judge"];

/** Vibe 工作会话档位：fast→sonic、good→task（omp `vibe_spawn` 的档位路由）。 */
export interface VibeTier {
  tier: "fast" | "good";
  title: string;
  chipLabel: string;
  agent: string;
  roleKey: string | null;
}
export const VIBE_TIERS: readonly VibeTier[] = [
  { tier: "fast", title: "快速工作会话", chipLabel: "Vibe 快速", agent: "sonic", roleKey: null },
  { tier: "good", title: "强力工作会话", chipLabel: "Vibe 强力", agent: "task", roleKey: "task" },
];

/** 内置 agent 的中文职责（omp 18.12.2 自带 6 个；英文 description 的意译）。 */
export interface AgentDutyInfo {
  /** 中文短标签（流程图节点标题用）。 */
  label: string;
  /** 一句话职责。 */
  duty: string;
}

export const AGENT_INFO: Record<string, AgentDutyInfo> = {
  task: { label: "通用执行", duty: "完整能力的通用子代理，执行多步委派任务" },
  sonic: { label: "机械处理", duty: "低推理，只做机械更新与数据收集" },
  scout: { label: "只读调研", duty: "快速只读调研，返回压缩上下文" },
  reviewer: { label: "代码评审", duty: "代码质量与安全评审专家" },
  "security-reviewer": { label: "安全审查", duty: "只读安全审查，找仓库漏洞证据" },
  seance: { label: "历史咨询", duty: "读历史会话与嵌套记录，回答一次咨询" },
};

/** 兜底 chain key 的分类：角色名 / 模型 selector / provider 通配。 */
export type ChainKeyKind = "role" | "model" | "wildcard";

export function classifyChainKey(key: string): ChainKeyKind {
  if (key.endsWith("/*")) return "wildcard";
  return key.includes("/") ? "model" : "role";
}

/** 去掉 `:thinking` 后缀取 base；非 selector 原样返回。 */
export function selectorBase(value: string): string {
  return parseSelectorValue(value).selector;
}

/** 取 `:thinking` 后缀（无后缀返回 ""）。 */
export function selectorThinking(value: string): string {
  return parseSelectorValue(value).thinking;
}

/**
 * 角色别名解析：`@role[:thinking]` / `pi/role[:thinking]` →
 * `{ role, thinking }`；不是别名写法返回 null。
 * （与 omp 的别名前缀规则一致；`role` 是否真实存在由调用方再判断。）
 */
export function parseRoleAlias(value: string): { role: string; thinking: string } | null {
  const rest = value.startsWith("@")
    ? value.slice(1)
    : value.startsWith("pi/")
      ? value.slice(3)
      : null;
  if (rest === null || rest === "") return null;
  const parsed = parseSelectorValue(rest);
  if (
    parsed.selector === "" ||
    parsed.selector.includes("/") ||
    parsed.selector.includes("@")
  ) {
    return null;
  }
  return { role: parsed.selector, thinking: parsed.thinking };
}

/** 模型友好名；不在列表里返回 null（调用方显示「未知值 · 保留」）。 */
export function friendlyModelName(selector: string, models: ModelInfo[]): string | null {
  return models.find((m) => m.selector === selector)?.name ?? null;
}

/** 模型供应商；不在列表里返回 null（调用方不打供应商标）。 */
export function modelProvider(selector: string, models: ModelInfo[]): string | null {
  return models.find((m) => m.selector === selector)?.provider ?? null;
}

/**
 * 未配置角色实际用谁：沿 omp 的回退规则展开（与 `mv()`/`abe` 一致）——
 * advisor 只认已配置的 slow；memory→tiny→smol→default 逐级找已配置的；
 * smol/slow 未配置时用 default；其余未配置直接内置。
 * 返回解析到的选择器与其来源角色；都解析不到返回 null（用 omp 内置默认）。
 */
export function resolveRoleFallback(
  role: string,
  roles: Record<string, unknown>,
): { selector: string; via: string | null } | null {
  const seen = new Set<string>([role]);
  let current: string | null = role;
  while (current !== null) {
    const raw = roles[current];
    if (typeof raw === "string" && raw.trim() !== "") {
      return { selector: raw, via: current === role ? null : current };
    }
    let next: string | null = null;
    if (current === "advisor") {
      next = typeof roles["slow"] === "string" ? "slow" : null;
    } else if (current === "memory" || current === "tiny") {
      next = current === "memory" ? "tiny" : "smol";
    } else if (current === "smol" || current === "slow") {
      next = "default";
    }
    if (next === null || seen.has(next)) return null;
    seen.add(next);
    current = next;
  }
  return null;
}

export interface RoleFallbackText {
  /** 主行：实际使用的模型（友好名 / 原始值 / omp 内置默认）。 */
  modelText: string;
  modelUnknown: boolean;
  /** 来源角色的中文名；null 表示就是该角色自己或走内置。 */
  viaDisplay: string | null;
}

/** 未配置角色的「实际使用」文案。 */
export function describeRoleFallback(
  role: string,
  roles: Record<string, unknown>,
  models: ModelInfo[],
): RoleFallbackText {
  const resolved = resolveRoleFallback(role, roles);
  if (resolved === null) {
    return { modelText: "omp 内置默认", modelUnknown: false, viaDisplay: null };
  }
  const parsed = parseSelectorValue(resolved.selector);
  const name = friendlyModelName(parsed.selector, models);
  return {
    modelText: `${name ?? resolved.selector}${parsed.thinking !== "" ? ` · ${parsed.thinking}` : ""}`,
    modelUnknown: name === null,
    viaDisplay: resolved.via === null ? null : (roleInfo(resolved.via)?.name ?? resolved.via),
  };
}

export interface AgentEffective {
  /** 主行：实际使用的模型（友好名 / 说明文字）。 */
  modelText: string;
  /** 主行是否为未知值（原样保留，不在模型列表里）。 */
  modelUnknown: boolean;
  /** 实际生效模型的供应商；跟随会话 / 内置默认 / 未知值时为 null（不打标）。 */
  provider: string | null;
  /** 次行：来源说明。 */
  sourceText: string;
  /** 思考强度（"" 表示默认）。 */
  thinking: string;
  /** 生效模型的 selector（去 thinking 后缀）；跟随会话 / 内置默认 / 未知形状时为 null。 */
  selector: string | null;
}

export interface AliasResolved {
  modelText: string;
  modelUnknown: boolean;
  provider: string | null;
  thinking: string;
  /** `@smol → 轻快任务角色`；兜底时附 `（smol未配置）`；内置时为 `@smol`。 */
  arrowText: string;
  builtin: boolean;
  /** 别名解析到底层模型的 selector；走内置默认时为 null。 */
  selector: string | null;
}

/**
 * 别名取值的公共解析（覆盖与内置默认共用）：`@角色` 先按该角色取值，
 * 未配置时沿角色回退链找实际生效者，再取不到走 omp 内置默认。
 * 不认识的别名返回 null（调用方按字面 selector 处理）。
 */
function resolveAliasValue(
  raw: string,
  roles: Record<string, unknown>,
  models: ModelInfo[],
  fallbackThinking: string,
): AliasResolved | null {
  const alias = parseRoleAlias(raw);
  if (alias === null) return null;
  if (roleInfo(alias.role) === null && roles[alias.role] === undefined) return null;
  const display = roleInfo(alias.role)?.name ?? alias.role;
  const own = roles[alias.role];
  if (own !== undefined && typeof own !== "string") {
    return {
      modelText: `${display}角色未配置，用 omp 内置默认`,
      modelUnknown: false,
      provider: null,
      thinking: alias.thinking || fallbackThinking,
      arrowText: `@${alias.role}`,
      builtin: true,
      selector: null,
    };
  }
  const resolved = resolveRoleFallback(alias.role, roles);
  if (resolved === null) {
    return {
      modelText: `${display}角色未配置，用 omp 内置默认`,
      modelUnknown: false,
      provider: null,
      thinking: alias.thinking || fallbackThinking,
      arrowText: `@${alias.role}`,
      builtin: true,
      selector: null,
    };
  }
  const parsed = parseSelectorValue(resolved.selector);
  const name = friendlyModelName(parsed.selector, models);
  const viaDisplay =
    resolved.via === null ? null : (roleInfo(resolved.via)?.name ?? resolved.via);
  return {
    modelText: name ?? resolved.selector,
    modelUnknown: name === null,
    provider: name === null ? null : modelProvider(parsed.selector, models),
    thinking: alias.thinking || parsed.thinking || fallbackThinking,
    arrowText:
      viaDisplay === null
        ? `@${alias.role} → ${display}角色`
        : `@${alias.role} → ${viaDisplay}角色（${alias.role}未配置）`,
    builtin: false,
    selector: parsed.selector,
  };
}

/**
 * Agent「当前实际使用的模型」解析：
 * 改用模型（覆盖）> 内置默认（首选；`@角色` 别名跟随该角色当前模型）>
 * 未指定则跟随当前会话模型。未知值一律原样保留。
 */
export function resolveAgentEffective(
  agent: AgentDefinition,
  overrideRaw: unknown,
  roles: Record<string, unknown>,
  models: ModelInfo[],
): AgentEffective {
  const fallbackThinking = agent.defaultThinkingLevel ?? "";
  if (overrideRaw !== undefined) {
    const raw = rawValueText(overrideRaw);
    const resolved = resolveAliasValue(raw, roles, models, fallbackThinking);
    if (resolved !== null) {
      return {
        modelText: resolved.modelText,
        modelUnknown: resolved.modelUnknown,
        provider: resolved.provider,
        sourceText: resolved.builtin
          ? `改用 ${resolved.arrowText}（跟随该角色）`
          : `来自「改用模型」${resolved.arrowText}`,
        thinking: resolved.thinking,
        selector: resolved.selector,
      };
    }
    const parsed = parseSelectorValue(raw);
    const name = friendlyModelName(parsed.selector, models);
    return {
      modelText: name ?? raw,
      modelUnknown: name === null,
      provider: name === null ? null : modelProvider(parsed.selector, models),
      sourceText: "来自「改用模型」",
      thinking: parsed.thinking || fallbackThinking,
      selector: parsed.selector,
    };
  }
  const first = agent.defaultModel[0];
  if (first === undefined) {
    return {
      modelText: "跟随当前会话模型",
      modelUnknown: false,
      provider: null,
      sourceText: "该 Agent 未指定默认模型",
      thinking: fallbackThinking,
      selector: null,
    };
  }
  const more =
    agent.defaultModel.length > 1 ? `（首选，其后还有 ${agent.defaultModel.length - 1} 个备选）` : "";
  const resolvedDefault = resolveAliasValue(first, roles, models, fallbackThinking);
  if (resolvedDefault !== null) {
    return {
      modelText: resolvedDefault.modelText,
      modelUnknown: resolvedDefault.modelUnknown,
      provider: resolvedDefault.provider,
      sourceText: `内置默认 ${resolvedDefault.arrowText}${more}`,
      thinking: resolvedDefault.thinking,
      selector: resolvedDefault.selector,
    };
  }
  const parsed = parseSelectorValue(first);
  const name = friendlyModelName(parsed.selector, models);
  return {
    modelText: name ?? first,
    modelUnknown: name === null,
    provider: name === null ? null : modelProvider(parsed.selector, models),
    sourceText: `内置默认（直接指定模型）${more}`,
    thinking: parsed.thinking || fallbackThinking,
    selector: parsed.selector,
  };
}

export interface RetryStatusText {
  enabled: boolean | null;
  trigger: string;
  revert: string;
}

/** 全局兜底状态的人话翻译；读不到时显示「未知」。 */
export function describeRetryStatus(status: RetryStatus): RetryStatusText {
  let trigger: string;
  switch (status.fallbackOn) {
    case null:
      trigger = "未知";
      break;
    case "any":
      trigger = "任何错误都切换";
      break;
    case "usage-limit":
      trigger = "仅用尽额度时切换";
      break;
    case "except-usage-limit":
      trigger = "除用尽额度外都切换";
      break;
    default:
      trigger = `未知（${status.fallbackOn}）`;
      break;
  }
  let revert: string;
  switch (status.fallbackRevertPolicy) {
    case null:
      revert = "未知";
      break;
    case "cooldown-expiry":
      revert = "主模型恢复后自动切回";
      break;
    case "never":
      revert = "切走后不再自动切回";
      break;
    default:
      revert = `未知（${status.fallbackRevertPolicy}）`;
      break;
  }
  return { enabled: status.modelFallback, trigger, revert };
}

/**
 * 吸附到角色卡里的「按模型的兜底」：chain key 是模型 selector（base 与角色主模型
 * 一致，忽略 `:thinking` 后缀）或命中主模型 provider 的通配 key。
 * 主模型是别名等非 selector 时不吸附（无法判断归属）。
 */
export function attachedChainKeys(primary: string | null, chainKeys: string[]): string[] {
  if (primary === null) return [];
  const base = selectorBase(primary);
  if (!base.includes("/")) return [];
  const slash = base.indexOf("/");
  const provider = base.slice(0, slash);
  const id = base.slice(slash + 1);
  return chainKeys.filter((key) => {
    const kind = classifyChainKey(key);
    if (kind === "model") return selectorBase(key) === base;
    if (kind === "wildcard") {
      const inner = key.slice(0, -"/*".length);
      if (!inner.includes("/")) return inner === provider;
      const [keyProvider, ...prefix] = inner.split("/");
      return keyProvider === provider && id.startsWith(`${prefix.join("/")}/`);
    }
    return false;
  });
}

/** 通配 key 的人话标题。 */
export function wildcardTitle(key: string): string {
  const inner = key.slice(0, -"/*".length);
  if (!inner.includes("/")) return `「${inner}」旗下所有模型的兜底`;
  const [provider, ...prefix] = inner.split("/");
  return `「${provider}」旗下「${prefix.join("/")}」开头的兜底`;
}

export interface SelectorRow {
  /** null = 未设置 / 不覆盖（保存时删除该条目）。 */
  selector: string | null;
  /** 空字符串 = 默认（不带 `:thinking` 后缀）。 */
  thinking: string;
  touched: boolean;
}

export type AdvisorState = "default" | "on" | "off";

export interface ChainDraft {
  key: string;
  /** 原始条目（非字符串值原样保留），编辑只增/删/移。 */
  entries: unknown[];
  touched: boolean;
}

export interface ModelDrafts {
  roles: Map<string, SelectorRow>;
  overrides: Map<string, SelectorRow>;
  disabled: Set<string>;
  advisor: Map<string, AdvisorState>;
  advisorTouched: Set<string>;
  /** 全部 chain 草稿（插入顺序 = 配置原顺序 + 新增）；删除即移出。 */
  chains: Map<string, ChainDraft>;
  /** 角色卡顺序：default 首位 + 已配置角色（配置原顺序）+ 已添加角色。 */
  shownRoles: string[];
}

export function rowFrom(raw: unknown): SelectorRow {
  const parsed = parseSelectorValue(rawValueText(raw));
  return { selector: parsed.selector, thinking: parsed.thinking, touched: false };
}

/**
 * 换模型后的行状态：原 thinking 仍在新模型的档位表里才保留，否则回默认；
 * 换模型即视为一次修改（touched）。角色卡、Agent 行、Vibe 档位行共用。
 */
export function rowAfterModelChange(
  row: SelectorRow,
  selector: string | null,
  models: ModelInfo[],
): SelectorRow {
  const nextLevels =
    selector !== null
      ? (models.find((m) => m.selector === selector)?.thinkingLevels ?? [])
      : [];
  const thinking =
    row.thinking !== "" && nextLevels.includes(row.thinking) ? row.thinking : "";
  return { selector, thinking, touched: true };
}

export function draftFromConfig(config: ModelConfig): ModelDrafts {
  const configured = Object.keys(config.roles);
  // 有主模型的角色都有卡；只有兜底的常见角色也有卡（主模型待配）；
  // 不认识的角色 key 去「其他模型的兜底」。
  const chained = Object.keys(config.fallbackChains).filter(
    (key) => classifyChainKey(key) === "role" && roleInfo(key) !== null,
  );
  const shownRoles = [
    "default",
    ...configured.filter((role) => role !== "default"),
    ...chained.filter((role) => role !== "default" && !configured.includes(role)),
  ];
  const roles = new Map<string, SelectorRow>();
  for (const role of shownRoles) {
    const raw = config.roles[role];
    roles.set(
      role,
      raw === undefined ? { selector: null, thinking: "", touched: false } : rowFrom(raw),
    );
  }
  const overrides = new Map<string, SelectorRow>();
  for (const agent of config.agents) {
    const raw = config.agentOverrides[agent.name];
    overrides.set(
      agent.name,
      raw === undefined ? { selector: null, thinking: "", touched: false } : rowFrom(raw),
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
  const chains = new Map<string, ChainDraft>();
  for (const [key, entries] of Object.entries(config.fallbackChains)) {
    chains.set(key, {
      key,
      entries: Array.isArray(entries) ? [...entries] : [entries],
      touched: false,
    });
  }
  return { roles, overrides, disabled, advisor, advisorTouched: new Set(), chains, shownRoles };
}

/** record 整体读-改-写：未触碰的键/值原样保留，触碰的键按行状态写回或删除。 */
export function buildRecord(
  base: Record<string, unknown>,
  rows: Map<string, SelectorRow>,
): Record<string, unknown> {
  const value: Record<string, unknown> = { ...base };
  for (const [key, row] of rows) {
    if (!row.touched) continue;
    if (row.selector === null) delete value[key];
    else {
      const composed =
        row.thinking !== "" ? `${row.selector}:${row.thinking}` : row.selector;
      value[key] = composed;
    }
  }
  return value;
}

export function buildDisabled(config: ModelConfig, disabled: Set<string>): unknown[] {
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

export function buildAdvisor(
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

export function buildChains(
  config: ModelConfig,
  chains: Map<string, ChainDraft>,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, chain] of chains) {
    value[key] = chain.touched ? chain.entries : config.fallbackChains[key];
  }
  return value;
}

/** 保存时多 key 场景的人话名（报错/提示用，不出现内部 key）。 */
export const SAVE_KEY_LABELS: Record<string, string> = {
  modelRoles: "主模型",
  "retry.fallbackChains": "兜底",
  "task.agentModelOverrides": "改用模型",
  "task.disabledAgents": "停用",
  "task.agentAdvisor": "顾问",
};

const CIRCLED = [
  "①",
  "②",
  "③",
  "④",
  "⑤",
  "⑥",
  "⑦",
  "⑧",
  "⑨",
  "⑩",
  "⑪",
  "⑫",
  "⑬",
  "⑭",
  "⑮",
  "⑯",
  "⑰",
  "⑱",
  "⑲",
  "⑳",
];

/** 兜底顺序号：①…⑳，超出用 `21.` 形式。 */
export function orderNumeral(index: number): string {
  return CIRCLED[index] ?? `${index + 1}.`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value
        .toFixed(2)
        .replace(/0+$/, "")
        .replace(/\.$/, "");
}

/** 上下文窗口人话：1000000 → `1M 上下文`。 */
export function formatContextWindow(contextWindow: number | null): string | null {
  if (contextWindow === null) return null;
  if (contextWindow >= 1_000_000) return `${trimNumber(contextWindow / 1_000_000)}M 上下文`;
  if (contextWindow >= 1_000) return `${trimNumber(contextWindow / 1_000)}K 上下文`;
  return `${contextWindow} 上下文`;
}

/** 目录价人话（USD/每百万 token 口径）：`输入 $0.3 / 输出 $1.2`。 */
export function formatCost(input: number | null, output: number | null): string | null {
  if (input === null && output === null) return null;
  const show = (v: number | null) => (v === null ? "–" : `$${v}`);
  return `输入 ${show(input)} / 输出 ${show(output)}`;
}
