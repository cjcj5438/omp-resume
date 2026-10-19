import type {
  ErrorKind,
  SessionUsage,
  UsageHealth,
  UsageHealthTimelinePoint,
  UsageRange,
  UsageStats,
  UsageTokens,
  UsageTrendPoint,
  UsageTrendUnit,
} from "../types";

export const mockSessionUsage: SessionUsage = {
  messages: { user: 24, assistant: 86 },
  tokens: { input: 125400, output: 48700, cacheRead: 920000, cacheWrite: 60300, total: 1154400 },
  cost: { total: 12.84, main: 9.4, background: 1.04, subagent: 2.4 },
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-5", messages: 72, cost: 10.44, tokens: { input: 100000, output: 40000, cacheRead: 800000, cacheWrite: 50000, total: 990000 } },
    { provider: "openai", model: "gpt-5", messages: 18, cost: 2.4, tokens: { input: 25400, output: 8700, cacheRead: 120000, cacheWrite: 10300, total: 164400 } },
  ],
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地时区 YYYY-MM-DD。 */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时区 YYYY-MM-DD HH。 */
function hourKey(d: Date): string {
  return `${dayKey(d)} ${pad2(d.getHours())}`;
}

function zeroTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

/** 确定性伪随机：同一下标恒得同一权重，界面与测试都稳定。 */
function weight(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

interface TrendWindow {
  unit: UsageTrendUnit;
  keys: string[];
  /** hour 桶对应本地小时（day 桶为 -1），用于模拟昼夜活跃差异。 */
  hours: number[];
}

/** 各范围的固定窗口：hour/day 分桶、升序；all 只含稀疏的有数据日期。 */
function trendWindow(range: UsageRange, now: Date): TrendWindow {
  if (range === "today") {
    const keys: string[] = [];
    const hours: number[] = [];
    for (let h = 0; h < 24; h += 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h);
      keys.push(hourKey(d));
      hours.push(h);
    }
    return { unit: "hour", keys, hours };
  }
  if (range === "24h") {
    const keys: string[] = [];
    const hours: number[] = [];
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0).getTime();
    for (let i = 23; i >= 0; i -= 1) {
      const d = new Date(start - i * 3600000);
      keys.push(hourKey(d));
      hours.push(d.getHours());
    }
    return { unit: "hour", keys, hours };
  }
  if (range === "all") {
    // 稀疏日期：只含 7 个有数据的日子，验证“all 不补零”。
    const back = [45, 30, 21, 12, 5, 2, 0];
    const keys = back.map((n) => dayKey(new Date(now.getTime() - n * 86400000)));
    return { unit: "day", keys, hours: keys.map(() => -1) };
  }
  const n = range === "7d" ? 7 : 30;
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) keys.push(dayKey(new Date(now.getTime() - i * 86400000)));
  return { unit: "day", keys, hours: keys.map(() => -1) };
}

/** 小时活跃度：深夜明显偏低（仍偶有活动），白天高；保留少量零桶以覆盖补零。 */
function hourActivity(hour: number, i: number): number {
  const base = hour >= 9 && hour <= 18 ? 1 : hour >= 1 && hour <= 6 ? 0.3 : 0.55;
  const v = base * (0.3 + 0.7 * weight(i, 3));
  return weight(i, 7) < 0.08 ? 0 : v;
}

function dayActivity(i: number, sparse: boolean): number {
  const v = 0.3 + 0.7 * weight(i, 11);
  if (!sparse && weight(i, 13) < 0.1) return 0;
  return v;
}

/** 按权重把 total 切成整数份，和严格等于 total（最大余数法）。 */
function splitTotal(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const base = raw.map(Math.floor);
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((_, i) => i).sort((a, b) => raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a])));
  for (const i of order) {
    if (rest <= 0) break;
    base[i] += 1;
    rest -= 1;
  }
  return base;
}

