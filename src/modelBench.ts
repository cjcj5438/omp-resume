/**
 * 模型测试器前端逻辑（§20.4）：localStorage 配置、列表/标签派生、窗口统计、
 * 综合分、一键推荐、花费预估、错误分类、运行器单例与应用级监控钩子。
 * 纯前端状态：读 omp 配置但不写，保存闭环只调既有的 update_model_config。
 */
import { useEffect } from "react";
import { modelBenchRun, normalizeError } from "./api";
import type { AgentDefinition, BenchRound, ModelInfo } from "./types";
import { parseSelectorValue } from "./modelConfig";
import { ROLE_INFO, roleInfo } from "./roleCards";

// ---- 本地配置（localStorage，与 pins 同 pattern） ----

export const BENCH_CONFIG_KEY = "omp-resume:model-tester:v1";

export type BenchIntervalMin = 0 | 30 | 60 | 360;

export interface BenchEntry {
  selector: string;
  tags: string[];
  monitor: boolean;
}

export interface BenchConfig {
  entries: BenchEntry[];
  customTags: string[];
  intervalMin: BenchIntervalMin;
}

export const CUSTOM_TAG_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

export function defaultBenchConfig(): BenchConfig {
  return { entries: [], customTags: ["test"], intervalMin: 0 };
}

function isIntervalMin(v: unknown): v is BenchIntervalMin {
  return v === 0 || v === 30 || v === 60 || v === 360;
}

/** 读不到或结构损坏时回到默认值；数组内的坏条目只跳过该条。 */
export function loadBenchConfig(storage?: Storage): BenchConfig {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(BENCH_CONFIG_KEY);
    if (raw == null) return defaultBenchConfig();
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return defaultBenchConfig();
    const obj = data as Record<string, unknown>;
    if (!Array.isArray(obj.entries) || !Array.isArray(obj.customTags)) return defaultBenchConfig();
    const entries: BenchEntry[] = [];
    for (const item of obj.entries) {
      if (typeof item !== "object" || item === null) continue;
      const e = item as Record<string, unknown>;
      if (typeof e.selector !== "string" || !isPlainSelector(e.selector)) continue;
      entries.push({
        selector: e.selector,
        tags: [...new Set(Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [])],
        monitor: e.monitor === true,
      });
    }
    return {
      entries,
      customTags: [
        ...new Set(
          obj.customTags.filter((t): t is string => typeof t === "string" && CUSTOM_TAG_PATTERN.test(t)),
        ),
      ],
      intervalMin: isIntervalMin(obj.intervalMin) ? obj.intervalMin : 0,
    };
  } catch {
    return defaultBenchConfig();
  }
}

/** 写入配置；存储不可用时静默忽略（本次运行内仍然有效）。 */
export function saveBenchConfig(config: BenchConfig, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage).setItem(BENCH_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // 存储不可用：忽略，界面状态仍然有效。
  }
}

// ---- 列表派生（entries ∪ modelRoles 普通 selector） ----

/** 普通 selector：能拿去 bench 的 `provider/model[:thinking]`；别名/逗号列表/非字符串都不是。 */
export function isPlainSelector(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("@") &&
    !value.includes(",") &&
    !/\s/.test(value) &&
    value.includes("/")
  );
}

export interface BenchRowModel {
  selector: string;
  /** provider/model 部分（不含 :thinking，用于匹配 ModelInfo/ModelPerf）。 */
  base: string;
  thinking: string;
  /** 角色隐式标签在前 + 用户标签，去重。 */
  tags: string[];
  /** 占用该模型的角色名；非空时不可删除。 */
  usedByRoles: string[];
  monitor: boolean;
}

/** 能力角色（judge/image/web/…）不进测试器；未知/自定义角色按对话角色处理。 */
function isBenchRole(role: string): boolean {
  return (roleInfo(role)?.kind ?? "chat") === "chat";
}

export function deriveBenchList(config: BenchConfig, roles: Record<string, unknown>): BenchRowModel[] {
  const bySelector = new Map<string, BenchRowModel>();
  const ensure = (selector: string): BenchRowModel => {
    let row = bySelector.get(selector);
    if (row === undefined) {
      const { selector: base, thinking } = parseSelectorValue(selector);
      row = { selector, base, thinking, tags: [], usedByRoles: [], monitor: false };
      bySelector.set(selector, row);
    }
    return row;
  };
  for (const entry of config.entries) {
    if (!isPlainSelector(entry.selector)) continue;
    const row = ensure(entry.selector);
    for (const tag of entry.tags) {
      if (!row.tags.includes(tag)) row.tags.push(tag);
    }
    row.monitor = row.monitor || entry.monitor;
  }
  for (const [role, raw] of Object.entries(roles)) {
    if (!isBenchRole(role) || !isPlainSelector(raw)) continue;
    const row = ensure(raw);
    row.usedByRoles.push(role);
    if (!row.tags.includes(role)) row.tags.unshift(role);
  }
  return [...bySelector.values()];
}

