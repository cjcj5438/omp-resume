/** layoutTree 单测：主干同轨、分支递增、边公式、fold 行占位。 */
import { describe, expect, it } from "vitest";
import { foldTree } from "./fold";
import { edgePath, layoutTree, TREE_ROW_H, TREE_X0 } from "./layout";
import { FIXTURE_SESSIONS } from "../dev/fixtures";

describe("layoutTree", () => {
  it("s5 分支树：主干 0 轨，分支递增；边跨轨标记正确", () => {
    const s5 = FIXTURE_SESSIONS[4];
    const rows = foldTree(s5.tree);
    const { points, edges } = layoutTree(rows);
    const byId = new Map(points.map((p) => [p.id, p]));
    // 主干（active 路径）在 0 轨（bx-m1/bx-m2 被折成一行，首节点占位）。
    for (const id of ["bx-r1", "bx-m1", "bx-F", "bx-c1", "bx-c2", "bx-c3", "bx-e1", "bx-L"]) {
      expect(byId.get(id)?.x).toBe(TREE_X0);
    }
    expect(points.find((pt) => pt.id === "bx-m1")?.foldable).toBe(true);
    // d 分支与 e2 分支不在 0 轨，且互不相同（各新开一轨）。
    const d1x = byId.get("bx-d1")?.x ?? 0;
    const e2x = byId.get("bx-e2")?.x ?? 0;
    expect(d1x).toBeGreaterThan(TREE_X0);
    expect(e2x).toBeGreaterThan(TREE_X0);
    // y 按行号递增。
    const ys = points.map((p) => p.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(ys[0]).toBe(TREE_ROW_H);
    // 边：bx-F→bx-d1 跨轨（branch），bx-F→bx-c1 同轨。
    const dEdge = edges.find((e) => e.to === "bx-d1");
    const cEdge = edges.find((e) => e.to === "bx-c1");
    expect(dEdge?.branch).toBe(true);
    expect(cEdge?.branch).toBe(false);
  });

  it("边路径：同轨直线，跨轨 bezier", () => {
    expect(edgePath({ from: "a", to: "b", x1: 96, y1: 100, x2: 96, y2: 120, branch: false })).toBe(
      "M96 100 L96 120",
    );
    expect(edgePath({ from: "a", to: "b", x1: 96, y1: 100, x2: 392, y2: 120, branch: true })).toBe(
      "M96 100 C96 128, 392 92, 392 120",
    );
  });
});
