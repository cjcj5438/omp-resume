/** 对话类型过滤与最近节点单测。 */
import { describe, expect, it } from "vitest";
import type { ConversationItem } from "./types";
import { filterConversation, recentTurns } from "./conversationFilter";

const T = "2026-10-26T08:11:51.128Z";
const items: ConversationItem[] = [
  { kind: "user", id: "u1", timestamp: T, text: "你好" },
  {
    kind: "assistant",
    id: "a1",
    timestamp: T,
    blocks: [
      { kind: "thinking", text: "想一想" },
      { kind: "text", text: "你好呀" },
      { kind: "toolCall", id: "c1", name: "read", args: {}, pending: false },
    ],
  },
  { kind: "toolResult", id: "t1", timestamp: T, toolCallId: "c1", toolName: "read", isError: false, text: "内容", truncated: false, durationMs: 7, diff: null },
  { kind: "bashExecution", id: "b1", timestamp: T, command: "ls", text: "a", truncated: false, exitCode: 0, cancelled: false },
  { kind: "assistant", id: "a2", timestamp: T, blocks: [{ kind: "toolCall", id: "c2", name: "bash", args: {}, pending: true }] },
  { kind: "compaction", id: "cp1", timestamp: T, summary: "压缩" },
  { kind: "branchSummary", id: "bs1", timestamp: T, summary: "分支" },
  { kind: "other", id: "o1", timestamp: T, role: "system", text: "x" },
];

describe("filterConversation", () => {
  it("all 返回同一引用", () => {
    expect(filterConversation(items, "all")).toBe(items);
  });

  it("chat 只留 user 与 text blocks，无 text 的 assistant 整条丢弃", () => {
    const out = filterConversation(items, "chat");
    expect(out).toEqual([
      { kind: "user", id: "u1", timestamp: T, text: "你好" },
      { kind: "assistant", id: "a1", timestamp: T, blocks: [{ kind: "text", text: "你好呀" }] },
    ]);
  });

  it("tools 保留 toolCall/toolResult/bashExecution", () => {
    const out = filterConversation(items, "tools");
    expect(out).toEqual([
      { kind: "assistant", id: "a1", timestamp: T, blocks: [{ kind: "toolCall", id: "c1", name: "read", args: {}, pending: false }] },
      { kind: "toolResult", id: "t1", timestamp: T, toolCallId: "c1", toolName: "read", isError: false, text: "内容", truncated: false, durationMs: 7, diff: null },
      { kind: "bashExecution", id: "b1", timestamp: T, command: "ls", text: "a", truncated: false, exitCode: 0, cancelled: false },
      { kind: "assistant", id: "a2", timestamp: T, blocks: [{ kind: "toolCall", id: "c2", name: "bash", args: {}, pending: true }] },
    ]);
  });

  it("thinking 只留 thinking blocks；非 all 丢弃 compaction/branchSummary/usage/other", () => {
    const out = filterConversation(items, "thinking");
    expect(out).toEqual([{ kind: "assistant", id: "a1", timestamp: T, blocks: [{ kind: "thinking", text: "想一想" }] }]);
  });

  it("零用量 usage 所有筛选都丢弃；非零 usage 只在 all 出现", () => {
    const zero: ConversationItem = { kind: "usage", id: "g0", timestamp: T, purpose: "job-widget", provider: "p", model: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const live: ConversationItem = { kind: "usage", id: "g1", timestamp: T, purpose: "job-widget", provider: "p", model: "m", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
    const withUsage = [...items, zero, live];
    const all = filterConversation(withUsage, "all");
    expect(all).toContain(live);
    expect(all).not.toContain(zero);
    expect(all.length).toBe(items.length + 1);
    for (const f of ["chat", "tools", "thinking"] as const) {
      const out = filterConversation(withUsage, f);
      expect(out).not.toContain(zero);
      expect(out).not.toContain(live);
    }
  });
});

describe("recentTurns", () => {
  it("从尾部取 n 条有文本的轮次，按时间正序", () => {
    const turns: ConversationItem[] = [
      { kind: "user", id: "u1", timestamp: T, text: "一" },
      { kind: "assistant", id: "a1", timestamp: T, blocks: [{ kind: "text", text: "一答" }] },
      { kind: "compaction", id: "cp1", timestamp: T, summary: "压缩" },
      { kind: "user", id: "u2", timestamp: T, text: "二" },
      { kind: "assistant", id: "a2", timestamp: T, blocks: [{ kind: "toolCall", id: "c", name: "x", args: {}, pending: false }] },
      { kind: "assistant", id: "a3", timestamp: T, blocks: [{ kind: "text", text: "二答" }] },
    ];
    expect(recentTurns(turns, 4)).toEqual([
      { role: "user", id: "u1", time: T, text: "一" },
      { role: "assistant", id: "a1", time: T, text: "一答" },
      { role: "user", id: "u2", time: T, text: "二" },
      { role: "assistant", id: "a3", time: T, text: "二答" },
    ]);
    // 无文本 assistant 被跳过，n=2 取最后两条有文本的。
    expect(recentTurns(turns, 2)).toEqual([
      { role: "user", id: "u2", time: T, text: "二" },
      { role: "assistant", id: "a3", time: T, text: "二答" },
    ]);
  });

  it("超长截断到 160 字加 …，多 text blocks 以换行连接", () => {
    const long = "a".repeat(200);
    const out = recentTurns(
      [{ kind: "assistant", id: "a9", timestamp: null, blocks: [{ kind: "text", text: "x" }, { kind: "text", text: long }] }],
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    expect(out[0].text).toBe(`x\n${"a".repeat(158)}…`);
  });
});
