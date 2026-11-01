/**
 * 页面级共享原语：页头、分段控件、搜索框、错误横幅、开关。
 * 各页面用 PageHeader 取代手写的 header.detail-head + 返回按钮。
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import type { AppError } from "../types";
import { errorText } from "../format";
import { Ico } from "./ui";
import "./Page.css";

interface PageHeaderProps {
  kicker?: string;
  title: string;
  sub?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

/** 页面头部：kicker / 标题 / 说明 / 右侧动作，下方可挂额外内容。 */
export function PageHeader({ kicker, title, sub, actions, children }: PageHeaderProps) {
  return (
    <>
      <header className="page-head">
        <div className="page-head-text">
          {kicker !== undefined ? <div className="page-kicker">{kicker}</div> : null}
          <h1 className="page-title">{title}</h1>
          {sub !== undefined ? <p className="page-sub">{sub}</p> : null}
        </div>
        {actions !== undefined ? <div className="page-actions">{actions}</div> : null}
      </header>
      {children}
    </>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
}

interface SegProps<T extends string> {
  label: string;
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}

/**
 * 分段控件：DOM 与原有手写 seg 一致（容器 + .btn + aria-pressed），
 * 按 role/name 查询的测试不受影响；有 count 时追加计数。
 */
export function Seg<T extends string>({ label, options, value, onChange, disabled = false }: SegProps<T>) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="btn"
          aria-pressed={value === o.value}
          disabled={disabled || o.disabled === true}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? <span className="seg-count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

interface SearchInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  /** 左侧搜索图标版本（设计稿 .search-box）。默认裸 input（命令面板等用）。 */
  icon?: boolean;
}

/** 搜索框：全应用同一形态（input[type=search].filter-input），可选图标版。 */
export function SearchInput({ label, placeholder, value, onChange, autoFocus = false, icon = false }: SearchInputProps) {
  const input = (
    <input
      type="search"
      className={icon ? undefined : "filter-input"}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (!icon) return input;
  return (
    <span className="search-box">
      <Ico icon={Search} size={14} />
      {input}
    </span>
  );
}

interface ErrorBannerProps {
  error: AppError | string;
  onRetry?: () => void;
}

/** 错误横幅：role=alert + 文本 + 可选重试按钮。 */
export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  return (
    <div className="banner banner-error" role="alert">
      <span>{typeof error === "string" ? error : errorText(error)}</span>
      {onRetry !== undefined ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

/** 开关行：标签 + 说明 + role=switch 按钮。 */
export function Switch({ label, description, checked, disabled = false, onChange }: SwitchProps) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {description !== undefined ? <div className="setting-desc">{description}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={checked ? "switch is-on" : "switch"}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

interface PanelProps {
  title: ReactNode;
  icon?: LucideIcon;
  /** 右侧 meta（11px，设计稿 .panel-meta）。 */
  meta?: ReactNode;
  /** 右侧动作组（与 meta 同行，meta 之后）。 */
  actions?: ReactNode;
  foot?: ReactNode;
  /** body 形态：默认 padding 16；flush 无 padding；tight 10px。 */
  body?: "default" | "flush" | "tight";
  className?: string;
  children: ReactNode;
}

/** 卡片面板：head（底边框 + 12.5px 标题 + 右侧 meta）/ body / foot。 */
export function Panel({ title, icon: Icon, meta, actions, foot, body = "default", className, children }: PanelProps) {
  const hasHead = title !== null && title !== undefined && title !== "";
  return (
    <section className={className ? `panel ${className}` : "panel"}>
      {hasHead || meta !== undefined || actions !== undefined ? (
        <div className="panel-head">
          <div className="panel-title">
            {Icon !== undefined ? <Ico icon={Icon} size={14} /> : null}
            {title}
          </div>
          {meta !== undefined || actions !== undefined ? (
            <div className="panel-meta">
              {meta}
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={body === "default" ? "panel-body" : `panel-body ${body}`}>{children}</div>
      {foot !== undefined ? <div className="panel-foot">{foot}</div> : null}
    </section>
  );
}

interface KpiProps {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  className?: string;
}

/** KPI 卡：label 11px / value 26px / foot 11px（设计稿 .kpi，用 .grid-4/.kpi-grid 排）。 */
export function Kpi({ label, value, foot, className }: KpiProps) {
  return (
    <div className={className ? `kpi ${className}` : "kpi"}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {foot !== undefined ? <div className="kpi-foot">{foot}</div> : null}
    </div>
  );
}

type StatePillState = "running" | "idle" | "queued" | "done" | "failed" | "lost";

/** 状态 pill：stage 状态词专用（running/idle/queued/done/failed/lost）。 */
export function StatePill({ state, children }: { state: StatePillState; children: ReactNode }) {
  return (
    <span className={`state-pill ${state}`}>
      <span className="dot" style={{ background: "currentColor" }} aria-hidden="true" />
      {children}
    </span>
  );
}
