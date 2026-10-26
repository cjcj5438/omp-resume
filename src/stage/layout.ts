/**
 * 舞台几何（逻辑像素，锚点 = 角色脚底中心）。
 *
 * 布局分区（y 自上而下）：
 * - `y < 92`：顶部带（老板桌 / 排队区 / 完成板 / 沙发）
 * - `y >= 100`：工位区，每行 52px：桌沿 `[deskTop, deskTop+14]`、
 *   座位锚点 `deskTop+2`（角色在桌后，腿被桌沿挡住）、
 *   行间通道 `laneY = deskTop+38`
 * - `GUTTER_X` 处的竖走廊 + `CORRIDOR_Y` 处的横走廊把两块区域连起来
 *
 * 恒定前提（`layout.test.ts` 锁定）：桌子只占 `x ∈ [36, 268]`，横/竖走廊与每行通道
 * 全程为空，因此 [`route`] 的路点永远不会穿过家具。
 */

export interface Point {
  x: number;
  y: number;
}

/** 轴对齐矩形（家具/显示器/桌子）。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 场景逻辑宽度（缩放前的画布宽）。 */
export const W = 320;
/** 左侧竖走廊的 x（同时是门口的 x）。 */
export const GUTTER_X = 16;
/** 横走廊的 y。 */
export const CORRIDOR_Y = 80;
/** 顶部带高度（老板桌 / 完成板 / 沙发所在区域的下边界）。 */
export const TOP_BAND_H = 92;

/** 老板（主会话）座位锚点：脚底落在桌沿内 2px，头肩露在桌前。 */
export const BOSS_SEAT: Point = { x: 64, y: 44 };
/** 老板桌矩形。 */
export const BOSS_DESK = { x: 44, y: 42, w: 40, h: 12 };
/** 完成板（墙面）。 */
export const DONE_BOARD = { x: 156, y: 6, w: 72, h: 24 };
/** 沙发。 */
export const SOFA = { x: 236, y: 32, w: 70, h: 12 };

/** 门口（新角色从这里入场）。 */
export const DOOR: Point = { x: GUTTER_X, y: CORRIDOR_Y - 12 };

/** 工位列数。 */
export const DESK_COLS = 4;
/** 工位列间距与行间距。 */
export const DESK_STEP_X = 64;
export const DESK_STEP_Y = 52;
/** 首个工位的桌面上沿。 */
export const DESK_TOP0 = 100;
/** 桌子矩形半宽 / 高。 */
export const DESK_HALF_W = 20;
export const DESK_H = 14;

/** 区域槽位容量。 */
export const QUEUE_CAP = 8;
export const DONE_CAP = 8;
export const LOUNGE_CAP = 6;

/**
 * 顶部带分区（互不重叠，且都在横走廊 y=80 之上）：
 * - 老板桌 `x 44..84`；
 * - 排队区 `x 100..142`（等活的人站在老板桌右侧）；
 * - 完成板前 `x 160..208`（板在墙上 y 6..30，人站在板下）；
 * - 沙发 `x 236..306`（待命的人坐着）。
 */
export const QUEUE_X0 = 100;
export const QUEUE_DX = 14;
export const QUEUE_Y0 = 62;
export const QUEUE_DY = 9;
export const DONE_X0 = 160;
export const DONE_DX = 16;
export const DONE_Y0 = 38;
export const DONE_DY = 9;
export const LOUNGE_X0 = 244;
export const LOUNGE_DX = 20;
export const LOUNGE_Y0 = 52;
export const LOUNGE_DY = 9;

/** 工位槽位的几何。 */
export interface DeskSlot {
  index: number;
  col: number;
  row: number;
  /** 座位锚点（角色坐着时的脚底中心）。 */
  seat: Point;
  /** 桌子矩形。 */
  desk: Rect;
  /** 显示器矩形。 */
  monitor: Rect;
  /** 该行的横向通道 y。 */
  laneY: number;
}

