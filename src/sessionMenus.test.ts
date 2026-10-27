/** sessionMenus 纯函数单测：启用条件、标签勾选与 10 个上限、批量/组头文案。 */
import { describe, expect, it, vi } from "vitest";
import {
  buildBatchMenu,
  buildGroupMenu,
  buildPinnedGroupMenu,
  buildSessionMenu,
  type SessionMenuActions,
} from "./sessionMenus";
import type { MenuSpec } from "./nativeMenu";
import type { SessionMeta, SessionSummary } from "./types";

function actions(): SessionMenuActions {
  return {
    openIterm: vi.fn(),
    newSessionIn: vi.fn(),
    togglePin: vi.fn(),
    startRename: vi.fn(),
    toggleTag: vi.fn(),
    newTag: vi.fn(),
    copy: vi.fn(),
    revealFile: vi.fn(),
    openProjectDir: vi.fn(),
    enterSelect: vi.fn(),
    requestDelete: vi.fn(),
    selectGroup: vi.fn(),
    collapseAll: vi.fn(),
    expandAll: vi.fn(),
  };
}

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    path: "/sessions/s1.jsonl",
    cwd: "/proj",
    cwdExists: true,
    title: "会话一",
    createdAt: "2026-10-01T00:00:00Z",
    modifiedAt: "2026-10-01T00:00:00Z",
    sizeBytes: 10,
    messageCount: 2,
    branchCount: 1,
    inUse: false,
    probeOk: true,
    occupant: null,
    fork: null,
    formatSupported: true,
    version: 3,
    badLines: 0,
    firstUserMessage: null,
    ...over,
  };
}

function meta(alias: string | null, tags: string[]): SessionMeta {
  return { alias, tags, note: null, updatedAt: "2026-10-01T00:00:00Z" };
}

