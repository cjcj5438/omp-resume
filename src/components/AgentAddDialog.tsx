/**
 * 新建 Agent 对话框（设计稿 agent-add）：名称 + 用途 → create_agent_definition
 * 写用户 agent 定义；成功后刷新配置。
 */
import { useState, type ReactNode } from "react";
import { createAgentDefinition, normalizeError } from "../api";
import { errorText } from "../format";
import { Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";

interface AgentAddDialogProps {
  onClose: () => void;
  onCreated: () => void;
  onToast: ToastFn;
}

export function AgentAddDialog(props: AgentAddDialogProps): ReactNode {
  const { onClose, onCreated, onToast } = props;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleCreate(): Promise<void> {
    if (name.trim() === "") {
      onToast("请填写 Agent 名称", "error");
      return;
    }
    if (description.trim() === "") {
      setFormError("请用一句话说明它负责什么");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await createAgentDefinition({ name: name.trim(), description: description.trim() });
      onToast(`已创建 Agent · ${name.trim()}`, "info");
      onCreated();
      onClose();
    } catch (e: unknown) {
      const text = errorText(normalizeError(e));
      setFormError(text);
      onToast(`新建 Agent 失败：${text}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新建 Agent"
      sub="Agent 只描述角色与模型，不会创建新的运行时。"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleCreate()}>
            {busy ? "创建中…" : "创建"}
          </button>
        </>
      }
    >
      <div className="fld">
        <label htmlFor="agent-add-name">名称</label>
        <input id="agent-add-name" value={name} disabled={busy} placeholder="e.g. reviewer" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="fld">
        <label htmlFor="agent-add-desc">用途</label>
        <textarea id="agent-add-desc" value={description} disabled={busy} placeholder="一句话说明它负责什么" onChange={(e) => setDescription(e.target.value)} />
      </div>
      {formError !== null ? <div className="spec-error" role="alert">{formError}</div> : null}
    </Modal>
  );
}
