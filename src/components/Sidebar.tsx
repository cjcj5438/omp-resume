/** 左侧会话列表：置顶区、过滤、标签过滤、分组折叠、批量勾选、刷新、右键菜单。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError, MetaSnapshot, ProjectGroup, SessionMeta, SessionSummary } from "../types";
import { checkState, type TagCount } from "../listUtils";
import type { PinKind, Pins } from "../pins";
import { displayCwd, errorText, formatRelativeTime, formatSize, openOmpChangelog } from "../format";
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
  buildPinnedGroupMenu,
  buildSessionMenu,
  type CopyKind,
  type SessionMenuActions,
} from "../sessionMenus";
import { EmptyState, Ico, SessionBadges } from "./ui";
import { BookOpen, ChartColumn, ChevronRight, Eraser, History, ListChecks, Pin, Plus, RotateCw, SearchX, Settings2, SquarePen, Theater } from "lucide-react";
import { AppearancePanel } from "./AppearancePanel";
import type { ToastFn } from "./useOmpOp";
import { ModePicker } from "./ModePicker";
import { NewTagDialog } from "./NewTagDialog";
import "./Sidebar.css";

interface SidebarProps {
  groups: ProjectGroup[];
  /** 跨项目聚合的置顶会话（已过滤、按修改时间新→旧；空时不渲染置顶区）。 */
  pinnedSessions: SessionSummary[];
  totalCount: number;
  hiddenEmpty: number;
  query: string;
  onQuery: (q: string) => void;
  loading: boolean;
  listError: AppError | null;
  onRetry: () => void;
  onRefresh: () => void;
  onOpenCheatSheet: () => void;
  manageActive: boolean;
  onToggleManage: () => void;
  statsActive: boolean;
  onToggleStats: () => void;
  stageActive: boolean;
  onToggleStage: () => void;
  cleanupActive: boolean;
  onToggleCleanup: () => void;
  checked: Set<string>;
  onToggleCheck: (path: string, on: boolean) => void;
  /** 批量勾选/取消：paths 为目标会话 path 列表。 */
  onToggleChecks: (paths: string[], on: boolean) => void;
  /** 清除全部勾选。 */
  onClearChecks: () => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  pins: Pins;
  onTogglePin: (kind: PinKind, key: string) => void;
  ompVersion: string | null;
  ompChecking: boolean;
  onCheckOmp: () => void;
  /** 本应用版本；null 时不显示版本行。 */
  appVersion: string | null;
  appChecking: boolean;
  onCheckApp: () => void;
  onNewSession: () => void;
  onNewSessionIn: (cwd: string) => void;
  historyActive: boolean;
  onToggleHistory: () => void;
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

