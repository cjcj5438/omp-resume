/** 工作台左栏（设计稿 sessionRail）：268px 卡片 + 紧凑行 + 小组头 + 选中边框。
 * railQuery 与列表页共用 App.query（同一过滤口径）；搜索为空时沿用列表页过滤结果。
 * 右键菜单/重命名/标签写入复用 SessionList 的 sessionMenus 动作（扩展保留）。
 */
import { useMemo, useRef, useState } from "react";
import type { AppError, MetaSnapshot, ProjectGroup, SessionSummary } from "../types";
import type { PinKind, Pins } from "../pins";
import { formatRelativeTime, errorText } from "../format";
import { buildGroupMenu, buildSessionMenu, type CopyKind, type SessionMenuActions } from "../sessionMenus";
import { popupMenu, type MenuSpec } from "../nativeMenu";
import { EmptyState, Ico } from "./ui";
import { ErrorBanner, SearchInput } from "./page";
import { ChevronDown, Folder, Pin, Plus, SearchX } from "lucide-react";
import { copyText } from "../clipboard";
import {
  getMeta,
  getResumeCommand,
  normalizeError,
  openProjectDir,
  revealSessionFile,
} from "../api";
import { MetaBatchError, applyTag } from "../metaOps";
import type { ToastFn } from "./useOmpOp";
import { NewTagDialog } from "./NewTagDialog";

interface SessionRailProps {
  groups: ProjectGroup[];
  /** 全量会话数（foot 分母）。 */
  totalCount: number;
  query: string;
  onQuery: (q: string) => void;
  listError: AppError | null;
  onRetry: () => void;
  selectedPath: string | null;
  /** 行激活：切换工作台选中。 */
  onSelectPath: (path: string) => void;
  /** rail head「+」：打开新建会话对话框。 */
  onNewSession: () => void;
  onNewSessionIn: (cwd: string) => void;
  collapsed: ReadonlySet<string>;
  onCollapsedChange: (next: Set<string>) => void;
  pins: Pins;
  onTogglePin: (kind: PinKind, key: string) => void;
  meta: MetaSnapshot | null;
  onToast: ToastFn;
  onOpenIterm: (s: SessionSummary) => void;
  onRequestDelete: (paths: string[]) => void;
  onMetaSnapshot: (snap: MetaSnapshot) => void;
}

