/** 清理视图纯逻辑单测：占用门禁、选中合计、全选、删除目标。 */
import { describe, expect, it } from "vitest";
import type { CleanupCandidate } from "./types";
import {
  selectionTotals,
  toDeleteTargets,
  toggleAllSelectable,
} from "./cleanup";

function cand(over: Partial<CleanupCandidate> & { path: string }): CleanupCandidate {
  return {
    id: over.path,
    title: over.path,
    cwd: "/w/proj",
    mtime: "2026-10-14T00:00:00.000Z",
    bytes: 100,
    reasons: ["stale"],
    inUse: false,
    probeOk: true,
    ...over,
  };
}

const LIST: CleanupCandidate[] = [
  cand({ path: "/a", bytes: 1000 }),
  cand({ path: "/busy", bytes: 5000, inUse: true }),
  cand({ path: "/unknown", bytes: 7000, probeOk: false }),
  cand({ path: "/b", bytes: 300 }),
];

describe("selectionTotals", () => {
  it("只统计可勾选且被选中的候选，占用中/未知即使在集合里也不计入", () => {
    const checked = new Set(["/a", "/busy", "/unknown", "/b"]);
    expect(selectionTotals(LIST, checked)).toEqual({ count: 2, bytes: 1300 });
  });
});

describe("toggleAllSelectable", () => {
  it("全选只选可勾选项，再次调用清空", () => {
    const all = toggleAllSelectable(LIST, new Set());
    expect([...all].sort()).toEqual(["/a", "/b"]);
    expect(toggleAllSelectable(LIST, all).size).toBe(0);
  });
});

describe("toDeleteTargets", () => {
  it("只输出选中且可删除的目标，体积取总字节，消息数为 null", () => {
    const targets = toDeleteTargets(LIST, new Set(["/a", "/busy"]));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ path: "/a", sizeBytes: 1000, messageCount: null });
  });
});