export function Sidebar({
  groups,
  pinnedSessions,
  totalCount,
  hiddenEmpty,
  query,
  onQuery,
  loading,
  listError,
  onRetry,
  onRefresh,
  onOpenCheatSheet,
  manageActive,
  onToggleManage,
  statsActive,
  onToggleStats,
  stageActive,
  onToggleStage,
  cleanupActive,
  onToggleCleanup,
  checked,
  onToggleCheck,
  onToggleChecks,
  onClearChecks,
  selectedPath,
  onSelect,
  pins,
  onTogglePin,
  ompVersion,
  ompChecking,
  onCheckOmp,
  appVersion,
  appChecking,
  onCheckApp,
  onNewSession,
  onNewSessionIn,
  historyActive,
  onToggleHistory,
  meta,
  tagCounts,
  activeTags,
  onToggleTag,
  onToast,
  onOpenIterm,
  onRequestDelete,
  onMetaSnapshot,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // 右键菜单的目标（行 path / 组 cwd / 置顶区键）：仅用于画出当前菜单归属。
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [tagTargets, setTagTargets] = useState<string[] | null>(null);
  // 当前可见的全部会话 path（置顶区 + 各组；置顶已从原组移出，不重复）。
  const visiblePaths = pinnedSessions
    .map((s) => s.path)
    .concat(groups.flatMap((g) => g.sessions.map((s) => s.path)));
  // 右键动作执行时按 path 重新解析会话：列表可能已刷新或会话已被删除。
  const byPath = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const s of pinnedSessions) map.set(s.path, s);
    for (const g of groups) for (const s of g.sessions) map.set(s.path, s);
    return map;
  }, [groups, pinnedSessions]);
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
  // 多选模式（本地 UI 状态）：打开后全部勾选框常显、选择条常驻（即使 0 选中，
  // 以便一键「全选当前列表」）；有任何勾选时自动视为进入选择态。
  const [multiMode, setMultiMode] = useState(false);
  const selecting = multiMode || checked.size > 0;
  // 四个视图按钮同一形态：激活时点击 = 返回上一级（title 说明）。
  const NAV_VIEWS = [
    { label: "舞台", icon: Theater, active: stageActive, hint: "Agent 舞台", onClick: onToggleStage },
    { label: "统计", icon: ChartColumn, active: statsActive, hint: "用量统计", onClick: onToggleStats },
    { label: "清理", icon: Eraser, active: cleanupActive, hint: "清理候选", onClick: onToggleCleanup },
    { label: "提示词历史", icon: History, active: historyActive, hint: "提示词历史", onClick: onToggleHistory },
    { label: "管理", icon: Settings2, active: manageActive, hint: "管理", onClick: onToggleManage },
  ];
  const toggleMulti = () => {
    if (selecting) {
      setMultiMode(false);
      onClearChecks();
    } else {
      setMultiMode(true);
    }
  };

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
      setMultiMode(true);
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
      setMultiMode(true);
      onToggleChecks(paths, true);
    },
    collapseAll: () => setCollapsed(new Set([PINNED_KEY, ...groups.map((g) => g.cwd)])),
    expandAll: () => setCollapsed(new Set()),
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

  return (
    <aside className={selecting ? "sidebar is-selecting" : "sidebar"}>
      <div className="sidebar-top">
        <div className="search-row">
          <input
            type="search"
            className="filter-input"
            placeholder="按标题或项目目录过滤"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="过滤会话"
          />
          <button
            type="button"
            className="btn icon-btn"
            aria-label="刷新"
            title="刷新"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <Ico icon={RotateCw} size={13} />
            )}
          </button>
          <button
            type="button"
            className="btn icon-btn icon-btn-multi"
            aria-label="多选"
            aria-pressed={selecting}
            title="多选"
            onClick={toggleMulti}
          >
            <Ico icon={ListChecks} size={13} />
          </button>
        </div>
        <button type="button" className="btn btn-accent new-session-btn" onClick={onNewSession}>
          <Ico icon={SquarePen} size={13} />新会话…
        </button>
        <div className="view-nav" role="group" aria-label="视图切换">
          {NAV_VIEWS.map((v) => (
            <button
              key={v.label}
              type="button"
              className="view-nav-btn"
              aria-pressed={v.active}
              title={v.active ? "返回上一级" : v.hint}
              onClick={v.onClick}
            >
              <Ico icon={v.icon} size={13} />
              {v.label}
            </button>
          ))}
          <button type="button" className="view-nav-btn" onClick={onOpenCheatSheet}>
            <Ico icon={BookOpen} size={13} />
            速查
          </button>
        </div>
      </div>
      {selecting && (checked.size > 0 || visiblePaths.length > 0) ? (
        <div className="select-bar">
          <span>已选 {checked.size} 项</span>
          {hasUncheckedVisible ? (
            <button
              type="button"
              className="select-link"
              onClick={() => onToggleChecks(visiblePaths, true)}
            >
              全选当前列表
            </button>
          ) : null}
          {checked.size > 0 ? (
            <button type="button" className="select-link" onClick={onClearChecks}>
              清除选择
            </button>
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
      <div className="sidebar-list">
        {listError ? (
          <div className="banner banner-error" role="alert">
            <span>{errorText(listError)}</span>
            <button type="button" className="btn btn-small" onClick={onRetry}>
              重试
            </button>
          </div>
        ) : null}
        {groups.length === 0 && pinnedSessions.length === 0 ? (
          <EmptyState icon={SearchX} title="没有匹配的会话">
            换个关键词，或清除标签筛选。
          </EmptyState>
        ) : null}
        {pinnedSessions.length > 0 ? (
          <section className="group pinned-group" aria-label="置顶会话">
            <div
              className={
                menuTarget === PINNED_KEY ? "group-header-row row-menu-target" : "group-header-row"
              }
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openGroupMenu(
                  PINNED_KEY,
                  buildPinnedGroupMenu(
                    pinnedSessions.map((s) => s.path),
                    actions,
                  ),
                );
              }}
            >
              <GroupCheck
                label="选择全部置顶会话"
                paths={pinnedSessions.map((s) => s.path)}
                checked={checked}
                onToggle={onToggleChecks}
              />
              <button
                type="button"
                className="group-header"
                aria-expanded={!collapsed.has(PINNED_KEY)}
                onClick={() => toggleCollapsed(PINNED_KEY)}
              >
                <span
                  className={collapsed.has(PINNED_KEY) ? "group-arrow" : "group-arrow group-arrow-open"}
                  aria-hidden="true"
                >
                  <Ico icon={ChevronRight} size={12} />
                </span>
                <span className="pinned-pin" aria-hidden="true">
                  <Ico icon={Pin} size={12} />
                </span>
                <span className="pinned-name">置顶</span>
                <span className="pinned-count">{pinnedSessions.length}</span>
              </button>
            </div>
            {!collapsed.has(PINNED_KEY) ? (
              <div className="group-rows">
                {pinnedSessions.map((s) => (
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
                    onSelect={onSelect}
                    onRowMenu={() => openRowMenu(s)}
                    pinned
                    onTogglePin={() => onTogglePin("session", s.id)}
                    projectName={s.cwd.split("/").filter(Boolean).pop() ?? s.cwd}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
        {groups.map((g) => {
          const open = !collapsed.has(g.cwd);
          // 空组是“会话均已置顶”的占位组：目录状态未知，不展示“目录不存在”。
          const dirMissing = g.sessions.length > 0 && g.sessions.every((s) => !s.cwdExists);
          const name = g.cwd.split("/").filter(Boolean).pop() ?? g.cwd;
          const pinnedProject = pins.projects.includes(g.cwd);
          return (
            <section className="group" key={g.cwd}>
              <div
                className={
                  menuTarget === g.cwd ? "group-header-row row-menu-target" : "group-header-row"
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
                  className="group-header"
                  aria-expanded={open}
                  onClick={() => toggleCollapsed(g.cwd)}
                >
                  <span
                    className={open ? "group-arrow group-arrow-open" : "group-arrow"}
                    aria-hidden="true"
                  >
                    <Ico icon={ChevronRight} size={12} />
                  </span>
                  <span className="group-name">{name}</span>
                  <span className="group-cwd mono">{displayCwd(g.cwd)}</span>
                  {dirMissing ? <span className="badge badge-danger">目录不存在</span> : null}
                  {g.sessions.length > 0 ? (
                    <span className="group-count">{g.sessions.length}</span>
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
                  {g.sessions.length === 0 ? (
                    <div className="group-empty-note">该项目的会话均已置顶</div>
                  ) : (
                    g.sessions.map((s) => (
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
                        onSelect={onSelect}
                        onRowMenu={() => openRowMenu(s)}
                        pinned={pins.sessions.includes(s.id)}
                        onTogglePin={() => onTogglePin("session", s.id)}
                      />
                    ))
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <footer className="sidebar-footer">
        <div className="footer-row">
          <span className="footer-count">
            共 {totalCount} 个会话 · 已隐藏 {hiddenEmpty} 个空会话
          </span>
          <ModePicker onToast={onToast} />
          <AppearancePanel />
        </div>
        {appVersion !== null ? (
          <div className="footer-row">
            <span className="mono muted">omp-resume {appVersion}</span>
            <div className="footer-actions">
              <button
                type="button"
                className="btn btn-small footer-update"
                disabled={appChecking}
                onClick={onCheckApp}
              >
                {appChecking ? <span className="spinner" aria-hidden="true" /> : null}
                检查应用更新
              </button>
            </div>
          </div>
        ) : null}
        {ompVersion !== null ? (
          <div className="footer-row">
            <span className="mono muted">omp {ompVersion}</span>
            <div className="footer-actions">
              <button
                type="button"
                className="btn btn-small footer-update"
                disabled={ompChecking}
                onClick={onCheckOmp}
              >
                {ompChecking ? <span className="spinner" aria-hidden="true" /> : null}
                检查 omp 更新
              </button>
              <button
                type="button"
                className="changelog-link"
                title="在浏览器打开 omp 官方更新日志"
                onClick={() => void openOmpChangelog()}
              >
                更新日志
              </button>
            </div>
          </div>
        ) : null}
      </footer>
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
    </aside>
  );
}

/** 置顶区在折叠集中的键（cwd 均为绝对路径，不会冲突）。 */
const PINNED_KEY = "__pinned__";

interface GroupCheckProps {
  label: string;
  /** 该组当前可见会话的 path（已过滤、含已折叠）。 */
  paths: string[];
  checked: Set<string>;
  onToggle: (paths: string[], on: boolean) => void;
}

/** 组头三态复选框：全选 / 部分（indeterminate）/ 无。 */
function GroupCheck({ label, paths, checked, onToggle }: GroupCheckProps) {
  const state = checkState(paths, checked);
  return (
    <input
      type="checkbox"
      className="group-check"
      aria-label={label}
      checked={state === "all"}
      ref={(el) => {
        if (el) el.indeterminate = state === "some";
      }}
      onChange={(e) => onToggle(paths, e.target.checked)}
    />
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
  onSelect: (path: string) => void;
  onRowMenu: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** 置顶行展示所属项目名；普通行不传。 */
  projectName?: string;
}

/** 会话行：有别名时别名作主标题、原标题小号灰字附后；至多 3 个标签徽章（多余计 `+N`）。 */
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
  onSelect,
  onRowMenu,
  pinned,
  onTogglePin,
  projectName,
}: RowProps) {
  const alias = meta?.alias ?? null;
  const shownTags = (meta?.tags ?? []).slice(0, 3);
  const extraTags = (meta?.tags ?? []).length - shownTags.length;
  const cls = [
    "row",
    selected ? "row-selected" : "",
    pinned ? "row-pinned" : "",
    menuTargeted ? "row-menu-target" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      onClick={() => onSelect(s.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRowMenu();
      }}
    >
      <input
        type="checkbox"
        className="row-check"
        aria-label={`选择 ${alias ?? s.title}`}
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onToggleCheck(s.path, e.target.checked)}
      />
      <div className="row-main">
        <div className="row-title-line">
          <div className="row-title" title={alias ? `${alias}（原标题：${s.title}）` : s.title}>
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
          </div>
          {/* 状态徽章固定跟在标题后：meta 行恒为单行，所有行等高。 */}
          <SessionBadges s={s} />
        </div>
        <div className="row-meta">
          {projectName ? (
            <span className="row-project" title={`所属项目：${projectName}`}>
              {projectName}
            </span>
          ) : null}
          <span
            className="row-meta-combo"
            title={`${s.messageCount} 条消息 · ${formatSize(s.sizeBytes)}`}
          >
            {formatRelativeTime(s.modifiedAt)} · {s.messageCount} 条 · {formatSize(s.sizeBytes)}
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
      <PinToggle
        pinned={pinned}
        kindLabel="会话"
        name={alias ?? s.title}
        onToggle={onTogglePin}
      />
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
