/**
 * 头顶气泡图标：13 个 5×5 点阵（`.` 空 / `#` 实），绘制时按 1 逻辑像素放大。
 *
 * 图案手绘；`glyphs.test.ts` 锁定：13 个都在、尺寸 5×5、字符集合法、两两不同。
 */

export type GlyphName =
  | "magnifier"
  | "pencil"
  | "terminal"
  | "branch"
  | "globe"
  | "dots"
  | "speech"
  | "gear"
  | "check"
  | "bang"
  | "question"
  | "hourglass"
  | "zz";

export const GLYPHS: Record<GlyphName, string[]> = {
  magnifier: [
    "..##.",
    ".#..#",
    ".#..#",
    "..##.",
    "....#",
  ],
  pencil: [
    "....#",
    "...##",
    "..##.",
    ".##..",
    "##...",
  ],
  terminal: [
    "#####",
    "#...#",
    "#.#.#",
    "#...#",
    "#####",
  ],
  branch: [
    "..#..",
    "..#..",
    ".###.",
    "..#..",
    "..#..",
  ],
  globe: [
    ".###.",
    "#.#.#",
    "#####",
    "#.#.#",
    ".###.",
  ],
  dots: [
    ".....",
    ".....",
    "#.#.#",
    ".....",
    ".....",
  ],
  speech: [
    ".###.",
    "#...#",
    "#...#",
    ".###.",
    "..#..",
  ],
  gear: [
    ".#.#.",
    "#####",
    ".#.#.",
    "#####",
    ".#.#.",
  ],
  check: [
    "....#",
    "...#.",
    "#.#..",
    ".#...",
    ".....",
  ],
  bang: [
    "..#..",
    "..#..",
    "..#..",
    ".....",
    "..#..",
  ],
  question: [
    ".###.",
    "#...#",
    "...#.",
    ".....",
    "...#.",
  ],
  hourglass: [
    "#####",
    ".#.#.",
    "..#..",
    ".#.#.",
    "#####",
  ],
  zz: [
    "####.",
    "...#.",
    "..#..",
    ".#...",
    "####.",
  ],
};

/** 工具名 → 图标（前缀匹配到已知分组，未知工具给 `gear`）。 */
const TOOL_GROUPS: Record<string, GlyphName> = {
  read: "magnifier",
  grep: "magnifier",
  find: "magnifier",
  glob: "magnifier",
  ls: "magnifier",
  search: "magnifier",
  edit: "pencil",
  write: "pencil",
  ast_edit: "pencil",
  apply_patch: "pencil",
  bash: "terminal",
  python: "terminal",
  eval: "terminal",
  ssh: "terminal",
  task: "branch",
  vibe_spawn: "branch",
  vibe_send: "branch",
  vibe_wait: "branch",
  web_search: "globe",
  fetch: "globe",
  browser: "globe",
};

/**
 * 当前活动 → 气泡图标。
 *
 * 工具名优先；没有工具时按活动种类（思考/回复）；都没有 → null（不画气泡）。
 */
export function toolGlyph(tool: string | null, kind: string | null): GlyphName | null {
  if (tool !== null) {
    const name = TOOL_GROUPS[tool];
    if (name !== undefined) return name;
    return "gear";
  }
  if (kind === "thinking") return "dots";
  if (kind === "reply") return "speech";
  return null;
}
