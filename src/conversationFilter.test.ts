/** 对话类型过滤与最近节点单测。 */
import { describe, expect, it } from "vitest";
import type { ConversationItem } from "./types";
import { filterConversation, recentTurns } from "./conversationFilter";

const items: ConversationItem[] = [
  { kind: "user", text: "你好" },
  {
    kind: "assistant",
    blocks: [
      { kind: "thinking", text: "想一想" },
      { kind: "text", text: "你好呀" },
      { kind: "toolCall", id: "c1", name: "read", args: {} },
    ],
  },
  { kind: "toolResult", toolCallId: "c1", toolName: "read", isError: false, text: "内容", truncated: false },
  { kind: "bashExecution", command: "ls", text: "a", truncated: false, exitCode: 0, cancelled: false },
  { kind: "assistant", blocks: [{ kind: "toolCall", id: "c2", name: "bash", args: {} }] },
  { kind: "compaction", summary: "压缩" },
  { kind: "branchSummary", summary: "分支" },
  { kind: "other", role: "system", text: "x" },
];

describe("filterConversation", () => {
  it("all 返回同一引用", () => {
    expect(filterConversation(items, "all")).toBe(items);
  });

  it("chat 只留 user 与 text blocks，无 text 的 assistant 整条丢弃", () => {
    const out = filterConversation(items, "chat");
    expect(out).toEqual([
      { kind: "user", text: "你好" },
      { kind: "assistant", blocks: [{ kind: "text", text: "你好呀" }] },
    ]);
  });

  it("tools 保留 toolCall/toolResult/bashExecution", () => {
    const out = filterConversation(items, "tools");
    expect(out).toEqual([
      { kind: "assistant", blocks: [{ kind: "toolCall", id: "c1", name: "read", args: {} }] },
      { kind: "toolResult", toolCallId: "c1", toolName: "read", isError: false, text: "内容", truncated: false },
      { kind: "bashExecution", command: "ls", text: "a", truncated: false, exitCode: 0, cancelled: false },
      { kind: "assistant", blocks: [{ kind: "toolCall", id: "c2", name: "bash", args: {} }] },
    ]);
  });

  it("thinking 只留 thinking blocks；非 all 丢弃 compaction/branchSummary/other", () => {
    const out = filterConversation(items, "thinking");
    expect(out).toEqual([{ kind: "assistant", blocks: [{ kind: "thinking", text: "想一想" }] }]);
  });
});

describe("recentTurns", () => {
  it("从尾部取 n 条有文本的轮次，按时间正序", () => {
    const turns: ConversationItem[] = [
      { kind: "user", text: "一" },
      { kind: "assistant", blocks: [{ kind: "text", text: "一答" }] },
      { kind: "compaction", summary: "压缩" },
      { kind: "user", text: "二" },
      { kind: "assistant", blocks: [{ kind: "toolCall", id: "c", name: "x", args: {} }] },
      { kind: "assistant", blocks: [{ kind: "text", text: "二答" }] },
    ];
    expect(recentTurns(turns, 4)).toEqual([
      { role: "user", text: "一" },
      { role: "assistant", text: "一答" },
      { role: "user", text: "二" },
      { role: "assistant", text: "二答" },
    ]);
    // 无文本 assistant 被跳过，n=2 取最后两条有文本的。
    expect(recentTurns(turns, 2)).toEqual([
      { role: "user", text: "二" },
      { role: "assistant", text: "二答" },
    ]);
  });

  it("超长截断到 160 字加 …，多 text blocks 以换行连接", () => {
    const long = "a".repeat(200);
    const out = recentTurns(
      [{ kind: "assistant", blocks: [{ kind: "text", text: "x" }, { kind: "text", text: long }] }],
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    expect(out[0].text).toBe(`x\n${"a".repeat(158)}…`);
  });
});
