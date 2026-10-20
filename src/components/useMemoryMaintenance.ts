/**
 * 记忆库维护共用：删除上限、备份类型中文名、写操作错误文案、库状态 hook。
 * 不渲染任何 UI；三个对话框与库行动作共用，保证门禁语义一致。
 */
import { useEffect, useState } from "react";
import { memoryBankStatus, normalizeError } from "../api";
import type { AppError, MemoryBackupHolder, MemoryBackupKind, MemoryBankStatus } from "../types";
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

export function formatHolders(holders: MemoryBackupHolder[]): string {
  return holders.map((h) => `${h.command} (pid ${h.pid})`).join("、");
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
      // 禁用（例如切到已移除库的恢复页）：清空旧库的状态，且取消中的请求不会再回写，
      // 因此 loading 也必须在此复位，否则会永远停在 true。
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    // 重新查询前丢弃旧状态：过期的“使用中/可用”不能当作门禁依据。
    setStatus(null);
    setLoading(true);
    setError(null);
    memoryBankStatus({ bank })
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(normalizeError(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bank, enabled, token]);
  return { status, loading, error };
}
