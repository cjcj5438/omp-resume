/** 清理视图的纯逻辑：可勾选规则、选中合计、删除目标构造（便于单测）。 */
import type { CleanupCandidate, CleanupReason } from "./types";
import type { DeleteTarget } from "./flows";

export const REASON_LABEL: Record<CleanupReason, string> = {
  empty: "空会话",
  cwd_missing: "cwd 已删除",
  large: "体积大",
  stale: "久未更新",
};

/** 占用中或占用探测失败的候选不可勾选（与删除门禁一致：IN_USE / PROBE_FAILED）。 */
export function isSelectable(c: CleanupCandidate): boolean {
  return !c.inUse && c.probeOk;
}

/** 已选数量与可释放字节（仅统计仍可勾选且被选中的候选）。 */
export function selectionTotals(
  candidates: CleanupCandidate[],
  checked: Set<string>,
): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const c of candidates) {
    if (!checked.has(c.path) || !isSelectable(c)) continue;
    count += 1;
    bytes += c.bytes;
  }
  return { count, bytes };
}

/** 全选可勾选项；若已全部选中则清空。 */
export function toggleAllSelectable(
  candidates: CleanupCandidate[],
  checked: Set<string>,
): Set<string> {
  const selectable = candidates.filter(isSelectable).map((c) => c.path);
  const allChecked = selectable.length > 0 && selectable.every((p) => checked.has(p));
  return allChecked ? new Set() : new Set(selectable);
}

/** 选中项转为删除对话框目标（清理候选无消息数，显示为 null）。 */
export function toDeleteTargets(
  candidates: CleanupCandidate[],
  checked: Set<string>,
): DeleteTarget[] {
  return candidates
    .filter((c) => checked.has(c.path) && isSelectable(c))
    .map((c) => ({
      path: c.path,
      id: c.id,
      title: c.title,
      cwd: c.cwd,
      sizeBytes: c.bytes,
      messageCount: null,
      inUse: c.inUse,
    }));
}

export type CleanupSortDir = "desc" | "asc";

/** 按体积排序（同体积按 path 升序），与后端返回顺序无关，保证确定性。 */
export function sortCandidates(list: CleanupCandidate[], dir: CleanupSortDir): CleanupCandidate[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    if (a.bytes !== b.bytes) return sign * (a.bytes - b.bytes);
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}
