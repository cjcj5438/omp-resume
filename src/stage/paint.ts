/**
 * 场景绘制：地板/墙/家具 + 角色混排（painter's algorithm）+ 头顶气泡。
 *
 * 全部 `fillRect`，`imageSmoothingEnabled = false`；不做任何 DOM 读写，
 * 主题通过参数传入（`paint.ts` 不管 CSS）。
 */
import { GLYPHS, type GlyphName } from "./glyphs";
import {
  BOSS_DESK,
  BOSS_SEAT,
  CORRIDOR_Y,
  DOOR,
  DONE_BOARD,
  SOFA,
  W,
  deskSlot,
  sceneHeight,
} from "./layout";
import type { Scene, SceneActor } from "./scene";
import { drawSprite, type CharacterId } from "./sprites";

export interface Palette {
  wall: string;
  floor: string;
  floorAlt: string;
  desk: string;
  deskTop: string;
  deskFace: string;
  metal: string;
  monitorOff: string;
  monitorOn: string;
  chair: string;
  sofa: string;
  plant: string;
  board: string;
}

export const LIGHT_PALETTE: Palette = {
  wall: "#cfd8e6",
  floor: "#e9e4d8",
  floorAlt: "#e1dccf",
  desk: "#b98a5a",
  deskTop: "#d2a674",
  deskFace: "#8f6540",
  metal: "#8a8f9c",
  monitorOff: "#3a3f4b",
  monitorOn: "#7fd1ff",
  chair: "#5b6b8c",
  sofa: "#c0675a",
  plant: "#4f9a5b",
  board: "#8a6a43",
};

export const DARK_PALETTE: Palette = {
  wall: "#2b3345",
  floor: "#232126",
  floorAlt: "#28252b",
  desk: "#6f4f31",
  deskTop: "#8a6540",
  deskFace: "#553c26",
  metal: "#4a4e58",
  monitorOff: "#14161c",
  monitorOn: "#5cc8ff",
  chair: "#44506e",
  sofa: "#8d4a42",
  plant: "#3b7a45",
  board: "#5b452b",
};

