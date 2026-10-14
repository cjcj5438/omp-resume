/** 左侧会话列表：过滤、分组折叠、批量勾选、刷新。 */
import { useState } from "react";
import type { AppError, ProjectGroup, SessionSummary } from "../types";
import { displayCwd, errorText, formatRelativeTime, formatSize } from "../format";
import { SessionBadges } from "./ui";

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
  checked: Set<string>;
  onToggleCheck: (path: string, on: boolean) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
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
  checked,
  onToggleCheck,
  selectedPath,
  onSelect,
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
        <button type="button" className="btn" onClick={onOpenCheatSheet}>
          速查
        </button>
        <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? <span className="spinner" aria-hidden="true" /> : null}
          刷新
        </button>
      </div>
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
          return (
            <section className="group" key={g.cwd}>
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
                <span className="group-name">
                  {g.cwd.split("/").filter(Boolean).pop() ?? g.cwd}
                </span>
                <span className="group-cwd mono">{displayCwd(g.cwd)}</span>
                {dirMissing ? <span className="badge badge-danger">目录不存在</span> : null}
                <span className="group-count">{g.sessions.length}</span>
              </button>
              {open ? (
                <div className="group-rows">
                  {g.sessions.map((s) => (
                    <Row
                      key={s.path}
                      s={s}
                      checked={checked.has(s.path)}
                      selected={s.path === selectedPath}
                      onToggleCheck={onToggleCheck}
                      onSelect={onSelect}
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
      </footer>
    </aside>
  );
}

interface RowProps {
  s: SessionSummary;
  checked: boolean;
  selected: boolean;
  onToggleCheck: (path: string, on: boolean) => void;
  onSelect: (path: string) => void;
}

function Row({ s, checked, selected, onToggleCheck, onSelect }: RowProps) {
  return (
    <div
      className={selected ? "row row-selected" : "row"}
      onClick={() => onSelect(s.path)}
    >
      <input
        type="checkbox"
        className="row-check"
        aria-label={`选择 ${s.title}`}
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onToggleCheck(s.path, e.target.checked)}
      />
      <div className="row-main">
        <div className="row-title" title={s.title}>
          {s.title}
        </div>
        <div className="row-meta">
          <span>{formatRelativeTime(s.modifiedAt)}</span>
          <span>{s.messageCount} 条消息</span>
          <span>{formatSize(s.sizeBytes)}</span>
          <SessionBadges s={s} />
        </div>
      </div>
    </div>
  );
}
