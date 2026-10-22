/**
 * bench 添加/编辑模型对话框 + 添加自定义标签对话框。
 * 从 ModelTesterPanel.tsx 逐字拆出，无行为变化。
 */
import { useState, type ReactNode } from "react";
import type { ModelInfo } from "../types";
import { CUSTOM_TAG_PATTERN } from "../modelBench";
import { composeSelectorValue, parseSelectorValue } from "../modelConfig";
import { formatContextWindow, formatCost } from "../roleCards";
import { tagLabel } from "./BenchSparkline";
import { ModelPicker } from "./ModelPicker";
import { Modal } from "./ui";

export interface ModelEntryModalProps {
  mode: "add" | "edit";
  models: ModelInfo[];
  existing: Set<string>;
  /** 现有标签（编辑时沿用条目已有标签，不在此改）。 */
  customTags: string[];
  initial?: { selector: string; tags: string[] };
  onClose: () => void;
  onSave: (selector: string, tags: string[]) => void;
  /** 有 yml 规格时「编辑规格…」的跳转；不传则不显示链接。 */
  onEditSpec?: (selector: string) => void;
  hasSpec?: (selector: string) => boolean;
}

export function ModelEntryModal(props: ModelEntryModalProps): ReactNode {
  const { mode, models, existing, customTags, initial, onClose, onSave, onEditSpec, hasSpec } = props;
  const parsed = initial === undefined ? null : parseSelectorValue(initial.selector);
  const [base, setBase] = useState<string | null>(parsed?.selector ?? null);
  const [thinking, setThinking] = useState(parsed?.thinking ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const info = base === null ? null : (models.find((m) => m.selector === base) ?? null);
  const composed = base === null ? null : composeSelectorValue({ selector: base, thinking });
  const dup = composed !== null && existing.has(composed);
  const editableSpec = base !== null && hasSpec !== undefined && onEditSpec !== undefined && hasSpec(base);
  // 徽章与 dup 同口径：精确变体=已加入，同 base 其他变体=已有变体（编辑态已排除自身）。
  const existingBases = new Set([...existing].map((s) => parseSelectorValue(s).selector));
  const badgeFor = (m: ModelInfo): string | null => {
    const exact = composeSelectorValue({ selector: m.selector, thinking });
    if (existing.has(exact)) return "已加入";
    return existingBases.has(m.selector) ? "已有变体" : null;
  };
  const toggleTag = (tag: string): void => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  return (
    <Modal title={mode === "add" ? "添加模型" : "编辑模型"} wide onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button
        type="button"
        className="btn btn-accent"
        disabled={composed === null || dup}
        title={dup ? "这个模型（含思考强度）已经在列表里" : undefined}
        onClick={() => {
          if (composed !== null) onSave(composed, tags);
        }}
      >
        {mode === "add" ? "添加" : "保存"}
      </button>
    </>}>
      <div className="bench-entry-grid">
        <div className="bench-add-form bench-entry-form">
          <ModelPicker
            models={models}
            value={base}
            onChange={(v) => {
              setBase(v);
              setThinking("");
            }}
            unsetLabel="选择模型…"
            allowUnset={false}
            disabled={false}
            label="选择模型"
            badgeFor={badgeFor}
            inline
          />
          <div className="field">
            <span className="field-label">思考强度</span>
            <div className="segment bench-segment" role="radiogroup" aria-label="思考强度">
              <button
                type="button"
                role="radio"
                aria-checked={thinking === ""}
                disabled={info === null}
                className={thinking === "" ? "segment-item segment-item-active" : "segment-item"}
                onClick={() => setThinking("")}
              >
                默认
              </button>
              {(info?.thinkingLevels ?? []).map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={thinking === level}
                  disabled={info === null}
                  className={thinking === level ? "segment-item segment-item-active" : "segment-item"}
                  onClick={() => setThinking(level)}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
          {info === null ? <span className="muted">先选一个模型，再选思考强度。</span> : null}
          {dup ? <span className="muted">这个模型（含思考强度）已经在列表里。</span> : null}
          {customTags.length > 0 ? (
            <div className="field">
              <span className="field-label">标签（可选）</span>
              <div className="bench-chips">
                {customTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={tags.includes(tag) ? "tag-chip tag-chip-on" : "tag-chip"}
                    aria-pressed={tags.includes(tag)}
                    onClick={() => toggleTag(tag)}
                  >
                    {tagLabel(tag)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="bench-entry-preview" aria-label="规格预览">
          {info === null ? (
            <span className="muted">选择模型后这里显示规格预览。</span>
          ) : (
            <>
              <div className="bench-preview-name">{info.name}</div>
              <div className="muted mono bench-preview-selector">{info.selector}</div>
              <dl className="bench-preview-list">
                <div><dt>供应商</dt><dd>{info.provider}</dd></div>
                <div><dt>上下文</dt><dd>{formatContextWindow(info.contextWindow) ?? "—"}</dd></div>
                <div><dt>最大输出</dt><dd>{info.maxTokens === null ? "—" : info.maxTokens.toLocaleString()}</dd></div>
                <div><dt>目录价</dt><dd>{formatCost(info.costInput, info.costOutput) ?? "—"}</dd></div>
                <div><dt>推理</dt><dd>{info.reasoning ? "是" : "否"}</dd></div>
                <div><dt>输入模态</dt><dd>{info.input.length === 0 ? "—" : info.input.join(" / ")}</dd></div>
                <div><dt>思考档位</dt><dd>{info.thinkingLevels.length === 0 ? "无" : info.thinkingLevels.join(" / ")}</dd></div>
              </dl>
              {editableSpec ? (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    if (base !== null) {
                      onClose();
                      onEditSpec(base);
                    }
                  }}
                >
                  编辑规格…
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function AddTagModal(props: {
  existing: Set<string>;
  onClose: () => void;
  onAdd: (tag: string) => void;
}): ReactNode {
  const { existing, onClose, onAdd } = props;
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const valid = CUSTOM_TAG_PATTERN.test(trimmed) && !existing.has(trimmed);
  return (
    <Modal title="添加自定义标签" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button
        type="button"
        className="btn btn-accent"
        disabled={!valid}
        onClick={() => onAdd(trimmed)}
      >
        添加
      </button>
    </>}>
      <div className="bench-add-form">
        <input
          className="filter-input"
          placeholder="小写字母开头，如 test"
          value={name}
          aria-label="标签名"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) onAdd(trimmed);
          }}
        />
        <span className="muted">小写字母开头，字母/数字/_/-，最多 24 个字符。</span>
      </div>
    </Modal>
  );
}
