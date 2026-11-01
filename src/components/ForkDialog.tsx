/** 分叉确认框（G11 设计稿 forkDialog）：父会话/分叉节点/写入内容/原会话 + note。
 * 确认后复用 runContinueFromNode（append_branch_marker + open_in_iterm）。
 */
import { useState } from "react";
import type { SessionSummary } from "../types";
import { runContinueFromNode, type ContinueOutcome } from "../flows";
import { appendBranchMarker, normalizeError, openInIterm } from "../api";
import { errorText } from "../format";
import { Ico, Modal } from "./ui";
import { GitBranch } from "lucide-react";
import type { ToastFn } from "./useOmpOp";

interface ForkDialogProps {
  session: SessionSummary;
  nodeId: string;
  onClose: () => void;
  onDone: (outcome: ContinueOutcome) => void;
  onToast: ToastFn;
}

export function ForkDialog({ session, nodeId, onClose, onDone, onToast }: ForkDialogProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await runContinueFromNode(
        {
          appendBranchMarker: async (p, n) => (await appendBranchMarker({ path: p, nodeId: n })).markerId,
          openInIterm: (p) => openInIterm({ path: p }),
          refresh: () => Promise.resolve(),
        },
        session.path,
        nodeId,
      );
      if (outcome.notice) {
        // markerId null（leaf 节点）走 notice 文案：留在框内说明，不直接关。
        setNotice(outcome.notice);
        return;
      }
      onToast(`已打开 iTerm2 标签页 · ${session.title}`, "info");
      onDone(outcome);
      onClose();
    } catch (e: unknown) {
      onToast(errorText(normalizeError(e)), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="从节点分叉"
      sub={
        <>
          将追加一个 <code>custom</code> 分支标记，再用 <code>omp --resume</code> 从该节点继续。
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-autofocus
            disabled={busy}
            onClick={() => void confirm()}
          >
            <Ico icon={GitBranch} size={13} />
            {busy ? "创建中…" : "创建分支并打开"}
          </button>
        </>
      }
    >
      <div className="dlg-kv">
        <div>
          <span>父会话</span>
          <span>{session.title}</span>
        </div>
        <div>
          <span>分叉节点</span>
          <span>{nodeId}</span>
        </div>
        <div>
          <span>写入内容</span>
          <span>1 行 custom 记录（omp-resume-branch）</span>
        </div>
        <div>
          <span>原会话</span>
          <span>不会被改写</span>
        </div>
      </div>
      <div className="inline-note">
        <span>omp 的上下文构建器会忽略这条记录，因此它不会进入模型上下文。</span>
      </div>
      {notice ? (
        <div className="inline-note warn" role="note">
          <span>{notice}</span>
        </div>
      ) : null}
    </Modal>
  );
}
