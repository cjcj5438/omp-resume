import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graphLayout";

const IDS = ["e1", "w1", "w2", "w3", "e2"];
const EDGES = [
  { source: "e1", target: "w1" },
  { source: "e1", target: "w2" },
  { source: "w1", target: "w2" },
  { source: "e1", target: "e2" },
];

describe("layoutGraph", () => {
  it("同样输入恒得同样坐标", () => {
    const a = layoutGraph(IDS, EDGES);
    const b = layoutGraph([...IDS].reverse(), [...EDGES].reverse());
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("坐标有限且不出界", () => {
    const out = layoutGraph(IDS, EDGES, { width: 640, height: 420 });
    expect(out.size).toBe(IDS.length);
    for (const p of out.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(640);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(420);
    }
  });

  it("空输入返回空表", () => {
    expect(layoutGraph([], []).size).toBe(0);
  });

  it("百节点图在 x/y 都铺开（旧 y-clamp 回归）", () => {
    let a = 123456789;
    const rand = (): number => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      return a / 4294967296;
    };
    const ids = Array.from({ length: 100 }, (_, i) => `n${i}`);
    const edges = Array.from({ length: 100 }, () => ({
      source: `n${Math.floor(rand() * 100)}`,
      target: `n${Math.floor(rand() * 100)}`,
    }));
    const out = layoutGraph(ids, edges, { width: 640, height: 420 });
    expect(out.size).toBe(100);
    const xs = [...out.values()].map((p) => p.x);
    const ys = [...out.values()].map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(640 * 0.4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(420 * 0.4);
    for (const p of out.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(640);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(420);
    }
  });
});