export function SessionRail({
  groups,
  totalCount,
  query,
  onQuery,
  listError,
  onRetry,
  selectedPath,
  onSelectPath,
  onNewSession,
  onNewSessionIn,
  collapsed,
  onCollapsedChange,
  pins,
  onTogglePin,
  meta,
  onToast,
  onOpenIterm,
  onRequestDelete,
  onMetaSnapshot,
}: SessionRailProps) {
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const [tagTargets, setTagTargets] = useState<string[] | null>(null);
  const visibleCount = groups.reduce((n, g) => n + g.sessions.length, 0);

  const byPath = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const g of groups) for (const s of g.sessions) map.set(s.path, s);
    return map;
  }, [groups]);
  const byPathRef = useRef(byPath);
  byPathRef.current = byPath;

  const liveSession = (path: string): SessionSummary | null => {
    const found = byPathRef.current.get(path) ?? null;
    if (found === null) onToast("会话已不存在", "error");
    return found;
  };

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
      onToast(`已更新 ${result.updated} 个会话的标签`, "info");
    } catch (e: unknown) {
      if (e instanceof MetaBatchError) {
        const err = normalizeError(e.cause);
        if (err.code === "CONFLICT") {
          try {
            onMetaSnapshot(await getMeta());
          } catch {
            // 保留旧快照，提示用户重试。
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

  const actions: SessionMenuActions = {
    openIterm: (s) => {
      const live = liveSession(s.path);
      if (live !== null) onOpenIterm(live);
    },
    newSessionIn: (cwd) => onNewSessionIn(cwd),
    togglePin: (kind, key) => onTogglePin(kind, key),
    startRename: () => {},
    toggleTag: (ids, tag, on) => {
      void runTag(ids, tag, on);
    },
    newTag: (ids) => setTagTargets(ids),
    copy: (kind, targets, literal) => {
      void copy(kind, targets, literal);
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
    enterSelect: () => {},
    requestDelete: (paths) => {
      const live = paths.filter((p) => byPathRef.current.has(p));
      if (live.length === 0) {
        onToast("会话已不存在", "error");
        return;
      }
      onRequestDelete(live);
    },
    selectGroup: () => {},
    collapseAll: () => onCollapsedChange(new Set(groups.map((g) => g.cwd))),
    expandAll: () => onCollapsedChange(new Set()),
  };

  function openMenu(key: string, specs: MenuSpec[]): void {
    setMenuTarget(key);
    void popupMenu(specs).finally(() => setMenuTarget(null));
  }

  function openRowMenu(s: SessionSummary): void {
    openMenu(
      s.path,
      buildSessionMenu(
        s,
        {
          meta: meta?.sessions[s.id] ?? null,
          metaReady: meta !== null,
          pinned: pins.sessions.includes(s.id),
          allTags: [],
        },
        actions,
      ),
    );
  }

  function toggleCollapsed(key: string): void {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onCollapsedChange(next);
  }

  const forceOpen = query.trim().length > 0;
  return (
    <aside className="ws-rail" aria-label="会话列表">
      <div className="ws-rail-head">
        <div className="ws-search">
          <SearchInput
            icon
            label="搜索会话"
            placeholder="搜索会话"
            value={query}
            onChange={onQuery}
          />
        </div>
        <button
          type="button"
          className="icon-btn ws-new-btn"
          aria-label="新建会话"
          title="新建会话"
          onClick={onNewSession}
        >
          <Ico icon={Plus} size={14} />
        </button>
      </div>
      <div className="ws-rail-body">
        {listError ? <ErrorBanner error={listError} onRetry={onRetry} /> : null}
        {visibleCount === 0 && listError === null ? (
          <EmptyState icon={SearchX} title="没有匹配的会话">
            换个关键词试试。
          </EmptyState>
        ) : null}
        {groups.map((g) => {
          const open = forceOpen || !collapsed.has(g.cwd);
          const name = g.cwd.split("/").filter(Boolean).pop() ?? g.cwd;
          const dirMissing =
            g.sessions.length > 0 && g.sessions.every((s) => !s.cwdExists);
          return (
            <div className="ws-group" key={g.cwd}>
              <button
                type="button"
                className="ws-group-label"
                aria-expanded={open}
                onClick={() => toggleCollapsed(g.cwd)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openMenu(
                    g.cwd,
                    buildGroupMenu(
                      {
                        cwd: g.cwd,
                        paths: g.sessions.map((s) => s.path),
                        dirMissing,
                        pinned: pins.projects.includes(g.cwd),
                      },
                      actions,
                    ),
                  );
                }}
              >
                <span className="ws-group-name">
                  <span
                    className={open ? "ws-chev" : "ws-chev is-collapsed"}
                    aria-hidden="true"
                  >
                    <Ico icon={ChevronDown} size={10} />
                  </span>
                  <Ico icon={Folder} size={11} aria-hidden="true" />
                  {name}
                </span>
                <span>{g.sessions.length}</span>
              </button>
              {open
                ? g.sessions.map((s) => {
                    const pinned = pins.sessions.includes(s.id);
                    const alias = meta?.sessions[s.id]?.alias ?? null;
                    const title = alias ?? s.title;
                    const active = s.path === selectedPath;
                    return (
                      <div className="ws-row-wrap" key={s.path}>
                        <button
                          type="button"
                          className={active ? "ws-row is-on" : "ws-row"}
                          aria-current={active || undefined}
                          aria-label={`打开会话：${title}`}
                          title={alias ? `${alias}（原标题：${s.title}）` : s.title}
                          onClick={() => onSelectPath(s.path)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openRowMenu(s);
                          }}
                          data-menu-target={menuTarget === s.path || undefined}
                        >
                          <span className="ws-row-head">
                            <span className="ws-row-title">{title}</span>
                            {s.inUse ? (
                              <span className="dot live" title="占用中" aria-label="占用中" />
                            ) : null}
                          </span>
                          <span className="ws-row-meta">
                            <span>{s.messageCount} 条</span>
                            <span>{formatRelativeTime(s.modifiedAt)}</span>
                            {!s.formatSupported ? <span className="ws-warn">v2</span> : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={pinned ? "ws-pin-btn is-on" : "ws-pin-btn"}
                          aria-pressed={pinned}
                          aria-label={`${pinned ? "取消置顶" : "置顶"}：${title}`}
                          title={pinned ? "取消置顶" : "置顶会话"}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTogglePin("session", s.id);
                          }}
                        >
                          <Ico icon={Pin} size={11} />
                        </button>
                      </div>
                    );
                  })
                : null}
            </div>
          );
        })}
      </div>
      <div className="ws-rail-foot">
        <span>
          {visibleCount} / {totalCount} 个会话
        </span>
      </div>
      {tagTargets !== null ? (
        <NewTagDialog
          count={tagTargets.length}
          existing={[]}
          known={[]}
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
