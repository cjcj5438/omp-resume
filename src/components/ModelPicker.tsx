/**
 * 模型选择器：按 provider 分组、可搜索的下拉选择。
 * 显示友好名 + provider 徽章 + 上下文/价格提示；当前值不在模型列表
 * （别名 / 已下线模型）时原样显示「未知值 · 保留」；
 * `allowUnset` 提供「未设置 / 不覆盖」（保存时删除该条目）。
 */
import { useEffect, useRef, useState } from "react";
import "./ModelPicker.css";
import type { ModelInfo } from "../types";
import { formatContextWindow, formatCost } from "../roleCards";
interface ModelPickerProps {
  models: ModelInfo[];
  /** 当前 selector；null 表示未设置（不覆盖）。 */
  value: string | null;
  onChange: (selector: string | null) => void;
  unsetLabel: string;
  allowUnset: boolean;
  disabled: boolean;
  label: string;
  /** 可选的行徽章（如「已加入」/「已有变体」）；返回 null 不显示。 */
  badgeFor?: (model: ModelInfo) => string | null;
  /** 内联形态：列表常显（添加模型对话框用），按钮点击聚焦搜索框而非折叠。 */
  inline?: boolean;
}

interface ProviderGroup {
  provider: string;
  models: ModelInfo[];
}

function groupByProvider(models: ModelInfo[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const model of models) {
    const group = groups.find((g) => g.provider === model.provider);
    if (group) group.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }
  return groups;
}

/** 下拉项第二行：上下文窗口与目录价（缺失不显示）。 */
function ModelMeta(props: { model: ModelInfo }) {
  const { model } = props;
  const context = formatContextWindow(model.contextWindow);
  const cost = formatCost(model.costInput, model.costOutput);
  if (context === null && cost === null) return null;
  return (
    <span className="muted model-picker-meta">
      {[context, cost].filter((part) => part !== null).join(" · ")}
    </span>
  );
}

export function ModelPicker(props: ModelPickerProps) {
  const { models, value, onChange, unsetLabel, allowUnset, disabled, label, badgeFor, inline = false } = props;
  const [open, setOpen] = useState(inline);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || inline) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, inline]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? models.filter(
        (m) =>
          m.name.toLowerCase().includes(needle) ||
          m.selector.toLowerCase().includes(needle) ||
          m.provider.toLowerCase().includes(needle),
      )
    : models;
  const groups = groupByProvider(visible);
  const current = value !== null ? models.find((m) => m.selector === value) ?? null : null;

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-btn"
        aria-label={label}
        aria-expanded={inline ? true : open}
        disabled={disabled}
        onClick={() => {
          if (inline) {
            searchRef.current?.focus();
            return;
          }
          setQuery("");
          setOpen(!open);
        }}
      >
        {value === null ? (
          <span className="muted">{unsetLabel}</span>
        ) : current !== null ? (
          <>
            <span>{current.name}</span>
            <span className="badge badge-grey">{current.provider}</span>
          </>
        ) : (
          <>
            <span className="mono">{value}</span>
            <span className="badge badge-grey">未知值 · 保留</span>
          </>
        )}
      </button>
      {inline || open ? (
        <div className="model-picker-pop">
          <input
            className="filter-input"
            placeholder="搜索模型名称或 selector…"
            value={query}
            aria-label="搜索模型"
            autoFocus
            ref={searchRef}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="model-picker-list" role="listbox" aria-label={label}>
            {allowUnset ? (
              <li>
                <button
                  type="button"
                  className="model-picker-item"
                  onClick={() => {
                    onChange(null);
                    if (!inline) setOpen(false);
                  }}
                >
                  <span className="muted">{unsetLabel}</span>
                </button>
              </li>
            ) : null}
            {value !== null && current === null ? (
              <li>
                <button
                  type="button"
                  className="model-picker-item"
                  onClick={() => {
                    if (!inline) setOpen(false);
                  }}
                >
                  <span className="mono">{value}</span>
                  <span className="badge badge-grey">当前值（不在模型列表）</span>
                </button>
              </li>
            ) : null}
            {groups.map((group) => (
              <li key={group.provider}>
                <div className="model-picker-group">{group.provider}</div>
                <ul>
                  {group.models.map((m) => (
                    <li key={m.selector}>
                      <button
                        type="button"
                        className={
                          m.selector === value
                            ? "model-picker-item model-picker-item-active"
                            : "model-picker-item"
                        }
                        onClick={() => {
                          onChange(m.selector);
                          if (!inline) setOpen(false);
                        }}
                      >
                        <span className="model-picker-name">{m.name}</span>
                        <span className="badge badge-grey">{m.provider}</span>
                        {badgeFor?.(m) ? <span className="badge badge-grey">{badgeFor(m)}</span> : null}
                        <span className="mono muted model-picker-selector">{m.selector}</span>
                        <ModelMeta model={m} />
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {groups.length === 0 && value === null ? (
              <li className="pane-note">无匹配模型</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