export function paletteFor(theme: string | undefined): Palette {
  return theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

/** 气泡文字色（按状态）。 */
const GLYPH_COLORS: Record<string, string> = {
  running: "#3b82f6",
  done: "#2ea043",
  failed: "#e5483d",
  lost: "#8e8e93",
  queued: "#b25a00",
  idle: "#6e6e73",
};

export interface PaintOptions {
  /** 动画时间（ms，单调递增）。 */
  t: number;
  palette: Palette;
  /** 深色主题：气泡底与描边反色。 */
  dark: boolean;
  reducedMotion: boolean;
  selectedId: string | null;
  /** 有效缩放倍率（仅用于选择底座等细节的取整）。 */
  scale: number;
}

/** 由 `t` 决定的显示器亮度（敲键盘时 400ms 闪一次）。 */
function monitorOn(actor: SceneActor | undefined, t: number): boolean {
  if (!actor) return false;
  if (actor.pose !== "type") return false;
  return Math.floor(t / 400) % 2 === 0;
}

function fill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** 地板 + 墙 + 窗外景。 */
function paintGround(ctx: CanvasRenderingContext2D, rows: number, p: Palette): void {
  const h = sceneHeight(rows);
  fill(ctx, 0, 0, W, h, p.floor);
  // 16px 棋盘地板。
  for (let y = 0; y < h; y += 16) {
    for (let x = 0; x < W; x += 16) {
      const even = ((x / 16) | 0) % 2 === ((y / 16) | 0) % 2;
      if (!even) fill(ctx, x, y, 16, 16, p.floorAlt);
    }
  }
  // 顶部墙带 + 窗（天空 + 云 + 十字窗框，读作窗而不是画/桌子）。
  fill(ctx, 0, 0, W, 24, p.wall);
  fill(ctx, 0, 23, W, 1, p.deskFace);
  fill(ctx, 249, 4, 40, 17, p.desk);
  fill(ctx, 250, 5, 38, 15, p.monitorOn);
  fill(ctx, 252, 7, 10, 3, p.floor);
  fill(ctx, 266, 11, 14, 3, p.floor);
  fill(ctx, 268, 6, 1, 14, p.desk);
  fill(ctx, 250, 12, 38, 1, p.desk);
  // 门。
  fill(ctx, DOOR.x - 8, CORRIDOR_Y - 28, 16, 28, p.wall);
  fill(ctx, DOOR.x - 6, CORRIDOR_Y - 26, 12, 26, p.monitorOff);
}

/** 背景家具：完成板 + 沙发 + 椅子 + 绿植（都在角色身后）。 */
function paintBackdrop(ctx: CanvasRenderingContext2D, scene: Scene, p: Palette): void {
  // 完成板：木框 + 软木面 + 三张米色便签（完成的人站它前面欢呼）。
  fill(ctx, DONE_BOARD.x, DONE_BOARD.y, DONE_BOARD.w, DONE_BOARD.h, p.board);
  fill(ctx, DONE_BOARD.x + 2, DONE_BOARD.y + 2, DONE_BOARD.w - 4, DONE_BOARD.h - 4, p.deskTop);
  for (let i = 0; i < 3; i += 1) {
    const nx = DONE_BOARD.x + 7 + i * 22;
    fill(ctx, nx, DONE_BOARD.y + 5, 15, 13, p.floor);
    fill(ctx, nx + 2, DONE_BOARD.y + 8, 11, 1, p.deskFace);
    fill(ctx, nx + 2, DONE_BOARD.y + 11, 11, 1, p.deskFace);
    fill(ctx, nx + 2, DONE_BOARD.y + 14, 7, 1, p.deskFace);
    // 图钉。
    fill(ctx, nx + 7, DONE_BOARD.y + 4, 1, 2, p.monitorOff);
  }
  // 沙发：靠背 + 三块座垫 + 两侧扶手 + 底座。
  fill(ctx, SOFA.x, SOFA.y, SOFA.w, 6, p.sofa);
  fill(ctx, SOFA.x + 3, SOFA.y + 6, SOFA.w - 6, 6, p.sofa);
  for (let i = 0; i < 3; i += 1) {
    const cx = SOFA.x + 4 + i * 22;
    fill(ctx, cx, SOFA.y + 6, 19, 4, p.floor);
    fill(ctx, cx, SOFA.y + 10, 19, 2, p.sofa);
  }
  fill(ctx, SOFA.x, SOFA.y + 3, 3, 9, p.sofa);
  fill(ctx, SOFA.x + SOFA.w - 3, SOFA.y + 3, 3, 9, p.sofa);
  fill(ctx, SOFA.x + 2, SOFA.y + 12, SOFA.w - 4, 1, p.deskFace);
  // 工位椅子（靠背贴在角色身后：只画在有人的工位上）。
  for (const actor of scene.actors.values()) {
    if (actor.slot === null || actor.zone !== "desk") continue;
    const slot = deskSlot(actor.slot);
    fill(ctx, slot.seat.x - 8, slot.desk.y - 3, 16, 3, p.chair);
    fill(ctx, slot.seat.x - 8, slot.desk.y - 3, 16, 1, p.monitorOff);
  }
  // 绿植（走廊右端）。
  fill(ctx, W - 18, CORRIDOR_Y + 6, 8, 6, p.desk);
  fill(ctx, W - 16, CORRIDOR_Y - 2, 4, 8, p.plant);
  fill(ctx, W - 20, CORRIDOR_Y + 1, 4, 4, p.plant);
  fill(ctx, W - 8, CORRIDOR_Y + 1, 4, 4, p.plant);
}

/** 老板桌（画在老板之后，让老板读作坐在桌后）。 */
function paintBossDesk(ctx: CanvasRenderingContext2D, p: Palette): void {
  // 店主椅靠背（在老板身后）。
  fill(ctx, BOSS_SEAT.x - 8, BOSS_DESK.y - 4, 16, 4, p.chair);
  fill(ctx, BOSS_SEAT.x - 8, BOSS_DESK.y - 4, 16, 1, p.monitorOff);
  fill(ctx, BOSS_DESK.x, BOSS_DESK.y, BOSS_DESK.w, BOSS_DESK.h, p.desk);
  fill(ctx, BOSS_DESK.x, BOSS_DESK.y, BOSS_DESK.w, 3, p.deskTop);
  // 桌面：文件 + 笔电 + 马克杯。
  fill(ctx, BOSS_DESK.x + 3, BOSS_DESK.y + 4, 9, 5, p.floor);
  fill(ctx, BOSS_DESK.x + 4, BOSS_DESK.y + 6, 7, 1, p.monitorOff);
  fill(ctx, BOSS_DESK.x + 16, BOSS_DESK.y + 2, 12, 7, p.metal);
  fill(ctx, BOSS_DESK.x + 17, BOSS_DESK.y + 3, 10, 5, p.monitorOff);
  fill(ctx, BOSS_DESK.x + 32, BOSS_DESK.y + 3, 4, 4, p.floor);
}

/**
 * 每个工位的桌子（画在角色之后：角色腿部被桌子挡住 = 坐在桌后）。
 *
 * 显示器在桌面上沿之上（角色身后），未就座时也画，空位读作「空工位」。
 */
function paintDesks(ctx: CanvasRenderingContext2D, scene: Scene, p: Palette, t: number): void {
  const bySlot: Record<number, SceneActor | undefined> = {};
  for (const actor of scene.actors.values()) {
    if (actor.slot !== null) bySlot[actor.slot] = actor;
  }
  // 只画有人的工位：空行不渲染，场景高度也随之收缩。
  for (const key of Object.keys(bySlot)) {
    const i = Number(key);
    const slot = deskSlot(i);
    const holder = bySlot[i];
    // 桌面：台面高光 + 台面 + 前立面 + 前沿阴影。
    fill(ctx, slot.desk.x, slot.desk.y, slot.desk.w, 5, p.deskTop);
    fill(ctx, slot.desk.x, slot.desk.y + 5, slot.desk.w, slot.desk.h - 5, p.deskFace);
    fill(ctx, slot.desk.x, slot.desk.y + slot.desk.h - 1, slot.desk.w, 1, p.monitorOff);
    // 笔电：金属框 + 屏幕（该工位角色敲键盘时点亮），立于桌沿之上、挡住就座角色上半身。
    const lit = monitorOn(holder, t);
    fill(ctx, slot.monitor.x - 1, slot.monitor.y - 1, slot.monitor.w + 2, slot.monitor.h + 2, p.metal);
    fill(ctx, slot.monitor.x, slot.monitor.y, slot.monitor.w, slot.monitor.h, p.monitorOff);
    if (lit) {
      // 亮屏只画三行「文本」，不整块填蓝（整块会读成鱼缸）。
      fill(ctx, slot.monitor.x + 2, slot.monitor.y + 2, slot.monitor.w - 4, 1, p.monitorOn);
      fill(ctx, slot.monitor.x + 2, slot.monitor.y + 4, slot.monitor.w - 7, 1, p.monitorOn);
      fill(ctx, slot.monitor.x + 2, slot.monitor.y + 6, slot.monitor.w - 9, 1, p.monitorOn);
    }
    // 转轴 + 便签 + 马克杯（桌角，不与笔电重叠）。
    fill(ctx, slot.monitor.x + 2, slot.monitor.y + slot.monitor.h, slot.monitor.w - 4, 1, p.metal);
    fill(ctx, slot.desk.x + 2, slot.desk.y + 2, 6, 4, p.floor);
    fill(ctx, slot.desk.x + slot.desk.w - 6, slot.desk.y + 1, 3, 3, p.metal);
  }
}

/** 失败工位上飘的烟点（最多 3 个，纯函数 of t）。 */
function paintSmoke(ctx: CanvasRenderingContext2D, actor: SceneActor, t: number): void {
  for (let i = 0; i < 3; i += 1) {
    const phase = (t / 500 + i) % 3;
    const y = actor.pos.y - 30 - phase * 6;
    const x = actor.pos.x - 4 + i * 4;
    if (phase > 2.2) continue;
    fill(ctx, Math.round(x), Math.round(y), 2, 2, "#9a9aa0");
  }
}

/** 气泡几何：9×9 白/深底 + 5×5 点阵图标，浮在头顶上方（脚底 -26）。 */
export const BUBBLE_SIZE = 9;
/** 气泡相对脚底的上移量。 */
export const BUBBLE_LIFT = 26;

function paintBubble(ctx: CanvasRenderingContext2D, actor: SceneActor, o: PaintOptions): void {
  const glyph = actor.glyph;
  if (glyph === null) return;
  const bob = o.reducedMotion ? 0 : Math.round(Math.sin((o.t / 1200) * Math.PI * 2));
  const x = Math.round(actor.pos.x - (BUBBLE_SIZE - 1) / 2);
  const y = Math.round(actor.pos.y - BUBBLE_LIFT + bob);
  const bg = o.dark ? "#e8e8ee" : "#ffffff";
  const edge = o.dark ? "#0c0c10" : "#3c3c40";
  fill(ctx, x - 1, y - 1, BUBBLE_SIZE + 2, BUBBLE_SIZE + 2, edge);
  fill(ctx, x, y, BUBBLE_SIZE, BUBBLE_SIZE, bg);
  const color = GLYPH_COLORS[actor.state] ?? GLYPH_COLORS.idle;
  ctx.fillStyle = color;
  const rows = GLYPHS[glyph as GlyphName];
  for (let row = 0; row < rows.length; row += 1) {
    const line = rows[row];
    for (let col = 0; col < line.length; col += 1) {
      if (line[col] === "#") ctx.fillRect(x + 2 + col, y + 2 + row, 1, 1);
    }
  }
}

/** 选中角色的脚下底座。 */
function paintSelection(ctx: CanvasRenderingContext2D, actor: SceneActor, accent: string): void {
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.ellipse(actor.pos.x, actor.pos.y, 7, 1.5, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 画整间办公室。
 *
 * 顺序：地面 → 背景家具（完成板/沙发/绿植）→ 按 `sortY` 混排角色 →
 * 桌子（老板桌 + 工位桌，挡住就座角色腿部）→ 气泡/烟/选中。
 */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  o: PaintOptions,
  accent = "#3b82f6",
): void {
  ctx.imageSmoothingEnabled = false;
  const rows = scene.rows;
  paintGround(ctx, rows, o.palette);
  paintBackdrop(ctx, scene, o.palette);

  const ordered = [...scene.actors.values()].sort((a, b) => a.sortY - b.sortY);
  for (const actor of ordered) {
    const alpha = actor.dim ? 0.35 : 1;
    drawSprite(
      ctx,
      actor.charId as CharacterId,
      actor.pose,
      actor.tint,
      actor.pos.x,
      actor.pos.y,
      1,
      alpha,
    );
  }
  // 桌子画在角色之后：就座角色腿部被挡住，读作「坐在桌后」。
  paintBossDesk(ctx, o.palette);
  paintDesks(ctx, scene, o.palette, o.t);

  for (const actor of ordered) {
    if (actor.state === "failed") paintSmoke(ctx, actor, o.t);
    if (actor.id === o.selectedId) paintSelection(ctx, actor, accent);
    paintBubble(ctx, actor, o);
  }
}
