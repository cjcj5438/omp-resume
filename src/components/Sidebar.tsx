/** 左侧会话列表：置顶区、过滤、标签过滤、分组折叠、批量勾选、刷新。 */
import { useState } from "react";
import type { AppError, MetaSnapshot, ProjectGroup, SessionMeta, SessionSummary } from "../types";
import { checkState, type TagCount } from "../listUtils";
import type { PinKind, Pins } from "../pins";
import { displayCwd, errorText, formatRelativeTime, formatSize, openOmpChangelog } from "../format";
import { SessionBadges } from "./ui";
import { AppearancePanel } from "./AppearancePanel";
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
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // 当前可见的全部会话 path（置顶区 + 各组；置顶已从原组移出，不重复）。
  const visiblePaths = pinnedSessions
    .map((s) => s.path)
    .concat(groups.flatMap((g) => g.sessions.map((s) => s.path)));
  const hasUncheckedVisible = visiblePaths.some((p) => !checked.has(p));
  // 多选模式（本地 UI 状态）：打开后全部勾选框常显、选择条常驻（即使 0 选中，
  // 以便一键「全选当前列表」）；有任何勾选时自动视为进入选择态。
  const [multiMode, setMultiMode] = useState(false);
  const selecting = multiMode || checked.size > 0;
  // 四个视图按钮同一形态：激活时点击 = 返回上一级（title 说明）。
  const NAV_VIEWS = [
    { label: "统计", active: statsActive, hint: "用量统计", onClick: onToggleStats },
    { label: "清理", active: cleanupActive, hint: "清理候选", onClick: onToggleCleanup },
    { label: "提示词历史", active: historyActive, hint: "提示词历史", onClick: onToggleHistory },
    { label: "管理", active: manageActive, hint: "管理", onClick: onToggleManage },
  ];
  const toggleMulti = () => {
    if (selecting) {
      setMultiMode(false);
      onClearChecks();
    } else {
      setMultiMode(true);
    }
  };
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
              <span aria-hidden="true">↻</span>
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
            <span aria-hidden="true">☑</span>
          </button>
        </div>
        <button type="button" className="btn btn-accent new-session-btn" onClick={onNewSession}>
          <span aria-hidden="true" className="new-session-plus">+</span>新会话…
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
              {v.label}
            </button>
          ))}
          <button type="button" className="view-nav-btn" onClick={onOpenCheatSheet}>
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
          <div className="pane-note">没有匹配的会话</div>
        ) : null}
        {pinnedSessions.length > 0 ? (
          <section className="group pinned-group" aria-label="置顶会话">
            <div className="group-header-row">
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
                  ▸
                </span>
                <span className="pinned-pin" aria-hidden="true">
                  📌
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
                    onToggleCheck={onToggleCheck}
                    onSelect={onSelect}
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
              <div className="group-header-row">
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
                    ▸
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
                  +
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
                        onToggleCheck={onToggleCheck}
                        onSelect={onSelect}
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
          <AppearancePanel />
        </div>
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
  onToggleCheck: (path: string, on: boolean) => void;
  onSelect: (path: string) => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** 置顶行展示所属项目名；普通行不传。 */
  projectName?: string;
}

/** 会话行：有别名时别名作主标题、原标题小号灰字附后；至多 3 个标签徽章（多余计 `+N`）。 */
function Row({ s, meta, checked, selected, pinned, onToggleCheck, onSelect, onTogglePin, projectName }: RowProps) {
  const alias = meta?.alias ?? null;
  const shownTags = (meta?.tags ?? []).slice(0, 3);
  const extraTags = (meta?.tags ?? []).length - shownTags.length;
  return (
    <div
      className={`row${selected ? " row-selected" : ""}${pinned ? " row-pinned" : ""}`}
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
          {projectName ? (
            <span className="row-project" title={`所属项目：${projectName}`}>
              {projectName}
            </span>
          ) : null}
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
      📌
    </button>
  );
}