// ---- 标签派生 ----
/** §20.4 预设标签里的内置对话角色：chat 类去掉 vision（契约枚举 9 个，无 vision）。 */
export const BENCH_BUILTIN_TAGS: string[] = ROLE_INFO.filter((r) => r.kind === "chat" && r.id !== "vision").map(
  (r) => r.id,
);

export interface BenchTag {
  id: string;
  /** 中文名（内置角色）或原 id。 */
  label: string;
  custom: boolean;
  /** 非内置标签且未被任何 agent 引用时为 true。 */
  unused: boolean;
}

function referencesTag(value: unknown, tag: string): boolean {
  if (typeof value !== "string") return false;
  const at = `@${tag}`;
  return value === at || value.startsWith(`${at}:`);
}

/** 预设 = 内置对话角色 ∪ modelRoles 其他对话键 ∪ customTags；顺序固定。 */
export function deriveTagSet(
  config: BenchConfig,
  roles: Record<string, unknown>,
  agentOverrides: Record<string, unknown>,
  agents: AgentDefinition[],
): BenchTag[] {
  const builtin = new Set(BENCH_BUILTIN_TAGS);
  const extraRoles = Object.keys(roles)
    .filter((k) => isBenchRole(k) && !builtin.has(k))
    .sort();
  const ids = [...BENCH_BUILTIN_TAGS, ...extraRoles, ...config.customTags.filter((t) => !builtin.has(t))];
  const overrideValues = Object.values(agentOverrides);
  return [...new Set(ids)].map((id) => {
    const used =
      builtin.has(id) ||
      overrideValues.some((v) => referencesTag(v, id)) ||
      agents.some((a) => a.defaultModel.some((m) => referencesTag(m, id)));
    return {
      id,
      label: roleInfo(id)?.name ?? id,
      custom: !builtin.has(id) && config.customTags.includes(id),
      unused: !used,
    };
  });
}

// ---- 窗口统计与综合分 ----

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BenchRangeStats {
  /** Σok/Σtotal；无样本 null。 */
  rate: number | null;
  /** Σtotal。 */
  samples: number;
  /** 最近一轮的值（成功率为 0 的轮次这些字段为 null）。 */
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  tpsP50: number | null;
  tpsCv: number | null;
  cost: number;
}

export interface BenchWindowStats extends BenchRangeStats {
  /** 24h 内无轮次、退化到最近一轮时为 true（推荐门槛不认这种样本）。 */
  fallback: boolean;
}

/**
 * 表格统计：优先最近 24h 的全部轮次（成功率/样本/花费累加，延迟取最近一轮）；
 * 24h 内无轮次时用最近一轮；从没测过返回 null。rounds 须按 at 从早到晚排序。
 */
export function windowStats(rounds: BenchRound[], nowMs = Date.now()): BenchWindowStats | null {
  const recent = rangeStats(rounds, DAY_MS, nowMs);
  if (recent !== null) return { ...recent, fallback: false };
  const last = rangeStats(rounds.slice(-1), Infinity, nowMs);
  return last === null ? null : { ...last, fallback: true };
}

/** 抽屉 KPI：某段时间范围内的聚合；范围内无轮次返回 null。 */
export function rangeStats(rounds: BenchRound[], rangeMs: number, nowMs = Date.now()): BenchRangeStats | null {
  const pool = rounds.filter((r) => Date.parse(r.at) >= nowMs - rangeMs);
  if (pool.length === 0) return null;
  const latest = pool[pool.length - 1];
  const total = pool.reduce((n, r) => n + r.total, 0);
  return {
    rate: total > 0 ? pool.reduce((n, r) => n + r.ok, 0) / total : null,
    samples: total,
    ttftP50Ms: latest.ttftP50Ms,
    ttftP95Ms: latest.ttftP95Ms,
    tpsP50: latest.tpsP50,
    tpsCv: latest.tpsCv,
    cost: pool.reduce((n, r) => n + r.cost, 0),
  };
}

/**
 * 综合分（0–100，只用于排序和推荐）：
 * round(100 × (0.5·成功率 + 0.3·tps/列表最大tps + 0.2·列表最小ttft/ttft))，缺项按 0。
 * 与入参一一对应。
 */
