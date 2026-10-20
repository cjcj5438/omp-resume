/** 记忆库维护共用：删除上限、备份中文名、写错误文案、库状态 hook 与门禁提示。 */
import { useEffect, useState, type ReactNode } from "react";
import { memoryBankStatus, normalizeError } from "../api";
import type { AppError, MemoryBackupKind, MemoryBankStatus, MemoryBankSummary } from "../types";
import { errorText } from "../format";

/** 单次删除上限（CONTRACT §18.8.2，与后端 MEMORY_DELETE_IDS_MAX 一致）。 */
export const MEMORY_DELETE_IDS_MAX = 500;

export const BACKUP_KIND_LABEL: Record<MemoryBackupKind, string> = {
  "before-delete": "删除前",
  "before-restore": "恢复前",
  "bank-removed": "移除的库",
};

export type MemoryWriteAction = "delete" | "remove" | "restore" | "backup-delete";

const ACTION_VERB: Record<MemoryWriteAction, string> = {
  delete: "删除",
  remove: "移除",
  restore: "恢复",
  "backup-delete": "删除备份",
};

/** 写操作错误文案：占用/探测失败给修复指引，其余沿用后端 message。 */
export function memoryWriteErrorText(e: AppError, action: MemoryWriteAction): string {
  if (e.code === "IN_USE") {
    return `无法${ACTION_VERB[action]}：${errorText(e)}。先退出占用该库的 omp 会话后再试。`;
  }
  if (e.code === "PROBE_FAILED") {
    return `无法${ACTION_VERB[action]}：无法确认是否有 omp 会话在使用该库（${errorText(e)}），请稍后重试。`;
  }
  return `${ACTION_VERB[action]}失败：${errorText(e)}`;
}

export function bankMemories(b: MemoryBankSummary): number {
  return b.working + b.episodic;
}

/** 无效库：目录已不存在 / 空库 / 不可读（一个库可同时命中多项）。 */
export type BankInvalidKind = "gone" | "empty" | "unreadable";

export const BANK_INVALID_LABEL: Record<BankInvalidKind, string> = {
  gone: "目录已不存在",
  empty: "空库",
  unreadable: "不可读",
};

export function bankInvalidKinds(b: MemoryBankSummary): BankInvalidKind[] {
  const kinds: BankInvalidKind[] = [];
  if (!b.readable) kinds.push("unreadable");
  if (b.cwdExists === false) kinds.push("gone");
  if (b.readable && bankMemories(b) === 0) kinds.push("empty");
  return kinds;
}

export interface BankStatusState {
  status: MemoryBankStatus | null;
  loading: boolean;
  error: string | null;
}

/** 库占用状态：enabled=false 时不请求；token 变化时重查（重试用）。 */
export function useBankStatus(bank: string, enabled: boolean, token = 0): BankStatusState {
  const [status, setStatus] = useState<MemoryBankStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    // 重查前丢弃旧状态：过期的“使用中/可用”不能当门禁依据。
    setStatus(null);
    setLoading(true);
    setError(null);
    memoryBankStatus({ bank })
      .then((s) => !cancelled && setStatus(s))
      .catch((e: unknown) => !cancelled && setError(errorText(normalizeError(e))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bank, enabled, token]);
  return { status, loading, error };
}

/** 门禁提示：加载失败 / 使用中 / 探测失败（status 须已按目标库匹配过；加载中由调用方处理）。 */
export function MemoryGateNote(props: { status: MemoryBankStatus | null; loadError: string | null; onRetry: () => void }): ReactNode {
  const { status, loadError, onRetry } = props;
  return (
    <>
      {loadError !== null ? (
        <p>
          占用状态加载失败：{loadError} <button type="button" className="btn btn-small" onClick={onRetry}>重试</button>
        </p>
      ) : null}
      {status?.inUse === true ? (
        <p className="mem-note-danger">
          该库正被使用：{status.holders.map((h) => `${h.command} (pid ${h.pid})`).join("、")}。先退出占用该库的 omp 会话后再试。
          <button type="button" className="btn btn-small" onClick={onRetry}>重试</button>
        </p>
      ) : null}
      {status?.probeFailed === true ? (
        <p className="mem-note-danger">
          无法确认是否有 omp 会话在使用该库（占用探测失败），请稍后重试。
          <button type="button" className="btn btn-small" onClick={onRetry}>重试</button>
        </p>
      ) : null}
    </>
  );
}
