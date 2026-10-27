/** Sidebar 右键菜单与行内重命名单测：右键不改选中态、批量菜单判定、别名写入参数。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { FIXTURE_SESSIONS, buildListResult } from "../dev/fixtures";
import type { MenuSpec } from "../nativeMenu";
import type { MetaSnapshot, ProjectGroup } from "../types";

const popupMenu = vi.fn<(items: MenuSpec[]) => Promise<void>>(() => Promise.resolve());
vi.mock("../nativeMenu", () => ({
  popupMenu: (items: MenuSpec[]) => popupMenu(items),
}));

const noop = () => {};
const list = buildListResult(FIXTURE_SESSIONS);
const omp = list.groups.find((g) => g.cwd.endsWith("/omp-resume"))!;
const [first, second] = omp.sessions;

const meta: MetaSnapshot = {
  revision: 1,
  sessions: {
    [first.id]: { alias: "已有别名", tags: ["bug"], note: "备注内容", updatedAt: "t" },
    [second.id]: { alias: null, tags: [], note: null, updatedAt: "t" },
  },
};

interface MetaCall {
  sessionId: string;
  meta: { alias: string | null; tags: string[]; note: string | null } | null;
  expectedRevision: number;
}

function installIpc(): { calls: MetaCall[] } {
  const calls: MetaCall[] = [];
  let revision = meta.revision;
  mockIPC((cmd, args) => {
    if (cmd !== "set_session_meta") throw new Error(`未预期的命令：${cmd}`);
    const a = args as unknown as {
      sessionId: string;
      meta: MetaCall["meta"];
      expectedRevision: number;
    };
    calls.push({ sessionId: a.sessionId, meta: a.meta, expectedRevision: a.expectedRevision });
    revision += 1;
    return {
      revision,
      sessions: {
        ...meta.sessions,
        [a.sessionId]: {
          alias: a.meta?.alias ?? null,
          tags: a.meta?.tags ?? [],
          note: a.meta?.note ?? null,
          updatedAt: "t2",
        },
      },
    };
  });
  return { calls };
}

function renderSidebar(over: {
  checked?: Set<string>;
  onSelect?: (p: string) => void;
  groups?: ProjectGroup[];
} = {}) {
  const onSelect = over.onSelect ?? vi.fn();
  const onOpenIterm = vi.fn();
  const onMetaSnapshot = vi.fn();
  const onToast = vi.fn();
  const props = {
    groups: over.groups ?? list.groups,
    pinnedSessions: [],
    totalCount: 10,
    hiddenEmpty: 0,
    query: "",
    onQuery: noop,
    loading: false,
    listError: null,
    onRetry: noop,
    onRefresh: noop,
    onOpenCheatSheet: noop,
    manageActive: false,
    onToggleManage: noop,
    statsActive: false,
    onToggleStats: noop,
    stageActive: false,
    onToggleStage: noop,
    cleanupActive: false,
    onToggleCleanup: noop,
    checked: over.checked ?? new Set<string>(),
    onToggleCheck: noop,
    onToggleChecks: noop,
    onClearChecks: noop,
    selectedPath: null,
    onSelect,
    pins: { projects: [], sessions: [] },
    onTogglePin: noop,
    ompVersion: null,
    ompChecking: false,
    onCheckOmp: noop,
    onNewSession: noop,
    onNewSessionIn: noop,
    historyActive: false,
    onToggleHistory: noop,
    meta,
    tagCounts: [{ tag: "bug", count: 1 }],
    activeTags: [],
    onToggleTag: noop,
    onToast,
    onOpenIterm,
    onRequestDelete: noop,
    onMetaSnapshot,
  };
  const view = render(<Sidebar {...props} />);
  return {
    onSelect,
    onOpenIterm,
    onMetaSnapshot,
    onToast,
    view,
    /** 模拟「菜单已弹出、列表随后刷新」：换一份 groups 重渲染。 */
    rerenderWith: (next: { groups: ProjectGroup[] }) =>
      view.rerender(<Sidebar {...props} {...next} />),
  };
}

/** 某一行的根节点（按标题文本定位）。 */
function rowOf(title: string): HTMLElement {
  const node = Array.from(document.querySelectorAll(".row")).find((row) => {
    const t = row.querySelector(".row-title")?.textContent ?? "";
    return t.includes(title);
  });
  if (!(node instanceof HTMLElement)) throw new Error(`未找到行：${title}`);
  return node;
}

beforeEach(() => {
  popupMenu.mockClear();
  clearMocks();
});

