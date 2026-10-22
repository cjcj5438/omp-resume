import type { ErrorKind, UsageTokens, UsageTrendUnit } from "../types";

/** ErrorKind 中文映射（契约固定 7 种）。 */
export const ERROR_KIND_NAME: Record<ErrorKind, string> = {
  quota: "额度用尽",
  rate_limit: "触发限流",
  auth: "鉴权失败",
  timeout: "响应超时",
  network: "网络异常",
  server: "服务端错误",
  other: "其他",
};

/** 缓存命中率：null 显示“—”，不画成 0%。 */
export function formatHitRate(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** 错误率：无请求时为“—”。 */
export function formatErrorRate(errors: number, requests: number): string {
  if (requests <= 0) return "—";
  return `${((errors / requests) * 100).toFixed(1)}%`;
}

/**
 * 分桶横轴标签：hour 桶 "YYYY-MM-DD HH" 取 "HH:00"，
 * day 桶 "YYYY-MM-DD" 取去前导零的 "M-D"。
 */
export function tickLabel(key: string, unit: UsageTrendUnit): string {
  if (unit === "hour") return `${key.slice(11, 13)}:00`;
  const [m, d] = key.slice(5).split("-");
  return `${Number(m)}-${Number(d)}`;
}

/** 稀疏取下标：均匀取至多 max 个，恒含首尾，保证横轴不拥挤。 */
export function sparseIndexes(count: number, max = 6): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (max - 1);
  const picked: number[] = [];
  for (let i = 0; i < max; i += 1) {
    const idx = Math.round(i * step);
    if (!picked.includes(idx)) picked.push(idx);
  }
  return picked;
}

/** 柱高：按最大值归一到 maxHeight；非零值至少 2px 可见，零值保持 0。 */
export function barHeights(values: number[], maxHeight: number): number[] {
  const max = Math.max(0, ...values);
  if (max <= 0 || maxHeight <= 0) return values.map(() => 0);
  const floor = Math.min(2, maxHeight);
  return values.map((v) => {
    if (v <= 0) return 0;
    return Math.max(floor, Math.round((v / max) * maxHeight));
  });
}

/** 每桶缓存命中率：无 prompt token 的桶为 null（折线断线，不画 0）。 */
export function cacheHitSeries(points: { cacheRead: number; promptTokens: number }[]): (number | null)[] {
  return points.map((p) => {
    if (p.promptTokens <= 0) return null;
    return Math.min(1, Math.max(0, p.cacheRead / p.promptTokens));
  });
}

/** 最近列表时间：本地 "M月D日 HH:MM"。 */
export function formatClock(time: number): string {
  const d = new Date(time);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 紧凑数字：<1000 原样，k/M/B 保留一位小数。 */
export function compactNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

/** 时长：59s / 15m31s / 1h1m（分钟取余，无补零）。 */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** 缓存命中率（与后端 hit_rate 同口径）：无缓存数据时 null。 */
export function cacheHitRate(t: UsageTokens): number | null {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  if (denom === 0 || (t.cacheRead === 0 && t.cacheWrite === 0)) return null;
  return t.cacheRead / denom;
}

/** 热力等级：0 → 0；非零按秩分 1–4（排名四分位）。 */
export function heatLevels(values: number[]): number[] {
  const nonzero = values.filter((v) => v > 0);
  if (nonzero.length === 0) return values.map(() => 0);
  return values.map((v) => {
    if (v <= 0) return 0;
    const rank = nonzero.filter((u) => u < v).length + 1;
    return Math.max(1, Math.ceil((4 * rank) / nonzero.length));
  });
}

export interface HeatCell { key: string; cost: number; tokens: number; level: number }

/** 热力列：周一为行 0，首尾补 null 至整列，每列 7 项。 */
export function heatGrid(cells: HeatCell[]): (HeatCell | null)[][] {
  const weekday = (key: string): number => {
    const [y, m, day] = key.slice(0, 10).split("-").map(Number);
    return (new Date(y, m - 1, day).getDay() + 6) % 7;
  };
  const cols: (HeatCell | null)[][] = [];
  if (cells.length === 0) return cols;
  let col: (HeatCell | null)[] = [];
  const pushCol = () => {
    while (col.length < 7) col.push(null);
    cols.push(col);
    col = [];
  };
  for (const cell of cells) {
    if (col.length === 0) {
      const w = weekday(cell.key);
      for (let i = 0; i < w; i += 1) col.push(null);
    }
    col.push(cell);
    if (col.length === 7) pushCol();
  }
  if (col.length > 0) pushCol();
  return cols;
}

/**
 * 活跃度汇总：活跃天数（花费 > 0）、合计花费、最高单日（同价取最早）、
 * 截至最后一天的连续活跃天数（末尾连续 >0 的天数）。
 */
export function activitySummary(days: { key: string; cost: number }[]): {
  activeDays: number;
  totalCost: number;
  best: { key: string; cost: number } | null;
  streak: number;
} {
  let activeDays = 0;
  let totalCost = 0;
  let best: { key: string; cost: number } | null = null;
  for (const d of days) {
    if (d.cost <= 0) continue;
    activeDays += 1;
    totalCost += d.cost;
    if (best === null || d.cost > best.cost) best = { key: d.key, cost: d.cost };
  }
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].cost <= 0) break;
    streak += 1;
  }
  return { activeDays, totalCost, best, streak };
}