/** 第 `index` 个工位（0 起，4 列）。 */
export function deskSlot(index: number): DeskSlot {
  const col = index % DESK_COLS;
  const row = Math.floor(index / DESK_COLS);
  const cx = 56 + DESK_STEP_X * col;
  const deskTop = DESK_TOP0 + DESK_STEP_Y * row;
  return {
    index,
    col,
    row,
    // 精灵高 18、腿占最后 6px：脚底在 deskTop+2 → 头在桌沿上方 13px、上身压着桌沿，
    // 腿被桌子挡住；笔电立在桌上挡在角色身前 → 读作「坐在桌后敲键盘」。
    seat: { x: cx, y: deskTop + 2 },
    desk: { x: cx - DESK_HALF_W, y: deskTop, w: DESK_HALF_W * 2, h: DESK_H },
    /** 桌上的笔电（画在角色之后 = 身前，挡住就座角色的上身）。 */
    monitor: { x: cx - 9, y: deskTop - 2, w: 18, h: 9 },
    laneY: deskTop + 38,
  };
}

/** 排队区/完成区/沙发槽位坐标（`index` 从 0 起，超出容量按容量取模排布）。 */
export function queueSlot(index: number): Point {
  return { x: QUEUE_X0 + QUEUE_DX * (index % 4), y: QUEUE_Y0 + QUEUE_DY * Math.floor(index / 4) };
}

export function doneSlot(index: number): Point {
  return { x: DONE_X0 + DONE_DX * (index % 4), y: DONE_Y0 + DONE_DY * Math.floor(index / 4) };
}

export function loungeSlot(index: number): Point {
  return { x: LOUNGE_X0 + LOUNGE_DX * (index % 3), y: LOUNGE_Y0 + LOUNGE_DY * Math.floor(index / 3) };
}

/** 需要 `desks` 个工位时的行数（至少 1 行；空位不渲染，场景随人数收缩）。 */
export function sceneRows(desks: number): number {
  return Math.max(1, Math.ceil(Math.max(0, desks) / DESK_COLS));
}

export function sceneHeight(rows: number): number {
  return DESK_TOP0 + DESK_STEP_Y * rows + 8;
}

/** 所在行（工位区）的横向通道 y；顶部带内统一走横走廊。 */
export function laneOf(p: Point): number {
  if (p.y < TOP_BAND_H) return CORRIDOR_Y;
  const row = Math.floor((p.y - DESK_TOP0) / DESK_STEP_Y);
  return deskSlot(row * DESK_COLS).laneY;
}

function same(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 去掉重合点与共线中间点（保留端点）。 */
function simplify(points: Point[]): Point[] {
  const dedup: Point[] = [];
  for (const p of points) {
    if (dedup.length === 0 || !same(dedup[dedup.length - 1], p)) dedup.push(p);
  }
  const out: Point[] = [];
  for (let i = 0; i < dedup.length; i += 1) {
    const prev = out[out.length - 1];
    const next = dedup[i + 1];
    if (prev && next) {
      const collinear =
        (prev.x === dedup[i].x && dedup[i].x === next.x) ||
        (prev.y === dedup[i].y && dedup[i].y === next.y);
      if (collinear) continue;
    }
    out.push(dedup[i]);
  }
  return out;
}

/**
 * 两点之间的走位路点（含起点与终点）。
 *
 * 竖走廊 + 横走廊 + 各自所在行的通道；首尾都是走廊内的点时自然退化。
 */
export function route(a: Point, b: Point): Point[] {
  if (same(a, b)) return [a];
  const la = laneOf(a);
  const lb = laneOf(b);
  const points: Point[] = [
    a,
    { x: a.x, y: la },
    { x: GUTTER_X, y: la },
    { x: GUTTER_X, y: CORRIDOR_Y },
    { x: b.x, y: CORRIDOR_Y },
    { x: b.x, y: lb },
    b,
  ];
  return simplify(points);
}

/** 路点总长度。 */
export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  }
  return total;
}