/** 从花费按 mockSessionUsage 的比例派生 token（total 为四项之和）。 */
function tokensForCost(cost: number): UsageTokens {
  if (cost <= 0) return zeroTokens();
  const input = Math.round(cost * 9766);
  const output = Math.round(cost * 3793);
  const cacheRead = Math.round(cost * 71651);
  const cacheWrite = Math.round(cost * 4696);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

const RANGE_BUDGET: Record<UsageRange, number> = {
  today: 4.86,
  "24h": 5.92,
  "7d": 28.44,
  "30d": 96.3,
  all: 192.6,
};

export function mockUsageStats(range: UsageRange): UsageStats {
  const now = new Date();
  const window = trendWindow(range, now);
  const sparse = range === "all";
  const weights = window.keys.map((_, i) =>
    window.unit === "hour"
      ? hourActivity(window.hours[i], i) * (range === "today" && window.hours[i] > now.getHours() ? 0 : 1)
      : dayActivity(i, sparse),
  );
  const budget = RANGE_BUDGET[range];
  const sum = weights.reduce((a, b) => a + b, 0);
  const points: UsageTrendPoint[] = window.keys.map((key, i) => {
    const cost = sum > 0 ? Math.round(((weights[i] / sum) * budget + Number.EPSILON) * 10000) / 10000 : 0;
    return { key, cost, tokens: tokensForCost(cost) };
  });
  const totalCost = Math.round(points.reduce((a, p) => a + p.cost, 0) * 10000) / 10000;
  const totalTokens = points.reduce<UsageTokens>((a, p) => addTokens(a, p.tokens), zeroTokens());
  // 主对话 / 后台 / 子代理沿用 mockSessionUsage 的大致比例，和严格等于 total。
  const main = Math.round(totalCost * 0.732 * 10000) / 10000;
  const background = Math.round(totalCost * 0.081 * 10000) / 10000;
  const subagent = Math.round((totalCost - main - background) * 10000) / 10000;
  const total: SessionUsage = {
    messages: {
      user: Math.max(1, Math.round((totalTokens.total / 1154400) * 24)),
      assistant: Math.max(1, Math.round((totalTokens.total / 1154400) * 86)),
    },
    tokens: totalTokens,
    cost: { total: totalCost, main, background, subagent },
    models: [],
  };
  const byModel: SessionUsage["models"] = [
    { provider: "anthropic", model: "claude-sonnet-4-5", messages: Math.max(1, Math.round(total.messages.assistant * 0.8)), cost: Math.round(totalCost * 0.813 * 10000) / 10000, tokens: tokensForCost(totalCost * 0.813) },
    { provider: "openai", model: "gpt-5", messages: Math.max(1, Math.round(total.messages.assistant * 0.2)), cost: 0, tokens: zeroTokens() },
  ];
  byModel[1].cost = Math.round((totalCost - byModel[0].cost) * 10000) / 10000;
  byModel[1].tokens = tokensForCost(byModel[1].cost);
  total.models = structuredClone(byModel);
  return {
    total,
    byProject: [
      { cwd: "/Users/demo/my/omp-resume", cost: Math.round(totalCost * 0.68 * 10000) / 10000, tokens: tokensForCost(totalCost * 0.68), sessions: 5 },
      { cwd: "/Users/demo/my/api-service", cost: Math.round(totalCost * 0.32 * 10000) / 10000, tokens: tokensForCost(totalCost * 0.32), sessions: 3 },
    ],
    byModel,
    trend: { unit: window.unit, points },
  };
}

export function mockEmptyUsageStats(range: UsageRange): UsageStats {
  const window = trendWindow(range, new Date());
  return {
    total: { messages: { user: 0, assistant: 0 }, tokens: zeroTokens(), cost: { total: 0, main: 0, background: 0, subagent: 0 }, models: [] },
    byProject: [],
    byModel: [],
    trend: {
      unit: window.unit,
      // 固定窗口补零；all 无数据日期则为空。
      points: range === "all" ? [] : window.keys.map((key) => ({ key, cost: 0, tokens: zeroTokens() })),
    },
  };
}

const KIND_ORDER: { kind: ErrorKind; w: number }[] = [
  { kind: "rate_limit", w: 0.3 },
  { kind: "timeout", w: 0.2 },
  { kind: "network", w: 0.15 },
  { kind: "server", w: 0.12 },
  { kind: "quota", w: 0.1 },
  { kind: "auth", w: 0.05 },
  { kind: "other", w: 0.08 },
];

const KIND_MESSAGE: Record<ErrorKind, string> = {
  quota: "本月免费额度已用尽，本次请求被拒绝（429 quota exceeded）",
  rate_limit: "请求过于频繁触发限流，429，需等待 30 秒后重试",
  auth: "API Key 已过期，鉴权失败（401 unauthorized）",
  timeout: "上游 60 秒未响应，请求超时（upstream timeout）",
  network: "连接被重置（ECONNRESET），请检查本地网络或代理",
  server: "上游返回 500，服务暂时不可用，请稍后重试",
  other: "未知错误：unexpected response shape（request-id 8f3a…c21d）",
};

const HEALTH_SCALE: Record<UsageRange, { requests: number; errors: number; aborted: number; fallbacks: number; hitRate: number }> = {
  today: { requests: 132, errors: 6, aborted: 2, fallbacks: 3, hitRate: 0.62 },
  "24h": { requests: 168, errors: 7, aborted: 3, fallbacks: 4, hitRate: 0.58 },
  "7d": { requests: 940, errors: 38, aborted: 11, fallbacks: 21, hitRate: 0.66 },
  "30d": { requests: 3820, errors: 141, aborted: 46, fallbacks: 88, hitRate: 0.71 },
  all: { requests: 7640, errors: 282, aborted: 90, fallbacks: 175, hitRate: 0.69 },
};

const HEALTH_MODELS: { provider: string; model: string }[] = [
  { provider: "anthropic", model: "claude-sonnet-4-5" },
  { provider: "openai", model: "gpt-5" },
  { provider: "deepseek", model: "deepseek-chat" },
];

export function mockUsageHealth(range: UsageRange): UsageHealth {
  const now = Date.now();
  const scale = HEALTH_SCALE[range];
  const window = trendWindow(range, new Date(now));
  const sparse = range === "all";
  const weights = window.keys.map((_, i) =>
    window.unit === "hour"
      ? hourActivity(window.hours[i], i + 40) * (range === "today" && window.hours[i] > new Date(now).getHours() ? 0 : 1)
      : dayActivity(i + 40, sparse),
  );
  const reqParts = splitTotal(scale.requests, weights);
  const errParts = splitTotal(scale.errors, weights);
  const fbParts = splitTotal(scale.fallbacks, weights);
  const points: UsageHealthTimelinePoint[] = window.keys.map((key, i) => {
    const promptTokens = reqParts[i] === 0 ? 0 : Math.round(reqParts[i] * 4200 * (0.6 + 0.8 * weight(i, 51)));
    const cacheRead = promptTokens === 0 ? 0 : Math.round(promptTokens * scale.hitRate * (0.8 + 0.4 * weight(i, 53)));
    return { key, requests: reqParts[i], errors: errParts[i], fallbacks: fbParts[i], cacheRead, promptTokens };
  });

  const kindCounts = splitTotal(scale.errors, KIND_ORDER.map((k) => k.w));
  const byKind = KIND_ORDER.map((k, i) => ({ kind: k.kind, count: kindCounts[i] })).filter((e) => e.count > 0);
  const recentKinds = byKind.length > 0 ? byKind : [{ kind: "other" as ErrorKind, count: 0 }];
  const recentCount = Math.min(20, scale.errors + 2);
  const recent = Array.from({ length: recentCount }, (_, i) => {
    const m = HEALTH_MODELS[i % HEALTH_MODELS.length];
    const kind = recentKinds[i % recentKinds.length].kind;
    return {
      time: now - i * 47 * 60000 - Math.round(weight(i, 61) * 20 * 60000),
      provider: m.provider,
      model: m.model,
      kind,
      message: KIND_MESSAGE[kind],
    };
  });

  const toAnthropic = Math.ceil(scale.fallbacks * 0.6);
  const byTarget = [
    { provider: "anthropic", model: "claude-haiku-4-5", count: toAnthropic },
    { provider: "deepseek", model: "deepseek-chat", count: scale.fallbacks - toAnthropic },
  ].filter((t) => t.count > 0);
  const recentFbCount = Math.min(8, scale.fallbacks);
  const fbRecent = Array.from({ length: recentFbCount }, (_, i) => ({
    time: now - i * 95 * 60000 - Math.round(weight(i, 67) * 30 * 60000),
    from: i % 4 === 3 ? null : { provider: "anthropic", model: "claude-sonnet-4-5" },
    to: byTarget[i % byTarget.length],
  }));

  const input = Math.round(scale.requests * 4200);
  const read = Math.round(input * scale.hitRate);
  const write = Math.round(input * 0.06);
  const mainReq = Math.round(scale.requests * 0.8);
  return {
    requests: scale.requests,
    errors: { total: scale.errors, aborted: scale.aborted, byKind, recent },
    fallbacks: { total: scale.fallbacks, byTarget, recent: fbRecent },
    cache: {
      hitRate: scale.hitRate,
      read,
      write,
      input,
      byModel: [
        { provider: "anthropic", model: "claude-sonnet-4-5", requests: mainReq, hitRate: scale.hitRate },
        // openai 上游不返回缓存数据：hitRate 为 null，界面显示“—”。
        { provider: "openai", model: "gpt-5", requests: scale.requests - mainReq, hitRate: null },
      ],
    },
    timeline: { unit: window.unit, points },
  };
}

export function mockEmptyUsageHealth(range: UsageRange): UsageHealth {
  const window = trendWindow(range, new Date());
  return {
    requests: 0,
    errors: { total: 0, aborted: 0, byKind: [], recent: [] },
    fallbacks: { total: 0, byTarget: [], recent: [] },
    cache: { hitRate: null, read: 0, write: 0, input: 0, byModel: [] },
    timeline: {
      unit: window.unit,
      points: range === "all" ? [] : window.keys.map((key) => ({ key, requests: 0, errors: 0, fallbacks: 0, cacheRead: 0, promptTokens: 0 })),
    },
  };
}