export function scoreRows(stats: (BenchWindowStats | null)[]): number[] {
  let maxTps = 0;
  let minTtft = Infinity;
  for (const s of stats) {
    if (s?.tpsP50 != null && s.tpsP50 > maxTps) maxTps = s.tpsP50;
    if (s?.ttftP50Ms != null && s.ttftP50Ms < minTtft) minTtft = s.ttftP50Ms;
  }
  return stats.map((s) => {
    if (s === null) return 0;
    const rate = s.rate ?? 0;
    const tps = s.tpsP50 != null && maxTps > 0 ? s.tpsP50 / maxTps : 0;
    const ttft = s.ttftP50Ms != null && s.ttftP50Ms > 0 && minTtft !== Infinity ? minTtft / s.ttftP50Ms : 0;
    return Math.round(100 * (0.5 * rate + 0.3 * tps + 0.2 * ttft));
  });
}

// ---- 一键推荐 ----

export interface RecommendRow {
  selector: string;
  tags: string[];
  stats: BenchWindowStats | null;
  score: number;
}

/**
 * 对每个标签，在候选（带该标签的模型 + 当前已分配的模型）里筛出
 * 24h 样本 ≥5 且成功率 ≥95% 的，取综合分最高者；与当前值不同才返回。
 * 同分优先留当前值（避免无意义切换），再按 selector 保证确定性。
 */
export function recommendChanges(
  rows: RecommendRow[],
  tags: BenchTag[],
  roles: Record<string, unknown>,
): Map<string, string> {
  const changes = new Map<string, string>();
  for (const tag of tags) {
    const current = typeof roles[tag.id] === "string" ? (roles[tag.id] as string) : null;
    const qualified = rows.filter(
      (r) =>
        (r.tags.includes(tag.id) || r.selector === current) &&
        r.stats !== null &&
        !r.stats.fallback &&
        r.stats.samples >= 5 &&
        (r.stats.rate ?? 0) >= 0.95,
    );
    if (qualified.length === 0) continue;
    qualified.sort(
      (a, b) =>
        b.score - a.score ||
        (b.selector === current ? 1 : 0) - (a.selector === current ? 1 : 0) ||
        (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0),
    );
    const best = qualified[0];
    if (best.selector !== current) changes.set(tag.id, best.selector);
  }
  return changes;
}

// ---- 花费预估（省钱护栏：单轮按 800 输入 + 2300 输出 token 估算） ----

const BENCH_INPUT_TOKENS = 800;
const BENCH_OUTPUT_TOKENS = 2300;
function estimateRoundCost(model: ModelInfo | null | undefined): number | null {
  if (model?.costInput == null || model.costOutput == null) return null;
  return (BENCH_INPUT_TOKENS * model.costInput + BENCH_OUTPUT_TOKENS * model.costOutput) / 1000000;
}

/** 多个 base 各跑一轮的预估总花费；单价未知的模型不计入。 */
export function estimateRoundsCost(bases: string[], models: ModelInfo[]): number {
  const bySelector = new Map(models.map((m) => [m.selector, m]));
  return bases.reduce((sum, base) => sum + (estimateRoundCost(bySelector.get(base)) ?? 0), 0);
}

// ---- 错误分类（展示用） ----

export type BenchErrorKind = "timeout" | "rateLimit" | "auth" | "empty" | "other";

export const BENCH_ERROR_LABEL: Record<BenchErrorKind, string> = {
  timeout: "超时",
  rateLimit: "限流",
  auth: "鉴权",
  empty: "空响应",
  other: "其他",
};

export function classifyBenchError(text: string): BenchErrorKind {
  const t = text.toLowerCase();
  if (t.includes("超时") || t.includes("timeout")) return "timeout";
  if (t.includes("429") || t.includes("rate limit")) return "rateLimit";
  if (
    t.includes("401") ||
    t.includes("403") ||
    t.includes("auth") ||
    t.includes("forbidden") ||
    t.includes("unauthorized")
  )
    return "auth";
  if (t.includes("empty") || t.includes("空")) return "empty";
  return "other";
}

// ---- 抽屉图表分桶（24h 按小时 / 7d 按天，key 沿用用量图的本地时间格式） ----

export type BenchBucketUnit = "hour" | "day";

export interface BenchBucket {
  key: string;
  rounds: number;
  requests: number;
  ok: number;
  /** 无请求时 null（柱不画、线断开）。 */
  rate: number | null;
  /** 桶内各轮 tpsP50 的均值；无成功轮次 null。 */
  tps: number | null;
  cost: number;
}