function find(items: MenuSpec[], text: string): MenuSpec | undefined {
  for (const item of items) {
    if ("text" in item && item.text === text) return item;
    if (item.kind === "submenu") {
      const hit = find(item.items, text);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 菜单项是否可用：未显式写 `enabled` 即默认可用。 */
function itemEnabled(items: MenuSpec[], text: string): boolean {
  const hit = find(items, text);
  if (hit == null || !("run" in hit)) throw new Error(`没有菜单项：${text}`);
  return hit.enabled ?? true;
}

/** 取可执行菜单项的 run（不可执行/不存在即抛错，避免测试静默通过）。 */
function runOf(items: MenuSpec[], text: string): () => void {
  const hit = find(items, text);
  if (hit == null || !("run" in hit)) throw new Error(`没有可执行菜单项：${text}`);
  return hit.run;
}

describe("buildSessionMenu", () => {
  it("在用会话禁用「在 iTerm 继续」与「删除…」", () => {
    const specs = buildSessionMenu(
      session({ inUse: true }),
      { meta: meta(null, []), metaReady: true, pinned: false, allTags: [] },
      actions(),
    );
    expect(itemEnabled(specs, "在 iTerm 继续")).toBe(false);
    expect(itemEnabled(specs, "删除…")).toBe(false);
    expect(itemEnabled(specs, "在 Finder 中打开项目目录")).toBe(true);
  });

  it("cwd 缺失时禁用继续、新建、打开目录与续聊命令", () => {
    const specs = buildSessionMenu(
      session({ cwdExists: false }),
      { meta: meta(null, []), metaReady: true, pinned: false, allTags: [] },
      actions(),
    );
    expect(itemEnabled(specs, "在 iTerm 继续")).toBe(false);
    expect(itemEnabled(specs, "在此项目新建会话")).toBe(false);
    expect(itemEnabled(specs, "在 Finder 中打开项目目录")).toBe(false);
    expect(itemEnabled(specs, "续聊命令")).toBe(false);
    expect(itemEnabled(specs, "会话 ID")).toBe(true);
  });

  it("置顶文案随状态切换", () => {
    const a = actions();
    const pinnedSpecs = buildSessionMenu(
      session(),
      { meta: meta(null, []), metaReady: true, pinned: true, allTags: [] },
      a,
    );
    expect(find(pinnedSpecs, "取消置顶")).toBeDefined();
    expect(find(pinnedSpecs, "置顶")).toBeUndefined();
  });

  it("标签勾选大小写不敏感；满 10 个时未勾选项禁用且新标签禁用", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    const specs = buildSessionMenu(
      // 会话里存的是 "TAG0"，菜单里展示的是 allTags 的写法：仍应判为已勾选。
      session(),
      { meta: meta(null, ["TAG0", ...tags.slice(1)]), metaReady: true, pinned: false, allTags: [...tags, "extra"] },
      actions(),
    );
    const existing = find(specs, "tag0");
    expect(existing).toMatchObject({ kind: "check", checked: true, enabled: true });
    expect(itemEnabled(specs, "extra")).toBe(false);
    expect(itemEnabled(specs, "新标签…")).toBe(false);
  });

  it("备注快照未加载时给出禁用提示项，且不能重命名", () => {
    const specs = buildSessionMenu(
      session(),
      { meta: null, metaReady: false, pinned: false, allTags: ["bug"] },
      actions(),
    );
    expect(itemEnabled(specs, "重命名…")).toBe(false);
    expect(find(specs, "备注加载失败，标签不可用")).toBeDefined();
  });
});

describe("buildSessionMenu（会话无备注条目）", () => {
  it("快照已加载但该会话无条目：重命名与标签可用", () => {
    const specs = buildSessionMenu(
      session(),
      { meta: null, metaReady: true, pinned: false, allTags: ["bug"] },
      actions(),
    );
    expect(itemEnabled(specs, "重命名…")).toBe(true);
    expect(itemEnabled(specs, "bug")).toBe(true);
    expect(find(specs, "备注加载失败，标签不可用")).toBeUndefined();
  });
});

describe("buildBatchMenu", () => {
  const ctx = (pinned: string[]) => ({
    metaOf: () => meta(null, []),
    pinnedIds: new Set(pinned),
    allTags: ["bug"],
    metaReady: true,
  });

  it("全部已置顶 → 取消置顶全部；否则置顶全部只作用于未置顶项", () => {
    const a = actions();
    const allPinned = buildBatchMenu(
      [session({ id: "a" }), session({ id: "b" })],
      ctx(["a", "b"]),
      a,
    );
    expect(find(allPinned, "取消置顶全部")).toBeDefined();

    const some = actions();
    const partial = buildBatchMenu(
      [session({ id: "a" }), session({ id: "b" })],
      ctx(["a"]),
      some,
    );
    runOf(partial, "置顶全部")();
    expect(some.togglePin).toHaveBeenCalledTimes(1);
    expect(some.togglePin).toHaveBeenCalledWith("session", "b");
  });

  it("全部禁用（在用）时删除项禁用；部分可用时启用", () => {
    const allBusy = buildBatchMenu(
      [session({ id: "a", inUse: true }), session({ id: "b", inUse: true })],
      ctx([]),
      actions(),
    );
    expect(itemEnabled(allBusy, "删除 2 个会话…")).toBe(false);

    const mixed = buildBatchMenu(
      [session({ id: "a", inUse: true }), session({ id: "b" })],
      ctx([]),
      actions(),
    );
    expect(itemEnabled(mixed, "删除 2 个会话…")).toBe(true);
  });

  it("标签勾选要求全部会话都有", () => {
    const specs = buildBatchMenu([session({ id: "a" }), session({ id: "b" })], ctx([]), actions());
    const bug = find(specs, "bug");
    expect(bug).toMatchObject({ kind: "check", checked: false, enabled: true });
  });
});

describe("buildGroupMenu", () => {
  it("目录缺失时禁用新建与打开目录；置顶文案随状态切换", () => {
    const specs = buildGroupMenu(
      { cwd: "/proj", paths: ["/a", "/b"], dirMissing: true, pinned: true },
      actions(),
    );
    expect(itemEnabled(specs, "在此项目新建会话")).toBe(false);
    expect(itemEnabled(specs, "在 Finder 中打开项目目录")).toBe(false);
    expect(find(specs, "取消置顶项目")).toBeDefined();
    expect(itemEnabled(specs, "选择组内全部会话")).toBe(true);
  });

  it("组内没有会话时「选择组内全部会话」禁用", () => {
    const specs = buildGroupMenu(
      { cwd: "/proj", paths: [], dirMissing: false, pinned: false },
      actions(),
    );
    expect(itemEnabled(specs, "选择组内全部会话")).toBe(false);
  });
});

describe("buildPinnedGroupMenu", () => {
  it("选择全部置顶会话并折叠/展开", () => {
    const a = actions();
    const specs = buildPinnedGroupMenu(["/a"], a);
    runOf(specs, "选择全部置顶会话")();
    expect(a.selectGroup).toHaveBeenCalledWith(["/a"]);
    runOf(specs, "折叠全部")();
    expect(a.collapseAll).toHaveBeenCalled();
  });
});
