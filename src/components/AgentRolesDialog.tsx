/**
 * Agent 角色对话框（设计稿 agent-roles）：主 Agent 每角色一 select 改 draft.roles；
 * 子 Agent 单个「改用模型」select 改 draft.overrides。全走草稿，保存条统一保存。
 */
import { useState, type ReactNode } from "react";
import type { ModelInfo } from "../types";
import { friendlyModelName } from "../roleCards";
import { Modal } from "./ui";

interface AgentRolesDialogProps {
  agent: string;
  /** 主 Agent：每角色当前 selector；子 Agent：单键 { override: selector|null }。 */
  rows: { role: string; label: string; selector: string | null }[];
  models: ModelInfo[];
  onClose: () => void;
  onSave: (changes: Map<string, string | null>) => void;
}

export function AgentRolesDialog(props: AgentRolesDialogProps): ReactNode {
  const { agent, rows, models, onClose, onSave } = props;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.role, r.selector ?? ""])),
  );
  const dirty = rows.some((r) => (values[r.role] ?? "") !== (r.selector ?? ""));

  return (
    <Modal
      title={`编辑 ${agent} 的角色`}
      sub="每个角色指向模型库里的一个模型。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty}
            onClick={() => {
              const changes = new Map<string, string | null>();
              for (const r of rows) {
                const next = values[r.role] ?? "";
                if (next !== (r.selector ?? "")) changes.set(r.role, next === "" ? null : next);
              }
              onSave(changes);
              onClose();
            }}
          >
            保存角色
          </button>
        </>
      }
    >
      {rows.map((r) => (
        <div className="fld" key={r.role}>
          <label htmlFor={`agent-role-${r.role}`}>{r.label}</label>
          <select
            id={`agent-role-${r.role}`}
            value={values[r.role] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [r.role]: e.target.value }))}
          >
            {models.map((m) => (
              <option key={m.selector} value={m.selector}>{friendlyModelName(m.selector, models) ?? m.selector}</option>
            ))}
          </select>
        </div>
      ))}
    </Modal>
  );
}
