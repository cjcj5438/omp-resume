/**
 * 树折叠：把最长线性 plain 消息链折成一行 "▸ N 条消息"。
 * 规则（UI spec）：根 / 分叉点（≥2 子）/ 叶子 / leafId / 带 label /
 * compaction / branchSummary 永不折叠；其余恰好一个孩子的 message 节点
 * 组成最长连续段（长度 ≥2 才折，单个直接渲染）。
 * 子节点顺序：activePath 上的孩子优先，其余保持原序。
 */
import type { TreeData, TreeNode } from "../types";

export interface NodeRow {
  type: "node";
  key: string;
  node: TreeNode;
  depth: number;
  onActivePath: boolean;
  isLeaf: boolean;
}

export interface FoldRow {
  type: "fold";
  key: string;
  nodes: TreeNode[];
  depth: number;
  parentId: string | null;
  onActivePath: boolean;
}

export type DisplayRow = NodeRow | FoldRow;

/** 缩进上限：超过后 CSS 不再加宽，行内显示深度标记。 */
export const MAX_INDENT_DEPTH = 8;

export function foldTree(tree: TreeData): DisplayRow[] {
  const byId = new Map<string, TreeNode>();
  for (const n of tree.nodes) byId.set(n.id, n);
  const active = new Set(tree.activePathIds);
  const roots = new Set(tree.rootIds);
  const out: DisplayRow[] = [];

  const orderedChildren = (n: TreeNode): TreeNode[] => {
    const kids: TreeNode[] = [];
    for (const id of n.childIds) {
      const c = byId.get(id);
      if (c) kids.push(c);
    }
    kids.sort((a, b) => {
      const aa = active.has(a.id) ? 0 : 1;
      const bb = active.has(b.id) ? 0 : 1;
      return aa - bb;
    });
    return kids;
  };

  // 可折叠：plain message、恰好一个孩子、非根非叶非 leafId、无 label、非压缩/分支摘要。
  const foldable = (n: TreeNode): boolean =>
    n.kind === "message" &&
    !n.isCompaction &&
    !n.isBranchSummary &&
    n.label == null &&
    n.childIds.length === 1 &&
    n.id !== tree.leafId &&
    !roots.has(n.id);

  const emitChain = (start: TreeNode, depth: number): void => {
    // 从 start 起收集最长 foldable 前缀（有趣节点打断）。
    const run: TreeNode[] = [];
    let cur: TreeNode | undefined = start;
    while (cur && foldable(cur)) {
      run.push(cur);
      cur = byId.get(cur.childIds[0]);
    }
    if (run.length >= 2) {
      out.push({
        type: "fold",
        key: `fold:${run[0].id}`,
        nodes: run,
        depth,
        parentId: run[0].parentId,
        onActivePath: run.some((r) => active.has(r.id)),
      });
      if (cur) emit(cur, depth + 1);
      return;
    }
    emit(start, depth);
  };

  const emit = (n: TreeNode, depth: number): void => {
    out.push({
      type: "node",
      key: n.id,
      node: n,
      depth,
      onActivePath: active.has(n.id),
      isLeaf: n.childIds.length === 0,
    });
    for (const c of orderedChildren(n)) emitChain(c, depth + 1);
  };

  for (const id of tree.rootIds) {
    const r = byId.get(id);
    if (r) emit(r, 0);
  }
  return out;
}

/** 展开后的可见行：expanded 存放已展开的 fold key。 */
export function flattenRows(
  rows: DisplayRow[],
  expanded: Set<string>,
): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const r of rows) {
    if (r.type === "fold" && expanded.has(r.key)) {
      for (const n of r.nodes) {
        out.push({
          type: "node",
          key: n.id,
          node: n,
          depth: r.depth,
          onActivePath: r.onActivePath,
          isLeaf: false,
        });
      }
    } else {
      out.push(r);
    }
  }
  return out;
}
