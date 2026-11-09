import type { UsageTokens, UsageTrendUnit } from "../types";

/** 缓存命中率：null 显示“—”，不画成 0%。 */
export function formatHitRate(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
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
