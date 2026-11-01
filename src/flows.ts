/**
 * 删除计划 + 从节点继续的编排：纯逻辑，便于单测，UI 层注入后端调用。
 */
import { normalizeError } from "./api";

/**
 * 删除对话框的目标：会话列表行与清理候选共用的最小形状。
 * `messageCount` 仅会话列表有值（清理候选为 null，不展示消息数）。
 * `source` 区分发起页：清理页发 `"cleanup"`（App 侧据此切 DeleteDialog cleanup 变体），
 * 会话页/行内/批量不填（默认会话形态，保持旧行为）。
 * `excluded` 仅 cleanup 来源有值：发起时可见集里不可勾选（占用中/占用未知）被排除的条数，
 * 供 cleanup 变体 kv「占用中已排除」展示（targets 本身只含可删项，无法从中统计）。
 */
export interface DeleteTarget {
  path: string;
  id: string;
  title: string;
  cwd: string;
  sizeBytes: number;
  messageCount: number | null;
  inUse: boolean;
  source?: "cleanup";
  excluded?: number;
}

export interface CleanupDialogInfo {
  count: number;
  bytes: number;
  excluded: number;
}

/**
 * 删除对话框路由：targets 里混入 cleanup 来源就走清理变体（cleanup-P0-2 接线）。
 * kv 计数：count 为目标数、bytes 为 sizeBytes 合计、excluded 取发起方算好的被排除数
 * （targets 只含可删项；在用数无法从 targets 反推，故由 CleanupView 发起时填）。
 * 会话页/行内/批量目标不带 source，返回 null 走默认会话形态。
 */
export function cleanupDialogInfo(targets: DeleteTarget[]): CleanupDialogInfo | null {
  const fromCleanup = targets.filter((t) => t.source === "cleanup");
  if (fromCleanup.length === 0) return null;
  return {
    count: targets.length,
    bytes: targets.reduce((n, t) => n + t.sizeBytes, 0),
    excluded: fromCleanup[0].excluded ?? 0,
  };
}

export interface DeletePlan {
  deletable: string[];
  skippedInUse: string[];
}

/** only 非 inUse 的 path 才提交删除；在用会话列为"将被跳过"。 */
export function planDelete(
  byPath: Map<string, { inUse: boolean }>,
  paths: string[],
): DeletePlan {
  const deletable: string[] = [];
  const skippedInUse: string[] = [];
  for (const p of paths) {
    const s = byPath.get(p);
    if (s?.inUse) skippedInUse.push(p);
    else deletable.push(p);
  }
  return { deletable, skippedInUse };
}

export interface ContinueDeps {
  appendBranchMarker: (path: string, nodeId: string) => Promise<string | null>;
  openInIterm: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export interface ContinueOutcome {
  /** markerId 为 null 时的非错误提示（仍会打开 iTerm）。 */
  notice: string | null;
}

/**
 * 从节点继续：append → open → refresh。
 * append 失败 ⇒ 直接抛错，绝不打开 iTerm；
 * open 失败 ⇒ 抛错并说明标记已追加（不回滚）。
 */
export async function runContinueFromNode(
  deps: ContinueDeps,
  path: string,
  nodeId: string,
): Promise<ContinueOutcome> {
  let markerId: string | null;
  try {
    markerId = await deps.appendBranchMarker(path, nodeId);
  } catch (e) {
    throw normalizeError(e);
  }
  const notice =
    markerId === null ? "该节点已是当前位置，未追加标记" : null;
  try {
    await deps.openInIterm(path);
  } catch (e) {
    const inner = normalizeError(e);
    throw { code: inner.code, message: `标记已追加，但打开 iTerm 失败：${inner.message}` };
  }
  await deps.refresh();
  return { notice };
}
