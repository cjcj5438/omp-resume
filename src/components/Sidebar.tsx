/** 左侧会话列表：过滤、标签过滤、分组折叠、批量勾选、刷新。 */
import { useState } from "react";
import type { AppError, MetaSnapshot, ProjectGroup, SessionMeta, SessionSummary } from "../types";
import type { TagCount } from "../listUtils";
import type { PinKind, Pins } from "../pins";
import { displayCwd, errorText, formatRelativeTime, formatSize } from "../format";
import { SessionBadges } from "./ui";
import { AppearancePanel } from "./AppearancePanel";

interface SidebarProps {
  groups: ProjectGroup[];
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
  cleanupActive: boolean;
  onToggleCleanup: () => void;
  checked: Set<string>;
  onToggleCheck: (path: string, on: boolean) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  pins: Pins;
  onTogglePin: (kind: PinKind, key: string) => void;
  ompVersion: string | null;
  ompChecking: boolean;
  onCheckOmp: () => void;
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
}

export function Sidebar({
  groups,
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
  cleanupActive,
  onToggleCleanup,
  checked,
  onToggleCheck,
  selectedPath,
  onSelect,
  pins,
  onTogglePin,
  ompVersion,
  ompChecking,
  onCheckOmp,
  onNewSession,
  onNewSessionIn,
  historyActive,
  onToggleHistory,
  meta,
  tagCounts,
  activeTags,
  onToggleTag,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <input
          type="search"
          className="filter-input"
          placeholder="按标题或项目目录过滤"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          aria-label="过滤会话"
        />
        <button type="button" className="btn" onClick={onNewSession}>
          新会话…
        </button>
        <button type="button" className="btn" aria-pressed={statsActive} onClick={onToggleStats}>
          统计
        </button>
        <button type="button" className="btn" aria-pressed={cleanupActive} onClick={onToggleCleanup}>
          清理
        </button>
        <button type="button" className="btn" aria-pressed={historyActive} onClick={onToggleHistory}>
          提示词历史
        </button>
        <button type="button" className="btn" aria-pressed={manageActive} onClick={onToggleManage}>
          管理
        </button>
        <button type="button" className="btn" onClick={onOpenCheatSheet}>
          速查
        </button>
        <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? <span className="spinner" aria-hidden="true" /> : null}
          刷新
        </button>
      </div>
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
        {groups.length === 0 ? (
          <div className="pane-note">没有匹配的会话</div>
        ) : null}
        {groups.map((g) => {
          const open = !collapsed.has(g.cwd);
          const dirMissing = g.sessions.every((s) => !s.cwdExists);
          const name = g.cwd.split("/").filter(Boolean).pop() ?? g.cwd;
          const pinnedProject = pins.projects.includes(g.cwd);
          return (
            <section className="group" key={g.cwd}>
              <div className="group-header-row">
                <button
                  type="button"
                  className="group-header"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.cwd)) next.delete(g.cwd);
                      else next.add(g.cwd);
                      return next;
                    })
                  }
                >
                  <span className="group-arrow" aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="group-name">{name}</span>
                  <span className="group-cwd mono">{displayCwd(g.cwd)}</span>
                  {dirMissing ? <span className="badge badge-danger">目录不存在</span> : null}
                  <span className="group-count">{g.sessions.length}</span>
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
                  +
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
                      onToggleCheck={onToggleCheck}
                      onSelect={onSelect}
                      pinned={pins.sessions.includes(s.id)}
                      onTogglePin={() => onTogglePin("session", s.id)}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <footer className="sidebar-footer">
        共 {totalCount} 个会话 · 已隐藏 {hiddenEmpty} 个空会话
        {ompVersion !== null ? (
          <div className="omp-row">
            <span className="mono muted">omp {ompVersion}</span>
            <button
              type="button"
              className="btn btn-small"
              disabled={ompChecking}
              onClick={onCheckOmp}
            >
              {ompChecking ? <span className="spinner" aria-hidden="true" /> : null}
              检查 omp 更新
            </button>
          </div>
        ) : null}
        <div className="omp-row">
          <AppearancePanel />
        </div>
      </footer>
    </aside>
  );
}

interface RowProps {
  s: SessionSummary;
  /** 该会话的应用侧备注；null = 无。 */
  meta: SessionMeta | null;
  checked: boolean;
  selected: boolean;
  onToggleCheck: (path: string, on: boolean) => void;
  onSelect: (path: string) => void;
  pinned: boolean;
  onTogglePin: () => void;
}

/** 会话行：有别名时别名作主标题、原标题小号灰字附后；至多 3 个标签徽章（多余计 `+N`）。 */
function Row({ s, meta, checked, selected, pinned, onToggleCheck, onSelect, onTogglePin }: RowProps) {
  const alias = meta?.alias ?? null;
  const shownTags = (meta?.tags ?? []).slice(0, 3);
  const extraTags = (meta?.tags ?? []).length - shownTags.length;
  return (
    <div
      className={selected ? "row row-selected" : "row"}
      onClick={() => onSelect(s.path)}
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
        <div className="row-title" title={alias ? `${alias}（原标题：${s.title}）` : s.title}>
          {alias ? (
            <>
              <span>{alias}</span>
              <span className="row-title-orig">{s.title}</span>
            </>
          ) : (
            s.title
          )}
        </div>
        <div className="row-meta">
          <span>{formatRelativeTime(s.modifiedAt)}</span>
          <span>{s.messageCount} 条消息</span>
          <span>{formatSize(s.sizeBytes)}</span>
          <SessionBadges s={s} />
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

interface PinToggleProps {
  pinned: boolean;
  kindLabel: "项目" | "会话";
  name: string;
  onToggle: () => void;
}

/** 置顶按钮：已置顶时常显；未置顶时仅在所在行 hover/focus 时显示（见 App.css）。 */
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
      📌
    </button>
  );
}
