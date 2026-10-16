/**
 * 删除计划 + 从节点继续的编排：纯逻辑，便于单测，UI 层注入后端调用。
 */
import { normalizeError } from "./api";

/**
 * 删除对话框的目标：会话列表行与清理候选共用的最小形状。
 * `messageCount` 仅会话列表有值（清理候选为 null，不展示消息数）。
 */
export interface DeleteTarget {
  path: string;
  id: string;
  title: string;
  cwd: string;
  sizeBytes: number;
  messageCount: number | null;
  inUse: boolean;
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
