/** 提示词历史的项目过滤：纯函数。 */
import type { PromptHistoryEntry } from "./types";

/** cwd 缺失条目的分组键。 */
export const HISTORY_NO_PROJECT = "__none__";

export interface HistoryProject {
  value: string;
  label: string;
  count: number;
}

/**
 * 按 cwd 分组：value 为 cwd（缺失时为 `__none__`），label 为 cwd 末段加计数，
 * 缺失组标签为「未记录目录」；按 count 倒序。
 */
export function historyProjects(entries: PromptHistoryEntry[]): HistoryProject[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = e.cwd ?? HISTORY_NO_PROJECT;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]): HistoryProject => {
      if (value === HISTORY_NO_PROJECT) return { value, label: `未记录目录（${count}）`, count };
      const name = value.split("/").filter(Boolean).pop() ?? value;
      return { value, label: `${name}（${count}）`, count };
    })
    .sort((a, b) => b.count - a.count);
}

/** 按项目值过滤；`all` 原样返回同一引用。 */
export function filterHistoryByProject(
  entries: PromptHistoryEntry[],
  value: string | "all",
): PromptHistoryEntry[] {
  if (value === "all") return entries;
  if (value === HISTORY_NO_PROJECT) return entries.filter((e) => e.cwd === null);
  return entries.filter((e) => e.cwd === value);
}

/**
 * 绝对时间（设计稿口径）：今天 HH:MM / 昨天 HH:MM / M月d日。
 * 无效时间返回空串（调用方渲染「—」）。
 */
export function formatHistoryTime(iso: string, nowMs = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const now = new Date(nowMs);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return hm;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
