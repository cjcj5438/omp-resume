/** 对话类型过滤与最近节点提取：纯函数。 */
import type { ConversationItem } from "./types";

export type ConversationFilter = "all" | "chat" | "tools" | "thinking";

/** 最近节点截断长度（字符），超出加 `…`。 */
export const RECENT_TURN_MAX_CHARS = 160;

/**
 * 按类型过滤对话条目：
 * - 零用量 usage（input/output/cache 全 0 且 cost 为 0）：所有筛选一律丢弃
 *   （后端全量返回，前端隐藏，见 CONTRACT §4.3）。
 * - all：原样返回（零用量丢弃后；无零用量时同一引用）。
 * - chat：保留 user；assistant 只留 text blocks，无 text 时整条丢弃。
 * - tools：assistant 只留 toolCall blocks，无时整条丢弃；保留 toolResult/bashExecution。
 * - thinking：assistant 只留 thinking blocks，无时整条丢弃。
 * 非 all 时丢弃 compaction/branchSummary/usage/other。
 */
function isZeroUsage(item: ConversationItem): boolean {
  return (
    item.kind === "usage" &&
    item.input === 0 &&
    item.output === 0 &&
    item.cacheRead === 0 &&
    item.cacheWrite === 0 &&
    item.cost === 0
  );
}
export function filterConversation(items: ConversationItem[], f: ConversationFilter): ConversationItem[] {
  const live = items.some(isZeroUsage) ? items.filter((i) => !isZeroUsage(i)) : items;
  if (f === "all") return live;
  const out: ConversationItem[] = [];
  for (const item of live) {
    if (item.kind === "user") {
      if (f === "chat") out.push(item);
      continue;
    }
    if (item.kind === "assistant") {
      const want = f === "chat" ? "text" : f === "tools" ? "toolCall" : "thinking";
      const blocks = item.blocks.filter((b) => b.kind === want);
      if (blocks.length > 0) out.push({ kind: "assistant", id: item.id, timestamp: item.timestamp, blocks });
      continue;
    }
    if (item.kind === "toolResult" || item.kind === "bashExecution") {
      if (f === "tools") out.push(item);
      continue;
    }
    // compaction / branchSummary / usage / other：非 all 时一律丢弃。
  }
  return out;
}

/**
 * 从尾部取最近 n 条有文本的 user/assistant，assistant 文本用 text blocks 以 `\n` 连接，
 * 截断到 160 字加 `…`，无文本条目跳过，结果按时间正序。
 */
export function recentTurns(
  items: ConversationItem[],
  n: number,
): { role: "user" | "assistant"; id: string; time: string | null; text: string }[] {
  const picked: { role: "user" | "assistant"; id: string; time: string | null; text: string }[] = [];
  for (let i = items.length - 1; i >= 0 && picked.length < n; i -= 1) {
    const item = items[i];
    if (item.kind === "user") {
      if (item.text !== "") picked.push({ role: "user", id: item.id, time: item.timestamp, text: truncate(item.text) });
    } else if (item.kind === "assistant") {
      const text = item.blocks
        .filter((b) => b.kind === "text")
        .map((b) => b.text)
        .join("\n");
      if (text !== "") picked.push({ role: "assistant", id: item.id, time: item.timestamp, text: truncate(text) });
    }
  }
  return picked.reverse();
}

function truncate(text: string): string {
  return text.length > RECENT_TURN_MAX_CHARS ? `${text.slice(0, RECENT_TURN_MAX_CHARS)}…` : text;
}
