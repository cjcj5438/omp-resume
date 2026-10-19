import type { ErrorKind, UsageTrendUnit } from "../types";

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
