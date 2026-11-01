/** 会话列表页：标签过滤、分组折叠、批量勾选、右键菜单。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppError, MetaSnapshot, ProjectGroup, SessionMeta, SessionSummary } from "../types";
import { checkState, type TagCount } from "../listUtils";
import type { PinKind, Pins } from "../pins";
import { displayCwd, errorText, formatRelativeTime, formatSize } from "../format";
import { compactNumber } from "./usageFormat";
import {
  getMeta,
  getResumeCommand,
  normalizeError,
  openProjectDir,
  revealSessionFile,
} from "../api";
import { copyText } from "../clipboard";
import { MetaBatchError, TAGS_MAX, applyTag, writeAlias } from "../metaOps";
import { popupMenu, type MenuSpec } from "../nativeMenu";
import {
  buildBatchMenu,
  buildGroupMenu,
  buildSessionMenu,
  type CopyKind,
  type SessionMenuActions,
} from "../sessionMenus";
import { Ico, SessionBadges } from "./ui";
import { ErrorBanner } from "./page";
import { Check, ChevronDown, Folder, MessageSquareText, Minus, Pin, Plus, SquareTerminal, Trash } from "lucide-react";
import type { ToastFn } from "./useOmpOp";
import { NewTagDialog } from "./NewTagDialog";
import "./SessionList.css";

interface SessionListProps {
  groups: ProjectGroup[];
  listError: AppError | null;
  onRetry: () => void;
  checked: Set<string>;
  onToggleCheck: (path: string, on: boolean) => void;
  /** 批量勾选/取消：paths 为目标会话 path 列表。 */
  onToggleChecks: (paths: string[], on: boolean) => void;
  /** 清除全部勾选。 */
  onClearChecks: () => void;
  /** 多选模式（SessionsPage 持有，经 toolbar 开关传入；S1）。 */
  multiMode: boolean;
  selectedPath: string | null;
  /** 行激活：列表页进工作台，工作台左栏切换选中。 */
  onOpenSession: (path: string) => void;
  /** 行内「备注」：进工作台并展开备注编辑器。 */
  onOpenMeta: (path: string) => void;
  /** 选择条「恢复…」：打开批量恢复确认。 */
  onBulkResume: (targets: SessionSummary[]) => void;
  /** 折叠集（App 持有，列表页与工作台左栏共享）。 */
  collapsed: ReadonlySet<string>;
  onCollapsedChange: (next: Set<string>) => void;
  pins: Pins;
  onTogglePin: (kind: PinKind, key: string) => void;
  onNewSessionIn: (cwd: string) => void;
  /** 应用侧备注快照；null = 未加载（行内不显示别名/标签）。 */
  meta: MetaSnapshot | null;
  /** 正在使用的标签及计数（空时不渲染过滤条）。 */
  tagCounts: TagCount[];
  activeTags: readonly string[];
  onToggleTag: (tag: string) => void;
  /** toast 出口（右键菜单反馈）。 */
  onToast: ToastFn;
  /** 「在 iTerm 继续」（与详情页同一路径）。 */
  onOpenIterm: (s: SessionSummary) => void;
  /** 删除确认（右键菜单「删除…」）。 */
  onRequestDelete: (paths: string[]) => void;
  /** 备注写入后的新快照（别名/标签）。 */
  onMetaSnapshot: (snap: MetaSnapshot) => void;
}

