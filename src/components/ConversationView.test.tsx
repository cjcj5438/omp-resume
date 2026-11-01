/** ConversationView：D2 消息头/时间 / D3 全宽文本 / D4 配对 tool-card / D5 思考折叠 / D6 用量行 / D7 双线分隔 / 定位。 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ConversationView } from "./ConversationView";
import type { AssistantBlock, Conversation, ConversationItem } from "../types";

function conv(items: Conversation["items"]): Conversation {
  return { path: "test", leafId: null, targetId: "", branchPointId: null, items };
}

function user(id: string, text: string, timestamp: string | null = "2026-10-31T14:09:00.000Z"): ConversationItem {
  return { kind: "user", id, timestamp, text };
}

function assistant(id: string, blocks: AssistantBlock[], timestamp: string | null = "2026-10-31T14:10:00.000Z"): ConversationItem {
  return { kind: "assistant", id, timestamp, blocks };
}

function toolResult(
  id: string,
  overrides: Partial<Extract<ConversationItem, { kind: "toolResult" }>> = {},
): ConversationItem {
  return {
    kind: "toolResult",
    id,
    timestamp: "2026-10-31T14:08:00.000Z",
    toolCallId: "c1",
    toolName: "read",
    isError: false,
    text: "ok",
    truncated: false,
    durationMs: null,
    diff: null,
    ...overrides,
  };
}

const noop = () => {};

describe("ConversationView 对话渲染", () => {
  it("D2 消息头：role 大写 + node-id chip + 右侧 time", () => {
    // 本地无时区时间串：解析与展示同口径，不依赖机器 TZ。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-31T18:00:00"));
      const { container } = render(
        <ConversationView conversation={conv([user("n8", "帮我重构一下", "2026-10-31T14:09:00")])} loading={false} error={null} onRetry={noop} />,
      );
      const head = container.querySelector(".msg.user .msg-head");
      expect(head?.querySelector(".role.user")?.textContent).toBe("用户");
      expect(head?.querySelector(".node-id")?.textContent).toBe("n8");
      expect(head?.querySelector(".msg-time")?.textContent).toBe("14:09");
    } finally {
      vi.useRealTimers();
    }
  });
  it("D2 分支点用户节点显示 warn 徽章", () => {
    const c = conv([user("n8", "hi"), user("n9", "hello")]);
    c.branchPointId = "n9";
    const { container } = render(
      <ConversationView conversation={c} loading={false} error={null} onRetry={noop} />,
    );
    const heads = [...container.querySelectorAll(".msg.user .msg-head")];
    expect(heads).toHaveLength(2);
    expect(heads[0]?.querySelector(".badge")).toBeNull();
    const badge = heads[1]?.querySelector(".badge.badge-warn");
    expect(badge?.textContent).toBe("分支点");
  });


  it("D2 非今天显示 M月d日 HH:MM", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-05T18:00:00"));
      const { container } = render(
        <ConversationView conversation={conv([user("n8", "hi", "2026-10-31T14:09:00")])} loading={false} error={null} onRetry={noop} />,
      );
      expect(container.querySelector(".msg-time")?.textContent).toBe("10月31日 14:09");
    } finally {
      vi.useRealTimers();
    }
  });

  it("D2 非法 ISO 透传原串", () => {
    const { container } = render(
      <ConversationView conversation={conv([user("n8", "hi", "not-a-time")])} loading={false} error={null} onRetry={noop} />,
    );
    expect(container.querySelector(".msg-time")?.textContent).toBe("not-a-time");
  });

  it("D2 timestamp null 显示 —", () => {
    const { container } = render(
      <ConversationView conversation={conv([user("n8", "hi", null)])} loading={false} error={null} onRetry={noop} />,
    );
    expect(container.querySelector(".msg-time")?.textContent).toBe("—");
  });

  it("D3 用户消息是全宽文本而非右对齐气泡", () => {
    const { container } = render(
      <ConversationView conversation={conv([user("n8", "帮我重构一下")])} loading={false} error={null} onRetry={noop} />,
    );
    expect(container.querySelector(".bubble-user")).toBeNull();
    expect(container.querySelector(".conv-user")).toBeNull();
    expect(container.querySelector(".msg.user .msg-body p")?.textContent).toBe("帮我重构一下");
  });

  it("D4 配对：一次调用只渲染一张卡（参数摘要 + 结果状态/时长/输出）", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([
          assistant("n5", [{ kind: "toolCall", id: "c1", name: "read", args: { path: "src/auth.ts" }, pending: false }]),
          toolResult("n6", { toolCallId: "c1", toolName: "read", text: "file content", durationMs: 118 }),
        ])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const cards = container.querySelectorAll(".tool-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".tool-name")?.textContent).toBe("read");
    expect(cards[0].querySelector(".tool-arg")?.textContent).toBe("src/auth.ts");
    expect(cards[0].querySelector(".tool-status")?.textContent).toContain("完成");
    expect(cards[0].querySelector(".tool-status")?.textContent).toContain("118 ms");
    expect(cards[0].querySelector(".tool-body pre")?.textContent).toBe("file content");
    // 被配对消费的 toolResult 不再单独渲染。
    expect(cards[0].getAttribute("data-result-id")).toBe("n6");
  });

  it("D4 工具出错显示失败状态与红色状态点", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([
          assistant("n5", [{ kind: "toolCall", id: "c1", name: "glob", args: { pattern: "src/**" }, pending: false }]),
          toolResult("n7", { toolCallId: "c1", toolName: "glob", isError: true, text: "Error: pattern too broad" }),
        ])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
    const status = container.querySelector(".tool-status.err");
    expect(status?.textContent).toContain("失败");
    expect(status?.querySelector(".dot.bad")).not.toBeNull();
  });

  it("D4 孤儿 toolResult 单独成卡且不显示 call id", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([toolResult("n7", { toolCallId: "lost-call", toolName: "glob", isError: true, text: "boom" })])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const card = container.querySelector(".tool-card");
    expect(card?.querySelector(".tool-name")?.textContent).toBe("glob");
    expect(card?.querySelector(".tool-arg")).toBeNull();
    expect(card?.textContent).not.toContain("lost-call");
    expect(card?.querySelector(".tool-status.err")?.textContent).toContain("失败");
  });

  it("D4 call 无 result 且非 pending 显示无结果", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([assistant("n9", [{ kind: "toolCall", id: "c9", name: "bash", args: { cmd: "cargo test" }, pending: false }])])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const status = container.querySelector(".tool-status.mute");
    expect(status?.textContent).toContain("无结果");
  });

  it("D4 时长与 diff foot：durationMs 格式化 + diff 行数统计", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([
          assistant("n5", [{ kind: "toolCall", id: "c1", name: "edit", args: { path: "tree.rs" }, pending: false }]),
          toolResult("n6", {
            toolCallId: "c1",
            toolName: "edit",
            durationMs: 8400,
            // omp 行号渲染（空格开头上下文，+行号新增，-行号删除）。
            diff: " 228|fn layout() {\n+229|  let x = 1;\n+230|  let y = 2;\n+231|  let z = 3;\n 232|}\n-233|  old_line();\n-234|  old_line2();",
          }),
        ])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
    expect(container.querySelector(".tool-status")?.textContent).toContain("8.4 s");
    const foot = container.querySelector(".tool-card .tool-foot");
    expect(foot?.textContent).toContain("+3 −2");
    expect(foot?.textContent).toContain("diff");
  });

  it("D4 无时长/diff 时不显示对应部位", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([
          assistant("n5", [{ kind: "toolCall", id: "c1", name: "read", args: { path: "a.ts" }, pending: false }]),
          toolResult("n3", { toolCallId: "c1" }),
        ])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(container.querySelector(".tool-status")?.textContent).toBe("完成");
    expect(container.querySelector(".tool-foot")).toBeNull();
  });

  it("D4 toolCall pending 显示运行中", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([assistant("n9", [{ kind: "toolCall", id: "c9", name: "bash", args: { cmd: "cargo test" }, pending: true }])])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const status = container.querySelector(".tool-status.run");
    expect(status?.textContent).toContain("运行中");
    expect(status?.querySelector(".dot.live")).not.toBeNull();
  });

  it("D4 参数 details 默认折叠，点击展开完整 JSON", () => {
    const args = { path: "src/auth.ts", extra: "keep-me" };
    const { container } = render(
      <ConversationView
        conversation={conv([
          assistant("n5", [{ kind: "toolCall", id: "c1", name: "read", args, pending: false }]),
          toolResult("n6", { toolCallId: "c1", text: "out" }),
        ])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const details = container.querySelector("details.tool-params");
    expect(details).not.toBeNull();
    // 摘要只显示 path，完整参数收在折叠区。
    expect(container.querySelector(".tool-arg")?.textContent).toBe("src/auth.ts");
    expect((details as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(details?.querySelector("summary") as HTMLElement);
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(details?.querySelector("pre")?.textContent).toContain("keep-me");
  });

  it("D4 参数摘要回退到首个字符串值", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([
          assistant("n5", [{ kind: "toolCall", id: "c1", name: "read", args: { custom: "fallback-value", n: 1 }, pending: false }]),
          toolResult("n6", { toolCallId: "c1", text: "out" }),
        ])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(container.querySelector(".tool-arg")?.textContent).toBe("fallback-value");
  });

  it("D4 截断输出在 tool-foot 标注已截断", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([toolResult("n3", { text: "line1\nline2", truncated: true })])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const foot = container.querySelector(".tool-foot");
    expect(foot?.textContent).toContain("已截断");
    expect(foot?.textContent).toContain("8KB");
  });

  it("D5 思考折叠默认收起，点击可展开", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([assistant("n4", [{ kind: "thinking", text: "先看目录结构" }])])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const details = container.querySelector("details.think");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain("思考过程 · 已折叠");
    expect((details as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(details?.querySelector("summary") as HTMLElement);
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(details?.querySelector("p")?.textContent).toBe("先看目录结构");
  });

  it("D6 用量记录行：purpose + 模型/输入/输出/缓存/成本", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([
          {
            kind: "usage",
            id: "n12",
            timestamp: "2026-10-31T14:15:00.000Z",
            purpose: "main",
            provider: "anthropic",
            model: "claude-opus-4.6",
            input: 84200,
            output: 12600,
            cacheRead: 91200,
            cacheWrite: 0,
            cost: 0.86,
          },
        ])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    const line = container.querySelector(".usage-line");
    expect(line?.textContent).toContain("用量记录");
    expect(line?.querySelector(".usage-purpose")?.textContent).toBe("main");
    expect(line?.textContent).toContain("claude-opus-4.6");
    expect(line?.textContent).toContain("84.2k");
    expect(line?.textContent).toContain("12.6k");
    expect(line?.textContent).toContain("91.2k");
    expect(line?.textContent).toContain("$0.86");
  });

  it("D7 压缩分隔是双线 divider-note", () => {
    const { container } = render(
      <ConversationView
        conversation={conv([{ kind: "compaction", id: "n13", timestamp: null, summary: "此前讨论了鉴权方案" }])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(container.querySelector(".conv-divider")).toBeNull();
    expect(container.querySelector(".divider-note")?.textContent).toContain("已压缩上下文");
    expect(container.querySelector(".divider-note + .msg .msg-body p")?.textContent).toBe("此前讨论了鉴权方案");
  });

  it("activeNodeId 定位到条目并高亮，找不到静默 no-op", () => {
    vi.useFakeTimers();
    try {
      const scrollIntoView = vi.fn();
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      const { container, rerender } = render(
        <ConversationView
          conversation={conv([user("n8", "第一条"), user("n9", "第二条")])}
          loading={false}
          error={null}
          onRetry={noop}
          activeNodeId="n9"
        />,
      );
      const target = container.querySelector('[data-node-id="n9"]');
      expect(scrollIntoView).toHaveBeenCalled();
      expect(target?.classList.contains("is-located")).toBe(true);
      // 找不到 id：不抛错、不高亮。
      rerender(
        <ConversationView
          conversation={conv([user("n8", "第一条")])}
          loading={false}
          error={null}
          onRetry={noop}
          activeNodeId="missing"
        />,
      );
      expect(container.querySelector(".is-located")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R4 被配对消费的 toolResult id 定位到合成卡", () => {
    vi.useFakeTimers();
    try {
      const scrollIntoView = vi.fn();
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      const { container } = render(
        <ConversationView
          conversation={conv([
            assistant("n5", [{ kind: "toolCall", id: "c1", name: "read", args: { path: "a.ts" }, pending: false }]),
            toolResult("n6", { toolCallId: "c1", text: "out" }),
          ])}
          loading={false}
          error={null}
          onRetry={noop}
          activeNodeId="n6"
        />,
      );
      // n6 的独立条目已被消费：data-node-id 不存在，回退高亮合成卡。
      expect(container.querySelector('[data-node-id="n6"]')).toBeNull();
      const card = container.querySelector('[data-result-id="n6"]');
      expect(card?.classList.contains("is-located")).toBe(true);
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
