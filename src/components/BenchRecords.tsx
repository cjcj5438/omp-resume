/**
 * 抽屉里的 bench 记录列表：每轮一行（时间 / 成功率 / TTFT / tok/s / 花费 / 删除），
 * 以及「清空记录…」（二次确认）。删除走 §20.4 `model_bench_delete`，
 * 与抽屉自带「删除」（移除测试条目）不是一回事。
 */
import { useState, type ReactNode } from "react";
import { normalizeError, modelBenchDelete } from "../api";
import { errorText } from "../format";
import { formatMs, formatRate, formatTps, formatUsd } from "../modelBench";
import type { BenchRound } from "../types";
import { formatClock } from "./usageFormat";
import { Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";

export interface BenchRecordsProps {
  selector: string;
  rounds: BenchRound[];
  onToast: ToastFn;
  /** 删除成功后由父级重载历史。 */
  onChanged: () => void;
}

export function BenchRecords({ selector, rounds, onToast, onChanged }: BenchRecordsProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  async function remove(at: string | null): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const deleted = await modelBenchDelete({ selector, at });
      onToast(deleted === 0 ? "没有可删除的记录" : `已删除 ${deleted} 轮记录`, "info");
      setConfirmClear(false);
      onChanged();
    } catch (e: unknown) {
      onToast(`删除失败：${errorText(normalizeError(e))}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const ordered = [...rounds].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return (
    <>
      <div className="bench-records-head">
        <div className="bench-drawer-title">测试记录（{ordered.length} 轮）</div>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy || ordered.length === 0}
          onClick={() => setConfirmClear(true)}
        >
          清空记录…
        </button>
      </div>
      {ordered.length === 0 ? (
        <span className="muted">还没有记录。</span>
      ) : (
        <ul className="bench-records">
          {ordered.map((r) => (
            <li key={r.at} className="bench-record">
              <span className="bench-record-at">{formatClock(Date.parse(r.at))}</span>
              <span className="bench-record-num">{formatRate(r.total === 0 ? null : r.ok / r.total)}</span>
              <span className="bench-record-num">{formatMs(r.ttftP50Ms)}</span>
              <span className="bench-record-num">{formatTps(r.tpsP50)}</span>
              <span className="bench-record-num">{formatUsd(r.cost)}</span>
              <button
                type="button"
                className="btn btn-small"
                aria-label={`删除 ${r.at} 这一轮记录`}
                disabled={busy}
                onClick={() => void remove(r.at)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirmClear ? (
        <Modal
          title="清空测试记录"
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(null)}>
                清空
              </button>
            </>
          }
        >
          <p>将删除该模型的 {ordered.length} 轮记录，不可撤销。</p>
        </Modal>
      ) : null}
    </>
  );
}