export function SessionList({
  groups,
  listError,
  onRetry,
  checked,
  onToggleCheck,
  onToggleChecks,
  onClearChecks,
  multiMode,
  selectedPath,
  onOpenSession,
  onOpenMeta,
  onBulkResume,
  collapsed,
  onCollapsedChange,
  pins,
  onTogglePin,
  onNewSessionIn,
  meta,
  tagCounts,
  activeTags,
  onToggleTag,
  onToast,
  onOpenIterm,
  onRequestDelete,
  onMetaSnapshot,
}: SessionListProps) {
  const toggleCollapsed = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onCollapsedChange(next);
  };
  // 右键菜单的目标（行 path / 组 cwd / 置顶区键）：仅用于画出当前菜单归属。
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [tagTargets, setTagTargets] = useState<string[] | null>(null);
  // 当前可见的全部会话 path（各组；组内置顶排序，无独立置顶区）。
  const visiblePaths = groups.flatMap((g) => g.sessions.map((s) => s.path));
  // 右键动作执行时按 path 重新解析会话：列表可能已刷新或会话已被删除。
  const byPath = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const g of groups) for (const s of g.sessions) map.set(s.path, s);
    return map;
  }, [groups]);
  // 菜单动作在「菜单已弹出、列表又刷新过」之后才执行：闭包里的 byPath 是旧渲染的
  // 快照，因此用 ref 指向最新映射，动作执行时按 path 重新解析会话。
  const byPathRef = useRef(byPath);
  byPathRef.current = byPath;
  const byIdRef = useRef(new Map<string, SessionSummary>());
  byIdRef.current = new Map([...byPath.values()].map((s) => [s.id, s]));

  /** 解析当前仍存在的会话；已消失则提示并返回 null（调用方不得再碰后端）。 */
  const liveSession = (path: string): SessionSummary | null => {
    const found = byPathRef.current.get(path) ?? null;
    if (found === null) onToast("会话已不存在", "error");
    return found;
  };

  /** 批量动作同样重解析：只保留仍在列表里的目标。 */
  const liveSessions = (targets: SessionSummary[]): SessionSummary[] =>
    targets
      .map((s) => byPathRef.current.get(s.path))
      .filter((s): s is SessionSummary => s != null);
  /** 按会话 id 重解析（标签类动作只带 id）。 */
  const liveById = (ids: string[]): SessionSummary[] =>
    ids.map((id) => byIdRef.current.get(id)).filter((s): s is SessionSummary => s != null);

  const hasUncheckedVisible = visiblePaths.some((p) => !checked.has(p));
  // 选择态（S1）：multiMode 由 SessionsPage 持有（toolbar 行尾开关），此处只读；
  // 打开后全部勾选框常显、选择条常驻（即使 0 选中，以便一键「全选当前列表」）；
  // 有任何勾选时自动视为进入选择态。
  const selecting = multiMode || checked.size > 0;

  // 会话从列表里消失（刷新/删除）时不要再留下一个悬空的重命名输入框。
  useEffect(() => {
    if (renamingPath !== null && !byPath.has(renamingPath)) setRenamingPath(null);
  }, [byPath, renamingPath]);

  const allTags = tagCounts.map((t) => t.tag);

  async function copy(kind: CopyKind, targets: SessionSummary[], literal?: string): Promise<void> {
    let text: string;
    let label: string;
    switch (kind) {
      case "id":
        text = targets.map((s) => s.id).join("\n");
        label = targets.length > 1 ? `已复制 ${targets.length} 个会话 ID` : "已复制会话 ID";
        break;
      case "path":
        text = targets.map((s) => s.path).join("\n");
        label = "已复制会话文件路径";
        break;
      case "cwd":
        text = literal ?? targets[0]?.cwd ?? "";
        label = "已复制项目路径";
        break;
      default: {
        const target = targets[0];
        if (target == null) return;
        try {
          text = await getResumeCommand(target.path);
        } catch (e: unknown) {
          onToast(errorText(normalizeError(e)), "error");
          return;
        }
        label = "已复制续聊命令";
      }
    }
    if (text.length === 0) return;
    if (await copyText(text)) onToast(label, "info");
    else onToast("复制失败：剪贴板不可用", "error");
  }

  async function runTag(ids: string[], tag: string, on: boolean): Promise<void> {
    if (meta === null) return;
    try {
      const result = await applyTag(meta, ids, tag, on);
      onMetaSnapshot(result.snapshot);
      const skipped =
        result.skipped > 0 ? `（${result.skipped} 个已满 ${TAGS_MAX} 个标签，已跳过）` : "";
      onToast(`已更新 ${result.updated} 个会话的标签${skipped}`, "info");
    } catch (e: unknown) {
      if (e instanceof MetaBatchError) {
        const err = normalizeError(e.cause);
        if (err.code === "CONFLICT") {
          try {
            onMetaSnapshot(await getMeta());
          } catch {
            // 重新载入也失败：保留旧快照，提示用户重试。
          }
          onToast(`备注已被外部修改，已重新载入，请重试（已更新 ${e.updated} 个）`, "error");
        } else {
          onMetaSnapshot(e.snapshot);
          onToast(errorText(err), "error");
        }
        return;
      }
      onToast(errorText(normalizeError(e)), "error");
    }
  }

  async function commitRename(s: SessionSummary, value: string): Promise<void> {
    if (meta === null) return;
    const entry = meta.sessions[s.id] ?? null;
    const trimmed = value.trim();
    if (trimmed === (entry?.alias ?? s.title)) {
      setRenamingPath(null);
      return;
    }
    setRenameBusy(true);
    try {
      const next = await writeAlias(meta, s.id, trimmed.length === 0 ? null : trimmed);
      onMetaSnapshot(next);
      setRenamingPath(null);
      onToast(
        trimmed.length === 0 ? "已清除别名" : `已重命名为「${trimmed}」`,
        "info",
      );
    } catch (e: unknown) {
      const err = normalizeError(e);
      if (err.code === "CONFLICT") {
        try {
          onMetaSnapshot(await getMeta());
        } catch {
          // 同上：重载失败时保持编辑框，让用户自己决定。
        }
        onToast("备注已被外部修改，已重新载入，请重试", "error");
      } else {
        onToast(errorText(err), "error");
      }
    } finally {
      setRenameBusy(false);
    }
  }

  const actions: SessionMenuActions = {
    openIterm: (s) => {
      const live = liveSession(s.path);
      if (live !== null) onOpenIterm(live);
    },
    newSessionIn: (cwd) => onNewSessionIn(cwd),
    togglePin: (kind, key) => onTogglePin(kind, key),
    startRename: (path) => {
      if (liveSession(path) !== null) setRenamingPath(path);
    },
    toggleTag: (ids, tag, on) => {
      // ids 是右键那一刻的集合：只对仍在列表里的会话写入。
      const live = liveById(ids);
      if (live.length < ids.length) onToast("会话已不存在", "error");
      if (live.length === 0) return;
      void runTag(live.map((entry) => entry.id), tag, on);
    },
    newTag: (ids) => {
      const live = liveById(ids);
      if (live.length < ids.length) onToast("会话已不存在", "error");
      if (live.length === 0) return;
      setTagTargets(live.map((entry) => entry.id));
    },
    copy: (kind, targets, literal) => {
      const live = liveSessions(targets);
      if (live.length < targets.length) onToast("会话已不存在", "error");
      if (targets.length > 0 && live.length === 0) return;
      void copy(kind, live, literal);
    },
    revealFile: (path) => {
      if (liveSession(path) === null) return;
      revealSessionFile(path).catch((e: unknown) =>
        onToast(errorText(normalizeError(e)), "error"),
      );
    },
    openProjectDir: (cwd) => {
      openProjectDir(cwd).catch((e: unknown) =>
        onToast(errorText(normalizeError(e)), "error"),
      );
    },
    enterSelect: (path) => {
      // multiMode 已上提：只勾选即可进入选择态（selecting 含 checked.size > 0）。
      onToggleCheck(path, true);
    },
    requestDelete: (paths) => {
      const live = paths.filter((p) => byPathRef.current.has(p));
      if (live.length === 0) {
        onToast("会话已不存在", "error");
        return;
      }
      onRequestDelete(live);
    },
    selectGroup: (paths) => {
      // 同上：勾选即进入选择态，无需再开 multiMode。
      onToggleChecks(paths, true);
    },
    collapseAll: () => onCollapsedChange(new Set(groups.map((g) => g.cwd))),
    expandAll: () => onCollapsedChange(new Set()),
  };

  /** 右键一行：勾选中的行（≥2 个勾选）走批量菜单，否则单会话菜单。右键不改选中态。 */
  function openRowMenu(s: SessionSummary): void {
    setMenuTarget(s.path);
    const batch =
      checked.has(s.path) && checked.size >= 2
        ? visiblePaths
            .filter((p) => checked.has(p))
            .map((p) => byPath.get(p))
            .filter((x): x is SessionSummary => x != null)
        : [];
    const specs =
      batch.length >= 2
        ? buildBatchMenu(
            batch,
            {
              metaOf: (id) => meta?.sessions[id] ?? null,
              pinnedIds: new Set(pins.sessions),
              allTags,
              metaReady: meta !== null,
            },
            actions,
          )
        : buildSessionMenu(
            s,
            {
              meta: meta?.sessions[s.id] ?? null,
              metaReady: meta !== null,
              pinned: pins.sessions.includes(s.id),
              allTags,
            },
            actions,
          );
    void popupMenu(specs).finally(() => setMenuTarget(null));
  }

  function openGroupMenu(key: string, specs: MenuSpec[]): void {
    setMenuTarget(key);
    void popupMenu(specs).finally(() => setMenuTarget(null));
  }

  /** 行内动作（设计稿 row-act 常显）：置顶 / 备注 / 恢复 / 删除。 */
  function renderRowActions(s: SessionSummary): ReactNode {
    const name = meta?.sessions[s.id]?.alias ?? s.title;
    const pinned = pins.sessions.includes(s.id);
    // H10/G8/G5：在用会话的恢复/删除可点（打开确认框解释），仅目录缺失禁用恢复。
    const itermTip = !s.cwdExists ? "项目目录不存在" : undefined;
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    return (
      <span className="row-actions" onClick={stop} onMouseDown={stop}>
        <button
          type="button"
          className={pinned ? "row-act is-on" : "row-act"}
          aria-pressed={pinned}
          aria-label={`${pinned ? "取消置顶" : "置顶"} ${name}`}
          title={pinned ? "取消置顶" : "置顶会话"}
          onClick={() => onTogglePin("session", s.id)}
        >
          <Ico icon={Pin} size={12} />
          <span>{pinned ? "已置顶" : "置顶"}</span>
        </button>
        <button
          type="button"
          className="row-act"
          aria-label={`备注 ${name}`}
          onClick={() => onOpenMeta(s.path)}
        >
          <Ico icon={MessageSquareText} size={12} />
          <span>备注</span>
        </button>
        <button
          type="button"
          className="row-act"
          aria-label={`恢复 ${name}`}
          title={itermTip}
          disabled={!s.cwdExists}
          onClick={() => onOpenIterm(s)}
        >
          <Ico icon={SquareTerminal} size={12} />
          <span>恢复</span>
        </button>
        <button
          type="button"
          className="row-act row-act-danger"
          aria-label={`删除 ${name}`}
          onClick={() => actions.requestDelete([s.path])}
        >
          <Ico icon={Trash} size={12} />
          <span>删除</span>
        </button>
      </span>
    );
  }

  // 选择条批量动作的目标：当前可见且已勾选的会话。
  const checkedVisible = visiblePaths
    .filter((p) => checked.has(p))
    .map((p) => byPath.get(p))
    .filter((x): x is SessionSummary => x != null);
  const checkedVisiblePinned = checkedVisible.every((s) => pins.sessions.includes(s.id));

  return (
    <div className={["session-list", "session-list-page", selecting ? "is-selecting" : ""].join(" ")}>
      {selecting && (checked.size > 0 || visiblePaths.length > 0) ? (
        <div className="selection-bar" role="status">
          <span>
            已选择 <strong>{checked.size}</strong> 个会话
          </span>
          <span className="spacer" />
          {hasUncheckedVisible ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => onToggleChecks(visiblePaths, true)}
            >
              全选当前列表
            </button>
          ) : null}
          {checked.size > 0 ? (
            <>
              <button type="button" className="btn btn-small btn-ghost" onClick={onClearChecks}>
                清除选择
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => {
                  if (checkedVisiblePinned) {
                    for (const s of checkedVisible) onTogglePin("session", s.id);
                  } else {
                    for (const s of checkedVisible) {
                      if (!pins.sessions.includes(s.id)) onTogglePin("session", s.id);
                    }
                  }
                }}
              >
                <Ico icon={Pin} size={12} />
                {checkedVisiblePinned ? "取消置顶全部" : "置顶"}
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => onBulkResume(checkedVisible)}
              >
                <Ico icon={SquareTerminal} size={12} />
                恢复
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => actions.newTag(checkedVisible.map((s) => s.id))}
              >
                加标签…
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => actions.requestDelete(checkedVisible.map((s) => s.path))}
              >
                <Ico icon={Trash} size={12} />
                删除
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {tagCounts.length > 0 ? (
        <div className="tag-bar" role="group" aria-label="按标签过滤">
          {tagCounts.map(({ tag, count }) => {
            const on = activeTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={on ? "tag-chip tag-chip-on" : "tag-chip"}
                aria-pressed={on}
                title={on ? `取消标签过滤：${tag}` : `只看带标签的会话：${tag}`}
                onClick={() => onToggleTag(tag)}
              >
                {tag} <span className="tag-count">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="panel sidebar-list">
        {listError ? <ErrorBanner error={listError} onRetry={onRetry} /> : null}
        {groups.map((g) => {
          const open = !collapsed.has(g.cwd);
          const dirMissing = g.sessions.length > 0 && g.sessions.every((s) => !s.cwdExists);
          const name = g.cwd.split("/").filter(Boolean).pop() ?? g.cwd;
          const pinnedProject = pins.projects.includes(g.cwd);
          return (
            <section className="group project-block" key={g.cwd}>
              <div
                className={
                  menuTarget === g.cwd ? "project-head-row row-menu-target" : "project-head-row"
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openGroupMenu(
                    g.cwd,
                    buildGroupMenu(
                      {
                        cwd: g.cwd,
                        paths: g.sessions.map((s) => s.path),
                        dirMissing,
                        pinned: pinnedProject,
                      },
                      actions,
                    ),
                  );
                }}
              >
                {g.sessions.length > 0 ? (
                  <GroupCheck
                    label={`选择项目 ${name} 的全部会话`}
                    paths={g.sessions.map((s) => s.path)}
                    checked={checked}
                    onToggle={onToggleChecks}
                  />
                ) : null}
                <button
                  type="button"
                  className={open ? "project-head" : "project-head is-collapsed"}
                  aria-expanded={open}
                  onClick={() => toggleCollapsed(g.cwd)}
                >
                  <span className="project-chevron" aria-hidden="true">
                    <Ico icon={ChevronDown} size={12} />
                  </span>
                  <span className="folder" aria-hidden="true">
                    <Ico icon={Folder} size={14} />
                  </span>
                  <span className="p-name">{name}</span>
                  <span className="p-path">{displayCwd(g.cwd)}</span>
                  {dirMissing ? <span className="badge badge-danger">目录不存在</span> : null}
                  <span className="p-count">{g.sessions.length} 个会话</span>
                  {g.sessions.some((s) => s.inUse) ? (
                    <span className="p-running">
                      <span className="dot live" />
                      运行中
                    </span>
                  ) : null}
                </button>
                <PinToggle
                  pinned={pinnedProject}
                  kindLabel="项目"
                  name={name}
                  onToggle={() => onTogglePin("project", g.cwd)}
                />
                <button
                  type="button"
                  className="group-new"
                  title={dirMissing ? "项目目录不存在" : "在此项目新会话"}
                  aria-label={`在 ${name} 新会话`}
                  disabled={dirMissing}
                  onClick={() => onNewSessionIn(g.cwd)}
                >
                  <Ico icon={Plus} size={12} />
                </button>
              </div>
              {open ? (
                <div className="group-rows">
                  {g.sessions.map((s) => (
                    <Row
                      key={s.path}
                      s={s}
                      meta={meta?.sessions[s.id] ?? null}
                      checked={checked.has(s.path)}
                      selected={s.path === selectedPath}
                      menuTargeted={menuTarget === s.path}
                      renaming={renamingPath === s.path}
                      renameBusy={renameBusy}
                      onRenameCommit={(value) => void commitRename(s, value)}
                      onRenameCancel={() => setRenamingPath(null)}
                      onToggleCheck={onToggleCheck}
                      onOpenSession={onOpenSession}
                      rowActions={renderRowActions(s)}
                      onRowMenu={() => openRowMenu(s)}
                      pinned={pins.sessions.includes(s.id)}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {tagTargets !== null ? (
        <NewTagDialog
          count={tagTargets.length}
          existing={[
            ...new Set(
              tagTargets.flatMap((id) => meta?.sessions[id]?.tags ?? []).map((t) => t.toLowerCase()),
            ),
          ].filter((lower) =>
            tagTargets.every((id) =>
              (meta?.sessions[id]?.tags ?? []).some((t) => t.toLowerCase() === lower),
            ),
          )}
          known={allTags}
          onCancel={() => setTagTargets(null)}
          onSubmit={(tag) => {
            const ids = tagTargets;
            setTagTargets(null);
            void runTag(ids, tag, true);
          }}
        />
      ) : null}
    </div>
  );
}

interface GroupCheckProps {
  label: string;
  /** 该组当前可见会话的 path（已过滤、含已折叠）。 */
  paths: string[];
  checked: Set<string>;
  onToggle: (paths: string[], on: boolean) => void;
}

/** 组头三态选择（扩展，设计稿无）：sel-box 形态，半选显示横线。 */
function GroupCheck({ label, paths, checked, onToggle }: GroupCheckProps) {
  const state = checkState(paths, checked);
  const on = state === "all";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : on}
      aria-label={label}
      className={on ? "sel-box is-on" : "sel-box"}
      data-state={state}
      onClick={() => onToggle(paths, !on)}
    >
      {state === "some" ? <Ico icon={Minus} size={10} /> : <Ico icon={Check} size={10} />}
    </button>
  );
}

interface RowProps {
  s: SessionSummary;
  /** 该会话的应用侧备注；null = 无。 */
  meta: SessionMeta | null;
  checked: boolean;
  selected: boolean;
  /** 该行是当前右键菜单的目标（描边提示）。 */
  menuTargeted: boolean;
  renaming: boolean;
  renameBusy: boolean;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
  onToggleCheck: (path: string, on: boolean) => void;
  onOpenSession: (path: string) => void;
  rowActions: ReactNode;
  onRowMenu: () => void;
  pinned: boolean;
}

/** 会话行（设计稿 session-row）：常显 sel-box + 标题（置顶 pin 图标）+ meta 行 + 常显行动作。 */
function Row({
  s,
  meta,
  checked,
  selected,
  menuTargeted,
  renaming,
  renameBusy,
  onRenameCommit,
  onRenameCancel,
  onToggleCheck,
  onOpenSession,
  rowActions,
  onRowMenu,
  pinned,
}: RowProps) {
  const alias = meta?.alias ?? null;
  const shownTags = (meta?.tags ?? []).slice(0, 3);
  const extraTags = (meta?.tags ?? []).length - shownTags.length;
  const cls = [
    "session-row",
    checked ? "is-selected" : "",
    selected ? "is-active" : "",
    menuTargeted ? "row-menu-target" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-label={`打开会话：${alias ?? s.title}`}
      onClick={() => onOpenSession(s.path)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpenSession(s.path);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRowMenu();
      }}
    >
      <span className="sel-cell">
        <button
          type="button"
          className={checked ? "sel-box is-on" : "sel-box"}
          aria-label={`${checked ? "取消选择" : "选择"}会话`}
          aria-pressed={checked}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(s.path, !checked);
          }}
        >
          <Ico icon={Check} size={10} />
        </button>
      </span>
      <div className="sr-main">
        <div className="sr-title">
          {pinned ? (
            <span className="pin" title="已置顶">
              <Ico icon={Pin} size={11} />
            </span>
          ) : null}
          <strong title={alias ? `${alias}（原标题：${s.title}）` : s.title}>
            {renaming ? (
              <RenameInput
                initial={alias ?? s.title}
                busy={renameBusy}
                onSubmit={onRenameCommit}
                onCancel={onRenameCancel}
              />
            ) : alias ? (
              <>
                <span>{alias}</span>
                <span className="row-title-orig">{s.title}</span>
              </>
            ) : (
              s.title
            )}
          </strong>
          <SessionBadges s={s} />
        </div>
        <div className="sr-meta">
          <span className="cwd">{displayCwd(s.cwd)}</span>
          <span className="sep">·</span>
          <span>{s.messageCount} 条消息</span>
          <span className="sep">·</span>
          <span>{formatSize(s.sizeBytes)}</span>
          <span className="sep">·</span>
          <span>{s.model ?? "—"}</span>
          <span className="sep">·</span>
          <span>{formatRelativeTime(s.modifiedAt)}</span>
          <span className="sep">·</span>
          <span
            className="mono"
            style={{ color: "var(--muted)" }}
            title={s.tokens == null ? undefined : "主会话 token（不含子代理）"}
          >
            {s.tokens == null ? "—" : `${compactNumber(s.tokens)} tok`}
          </span>
          {shownTags.map((t) => (
            <span key={t} className="badge badge-tag" title={`标签：${t}`}>
              {t}
            </span>
          ))}
          {extraTags > 0 ? (
            <span className="badge badge-tag" title={(meta?.tags ?? []).slice(3).join("、")}>
              +{extraTags}
            </span>
          ) : null}
        </div>
      </div>
      {rowActions}
    </div>
  );
}

interface RenameInputProps {
  initial: string;
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** 行内重命名输入框：Enter 或失焦提交，Esc 取消；`committing` 防重复提交。 */
function RenameInput({ initial, busy, onSubmit, onCancel }: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (value: string) => {
    if (committed.current) return;
    committed.current = true;
    onSubmit(value);
  };
  return (
    <input
      ref={ref}
      type="text"
      className="row-rename"
      aria-label="重命名会话"
      defaultValue={initial}
      maxLength={80}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          committed.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}

interface PinToggleProps {
  pinned: boolean;
  kindLabel: "项目" | "会话";
  name: string;
  onToggle: () => void;
}

/** 置顶按钮：已置顶常显（彩色 + 淡底）；未置顶灰色，仅在所在行 hover/focus 时显示（见 App.css）。 */
function PinToggle({ pinned, kindLabel, name, onToggle }: PinToggleProps) {
  const action = pinned ? "取消置顶" : "置顶";
  return (
    <button
      type="button"
      className={pinned ? "pin-toggle pin-toggle-on" : "pin-toggle"}
      aria-pressed={pinned}
      aria-label={`${action}${kindLabel} ${name}`}
      title={action}
      onClick={(e) => {
        // 置顶按钮位于会话行内：阻止冒泡，避免点击置顶时选中该行。
        e.stopPropagation();
        onToggle();
      }}
    >
      <Ico icon={Pin} size={12} />
    </button>
  );
}
