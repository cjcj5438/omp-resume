import { describe, expect, test } from "vitest";
import {
  BOSS_SEAT,
  CORRIDOR_Y,
  DONE_CAP,
  LOUNGE_CAP,
  QUEUE_CAP,
  DESK_COLS,
  GUTTER_X,
  TOP_BAND_H,
  W,
  deskSlot,
  doneSlot,
  loungeSlot,
  queueSlot,
  route,
  sceneHeight,
  sceneRows,
  type Point,
} from "./layout";

/** 家具包围盒（含显示器），用 `x0/y0/x1/y1` 便于做区间比较。 */
interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 所有桌子矩形（含显示器）——路点绝不能落进去。 */
function deskRects(rows: number): Bounds[] {
  const rects: Bounds[] = [];
  for (let i = 0; i < rows * DESK_COLS; i += 1) {
    const slot = deskSlot(i);
    rects.push({
      x0: slot.monitor.x,
      y0: slot.monitor.y,
      x1: slot.desk.x + slot.desk.w,
      y1: slot.desk.y + slot.desk.h,
    });
  }
  return rects;
}

/** 线段（水平或垂直）是否穿过任何桌子矩形（内部，边界不算）。 */
function crossesDesk(a: Point, b: Point, rects: Bounds[]): boolean {
  for (const r of rects) {
    if (a.y === b.y) {
      const y = a.y;
      if (y <= r.y0 || y >= r.y1) continue;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      if (x1 > r.x0 && x0 < r.x1) return true;
    } else if (a.x === b.x) {
      const x = a.x;
      if (x <= r.x0 || x >= r.x1) continue;
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      if (y1 > r.y0 && y0 < r.y1) return true;
    }
  }
  return false;
}

describe("layout", () => {
  test("工位槽位按 4 列排布，桌面在通道之上", () => {
    const a = deskSlot(0);
    const b = deskSlot(1);
    const row2 = deskSlot(DESK_COLS);
    expect(a.col).toBe(0);
    expect(b.col).toBe(1);
    expect(row2.row).toBe(1);
    expect(b.seat.x - a.seat.x).toBe(64);
    expect(row2.seat.y - a.seat.y).toBe(52);
    // 座位（脚底）落在桌沿内 2px：精灵头肩露出桌前，腿被桌面挡住。
    expect(a.seat.y).toBe(a.desk.y + 2);
    // 笔电立在桌沿上方（挡住就座角色的上身），且不越出桌面宽度。
    expect(a.monitor.y).toBeLessThan(a.desk.y);
    expect(a.monitor.x).toBeGreaterThanOrEqual(a.desk.x);
    expect(a.monitor.x + a.monitor.w).toBeLessThanOrEqual(a.desk.x + a.desk.w);
    // 桌子不越过场景右边界。
    const last = deskSlot(DESK_COLS - 1);
    expect(last.desk.x + last.desk.w).toBeLessThan(W);
  });

  test("三条走廊与老板桌/完成板/沙发互不重叠", () => {
    const rows = sceneRows(12);
    const rects = deskRects(rows);
    // 横走廊本身是空的。
    expect(crossesDesk({ x: 0, y: CORRIDOR_Y }, { x: W, y: CORRIDOR_Y }, rects)).toBe(false);
    // 竖走廊是空的。
    expect(
      crossesDesk({ x: GUTTER_X, y: TOP_BAND_H }, { x: GUTTER_X, y: sceneHeight(rows) }, rects),
    ).toBe(false);
    // 各行的横向通道是空的（座位锚点也必须在通道上方）。
    for (let row = 0; row < rows; row += 1) {
      const lane = deskSlot(row * DESK_COLS).laneY;
      expect(crossesDesk({ x: 0, y: lane }, { x: W, y: lane }, rects)).toBe(false);
    }
    // 老板座位在顶部带内。
    expect(BOSS_SEAT.y).toBeLessThan(TOP_BAND_H);
  });

  test("route 只经过走廊/通道，中间段不穿桌子", () => {
    const rows = sceneRows(12);
    const rects = deskRects(rows);
    const from = deskSlot(3).seat; // row0 col3
    const to = doneSlot(2);
    const points = route(from, to);
    expect(points[0]).toEqual(from);
    expect(points[points.length - 1]).toEqual(to);
    // 每一段都是纯水平或纯垂直。
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      expect(a.x === b.x || a.y === b.y).toBe(true);
      // 起终点是座位的那一段必然从桌后出来（精灵脚底在桌沿内），其余段必须空。
      const touchesSeat = i === 1 || i === points.length - 1;
      if (touchesSeat) continue;
      expect(crossesDesk(a, b, rects), `段 ${i}: ${JSON.stringify([a, b])}`).toBe(false);
    }
    // 路点里出现了竖走廊与横走廊。
    expect(points.some((p) => p.x === GUTTER_X)).toBe(true);
    expect(points.some((p) => p.y === CORRIDOR_Y)).toBe(true);
  });

  test("route 对同一点退化为单点、去掉共线中间点", () => {
    const p = queueSlot(0);
    expect(route(p, p)).toEqual([p]);
    const points = route(deskSlot(4).seat, deskSlot(5).seat);
    // 相邻工位同一行：不应出现多余的折返点。
    expect(points.length).toBeLessThanOrEqual(6);
  });

  test("顶部带三个区域互不重叠，且都在走廊之上", () => {
    const boxes = {
      boss: { x0: 34, x1: 94, y0: 26, y1: 56 },
      queue: { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
      done: { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
      lounge: { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
    };
    const expand = (box: typeof boxes.queue, p: Point) => {
      box.x0 = Math.min(box.x0, p.x);
      box.x1 = Math.max(box.x1, p.x);
      box.y0 = Math.min(box.y0, p.y);
      box.y1 = Math.max(box.y1, p.y);
    };
    for (let i = 0; i < QUEUE_CAP; i += 1) expand(boxes.queue, queueSlot(i));
    for (let i = 0; i < DONE_CAP; i += 1) expand(boxes.done, doneSlot(i));
    for (let i = 0; i < LOUNGE_CAP; i += 1) expand(boxes.lounge, loungeSlot(i));

    const keys = ["boss", "queue", "done", "lounge"] as const;
    for (const key of keys) {
      expect(boxes[key].y1, `${key} 必须在走廊之上`).toBeLessThan(CORRIDOR_Y);
      expect(boxes[key].x0, `${key} 不出左边界`).toBeGreaterThan(GUTTER_X + 6);
      expect(boxes[key].x1, `${key} 不出右边界`).toBeLessThan(W - 8);
    }
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = boxes[keys[i]];
        const b = boxes[keys[j]];
        const overlap = a.x0 <= b.x1 + 4 && b.x0 <= a.x1 + 4 && a.y0 <= b.y1 + 4 && b.y0 <= a.y1 + 4;
        expect(overlap, `${keys[i]} 与 ${keys[j]} 重叠`).toBe(false);
      }
    }
  });

  test("区域槽位与场景高度", () => {
    expect(queueSlot(0).y).toBeLessThan(TOP_BAND_H);
    expect(doneSlot(0).y).toBeLessThan(TOP_BAND_H);
    expect(loungeSlot(0).y).toBeLessThan(TOP_BAND_H);
    expect(sceneRows(0)).toBe(1);
    expect(sceneRows(9)).toBe(3);
    expect(sceneRows(13)).toBe(4);
    expect(sceneHeight(3)).toBe(100 + 52 * 3 + 8);
  });
});
