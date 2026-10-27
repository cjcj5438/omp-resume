/**
 * 会话列表右键菜单的内容构建（纯函数，可脱离 Tauri 单测）。
 *
 * 输入是最新列表快照 + 备注/置顶状态，输出 [`MenuSpec`] 树；动作通过
 * `actions` 注入，因此本模块不 import 任何 Tauri API，也不直接调用后端。
 */
import type { MenuSpec } from "./nativeMenu";
import type { SessionMeta, SessionSummary } from "./types";

/** 标签上限（与后端 `meta::TAGS_MAX_COUNT` 一致）。 */
const TAGS_MAX = 10;

export type CopyKind = "id" | "path" | "cwd" | "resume";

export interface SessionMenuActions {
  openIterm: (s: SessionSummary) => void;
  newSessionIn: (cwd: string) => void;
  togglePin: (kind: "session" | "project", key: string) => void;
  startRename: (path: string) => void;
  toggleTag: (ids: string[], tag: string, on: boolean) => void;
  newTag: (ids: string[]) => void;
  /** `literal` 用于没有会话对象的场景（项目组头的「复制项目路径」）。 */
  copy: (kind: CopyKind, targets: SessionSummary[], literal?: string) => void;
  revealFile: (path: string) => void;
  openProjectDir: (cwd: string) => void;
  enterSelect: (path: string) => void;
  requestDelete: (paths: string[]) => void;
  selectGroup: (paths: string[]) => void;
  collapseAll: () => void;
  expandAll: () => void;
}

const hasTag = (meta: SessionMeta | null, tag: string): boolean =>
  (meta?.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase());

/**
 * 「标签」子菜单：多选时「全部目标都有」才算勾选。
 * 勾选动作仅在「所有目标都已满 10 个标签」时禁用；取消勾选永远可用。
 */
function tagItems(
  ids: string[],
  metas: Array<SessionMeta | null>,
  allTags: string[],
  metaReady: boolean,
  actions: SessionMenuActions,
): MenuSpec[] {
  const full = metas.every((m) => (m?.tags ?? []).length >= TAGS_MAX);
  const items: MenuSpec[] = allTags.map((tag) => {
    const checked = metas.every((m) => hasTag(m, tag));
    return {
      kind: "check",
      text: tag,
      checked,
      enabled: metaReady && (checked || !full),
      run: () => actions.toggleTag(ids, tag, !checked),
    };
  });
  const newTag: MenuSpec = {
    kind: "item",
    text: "新标签…",
    enabled: metaReady && metas.some((m) => (m?.tags ?? []).length < TAGS_MAX),
    run: () => actions.newTag(ids),
  };
  return items.length > 0 ? [...items, { kind: "separator" }, newTag] : [newTag];
}

const META_MISSING: MenuSpec = {
  kind: "item",
  text: "备注加载失败，标签不可用",
  enabled: false,
  run: () => {},
};

/** 单会话菜单。 */
export function buildSessionMenu(
  s: SessionSummary,
  ctx: {
    /** 该会话的备注条目；null = 该会话还没有备注（可以新建）。 */
    meta: SessionMeta | null;
    /** false = 备注快照整体没加载成功：写入缺少 revision，只能禁用。 */
    metaReady: boolean;
    pinned: boolean;
    allTags: string[];
  },
  actions: SessionMenuActions,
): MenuSpec[] {
  const meta = ctx.meta;
  return [
    {
      kind: "item",
      text: "在 iTerm 继续",
      enabled: !s.inUse && s.cwdExists,
      run: () => actions.openIterm(s),
    },
    {
      kind: "item",
      text: "在此项目新建会话",
      enabled: s.cwdExists,
      run: () => actions.newSessionIn(s.cwd),
    },
    { kind: "separator" },
    {
      kind: "item",
      text: ctx.pinned ? "取消置顶" : "置顶",
      run: () => actions.togglePin("session", s.id),
    },
    {
      kind: "item",
      text: "重命名…",
      enabled: ctx.metaReady,
      run: () => actions.startRename(s.path),
    },
    ctx.metaReady
      ? {
          kind: "submenu",
          text: "标签",
          items: tagItems([s.id], [meta], ctx.allTags, true, actions),
        }
      : META_MISSING,
    { kind: "separator" },
    {
      kind: "submenu",
      text: "复制",
      items: [
        { kind: "item", text: "会话 ID", run: () => actions.copy("id", [s]) },
        { kind: "item", text: "会话文件路径", run: () => actions.copy("path", [s]) },
        { kind: "item", text: "项目路径", run: () => actions.copy("cwd", [s]) },
        {
          kind: "item",
          text: "续聊命令",
          enabled: s.cwdExists,
          run: () => actions.copy("resume", [s]),
        },
      ],
    },
    { kind: "item", text: "在 Finder 中显示", run: () => actions.revealFile(s.path) },
    {
      kind: "item",
      text: "在 Finder 中打开项目目录",
      enabled: s.cwdExists,
      run: () => actions.openProjectDir(s.cwd),
    },
    { kind: "separator" },
    { kind: "item", text: "选择", run: () => actions.enterSelect(s.path) },
    { kind: "separator" },
    {
      kind: "item",
      text: "删除…",
      enabled: !s.inUse,
      run: () => actions.requestDelete([s.path]),
    },
  ];
}

