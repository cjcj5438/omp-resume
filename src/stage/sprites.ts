/**
 * 像素角色精灵：12×16 主体 + 1px 描边，逐帧矩形表，先画到离屏 canvas 再缓存。
 *
 * 全部原创（矩形拼装，不复制参考图）。绘制入口：
 * - [`spriteCanvas`]：取（并缓存）某个角色 × 姿态 × 颜色修正的离屏 canvas；
 * - [`drawSprite`]：把精灵画到目标 ctx。
 */

export type CharacterId =
  | "coder"
  | "designer"
  | "ops"
  | "tester"
  | "scholar"
  | "admin"
  | "guard";

export type SpritePose = "idle" | "blink" | "back" | "type" | "walkA" | "walkB" | "sit" | "cheer";

export type SpriteTint = "none" | "fail" | "lost";

export interface Character {
  id: CharacterId;
  name: string;
  hair: string;
  skin: string;
  shirt: string;
  shirtDark: string;
  pants: string;
  shoe: string;
  eye: string;
  accessory: "glasses" | "cap" | "headphones" | "none";
}

export const CHARACTERS: Record<CharacterId, Character> = {
  coder: {
    id: "coder",
    name: "码农",
    hair: "#1b1b22",
    skin: "#f2c7a0",
    shirt: "#3b82f6",
    shirtDark: "#2f63c0",
    pants: "#1f2a44",
    shoe: "#20202a",
    eye: "#1b1b22",
    accessory: "glasses",
  },
  designer: {
    id: "designer",
    name: "设计",
    hair: "#5a3a2a",
    skin: "#f4cfae",
    shirt: "#ec6aa6",
    shirtDark: "#bd4f84",
    pants: "#3a2f4f",
    shoe: "#20202a",
    eye: "#1b1b22",
    accessory: "none",
  },
  ops: {
    id: "ops",
    name: "运维",
    hair: "#2b2b2b",
    skin: "#e3b48c",
    shirt: "#34c27a",
    shirtDark: "#279a60",
    pants: "#23372f",
    shoe: "#20202a",
    eye: "#1b1b22",
    accessory: "cap",
  },
  tester: {
    id: "tester",
    name: "测试",
    hair: "#8a4b1f",
    skin: "#f2c7a0",
    shirt: "#f59e3d",
    shirtDark: "#c97f2c",
    pants: "#3a2e22",
    shoe: "#20202a",
    eye: "#1b1b22",
    accessory: "headphones",
  },
  scholar: {
    id: "scholar",
    name: "研究",
    hair: "#e8e8ee",
    skin: "#f4d9c2",
    shirt: "#8b6cf0",
    shirtDark: "#6c52c4",
    pants: "#2a2447",
    shoe: "#20202a",
    eye: "#1b1b22",
    accessory: "glasses",
  },
  admin: {
    id: "admin",
    name: "管理员",
    hair: "#3a2a22",
    skin: "#e8b997",
    shirt: "#d9534f",
    shirtDark: "#ad3f3b",
    pants: "#2a2a30",
    shoe: "#20202a",
    eye: "#1b1b22",
    accessory: "cap",
  },
  guard: {
    id: "guard",
    name: "安全",
    hair: "#1f1f24",
    skin: "#e8b997",
    shirt: "#475569",
    shirtDark: "#334155",
    pants: "#1e293b",
    shoe: "#20202a",
    eye: "#1b1b22",
    accessory: "cap",
  },
};

/** 访客可选角色池（未知 agent 按名称哈希分配）。 */
export const GUEST_POOL: CharacterId[] = [
  "coder",
  "designer",
  "ops",
  "tester",
  "scholar",
  "guard",
];

export const CHARACTER_IDS: CharacterId[] = [
  "coder",
  "designer",
  "ops",
  "tester",
  "scholar",
  "admin",
  "guard",
];

export function hasCharacter(id: unknown): id is CharacterId {
  return typeof id === "string" && (CHARACTER_IDS as string[]).includes(id);
}

/** 精灵画布尺寸（含 1px 描边）。 */
export const SPRITE_W = 14;
export const SPRITE_H = 18;
/** 主体偏移（描边占 1px）。 */
const OX = 1;
const OY = 1;

type Part = [x: number, y: number, w: number, h: number, color: "hair" | "skin" | "shirt" | "shirtDark" | "pants" | "shoe" | "eye"];

/** 基础站立帧（正面）。 */
const IDLE: Part[] = [
  [2, 13, 3, 3, "pants"],
  [7, 13, 3, 3, "pants"],
  [2, 15, 3, 1, "shoe"],
  [7, 15, 3, 1, "shoe"],
  [1, 8, 10, 5, "shirt"],
  [1, 12, 10, 1, "shirtDark"],
  [0, 8, 1, 4, "shirt"],
  [11, 8, 1, 4, "shirt"],
  [0, 12, 1, 1, "skin"],
  [11, 12, 1, 1, "skin"],
  [2, 3, 8, 5, "skin"],
  [4, 5, 1, 2, "eye"],
  [7, 5, 1, 2, "eye"],
  [2, 0, 8, 3, "hair"],
  [1, 2, 1, 4, "hair"],
  [10, 2, 1, 4, "hair"],
];