describe("Sidebar 右键菜单", () => {
  it("右键未勾选的行：弹出单会话菜单且不改变选中态", async () => {
    const { onSelect } = renderSidebar();
    fireEvent.contextMenu(rowOf(first.title));
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1));
    expect(onSelect).not.toHaveBeenCalled();
    const items = popupMenu.mock.calls[0][0];
    const texts = items.map((i) => ("text" in i ? i.text : i.kind));
    expect(texts).toContain("在 iTerm 继续");
    expect(texts).not.toContain(`已选 2 个会话`);
  });

  it("右键已勾选的行且勾选 ≥ 2 → 批量菜单", async () => {
    const checked = new Set([first.path, second.path]);
    renderSidebar({ checked });
    fireEvent.contextMenu(rowOf(first.title));
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1));
    const items = popupMenu.mock.calls[0][0];
    const texts = items.map((i) => ("text" in i ? i.text : i.kind));
    expect(texts[0]).toBe("已选 2 个会话");
    expect(texts).toContain("复制会话 ID");
  });

  it("「重命名…」后出现输入框；Enter 写入别名并保留标签与备注", async () => {
    const { calls } = installIpc();
    const { onMetaSnapshot } = renderSidebar();
    fireEvent.contextMenu(rowOf(first.title));
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1));
    const items = popupMenu.mock.calls[0][0];
    const rename = items.find(
      (i): i is Extract<MenuSpec, { kind: "item" }> => "text" in i && i.text === "重命名…",
    );
    if (rename == null) throw new Error("没有重命名项");
    rename.run();

    const input = await screen.findByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "新别名" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      sessionId: first.id,
      meta: { alias: "新别名", tags: ["bug"], note: "备注内容" },
      expectedRevision: 1,
    });
    await waitFor(() => expect(onMetaSnapshot).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull();
  });

  it("Esc 取消重命名，不发生写入", async () => {
    const { calls } = installIpc();
    renderSidebar();
    fireEvent.contextMenu(rowOf(first.title));
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1));
    const items = popupMenu.mock.calls[0][0];
    const rename = items.find(
      (i): i is Extract<MenuSpec, { kind: "item" }> => "text" in i && i.text === "重命名…",
    );
    if (rename == null) throw new Error("没有重命名项");
    rename.run();
    const input = await screen.findByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "不要保存" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull());
    expect(calls).toHaveLength(0);
  });

  it("批量菜单「标签 → 新标签…」给勾选的会话逐个加标签", async () => {
    const { calls } = installIpc();
    const { onMetaSnapshot } = renderSidebar({ checked: new Set([first.path, second.path]) });
    fireEvent.contextMenu(rowOf(first.title));
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1));
    const items = popupMenu.mock.calls[0][0];
    const tags = items.find(
      (i): i is Extract<MenuSpec, { kind: "submenu" }> => i.kind === "submenu" && i.text === "标签",
    );
    if (tags == null) throw new Error("没有标签子菜单");
    const newTag = tags.items.find(
      (i): i is Extract<MenuSpec, { kind: "item" }> => "text" in i && i.text === "新标签…",
    );
    if (newTag == null) throw new Error("没有新标签项");
    newTag.run();

    const input = await screen.findByRole("textbox", { name: "标签名" });
    fireEvent.change(input, { target: { value: "高优" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(calls).toHaveLength(2));
    // 串行写入：第二次写入用第一次返回的 revision。
    expect(calls.map((c) => c.expectedRevision)).toEqual([1, 2]);
    expect(calls[0].meta).toMatchObject({ alias: "已有别名", tags: ["bug", "高优"], note: "备注内容" });
    expect(calls[1].meta).toMatchObject({ alias: null, tags: ["高优"], note: null });
    await waitFor(() => expect(onMetaSnapshot).toHaveBeenCalledTimes(1));
  });

  it("列表刷新后会话已消失：动作只 toast，不碰后端", async () => {
    installIpc();
    const { onOpenIterm, onToast, rerenderWith } = renderSidebar();
    fireEvent.contextMenu(rowOf(first.title));
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1));
    const items = popupMenu.mock.calls[0][0];
    const open = items.find(
      (i): i is Extract<MenuSpec, { kind: "item" }> => "text" in i && i.text === "在 iTerm 继续",
    );
    const rename = items.find(
      (i): i is Extract<MenuSpec, { kind: "item" }> => "text" in i && i.text === "重命名…",
    );
    if (open == null || rename == null) throw new Error("菜单项缺失");

    // 菜单弹出后列表刷新，该会话已不在列表里。
    rerenderWith({ groups: list.groups.map((g) => ({ ...g, sessions: g.sessions.filter((x) => x.path !== first.path) })) });

    open.run();
    expect(onOpenIterm).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("会话已不存在", "error");

    rename.run();
    expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull();
  });

  it("值未变化时直接关闭，不发写入", async () => {
    const { calls } = installIpc();
    renderSidebar();
    fireEvent.contextMenu(rowOf(first.title));
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1));
    const items = popupMenu.mock.calls[0][0];
    const rename = items.find(
      (i): i is Extract<MenuSpec, { kind: "item" }> => "text" in i && i.text === "重命名…",
    );
    if (rename == null) throw new Error("没有重命名项");
    rename.run();
    const input = await screen.findByRole("textbox", { name: "重命名会话" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull());
    expect(calls).toHaveLength(0);
  });
});
