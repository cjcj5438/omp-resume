/**
 * 模型/Agent 草稿共用的小组件：思考强度分段控件 + 兜底条目 chip。
 * 从 ModelsSection.tsx 原样移出，消除兄弟组件间的交叉 import。
 */
import "./ModelsAgentsPanel.css";
import type { ModelInfo } from "../types";
import { orderNumeral, selectorBase, selectorThinking } from "../roleCards";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Ico } from "./ui";

/** 思考强度分段控件：默认 + 所选模型的档位；当前值不在档位表时原样保留。 */
export function ThinkingSegment(props: {
  levels: string[];
  value: string;
  disabled: boolean;
  label: string;
  /** 默认选项的文案；添加兜底时用「继承」。 */
  defaultLabel?: string;
  onChange: (value: string) => void;
}) {
  const { levels, value, disabled, label, defaultLabel, onChange } = props;
  const extra = value !== "" && !levels.includes(value) ? value : null;
  const options = extra !== null ? [...levels, extra] : levels;
  return (
    <div className="field">
      <span className="field-label">思考强度</span>
      <div className="segment" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          aria-checked={value === ""}
          className={value === "" ? "segment-item segment-item-active" : "segment-item"}
          disabled={disabled}
          onClick={() => onChange("")}
        >
          {defaultLabel ?? "默认"}
        </button>
        {options.map((level) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={value === level}
            className={value === level ? "segment-item segment-item-active" : "segment-item"}
            disabled={disabled}
            title={level === extra ? "当前值（不在该模型的档位表里，原样保留）" : undefined}
            onClick={() => onChange(level)}
          >
            {level === extra ? `${level} · 保留` : level}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 兜底条目 chip：顺序号 + 模型名 + 操作。 */
export function ChainChip(props: {
  entry: unknown;
  index: number;
  last: boolean;
  models: ModelInfo[];
  disabled: boolean;
  /** 只读展示时隐藏排序/删除按钮（Vibe 行的兜底用）。 */
  readOnly?: boolean;
  onMove: (index: number, delta: number) => void;
  onDelete: () => void;
}) {
  const { entry, index, last, models, disabled, readOnly, onMove, onDelete } = props;
  const text = typeof entry === "string" ? entry : null;
  const parsed = text !== null ? { base: selectorBase(text), thinking: selectorThinking(text) } : null;
  // omp 的 name 只在部分 provider 上带「(账号)」后缀，单看名字判断不了供应商，
  // 因此这里补 provider 徽章；档位统一显示，裸条目按 §16.8 显示「继承」。
  const matched = parsed !== null ? models.find((m) => m.selector === parsed.base) ?? null : null;
  const name = matched?.name ?? null;
  const label = text ?? (typeof entry === "number" ? String(entry) : JSON.stringify(entry) ?? "?");
  return (
    <li className="chain-chip">
      <span className="chain-order" aria-hidden="true">
        {orderNumeral(index)}
      </span>
      <span className={name !== null ? undefined : "mono"}>
        {name ?? (parsed !== null ? parsed.base : label)}
      </span>
      {matched !== null && matched.provider !== "" ? (
        <span className="badge badge-grey" title="供应商">
          {matched.provider}
        </span>
      ) : null}
      {parsed !== null ? (
        parsed.thinking !== "" ? (
          <span className="badge badge-grey" title="思考强度">
            {parsed.thinking}
          </span>
        ) : (
          <span className="badge badge-grey" title="未指定档位：继承出错回合的思考强度">
            继承
          </span>
        )
      ) : null}
      {text !== null && name === null ? (
        <span className="badge badge-grey">未知值 · 保留</span>
      ) : null}
      {text === null ? <span className="badge badge-grey">原样保留</span> : null}
      {readOnly ? null : (
      <span className="chain-chip-actions">
        <button
          type="button"
          className="icon-btn"
          disabled={disabled || index === 0}
          aria-label={`上移 ${label}`}
          title="上移"
          onClick={() => onMove(index, -1)}
        >
          <Ico icon={ArrowUp} size={12} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={disabled || last}
          aria-label={`下移 ${label}`}
          title="下移"
          onClick={() => onMove(index, 1)}
        >
          <Ico icon={ArrowDown} size={12} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-danger"
          disabled={disabled}
          aria-label={`删除 ${label}`}
          title="删除"
          onClick={onDelete}
        >
          <Ico icon={X} size={12} />
        </button>
      </span>
      )}
    </li>
  );
}