export function bucketizeRounds(rounds: BenchRound[], unit: BenchBucketUnit, nowMs = Date.now()): BenchBucket[] {
  const spanMs = unit === "hour" ? 3600000 : DAY_MS;
  const count = unit === "hour" ? 24 : 7;
  const now = new Date(nowMs);
  const aligned =
    unit === "hour"
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime()
      : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const windowStart = aligned - (count - 1) * spanMs;
  const keyOf = (t: number): string => {
    const d = new Date(t);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return unit === "hour" ? `${day} ${String(d.getHours()).padStart(2, "0")}` : day;
  };
  const buckets: BenchBucket[] = Array.from({ length: count }, (_, i) => ({
    key: keyOf(windowStart + i * spanMs),
    rounds: 0,
    requests: 0,
    ok: 0,
    rate: null,
    tps: null,
    cost: 0,
  }));
  const tpsSum = new Array<number>(count).fill(0);
  const tpsN = new Array<number>(count).fill(0);
  for (const r of rounds) {
    const idx = Math.floor((Date.parse(r.at) - windowStart) / spanMs);
    if (idx < 0 || idx >= count) continue;
    const b = buckets[idx];
    b.rounds += 1;
    b.requests += r.total;
    b.ok += r.ok;
    b.cost += r.cost;
    if (r.tpsP50 != null) {
      tpsSum[idx] += r.tpsP50;
      tpsN[idx] += 1;
    }
  }
  for (let i = 0; i < count; i += 1) {
    const b = buckets[i];
    if (b.requests > 0) b.rate = b.ok / b.requests;
    if (tpsN[i] > 0) b.tps = tpsSum[i] / tpsN[i];
  }
  return buckets;
}

// ---- 展示格式（表格/抽屉/图表多处共用，口径锁步） ----

export function formatRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function formatTps(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

export function formatMs(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

/** USD 人话：≥$0.01 两位小数，更小显示 4 位（bench 单轮常不足 1 分钱）。 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

// ---- 运行器（模块级单例，手动和监控共用） ----

export type BenchRunFn = (selector: string) => Promise<BenchRound>;

export interface BenchRunnerSnapshot {
  running: string[];
  queued: string[];
  /** selector → 上次失败的错误文本（成功后清除，不写历史）。 */
  errors: Record<string, string>;
  /** 累计完成的轮次数（单调递增，面板据此重载历史）。 */
  completedRuns: number;
}

export interface BenchRunner {
  enqueue(selector: string): void;
  enqueueMany(selectors: string[]): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): BenchRunnerSnapshot;
}

/**
 * 同 provider 串行、跨 provider 并行（最多 3 个）；已在排队/运行的不重复入队。
 * runFn 默认调真实命令，测试可注入假函数。
 */
export function createBenchRunner(runFn: BenchRunFn = modelBenchRun): BenchRunner {
  let running: string[] = [];
  let queued: string[] = [];
  let errors: Record<string, string> = {};
  let completedRuns = 0;
  let snapshot: BenchRunnerSnapshot = { running, queued, errors, completedRuns };
  const listeners = new Set<() => void>();

  const emit = (): void => {
    snapshot = { running: [...running], queued: [...queued], errors: { ...errors }, completedRuns };
    listeners.forEach((l) => l());
  };

  const pump = (): void => {
    while (running.length < 3) {
      const busyProviders = new Set(running.map((s) => s.split("/")[0]));
      const idx = queued.findIndex((s) => !busyProviders.has(s.split("/")[0]));
      if (idx < 0) return;
      const [next] = queued.splice(idx, 1);
      running.push(next);
      emit();
      void runFn(next).then(
        () => {
          running = running.filter((s) => s !== next);
          completedRuns += 1;
          const { [next]: _dropped, ...rest } = errors;
          void _dropped;
          errors = rest;
          emit();
          pump();
        },
        (e: unknown) => {
          running = running.filter((s) => s !== next);
          errors = { ...errors, [next]: normalizeError(e).message };
          emit();
          pump();
        },
      );
    }
  };

  const enqueue = (selector: string): void => {
    if (running.includes(selector) || queued.includes(selector)) return;
    queued = [...queued, selector];
    emit();
    pump();
  };

  return {
    enqueue,
    enqueueMany: (selectors: string[]): void => {
      for (const s of selectors) enqueue(s);
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: (): BenchRunnerSnapshot => snapshot,
  };
}

export const benchRunner: BenchRunner = createBenchRunner();

// ---- 应用级定时监控 ----

const MONITOR_TICK_MS = 30000;

/**
 * 定时监控：在 App 挂载一次。每 30 秒重读本地配置，距上次触发超过
 * intervalMin 就把 monitor=true 的模型入队；intervalMin=0 时不跑。
 * 应用开着才跑，退出就停；面板改配置后至多 30 秒生效。
 */
export function useBenchMonitor(): void {
  useEffect(() => {
    let lastRun = Date.now();
    const timer = setInterval(() => {
      const config = loadBenchConfig();
      if (config.intervalMin <= 0) return;
      if (Date.now() - lastRun < config.intervalMin * 60000) return;
      lastRun = Date.now();
      for (const entry of config.entries) {
        if (entry.monitor) benchRunner.enqueue(entry.selector);
      }
    }, MONITOR_TICK_MS);
    return () => clearInterval(timer);
  }, []);
}
