/**
 * 页面级共享原语：页头、分段控件、搜索框、错误横幅、开关。
 * 各页面用 PageHeader 取代手写的 header.detail-head + 返回按钮。
 */
import type { ReactNode } from "react";
import type { AppError } from "../types";
import { errorText } from "../format";
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
}

/** 搜索框：全应用同一形态（input[type=search].filter-input）。 */
export function SearchInput({ label, placeholder, value, onChange, autoFocus = false }: SearchInputProps) {
  return (
    <input
      type="search"
      className="filter-input"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
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
