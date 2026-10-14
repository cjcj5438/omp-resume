/**
 * foldTree 折叠规则单测：线性链、分叉、嵌套分叉、多根、
 * label/compaction/leaf 打断折叠、active 优先排序、展开/收起。
 */
import { describe, expect, it } from "vitest";
import type { TreeData, TreeNode } from "../types";
import { flattenRows, foldTree, type DisplayRow } from "./fold";

function n(
  id: string,
  parentId: string | null,
  childIds: string[],
  over: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    parentId,
    childIds,
    kind: "message",
    role: "user",
    timestamp: "2026-10-14T00:00:00.000Z",
    preview: `p-${id}`,
    label: null,
    isCompaction: false,
    isBranchSummary: false,
    ...over,
  };
}

function t(
  nodes: TreeNode[],
  rootIds: string[],
  activePathIds: string[],
  leafId: string | null,
): TreeData {
  return { path: "/s/x.jsonl", leafId, rootIds, activePathIds, nodes };
}

const kinds = (rows: DisplayRow[]): string[] =>
  rows.map((r) => (r.type === "fold" ? `fold(${r.nodes.map((x) => x.id).join(",")})` : r.node.id));

describe("foldTree：线性链", () => {
  it("中间的最长线性链折成一行，根/叶保持独立", () => {
    const tree = t(
      [
        n("a", null, ["b"]),
        n("b", "a", ["c"]),
        n("c", "b", ["d"]),
        n("d", "c", []),
      ],
      ["a"],
      ["d", "c", "b", "a"],
      "d",
    );
    expect(kinds(foldTree(tree))).toEqual(["a", "fold(b,c)", "d"]);
  });

  it("单个不可成段的节点不折叠（长度 1）", () => {
    const tree = t(
      [n("a", null, ["b"]), n("b", "a", ["c"]), n("c", "b", [])],
      ["a"],
      ["c", "b", "a"],
      "c",
    );
    expect(kinds(foldTree(tree))).toEqual(["a", "b", "c"]);
  });

  it("空树返回空", () => {
    expect(foldTree(t([], [], [], null))).toEqual([]);
  });
});

describe("foldTree：分叉与嵌套分叉", () => {
  it("分叉点独立成行，两支各自折叠", () => {
    // a → F(分叉) → [c1→c2→c3→L | d1→d2→d3→leaf2]
    const tree = t(
      [
        n("a", null, ["F"]),
        n("F", "a", ["c1", "d1"]),
        n("c1", "F", ["c2"]),
        n("c2", "c1", ["c3"]),
        n("c3", "c2", ["L"]),
        n("L", "c3", []),
        n("d1", "F", ["d2"]),
        n("d2", "d1", ["d3"]),
        n("d3", "d2", ["leaf2"]),
        n("leaf2", "d3", []),
      ],
      ["a"],
      ["L", "c3", "c2", "c1", "F", "a"],
      "L",
    );
    expect(kinds(foldTree(tree))).toEqual([
      "a",
      "F",
      "fold(c1,c2,c3)",
      "L",
      "fold(d1,d2,d3)",
      "leaf2",
    ]);
  });

  it("嵌套分叉：内层分叉打断外层折叠段", () => {
    // r → x1 → X(分叉) → [y1→y2 | z1]
    const tree = t(
      [
        n("r", null, ["x1"]),
        n("x1", "r", ["X"]),
        n("X", "x1", ["y1", "z1"]),
        n("y1", "X", ["y2"]),
        n("y2", "y1", []),
        n("z1", "X", []),
      ],
      ["r"],
      ["y2", "y1", "X", "x1", "r"],
      "y2",
    );
    expect(kinds(foldTree(tree))).toEqual(["r", "x1", "X", "y1", "y2", "z1"]);
  });

  it("多个根都输出，长链各自折叠", () => {
    const tree = t(
      [
        n("r1", null, ["m1"]),
        n("m1", "r1", ["m2"]),
        n("m2", "m1", ["e1"]),
        n("e1", "m2", []),
        n("r2", null, ["e2"]),
        n("e2", "r2", []),
      ],
      ["r1", "r2"],
      ["e1", "m2", "m1", "r1"],
      "e1",
    );
    expect(kinds(foldTree(tree))).toEqual([
      "r1",
      "fold(m1,m2)",
      "e1",
      "r2",
      "e2",
    ]);
  });
});

