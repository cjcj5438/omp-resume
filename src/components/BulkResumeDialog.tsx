/** 批量恢复确认：逐会话明细 + 安心说明 + 跳过/超限三分（扩展保留）。 */
import { MAX_BULK_RESUME, type BulkResumePlan } from "../bulkResume";
import { displayCwd } from "../format";
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
      sub={
        <>
          每个会话都会在新的 iTerm2 标签页中执行 <code>omp --resume</code>，互不影响。
        </>
      }
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={plan.open.length === 0}
            onClick={onConfirm}
          >
            {`打开 ${plan.open.length} 个标签页`}
          </button>
        </>
      }
    >
      {plan.open.length > 0 ? (
        <div className="dlg-kv">
          {plan.open.map((s) => (
            <div key={s.path}>
              <span>{s.title}</span>
              <span>{displayCwd(s.cwd)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="inline-note">
        <span>恢复后不会向任何标签页输入按键。</span>
      </div>
      {plan.skipped.length > 0 ? <p>{`已跳过 ${plan.skipped.length} 个（${skippedText}）。`}</p> : null}
      {plan.overLimit.length > 0 ? (
        <p>{`超出单次上限 ${MAX_BULK_RESUME} 个、未打开 ${plan.overLimit.length} 个。`}</p>
      ) : null}
    </Modal>
  );
}
