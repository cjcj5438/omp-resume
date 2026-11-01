import { Info } from "lucide-react";
import { Modal } from "../components/ui";
import { formatUsd, usageNumber } from "../format";
import type { StageActor } from "../types";
import { compactNumber } from "../components/usageFormat";
import { STATE_WORD } from "./stateWords";

/** 查看原始节点对话框（设计稿 stage-detail：5 行 kv 全真实 + 关闭/查看会话）。 */
export function StageDetailDialog({ actor, onClose, onOpenSession }: { actor: StageActor; onClose: () => void; onOpenSession: () => void }) {
  return (
    <Modal
      title={`${actor.name} · 原始节点`}
      sub="角色由 spawn 记录、生命周期事件与消息尾部推导。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="btn btn-primary" onClick={onOpenSession}>
            查看会话
          </button>
        </>
      }
    >
      <div className="dlg-kv">
        <div><span>角色</span><span>{actor.agent ?? actor.kind}</span></div>
        <div><span>状态</span><span>{`${STATE_WORD[actor.state]}${actor.statusText !== null && actor.statusText !== STATE_WORD[actor.state] ? ` · ${actor.statusText}` : ""}`}</span></div>
        <div><span>模型</span><span>{actor.model ?? "—"}</span></div>
        <div><span>Token</span><span>{compactNumber(actor.contextTokens)}</span></div>
        <div><span>成本</span><span>{formatUsd(actor.cost)}</span></div>
      </div>
      {actor.provenance !== null || actor.toolCalls > 0 ? (
        <p className="stage-detail-note">
          <Info size={12} aria-hidden="true" />
          {actor.provenance !== null ? `状态来源 ${actor.provenance}` : ""}
          {actor.provenance !== null && actor.toolCalls > 0 ? " · " : ""}
          {actor.toolCalls > 0 ? `工具调用 ${usageNumber(actor.toolCalls)} 次` : ""}
        </p>
      ) : null}
    </Modal>
  );
}