/** 批量菜单：右键的行已被勾选，且勾选数 ≥ 2。 */
export function buildBatchMenu(
  targets: SessionSummary[],
  ctx: {
    metaOf: (id: string) => SessionMeta | null;
    pinnedIds: ReadonlySet<string>;
    allTags: string[];
    /** false = 备注未加载：标签项全部禁用（写入需要 revision）。 */
    metaReady: boolean;
  },
  actions: SessionMenuActions,
): MenuSpec[] {
  const ids = targets.map((s) => s.id);
  const metas = ids.map((id) => ctx.metaOf(id));
  const allPinned = targets.every((s) => ctx.pinnedIds.has(s.id));
  const unpinned = targets.filter((s) => !ctx.pinnedIds.has(s.id));
  return [
    {
      kind: "item",
      text: `已选 ${targets.length} 个会话`,
      enabled: false,
      run: () => {},
    },
    { kind: "separator" },
    allPinned
      ? {
          kind: "item",
          text: "取消置顶全部",
          run: () => {
            for (const s of targets) actions.togglePin("session", s.id);
          },
        }
      : {
          kind: "item",
          text: "置顶全部",
          enabled: unpinned.length > 0,
          run: () => {
            for (const s of unpinned) actions.togglePin("session", s.id);
          },
        },
    ctx.metaReady
      ? {
          kind: "submenu",
          text: "标签",
          items: tagItems(ids, metas, ctx.allTags, true, actions),
        }
      : META_MISSING,
    {
      kind: "item",
      text: "复制会话 ID",
      run: () => actions.copy("id", targets),
    },
    { kind: "separator" },
    {
      kind: "item",
      text: `删除 ${targets.length} 个会话…`,
      enabled: targets.some((s) => !s.inUse),
      run: () => actions.requestDelete(targets.map((s) => s.path)),
    },
  ];
}

/** 项目组头菜单。 */
export function buildGroupMenu(
  g: { cwd: string; paths: string[]; dirMissing: boolean; pinned: boolean },
  actions: SessionMenuActions,
): MenuSpec[] {
  return [
    {
      kind: "item",
      text: "在此项目新建会话",
      enabled: !g.dirMissing,
      run: () => actions.newSessionIn(g.cwd),
    },
    {
      kind: "item",
      text: g.pinned ? "取消置顶项目" : "置顶项目",
      run: () => actions.togglePin("project", g.cwd),
    },
    {
      kind: "item",
      text: "在 Finder 中打开项目目录",
      enabled: !g.dirMissing,
      run: () => actions.openProjectDir(g.cwd),
    },
    {
      kind: "item",
      text: "复制项目路径",
      run: () => actions.copy("cwd", [], g.cwd),
    },
    { kind: "separator" },
    {
      kind: "item",
      text: "选择组内全部会话",
      enabled: g.paths.length > 0,
      run: () => actions.selectGroup(g.paths),
    },
    { kind: "item", text: "折叠全部", run: () => actions.collapseAll() },
    { kind: "item", text: "展开全部", run: () => actions.expandAll() },
  ];
}

/** 置顶区组头菜单。 */
export function buildPinnedGroupMenu(
  paths: string[],
  actions: SessionMenuActions,
): MenuSpec[] {
  return [
    {
      kind: "item",
      text: "选择全部置顶会话",
      enabled: paths.length > 0,
      run: () => actions.selectGroup(paths),
    },
    { kind: "separator" },
    { kind: "item", text: "折叠全部", run: () => actions.collapseAll() },
    { kind: "item", text: "展开全部", run: () => actions.expandAll() },
  ];
}
