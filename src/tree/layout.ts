/**
 * SVG 树布局：fold 行 → 节点坐标（轨道布局）。
 * - 输入为 `foldTree` 的 DisplayRow（默认收起态）：fold 行只占一行（首节点坐标）。
 * - active 路径 x=0 继承父轨道；新分支取当前最大轨道 + 1（设计稿口径，主干固定 0 轨）。
 * - y = 行号 × 行高；边照抄设计稿 bezier 公式（同轨直线，跨轨 curve）；跨轨边虚线 warn。
 */
import type { DisplayRow } from "./fold";

export interface TreePoint {
  id: string;
  x: number;
  y: number;
  /** 该行是否折叠头（点击可展开/收起）。 */
  foldable: boolean;
  foldKey: string | null;
}

export interface TreeEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  branch: boolean;
}

export const TREE_COL_W = 296;
export const TREE_ROW_H = 58;
export const TREE_X0 = 96;

/** 轨道分配 + 行映射：返回节点坐标与边（均为 SVG 坐标，y 含首行偏移）。 */
export function layoutTree(rows: DisplayRow[]): { points: TreePoint[]; edges: TreeEdge[]; width: number; height: number } {
  const points: TreePoint[] = [];
  const trackOf = new Map<string, number>();
  let maxTrack = 0;
  // 父 id → 首个子 id（active 优先即为 rows 顺序的首个）：用于判断「首子继承父轨道」。
  const firstChild = new Map<string, string>();

  const rowNodeId = (r: DisplayRow): string => (r.type === "node" ? r.node.id : r.nodes[0].id);
  const rowParentId = (r: DisplayRow): string | null =>
    r.type === "node" ? r.node.parentId : (r.nodes[0].parentId ?? r.parentId);

  for (const r of rows) {
    const pid = rowParentId(r);
    if (pid !== null && !firstChild.has(pid)) firstChild.set(pid, rowNodeId(r));
  }

  rows.forEach((r, i) => {
    const id = rowNodeId(r);
    const pid = rowParentId(r);
    let track: number;
    if (pid === null || !trackOf.has(pid)) {
      // 根或父不在可见行（折叠隐藏）：根取 0 轨，否则继承最近可见祖先（退化取 0）。
      track = pid === null ? 0 : (trackOf.get(pid) ?? 0);
    } else if (firstChild.get(pid) === id) {
      track = trackOf.get(pid)!;
    } else {
      maxTrack += 1;
      track = maxTrack;
    }
    trackOf.set(id, track);
    points.push({
      id,
      x: TREE_X0 + track * TREE_COL_W,
      y: TREE_ROW_H * (i + 1),
      foldable: r.type === "fold",
      foldKey: r.type === "fold" ? r.key : null,
    });
  });

  const byId = new Map(points.map((p) => [p.id, p]));
  const edges: TreeEdge[] = [];
  rows.forEach((r) => {
    const pid = rowParentId(r);
    if (pid === null) return;
    const p = byId.get(pid);
    const n = byId.get(rowNodeId(r));
    if (!p || !n) return;
    edges.push({
      from: pid,
      to: n.id,
      x1: p.x,
      y1: p.y + 18,
      x2: n.x,
      y2: n.y - 18,
      branch: n.x !== p.x,
    });
  });

  return {
    points,
    edges,
    width: TREE_X0 * 2 + maxTrack * TREE_COL_W + 200,
    height: TREE_ROW_H * (rows.length + 1),
  };
}

/** 边路径：同轨直线，跨轨 bezier（设计稿 views-core.js:575-577 公式）。 */
export function edgePath(e: TreeEdge): string {
  if (!e.branch) return `M${e.x1} ${e.y1} L${e.x1} ${e.y2}`;
  return `M${e.x1} ${e.y1} C${e.x1} ${e.y1 + 28}, ${e.x2} ${e.y2 - 28}, ${e.x2} ${e.y2}`;
}

/** label 截断（JS 截断，设计稿无 CSS 省略）：按字符数截断加 …。 */
export function truncateLabel(label: string, max = 18): string {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}