const back = (extra: Part[] = []): Part[] => [
  [2, 13, 3, 3, "pants"],
  [7, 13, 3, 3, "pants"],
  [2, 15, 3, 1, "shoe"],
  [7, 15, 3, 1, "shoe"],
  [1, 8, 10, 5, "shirt"],
  [1, 12, 10, 1, "shirtDark"],
  [0, 8, 1, 4, "shirt"],
  [11, 8, 1, 4, "shirt"],
  [2, 3, 8, 5, "skin"],
  [2, 0, 8, 8, "hair"],
  [1, 2, 1, 5, "hair"],
  [10, 2, 1, 5, "hair"],
  ...extra,
];

/** 各姿态的矩形表（姿态间只列差异，正面帧复用 IDLE 的躯干/头）。 */
export const FRAMES: Record<SpritePose, Part[]> = {
  idle: IDLE,
  blink: IDLE.map((p) => (p[2] === 1 && p[3] === 2 && p[4] === "eye" ? ([p[0], 6, 1, 1, "eye"] as Part) : p)),
  back: back(),
  type: back([
    [1, 7, 2, 1, "skin"],
    [9, 7, 2, 1, "skin"],
  ]),
  walkA: [
    [2, 12, 3, 2, "pants"],
    [2, 14, 3, 1, "shoe"],
    [7, 13, 3, 3, "pants"],
    [7, 15, 3, 1, "shoe"],
    [1, 8, 10, 5, "shirt"],
    [1, 12, 10, 1, "shirtDark"],
    [0, 8, 1, 4, "shirt"],
    [11, 8, 1, 4, "shirt"],
    [0, 12, 1, 1, "skin"],
    [11, 12, 1, 1, "skin"],
    [2, 3, 8, 5, "skin"],
    [4, 5, 1, 2, "eye"],
    [7, 5, 1, 2, "eye"],
    [2, 0, 8, 3, "hair"],
    [1, 2, 1, 4, "hair"],
    [10, 2, 1, 4, "hair"],
  ],
  walkB: [
    [2, 13, 3, 3, "pants"],
    [2, 15, 3, 1, "shoe"],
    [7, 12, 3, 2, "pants"],
    [7, 14, 3, 1, "shoe"],
    [1, 8, 10, 5, "shirt"],
    [1, 12, 10, 1, "shirtDark"],
    [0, 8, 1, 4, "shirt"],
    [11, 8, 1, 4, "shirt"],
    [0, 12, 1, 1, "skin"],
    [11, 12, 1, 1, "skin"],
    [2, 3, 8, 5, "skin"],
    [4, 5, 1, 2, "eye"],
    [7, 5, 1, 2, "eye"],
    [2, 0, 8, 3, "hair"],
    [1, 2, 1, 4, "hair"],
    [10, 2, 1, 4, "hair"],
  ],
  sit: [
    [2, 12, 8, 2, "pants"],
    [2, 14, 3, 1, "shoe"],
    [7, 14, 3, 1, "shoe"],
    [1, 8, 10, 5, "shirt"],
    [1, 12, 10, 1, "shirtDark"],
    [0, 8, 1, 4, "shirt"],
    [11, 8, 1, 4, "shirt"],
    [2, 3, 8, 5, "skin"],
    [4, 5, 1, 2, "eye"],
    [7, 5, 1, 2, "eye"],
    [2, 0, 8, 3, "hair"],
    [1, 2, 1, 4, "hair"],
    [10, 2, 1, 4, "hair"],
  ],
  cheer: [
    [2, 13, 3, 3, "pants"],
    [7, 13, 3, 3, "pants"],
    [2, 15, 3, 1, "shoe"],
    [7, 15, 3, 1, "shoe"],
    [1, 8, 10, 5, "shirt"],
    [1, 12, 10, 1, "shirtDark"],
    [0, 4, 1, 4, "shirt"],
    [11, 4, 1, 4, "shirt"],
    [0, 3, 1, 1, "skin"],
    [11, 3, 1, 1, "skin"],
    [2, 3, 8, 5, "skin"],
    [4, 5, 1, 2, "eye"],
    [7, 5, 1, 2, "eye"],
    [2, 0, 8, 3, "hair"],
    [1, 2, 1, 4, "hair"],
    [10, 2, 1, 4, "hair"],
  ],
};

/** 背向姿态（背面不需要五官+眼镜），配饰按背向形态。 */
const BACK_POSES: Partial<Record<SpritePose, true>> = { back: true, type: true };

