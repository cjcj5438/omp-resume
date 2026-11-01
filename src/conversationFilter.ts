/** 对话类型过滤与最近节点提取：纯函数。 */
import type { ConversationItem } from "./types";

export type ConversationFilter = "all" | "chat" | "tools" | "thinking";

/** 最近节点截断长度（字符），超出加 `…`。 */
export const RECENT_TURN_MAX_CHARS = 160;

/**
 * 按类型过滤对话条目：
 * - all：原样返回同一引用。
 * - chat：保留 user；assistant 只留 text blocks，无 text 时整条丢弃。
 * - tools：assistant 只留 toolCall blocks，无时整条丢弃；保留 toolResult/bashExecution。
 * - thinking：assistant 只留 thinking blocks，无时整条丢弃。
 * 非 all 时丢弃 compaction/branchSummary/other。
 */
export function filterConversation(items: ConversationItem[], f: ConversationFilter): ConversationItem[] {
  if (f === "all") return items;
  const out: ConversationItem[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      if (f === "chat") out.push(item);
      continue;
    }
    if (item.kind === "assistant") {
      const want = f === "chat" ? "text" : f === "tools" ? "toolCall" : "thinking";
      const blocks = item.blocks.filter((b) => b.kind === want);
      if (blocks.length > 0) out.push({ kind: "assistant", blocks });
      continue;
    }
    if (item.kind === "toolResult" || item.kind === "bashExecution") {
      if (f === "tools") out.push(item);
      continue;
    }
    // compaction / branchSummary / other：非 all 时一律丢弃。
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
): { role: "user" | "assistant"; text: string }[] {
  const picked: { role: "user" | "assistant"; text: string }[] = [];
  for (let i = items.length - 1; i >= 0 && picked.length < n; i -= 1) {
    const item = items[i];
    if (item.kind === "user") {
      if (item.text !== "") picked.push({ role: "user", text: truncate(item.text) });
    } else if (item.kind === "assistant") {
      const text = item.blocks
        .filter((b) => b.kind === "text")
        .map((b) => b.text)
        .join("\n");
      if (text !== "") picked.push({ role: "assistant", text: truncate(text) });
    }
  }
  return picked.reverse();
}

function truncate(text: string): string {
  return text.length > RECENT_TURN_MAX_CHARS ? `${text.slice(0, RECENT_TURN_MAX_CHARS)}…` : text;
}