describe("foldTree：有趣节点打断折叠", () => {
  it("label 节点不进折叠段", () => {
    const tree = t(
      [
        n("a", null, ["b"]),
        n("b", "a", ["c"], { label: "重要" }),
        n("c", "b", ["d"]),
        n("d", "c", []),
      ],
      ["a"],
      ["d", "c", "b", "a"],
      "d",
    );
    expect(kinds(foldTree(tree))).toEqual(["a", "b", "c", "d"]);
  });

  it("compaction / branchSummary 自成一行", () => {
    const tree = t(
      [
        n("a", null, ["k1"]),
        n("k1", "a", ["k2"], { kind: "compaction", isCompaction: true, role: null }),
        n("k2", "k1", ["k3"], { kind: "branchSummary", isBranchSummary: true, role: null }),
        n("k3", "k2", []),
      ],
      ["a"],
      ["k3", "k2", "k1", "a"],
      "k3",
    );
    expect(kinds(foldTree(tree))).toEqual(["a", "k1", "k2", "k3"]);
  });

  it("leafId 节点即使 plain 也不折叠（leaf 非文件末顺序）", () => {
    // 文件顺序里 d 在 e 之前，但 leafId 指向 c
    const tree = t(
      [
        n("a", null, ["b"]),
        n("b", "a", ["c"]),
        n("c", "b", ["d"]),
        n("d", "c", ["e"]),
        n("e", "d", []),
      ],
      ["a"],
      ["c", "b", "a"],
      "c",
    );
    expect(kinds(foldTree(tree))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("根节点从不折叠，即便它只有一个孩子", () => {
    const tree = t(
      [n("r", null, ["x"]), n("x", "r", ["y"]), n("y", "x", ["z"]), n("z", "y", [])],
      ["r"],
      ["z", "y", "x", "r"],
      "z",
    );
    expect(kinds(foldTree(tree))).toEqual(["r", "fold(x,y)", "z"]);
  });
});

describe("foldTree：子节点顺序与标记", () => {
  it("active 路径上的孩子排最前，其余保持原序", () => {
    const tree = t(
      [
        n("F", null, ["x", "y", "z"]),
        n("x", "F", []),
        n("y", "F", []),
        n("z", "F", []),
      ],
      ["F"],
      ["y", "F"],
      "y",
    );
    expect(kinds(foldTree(tree))).toEqual(["F", "y", "x", "z"]);
  });

  it("onActivePath / isLeaf / depth 标记正确", () => {
    const tree = t(
      [n("a", null, ["b"]), n("b", "a", ["c"]), n("c", "b", ["d"]), n("d", "c", [])],
      ["a"],
      ["d", "c", "b", "a"],
      "d",
    );
    const rows = foldTree(tree);
    const a = rows[0];
    expect(a.type).toBe("node");
    if (a.type === "node") {
      expect(a.onActivePath).toBe(true);
      expect(a.isLeaf).toBe(false);
      expect(a.depth).toBe(0);
    }
    const fold = rows[1];
    expect(fold.type).toBe("fold");
    if (fold.type === "fold") {
      expect(fold.depth).toBe(1);
      expect(fold.parentId).toBe("a");
      expect(fold.onActivePath).toBe(true);
    }
    const d = rows[2];
    if (d.type === "node") expect(d.isLeaf).toBe(true);
  });
});

describe("flattenRows：展开/收起", () => {
  const tree = t(
    [
      n("a", null, ["b"]),
      n("b", "a", ["c"]),
      n("c", "b", ["d"]),
      n("d", "c", []),
    ],
    ["a"],
    ["d", "c", "b", "a"],
    "d",
  );
  const rows = foldTree(tree);

  it("展开折叠行显示其中各节点，折叠头保留为收起开关", () => {
    expect(kinds(flattenRows(rows, new Set()))).toEqual(["a", "fold(b,c)", "d"]);
    expect(kinds(flattenRows(rows, new Set(["fold:b"])))).toEqual([
      "a",
      "fold(b,c)",
      "b",
      "c",
      "d",
    ]);
    // 收起后回到折叠行
    expect(kinds(flattenRows(rows, new Set()))).toEqual(["a", "fold(b,c)", "d"]);
  });
});