const OUTLINE = "#0c0c10";

/** 配饰矩形（按姿态给，正面/背面不同）。 */
function accessoryParts(char: Character, pose: SpritePose): Part[] {
  const facingBack = BACK_POSES[pose] === true;
  switch (char.accessory) {
    case "glasses":
      if (facingBack) return [];
      return [
        [3, 5, 2, 2, "eye"],
        [6, 5, 2, 2, "eye"],
        [5, 5, 1, 1, "eye"],
      ];
    case "cap":
      return facingBack
        ? [
            [1, 0, 10, 3, "shirtDark"],
            [1, 2, 10, 1, "shirtDark"],
          ]
        : [
            [1, 0, 10, 2, "shirtDark"],
            [1, 2, 10, 1, "shirtDark"],
          ];
    case "headphones":
      return [
        [1, 1, 10, 1, "shoe"],
        [0, 4, 1, 3, "shoe"],
        [11, 4, 1, 3, "shoe"],
      ];
    default:
      return [];
  }
}

/** 把 `pose` 的矩形表叠上配饰，颜色解析成十六进制。 */
function resolvedParts(char: Character, pose: SpritePose): [number, number, number, number, string][] {
  const parts = [...FRAMES[pose], ...accessoryParts(char, pose)];
  return parts.map(([x, y, w, h, key]) => [x, y, w, h, char[key]]);
}

const cache = new Map<string, HTMLCanvasElement>();

function canDraw(): boolean {
  return typeof document !== "undefined";
}

function freshCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/**
 * 取精灵离屏 canvas（缓存）：`char` × `pose` × `tint`。
 *
 * 无 DOM（jsdom 无 canvas 实现）时返回 1×1 占位 canvas。
 */
export function spriteCanvas(charId: CharacterId, pose: SpritePose, tint: SpriteTint = "none"): HTMLCanvasElement {
  const key = `${charId}:${pose}:${tint}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const char = CHARACTERS[charId] ?? CHARACTERS.coder;

  const body = freshCanvas(SPRITE_W, SPRITE_H);
  const ctx = body.getContext("2d");
  if (ctx === null) {
    const blank = freshCanvas(1, 1);
    cache.set(key, blank);
    return blank;
  }
  ctx.imageSmoothingEnabled = false;
  // 主体。
  for (const [x, y, w, h, color] of resolvedParts(char, pose)) {
    ctx.fillStyle = color;
    ctx.fillRect(x + OX, y + OY, w, h);
  }
  // 4 邻域膨胀 1px 描边：用 alpha 判定，描边只画在透明像素上。
  const img = ctx.getImageData(0, 0, SPRITE_W, SPRITE_H);
  const src = img.data;
  const alphaAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= SPRITE_W || y >= SPRITE_H ? 0 : src[(y * SPRITE_W + x) * 4 + 3];
  const outline: [number, number][] = [];
  for (let y = 0; y < SPRITE_H; y += 1) {
    for (let x = 0; x < SPRITE_W; x += 1) {
      if (alphaAt(x, y) !== 0) continue;
      if (alphaAt(x - 1, y) || alphaAt(x + 1, y) || alphaAt(x, y - 1) || alphaAt(x, y + 1)) {
        outline.push([x, y]);
      }
    }
  }
  ctx.fillStyle = OUTLINE;
  for (const [x, y] of outline) ctx.fillRect(x, y, 1, 1);

  if (tint !== "none") {
    const canvas = freshCanvas(SPRITE_W, SPRITE_H);
    const tctx = canvas.getContext("2d");
    if (tctx !== null) {
      tctx.imageSmoothingEnabled = false;
      if (tint === "lost" && typeof tctx.filter === "string") {
        tctx.filter = "grayscale(1)";
      }
      tctx.drawImage(body, 0, 0);
      tctx.filter = "none";
      if (tint === "fail") {
        tctx.globalCompositeOperation = "source-atop";
        tctx.fillStyle = "rgba(255,70,60,0.35)";
        tctx.fillRect(0, 0, SPRITE_W, SPRITE_H);
        tctx.globalCompositeOperation = "source-over";
      }
    }
    cache.set(key, canvas);
    return canvas;
  }
  cache.set(key, body);
  return body;
}

/** 把精灵画到目标上下文：`(x,y)` 是脚底中心，`scale` 是整数倍放大。 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  charId: CharacterId,
  pose: SpritePose,
  tint: SpriteTint,
  x: number,
  y: number,
  scale = 1,
  alpha = 1,
): void {
  if (!canDraw()) return;
  const sprite = spriteCanvas(charId, pose, tint);
  const w = SPRITE_W * scale;
  const h = SPRITE_H * scale;
  const prevAlpha = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, Math.round(x - w / 2), Math.round(y - h), w, h);
  if (alpha !== 1) ctx.globalAlpha = prevAlpha;
}
