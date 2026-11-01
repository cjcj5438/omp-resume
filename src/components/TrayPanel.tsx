/**
 * 菜单栏面板共享组件：真面板窗口与菜单栏页左侧预览渲染同一组件。
 * `mode: "panel"` 真面板（全部操作接真）/ `"preview"` 菜单栏页预览（行点击跳工作台）。
 * 数据全部来自 `TrayPreview` + `TraySettings` 真实后端；头部计数/分组前端派生。
 */
import { useMemo, useRef, useState } from "react";
import {
  Check,
  Cpu,
  ExternalLink,
  History,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import { Ico } from "./ui";
import type {
  TrayPreview,
  TrayPreviewRow,
  TraySettings,
  TrayTitleWidth,
} from "../types";
import "./TrayPanel.css";

/** 状态键 → 中文名（设计稿 TRAY_STATUS；stuck 用「可能卡住」）。 */
export const TRAY_STATUS_NAME: Record<TrayPreviewRow["status"], string> = {
  working: "工作中",
  waiting: "等待输入",
  idle: "空闲",
  stuck: "可能卡住",
};

/** 托盘 π 字形图标（设计稿 TRAY_MARK 同款）。 */
export function TrayMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="4" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7 9.5h5M7 13h10M7 16.5h7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 项目缩写：按 [-_/] 取首字母 ≤2，大写；未知项目 → "··"。 */
export function projectGlyph(project: string | null): string {
  if (project === null || project.trim() === "") return "··";
  const parts = project.split(/[-_/]+/).filter((p) => p.length > 0);
  const glyph = parts
    .slice(0, 2)
    .map((p) => [...p][0] ?? "")
    .join("");
  return (glyph || "··").toUpperCase();
}

/** 时长格式化（设计稿带空格口径）：刚刚 / X 分钟 / X 小时 / X 天。 */
export function formatTrayElapsed(secs: number): string {
  if (secs < 60) return "刚刚";
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时`;
  return `${Math.floor(secs / 86400)} 天`;
}

export interface TrayPanelActions {
  onFocusSession: (sessionId: string) => void;
  onResumeRecent: (sessionId: string) => void;
  onNewSession: () => void;
  onOpenMain: (page?: string) => void;
  onOpenSettings: () => void;
  onSwitchMode: (name: string) => void;
  onQuit: () => void;
}

interface TrayPanelProps {
  preview: TrayPreview;
  settings: TraySettings;
  mode: "panel" | "preview";
  actions: TrayPanelActions;
  appVersion: string | null;
  ompVersion: string | null;
  switchingMode: string | null;
}

type Expanded = "recent" | "modes" | null;

export function TrayPanel({
  preview,
  settings,
  mode,
  actions,
  appVersion,
  ompVersion,
  switchingMode,
}: TrayPanelProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Expanded>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  const allRows = useMemo(
    () => [...preview.rows, ...preview.overflow],
    [preview.rows, preview.overflow],
  );
  const counts = useMemo(() => {
    let working = 0;
    let waiting = 0;
    let stuck = 0;
    for (const r of allRows) {
      if (r.status === "working") working += 1;
      else if (r.status === "waiting") waiting += 1;
      else if (r.status === "stuck") stuck += 1;
    }
    return { total: allRows.length, working, waiting, stuck };
  }, [allRows]);

  const match = (r: TrayPreviewRow): boolean =>
    q === "" ||
    `${r.title} ${r.project ?? ""} ${TRAY_STATUS_NAME[r.status]}`.toLowerCase().includes(q);
  const runningRows = allRows.filter((r) => r.status !== "idle" && match(r));
  const idleRows = allRows.filter((r) => r.status === "idle" && match(r));
  const resultRows = allRows.filter(match);

  const activeMode = preview.modes?.find((m) => m.active) ?? null;
  const widthClass =
    settings.titleWidth === "compact"
      ? "w-compact"
      : settings.titleWidth === "wide"
        ? "w-wide"
        : "w-standard";

  const sessionBody =
    q !== "" ? (
      resultRows.length > 0 ? (
        <SessionSection title="搜索结果" count={resultRows.length}>
          {resultRows.map((r) => (
            <SessionRow key={r.sessionId} row={r} showProject={settings.showProject} onFocus={() => actions.onFocusSession(r.sessionId)} />
          ))}
        </SessionSection>
      ) : (
        <div className="tray-empty">没有匹配「{query.trim()}」的会话</div>
      )
    ) : (
      <>
        {runningRows.length > 0 ? (
          <SessionSection title="正在运行" count={runningRows.length}>
            {runningRows.map((r) => (
              <SessionRow key={r.sessionId} row={r} showProject={settings.showProject} onFocus={() => actions.onFocusSession(r.sessionId)} />
            ))}
          </SessionSection>
        ) : null}
        {settings.showIdle && idleRows.length > 0 ? (
          <SessionSection
            title="最近空闲"
            link={
              <button
                type="button"
                className="tray-sec-link"
                onClick={() => actions.onOpenMain("sessions")}
              >
                全部 {counts.total} 个
              </button>
            }
          >
            {idleRows.map((r) => (
              <SessionRow key={r.sessionId} row={r} showProject={settings.showProject} onFocus={() => actions.onFocusSession(r.sessionId)} />
            ))}
          </SessionSection>
        ) : null}
        {runningRows.length === 0 && idleRows.length === 0 ? (
          <div className="tray-empty">没有运行中的 omp 会话</div>
        ) : null}
      </>
    );

  return (
    <div className={`tray-pop ${widthClass}${settings.compactRows ? " is-compact" : ""}`}>
      <div className="tray-panel-head">
        <div className="tray-id">
          <span className="tray-appmark">
            <TrayMark />
          </span>
          <div>
            <div className="tray-name">omp-resume</div>
            <div className="tray-summary">
              <span className="dot ok" aria-hidden="true" />
              {counts.total} 个会话 · {counts.working} 工作中 · {counts.waiting} 等待输入
            </div>
          </div>
        </div>
        {settings.showCost && preview.costUsd !== null ? (
          <div className="tray-spend">
            <strong>${preview.costUsd.toFixed(2)}</strong>
            <span>今日 · {preview.requestCount ?? 0} 请求</span>
          </div>
        ) : null}
      </div>
      {settings.showSearch ? (
        <div className="tray-search-row">
          <Ico icon={Search} size={14} />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder="搜索会话或项目…"
            autoComplete="off"
            aria-label="搜索会话或项目"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query !== "" ? (
            <button
              type="button"
              className="tray-clear"
              aria-label="清除搜索"
              onClick={() => { setQuery(""); searchRef.current?.focus(); }}
            >
              <Ico icon={X} size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="tray-sessions">{sessionBody}</div>
      {expanded === "recent" ? (
        <div className="tray-expand" role="region" aria-label="最近会话">
          <div className="tray-sec-head">
            <span>最近会话</span>
            <span className="tray-count">{preview.recent.length}</span>
          </div>
          {preview.recent.length === 0 ? (
            <div className="tray-expand-empty">没有最近会话</div>
          ) : (
            preview.recent.map((e) => (
              <button
                key={e.key}
                type="button"
                className="tray-expand-row"
                onClick={() => actions.onResumeRecent(e.key)}
              >
                <span className="tray-expand-text">{e.text}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {expanded === "modes" ? (
        <div className="tray-expand" role="region" aria-label="模式">
          <div className="tray-sec-head">
            <span>模式</span>
            <span className="tray-expand-hint">模型预设</span>
          </div>
          {preview.modes === null ? (
            <div className="tray-expand-empty">尚未读到模式列表</div>
          ) : (
            preview.modes.map((m) => (
              <button
                key={m.name}
                type="button"
                className="tray-expand-row"
                disabled={!m.enabled || switchingMode !== null}
                onClick={() => actions.onSwitchMode(m.name)}
              >
                <span className="tray-expand-check" aria-hidden="true">
                  {m.active ? <Ico icon={Check} size={12} /> : null}
                </span>
                <span className="tray-expand-text">
                  {m.name}
                  {switchingMode === m.name ? "（切换中…）" : ""}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
      <div className="tray-actions">
        <button type="button" className="tray-cta" onClick={actions.onNewSession}>
          <Ico icon={Plus} size={14} />
          <span>新建会话</span>
          <span className="tray-kbd">⌘N</span>
        </button>
        <div className="tray-quick">
          <button
            type="button"
            aria-expanded={expanded === "recent"}
            onClick={() => setExpanded((e) => (e === "recent" ? null : "recent"))}
          >
            <Ico icon={History} size={14} />
            <span>最近会话</span>
            <span>{preview.recent.length}</span>
          </button>
          <button
            type="button"
            aria-expanded={expanded === "modes"}
            onClick={() => setExpanded((e) => (e === "modes" ? null : "modes"))}
          >
            <Ico icon={Cpu} size={14} />
            <span>模式</span>
            <span>{activeMode?.name ?? "自定义"}</span>
          </button>
          <button type="button" onClick={() => actions.onOpenMain()}>
            <Ico icon={ExternalLink} size={14} />
            <span>主窗口</span>
            <span>⌘1</span>
          </button>
          <button type="button" onClick={actions.onOpenSettings}>
            <Ico icon={Settings} size={14} />
            <span>设置</span>
            <span>⌘,</span>
          </button>
        </div>
      </div>
      <div className="tray-panel-foot">
        <span className="tray-version">
          <span className="dot ok" aria-hidden="true" />
          {appVersion ?? "…"}
        </span>
        <span className="tray-foot-meta">omp {ompVersion ?? "…"}</span>
        {mode === "panel" ? (
          <button type="button" className="tray-quit" onClick={actions.onQuit}>
            退出
          </button>
        ) : (
          <span className="tray-quit is-static">退出</span>
        )}
      </div>
    </div>
  );
}

function SessionSection({
  title,
  count,
  link,
  children,
}: {
  title: string;
  count?: number;
  link?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="tray-sec">
      <div className="tray-sec-head">
        <span>{title}</span>
        {link ?? (count !== undefined ? <span className="tray-count">{count}</span> : null)}
      </div>
      {children}
    </div>
  );
}

function SessionRow({
  row,
  showProject,
  onFocus,
}: {
  row: TrayPreviewRow;
  showProject: boolean;
  onFocus: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`tray-sess ${row.status}`}
      title={row.enabled ? "聚焦 iTerm2 标签页" : (row.disabledReason ?? "不可聚焦")}
      disabled={!row.enabled}
      onClick={onFocus}
    >
      <span className="tray-glyph" aria-hidden="true">
        {projectGlyph(row.project)}
      </span>
      <span className="tray-sess-main">
        <span className="tray-sess-title">{row.title}</span>
        <span className="tray-sess-meta">
          <span className="tray-sdot" aria-hidden="true" />
          {TRAY_STATUS_NAME[row.status]}
          {showProject && row.project !== null ? ` · ${row.project}` : ""}
        </span>
      </span>
      <span className="tray-sess-side">
        <span className="tray-elapsed">{formatTrayElapsed(row.elapsedSecs)}</span>
        {row.subagents > 0 ? (
          <span className="tray-subagents" title={`${row.subagents} 个子代理`}>
            +{row.subagents}
          </span>
        ) : null}
      </span>
      <span className="tray-sess-go" aria-hidden="true">
        <Ico icon={ExternalLink} size={12} />
      </span>
    </button>
  );
}

/** 标题宽度 → 面板逻辑宽（与 Rust `panel_width` 同值，供预览布局用）。 */
export function panelWidthPx(width: TrayTitleWidth): number {
  return width === "compact" ? 316 : width === "wide" ? 396 : 356;
}
