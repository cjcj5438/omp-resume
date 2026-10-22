/**
 * bench 待保存栏：角色改动逐条撤销 / 全部放弃 / 保存到 omp。
 * 从 ModelTesterPanel.tsx 逐字拆出，无行为变化。
 */
import type { ReactNode } from "react";
import { tagLabel } from "./BenchSparkline";

export interface BenchSavebarProps {
  pending: Map<string, string>;
  roles: Record<string, unknown>;
  saving: boolean;
  onRevert: (role: string) => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function BenchSavebar(props: BenchSavebarProps): ReactNode {
  const { pending, roles, saving, onRevert, onDiscard, onSave } = props;
  return (
    <div className="bench-savebar" role="status">
      <span>待保存 {pending.size} 项</span>
      {[...pending].map(([role, selector]) => (
        <span key={role} className="bench-pending-item">
          {tagLabel(role)}：<span className="mono">{typeof roles[role] === "string" ? (roles[role] as string) : "未设置"}</span>
          {" → "}
          <span className="mono">{selector}</span>
          <button
            type="button"
            className="btn btn-small"
            aria-label={`撤销 ${tagLabel(role)} 的修改`}
            disabled={saving}
            onClick={() => onRevert(role)}
          >
            ✕撤销
          </button>
        </span>
      ))}
      <button type="button" className="btn btn-small" disabled={saving} onClick={onDiscard}>
        放弃
      </button>
      <button type="button" className="btn btn-small btn-accent" disabled={saving} onClick={onSave}>
        {saving ? <span className="spinner" aria-hidden="true" /> : null}
        保存到 omp
      </button>
      <span className="muted">已开的 omp 窗口不受影响，新会话生效</span>
    </div>
  );
}
