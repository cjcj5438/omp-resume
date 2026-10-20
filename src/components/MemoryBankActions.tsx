/**
 * 项目库行操作（renderBankActions 默认实现）：「备份与恢复」入口、
 * 「移除此库…」确认框、选中时懒查的「使用中」徽标、空库/目录缺失的清理建议。
 * 不可读的库不提供维护入口。
 */
import { useRef, useState, type ReactNode } from "react";
import { memoryDeleteBank, normalizeError } from "../api";
import type { MemoryBankSummary } from "../types";
import { formatSize } from "../format";
import { Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";
import { formatHolders, memoryWriteErrorText, useBankStatus } from "./useMemoryMaintenance";
import "./MemoryPanel.css";

export function MemoryBankActions(props: {
  bank: MemoryBankSummary;
  /** 行被选中时才查一次占用状态；平时与弹窗打开时不轮询。 */
  active: boolean;
  onToast: ToastFn;
  refresh: () => void;
  onOpenBackups: (bank: string) => void;
}): ReactNode {
  const { bank, active, onToast, refresh, onOpenBackups } = props;
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [gateToken, setGateToken] = useState(0);
  const gate = useBankStatus(bank.bank, bank.readable && (active || removing), gateToken);
  const busyRef = useRef(false);

  if (!bank.readable) return null;
  const total = bank.working + bank.episodic;
  const suggestCleanup = total === 0 || bank.cwdExists === false;
  const cleanupReason = total === 0 ? "该库是空库，可以移除以保持列表整洁" : "该库的项目目录已不存在，可以移除以保持列表整洁";
  // 只有“本库”的状态结果才算数：首帧（status null + loading false）与之前库的残留都不能放行。
  const statusForBank = gate.status !== null && gate.status.bank === bank.bank ? gate.status : null;
  const blocked = statusForBank !== null && (statusForBank.inUse || statusForBank.probeFailed);
  const ready = removing && !busy && !gate.loading && gate.error === null && statusForBank !== null && !blocked;

  async function confirm(): Promise<void> {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      await memoryDeleteBank({ bank: bank.bank });
      onToast(`已移除 ${bank.displayName}，可在「备份与恢复」中还原`, "info");
      setRemoving(false);
      refresh();
    } catch (e: unknown) {
      setSubmitError(memoryWriteErrorText(normalizeError(e), "remove"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="mem-bank-actions">
      {gate.status?.inUse === true ? (
        <span className="badge badge-accent" title={`正被使用：${formatHolders(gate.status.holders)}`}>
          使用中
        </span>
      ) : null}
      {suggestCleanup ? (
        <span className="badge badge-label" title={cleanupReason}>
          建议清理
        </span>
      ) : null}
      <button
        type="button"
        className="btn btn-small"
        onClick={(e) => {
          e.stopPropagation();
          onOpenBackups(bank.bank);
        }}
      >
        备份与恢复
      </button>
      <button
        type="button"
        className="btn btn-small"
        onClick={(e) => {
          e.stopPropagation();
          setSubmitError(null);
          setRemoving(true);
        }}
      >
        移除此库…
      </button>
      {removing ? (
        <Modal
          title={`移除项目库（${bank.displayName}）`}
          onClose={() => {
            if (!busy) setRemoving(false);
          }}
          footer={
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setRemoving(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!ready}
                title={
                  ready
                    ? undefined
                    : gate.status?.inUse === true
                      ? "该库正被 omp 会话使用，先退出后再试"
                      : gate.status?.probeFailed === true
                        ? "无法确认占用状态，请稍后重试"
                        : undefined
                }
                onClick={() => void confirm()}
              >
                {busy ? "移除中…" : "移除此库"}
              </button>
            </>
          }
        >
          <p>
            将移除「{bank.displayName}」的全部记忆（工作 {bank.working} · 情节 {bank.episodic}，共{" "}
            {formatSize(bank.bytes)}）；omp 将不再看到这个库。
          </p>
          <p className="muted">移除前会保留一份可恢复的副本（“移除的库”），可在「备份与恢复」中还原。</p>
          {gate.loading ? <p className="muted">正在确认占用状态…</p> : null}
          {gate.error !== null ? (
            <p>
              占用状态加载失败：{gate.error}{" "}
              <button type="button" className="btn btn-small" onClick={() => setGateToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {gate.status?.inUse === true ? (
            <p className="mem-note-danger">
              该库正被使用：{formatHolders(gate.status.holders)}。先退出占用该库的 omp 会话后再试。
              <button type="button" className="btn btn-small" onClick={() => setGateToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {gate.status?.probeFailed === true ? (
            <p className="mem-note-danger">
              无法确认是否有 omp 会话在使用该库（占用探测失败），请稍后重试。
              <button type="button" className="btn btn-small" onClick={() => setGateToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {submitError !== null ? <p className="mem-note-danger">{submitError}</p> : null}
        </Modal>
      ) : null}
    </span>
  );
}
