/** 提示词历史动作门禁：来源会话未加载 / cwd 为空时对应动作必须禁用；新会话只传目录。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { PromptHistoryView } from "./PromptHistoryView";
import type { PromptHistoryEntry } from "../types";

const ENTRIES: PromptHistoryEntry[] = [
  {
    id: 2,
    prompt: "来自已加载会话",
    cwd: "/w/alpha",
    sessionId: "s-loaded",
    createdAt: "2026-10-16T01:00:00.000Z",
    useCount: 2,
  },
  {
    id: 1,
    prompt: "来源会话已不在列表",
    cwd: null,
    sessionId: "s-gone",
    createdAt: "2026-10-15T01:00:00.000Z",
    useCount: 1,
  },
];

afterEach(() => clearMocks());

function renderView() {
  mockIPC((cmd) => (cmd === "search_prompt_history" ? ENTRIES : undefined));
  const onNewSessionIn = vi.fn();
  const onOpenSession = vi.fn();
  const onBack = vi.fn();
  render(
    <PromptHistoryView
      onBack={onBack}
      loadedSessionIds={new Set(["s-loaded"])}
      onOpenSession={onOpenSession}
      onNewSessionIn={onNewSessionIn}
      onToast={() => {}}
    />,
  );
  return { onNewSessionIn, onOpenSession, onBack };
}

describe("PromptHistoryView 动作门禁", () => {
  it("头部「返回」调 onBack", () => {
    const { onBack } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("来源会话未加载时禁用跳转；cwd 为空时禁用新会话", async () => {
    renderView();
    const gone = (await screen.findByText("来源会话已不在列表")).closest("li");
    expect(gone).not.toBeNull();
    expect(within(gone!).getByRole("button", { name: "跳到来源会话" })).toBeDisabled();
    expect(within(gone!).getByRole("button", { name: "在该目录新会话" })).toBeDisabled();
  });

  it("新会话只传目录，且仅在来源会话已加载时可跳转", async () => {
    const { onNewSessionIn, onOpenSession } = renderView();
    const loaded = (await screen.findByText("来自已加载会话")).closest("li");
    expect(loaded).not.toBeNull();
    const jump = within(loaded!).getByRole("button", { name: "跳到来源会话" });
    expect(jump).toBeEnabled();
    fireEvent.click(jump);
    expect(onOpenSession).toHaveBeenCalledWith("s-loaded");

    fireEvent.click(within(loaded!).getByRole("button", { name: "在该目录新会话" }));
    expect(onNewSessionIn).toHaveBeenCalledTimes(1);
    expect(onNewSessionIn).toHaveBeenCalledWith("/w/alpha");
  });
});

describe("PromptHistoryView 滚动结构", () => {
  it("列表在独立滚动区内，搜索栏在滚动区外（滚列表不带走头部）", async () => {
    const many: PromptHistoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i,
      prompt: `滚动条目 ${i}`,
      cwd: "/w/alpha",
      sessionId: "s-loaded",
      createdAt: "2026-10-16T01:00:00.000Z",
      useCount: 1,
    }));
    mockIPC((cmd) => (cmd === "search_prompt_history" ? many : undefined));
    render(
      <PromptHistoryView
        onBack={() => {}}
        loadedSessionIds={new Set(["s-loaded"])}
        onOpenSession={() => {}}
        onNewSessionIn={() => {}}
        onToast={() => {}}
      />,
    );
    const items = await screen.findAllByText(/滚动条目 \d+/);
    expect(items).toHaveLength(30);
    // 滚动区存在，且是每条条目的祖先：长列表只能在它内部滚动。
    const body = document.querySelector(".ph-body");
    expect(body).not.toBeNull();
    for (const item of items) {
      expect(body!.contains(item.closest("li"))).toBe(true);
    }
    // 搜索栏是滚动区的兄弟（在其外部）：滚动列表不会把它带走。
    const head = document.querySelector(".ph-head");
    expect(head).not.toBeNull();
    expect(body!.contains(head)).toBe(false);
    expect(head!.parentElement).toBe(body!.parentElement);
  });
});
