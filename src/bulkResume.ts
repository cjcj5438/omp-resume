/** 批量恢复规划：纯函数。把勾选会话分成可打开 / 跳过 / 超限三份。 */
import type { SessionSummary } from "./types";

/** 单次批量恢复上限：一次开太多 iTerm 标签页会淹没用户。 */
export const MAX_BULK_RESUME = 10;

export interface BulkResumePlan {
  open: SessionSummary[];
  skipped: { s: SessionSummary; reason: "使用中" | "目录不存在" }[];
  overLimit: SessionSummary[];
}

/**
 * 规划批量恢复：可打开条件为 `!inUse && cwdExists`（与 DetailPane 的 iTerm 禁用口径一致；
 * 格式不支持仍可继续）。可打开数超限时按输入顺序取前 10，其余进 overLimit。
 */
export function planBulkResume(targets: SessionSummary[]): BulkResumePlan {
  const open: SessionSummary[] = [];
  const skipped: BulkResumePlan["skipped"] = [];
  const overLimit: SessionSummary[] = [];
  for (const s of targets) {
    if (s.inUse) {
      skipped.push({ s, reason: "使用中" });
      continue;
    }
    if (!s.cwdExists) {
      skipped.push({ s, reason: "目录不存在" });
      continue;
    }
    if (open.length < MAX_BULK_RESUME) open.push(s);
    else overLimit.push(s);
  }
  return { open, skipped, overLimit };
}
