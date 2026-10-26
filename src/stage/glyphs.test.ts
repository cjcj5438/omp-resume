import { describe, expect, test } from "vitest";
import { GLYPHS, toolGlyph, type GlyphName } from "./glyphs";

const NAMES: GlyphName[] = [
  "magnifier",
  "pencil",
  "terminal",
  "branch",
  "globe",
  "dots",
  "speech",
  "gear",
  "check",
  "bang",
  "question",
  "hourglass",
  "zz",
];

describe("glyphs", () => {
  test("13 个图标都存在且为 5×5 合法点阵", () => {
    expect(Object.keys(GLYPHS).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      const rows = GLYPHS[name];
      expect(rows, name).toHaveLength(5);
      for (const row of rows) {
        expect(row, name).toHaveLength(5);
        expect(/^[.#]{5}$/.test(row), `${name}: ${row}`).toBe(true);
      }
      // 至少要画出东西。
      expect(rows.join("").includes("#"), name).toBe(true);
    }
  });

  test("两两不同", () => {
    const seen = new Map<string, GlyphName>();
    for (const name of NAMES) {
      const key = GLYPHS[name].join("/");
      expect(seen.has(key), `${name} 与 ${seen.get(key)} 相同`).toBe(false);
      seen.set(key, name);
    }
  });

  test("工具名映射到分组图标，未知工具给 gear", () => {
    expect(toolGlyph("edit", "tool")).toBe("pencil");
    expect(toolGlyph("write", "tool")).toBe("pencil");
    expect(toolGlyph("read", "tool")).toBe("magnifier");
    expect(toolGlyph("bash", "tool")).toBe("terminal");
    expect(toolGlyph("task", "tool")).toBe("branch");
    expect(toolGlyph("vibe_spawn", "tool")).toBe("branch");
    expect(toolGlyph("web_search", "tool")).toBe("globe");
    expect(toolGlyph("mystery_tool", "tool")).toBe("gear");
  });

  test("无工具时按活动种类，都缺省为 null", () => {
    expect(toolGlyph(null, "thinking")).toBe("dots");
    expect(toolGlyph(null, "reply")).toBe("speech");
    expect(toolGlyph(null, "state")).toBeNull();
    expect(toolGlyph(null, null)).toBeNull();
  });
});
