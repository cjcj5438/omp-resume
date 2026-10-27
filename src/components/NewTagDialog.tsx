/**
 * 新标签对话框：输入一个标签并应用到目标会话（右键菜单「新标签…」）。
 * 校验与后端一致：trim 后非空、≤ 24 字符；全部目标都已有时提示并禁用。
 */
import { useState } from "react";
import { Modal } from "./ui";

export const TAG_MAX_CHARS = 24;

interface NewTagDialogProps {
  /** 目标会话数（正文里展示）。 */
  count: number;
  /** 目标会话已有的全部标签（大小写不敏感比较）。 */
  existing: string[];
  /** 已存在的全部标签（提示重名时用）。 */
  known: string[];
  onCancel: () => void;
  onSubmit: (tag: string) => void;
}

export function NewTagDialog({ count, existing, known, onCancel, onSubmit }: NewTagDialogProps) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const error =
    trimmed.length === 0
      ? null
      : trimmed.length > TAG_MAX_CHARS
        ? `标签最多 ${TAG_MAX_CHARS} 个字符`
        : existing.some((t) => t.toLowerCase() === lower)
          ? "这些会话都已有该标签"
          : null;
  const duplicateCase = known.some((t) => t.toLowerCase() === lower) && trimmed.length > 0;
  const canSubmit = trimmed.length > 0 && error === null;

  return (
    <Modal
      title={`给 ${count} 个会话加标签`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={!canSubmit}
            onClick={() => onSubmit(trimmed)}
          >
            添加
          </button>
        </>
      }
    >
      <label className="dialog-field">
        <span className="dialog-field-label">标签名</span>
        <input
          type="text"
          className="filter-input"
          data-autofocus
          maxLength={TAG_MAX_CHARS}
          value={value}
          aria-invalid={error !== null}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              onSubmit(trimmed);
            }
          }}
        />
      </label>
      {error !== null ? <div className="dialog-field-error">{error}</div> : null}
      {error === null && duplicateCase ? (
        <div className="dialog-field-note">已有同名标签，将复用它的写法</div>
      ) : null}
    </Modal>
  );
}
