/**
 * Agent 库对话框（设计稿 agent-library）：只读 dlg-kv（name · desc → 首角色模型）。
 * foot「关闭」+ primary「管理 Agent」→ agents 页（设计稿 app.js:837-844；已在 agents 页内打开时禁用）。
 */
import type { ReactNode } from "react";
import type { AgentDefinition } from "../types";
import { Modal } from "./ui";

interface AgentLibraryDialogProps {
  agents: AgentDefinition[];
  onClose: () => void;
  /** 已在 agents 页内打开时为 true：此时「管理 Agent」禁用（无处可跳）。 */
  embedded?: boolean;
  onManageAgents?: () => void;
}

export function AgentLibraryDialog(props: AgentLibraryDialogProps): ReactNode {
  const { agents, onClose, embedded = false, onManageAgents } = props;
  return (
    <Modal
      title="Agent 库"
      sub="这里只读取 Agent 定义；运行动态仍以当前会话的 JSONL 为准。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
          <button type="button" className="btn btn-primary" disabled={embedded || onManageAgents === undefined} onClick={() => onManageAgents?.()}>管理 Agent</button>
        </>
      }
    >
      <div className="dlg-kv">
        {agents.map((a) => (
          <div key={a.name}><span>{a.name} · {a.description}</span><span>{a.defaultModel[0] ?? "—"}</span></div>
        ))}
      </div>
    </Modal>
  );
}
