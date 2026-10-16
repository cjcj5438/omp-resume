/**
 * 模型选择器：按 provider 分组、可搜索的下拉选择。
 * 当前值不在模型列表（别名 / 已下线模型）时原样显示并保留为可选项；
 * `allowUnset` 提供「未设置 / 不覆盖」（保存时删除该条目）。
 */
import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "../types";

interface ModelPickerProps {
  models: ModelInfo[];
  /** 当前 selector；null 表示未设置（不覆盖）。 */
  value: string | null;
  onChange: (selector: string | null) => void;
  unsetLabel: string;
  allowUnset: boolean;
  disabled: boolean;
  label: string;
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

export function ModelPicker(props: ModelPickerProps) {
  const { models, value, onChange, unsetLabel, allowUnset, disabled, label } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? models.filter(
        (m) =>
          m.name.toLowerCase().includes(needle) ||
          m.selector.toLowerCase().includes(needle),
      )
    : models;
  const groups = groupByProvider(visible);
  const known = value !== null && models.some((m) => m.selector === value);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-btn"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
      >
        {value === null ? (
          <span className="muted">{unsetLabel}</span>
        ) : (
          <>
            <span className="mono">{value}</span>
            {known ? null : <span className="badge badge-grey">未知值 · 保留</span>}
          </>
        )}
      </button>
      {open ? (
        <div className="model-picker-pop">
          <input
            className="filter-input"
            placeholder="搜索模型名称或 selector…"
            value={query}
            aria-label="搜索模型"
            autoFocus
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
                    setOpen(false);
                  }}
                >
                  <span className="muted">{unsetLabel}</span>
                </button>
              </li>
            ) : null}
            {value !== null && !known ? (
              <li>
                <button
                  type="button"
                  className="model-picker-item"
                  onClick={() => {
                    setOpen(false);
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
                          setOpen(false);
                        }}
                      >
                        <span>{m.name}</span>
                        <span className="mono muted">{m.selector}</span>
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
