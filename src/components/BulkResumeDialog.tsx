/** 批量恢复确认：列出将打开 / 跳过 / 超限三份，确认后由 App 顺序打开 iTerm。 */
import { MAX_BULK_RESUME, type BulkResumePlan } from "../bulkResume";
import { Modal } from "./ui";

interface BulkResumeDialogProps {
  /** 勾选总数（标题用）。 */
  total: number;
  plan: BulkResumePlan;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BulkResumeDialog({ total, plan, onCancel, onConfirm }: BulkResumeDialogProps) {
  const skippedByReason = new Map<string, number>();
  for (const { reason } of plan.skipped) {
    skippedByReason.set(reason, (skippedByReason.get(reason) ?? 0) + 1);
  }
  const skippedText = [...skippedByReason].map(([reason, n]) => `${reason} ${n} 个`).join("、");
  return (
    <Modal
      title={`恢复 ${total} 个会话`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={plan.open.length === 0}
            onClick={onConfirm}
          >
            {`打开 ${plan.open.length} 个标签页`}
          </button>
        </>
      }
    >
      <p>{`将打开 ${plan.open.length} 个 iTerm 标签页。`}</p>
      {plan.skipped.length > 0 ? <p>{`已跳过 ${plan.skipped.length} 个（${skippedText}）。`}</p> : null}
      {plan.overLimit.length > 0 ? (
        <p>{`超出单次上限 ${MAX_BULK_RESUME} 个、未打开 ${plan.overLimit.length} 个。`}</p>
      ) : null}
    </Modal>
  );
}
