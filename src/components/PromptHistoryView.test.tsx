/** 提示词历史：整行跳转门禁、hover 快捷动作只传目录、项目 Seg、空态清除筛选。 */
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
    sessionTitle: "已加载会话标题",
  },
  {
    id: 1,
    prompt: "来源会话已不在列表",
    cwd: null,
    sessionId: "s-gone",
    createdAt: "2026-10-15T01:00:00.000Z",
    useCount: 1,
    sessionTitle: null,
  },
];

afterEach(() => clearMocks());

function renderView() {
  mockIPC((cmd) => (cmd === "search_prompt_history" ? ENTRIES : undefined));
  const onNewSessionIn = vi.fn();
  const onOpenSession = vi.fn();
  render(
    <PromptHistoryView
      loadedSessionIds={new Set(["s-loaded"])}
      onOpenSession={onOpenSession}
      onNewSessionIn={onNewSessionIn}
      onToast={() => {}}
    />,
  );
  return { onNewSessionIn, onOpenSession };
}

describe("PromptHistoryView 动作门禁", () => {
  it("来源会话未加载时整行不可点；cwd 为空时新会话禁用", async () => {
    renderView();
    const gone = (await screen.findByText("来源会话已不在列表")).closest("li");
    expect(gone).not.toBeNull();
    expect(gone!.getAttribute("role")).toBeNull();
    expect(gone!.querySelector(".hist-fwd svg")).toBeNull();
    expect(within(gone!).getByRole("button", { name: "在该目录新会话" })).toBeDisabled();
    // 会话短码降级：无标题时 meta 显示短码。
    expect(gone!.textContent).toContain("→ s-gone");
  });

  it("无来源会话时标题占位显示「未知会话」", async () => {
    mockIPC((cmd) =>
      cmd === "search_prompt_history"
        ? [{ id: 9, prompt: "无来源", cwd: "/w/alpha", sessionId: null, createdAt: "2026-10-16T01:00:00.000Z", useCount: 1, sessionTitle: null }]
        : undefined,
    );
    render(
      <PromptHistoryView
        loadedSessionIds={new Set()}
        onOpenSession={() => {}}
        onNewSessionIn={() => {}}
        onToast={() => {}}
      />,
    );
    const row = (await screen.findByText("无来源")).closest("li");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("→ 未知会话");
  });

  it("整行点击跳转；新会话只传目录", async () => {
    const { onNewSessionIn, onOpenSession } = renderView();
    const loaded = (await screen.findByText("来自已加载会话")).closest("li");
    expect(loaded).not.toBeNull();
    expect(loaded!.getAttribute("role")).toBe("button");
    // meta 显示「项目 → 会话标题」。
    expect(loaded!.textContent).toContain("已加载会话标题");
    fireEvent.click(loaded!);
    expect(onOpenSession).toHaveBeenCalledWith("s-loaded");

    fireEvent.click(within(loaded!).getByRole("button", { name: "在该目录新会话" }));
    expect(onNewSessionIn).toHaveBeenCalledTimes(1);
    expect(onNewSessionIn).toHaveBeenCalledWith("/w/alpha");
    // hover 按钮冒泡被截停：不触发整行跳转。
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });

  it("键盘 Enter 触发整行跳转", async () => {
    const { onOpenSession } = renderView();
    const loaded = (await screen.findByText("来自已加载会话")).closest("li");
    fireEvent.keyDown(loaded!, { key: "Enter" });
    expect(onOpenSession).toHaveBeenCalledWith("s-loaded");
  });
});

describe("PromptHistoryView 筛选与空态", () => {
  it("项目 Seg 带计数；切项目过滤列表", async () => {
    renderView();
    await screen.findByText("来自已加载会话");
    const seg = screen.getByRole("group", { name: "按项目过滤" });
    const btns = within(seg).getAllByRole("button");
    expect(btns[0].textContent).toContain("全部项目");
    expect(btns.map((b) => b.textContent).join(" ")).toContain("alpha");
    // 切到 alpha：只剩一条。
    fireEvent.click(within(seg).getByRole("button", { name: /alpha/ }));
    expect(screen.queryByText("来源会话已不在列表")).toBeNull();
    expect(screen.getByText("来自已加载会话")).toBeTruthy();
    expect(screen.getByText("1 条匹配")).toBeTruthy();
  });

  it("空态带清除筛选；页头有记录数 badge；foot 显示共 N 条", async () => {
    mockIPC((cmd, args) => {
      if (cmd !== "search_prompt_history") return undefined;
      const q = (args as { query?: string }).query ?? "";
      return q.includes("zzz-no-match") ? [] : ENTRIES;
    });
    render(
      <PromptHistoryView
        loadedSessionIds={new Set(["s-loaded"])}
        onOpenSession={() => {}}
        onNewSessionIn={() => {}}
        onToast={() => {}}
      />,
    );
    await screen.findByText("来自已加载会话");
    fireEvent.change(screen.getByLabelText("搜索提示词历史"), { target: { value: "zzz-no-match" } });
    expect(await screen.findByText("没有匹配的提示词")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByText("来自已加载会话")).toBeTruthy();
    expect(screen.getByText("2 条记录")).toBeTruthy();
    expect(screen.getByText("共 2 条")).toBeTruthy();
  });
});
