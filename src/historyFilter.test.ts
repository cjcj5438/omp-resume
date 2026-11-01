/** 提示词历史项目过滤单测。 */
import { describe, expect, it } from "vitest";
import type { PromptHistoryEntry } from "./types";
import { HISTORY_NO_PROJECT, filterHistoryByProject, historyProjects } from "./historyFilter";

function e(over: Partial<PromptHistoryEntry> & { id: number }): PromptHistoryEntry {
  return { prompt: "p", cwd: "/w/alpha", sessionId: "s", createdAt: "2026-10-16T01:00:00Z", useCount: 1, ...over };
}

describe("historyProjects", () => {
  it("cwd=null 归入 __none__，按计数倒序", () => {
    const entries = [e({ id: 1, cwd: "/w/alpha" }), e({ id: 2, cwd: null }), e({ id: 3, cwd: null }), e({ id: 4, cwd: "/w/beta" })];
    expect(historyProjects(entries)).toEqual([
      { value: HISTORY_NO_PROJECT, label: "未记录目录（2）", count: 2 },
      { value: "/w/alpha", label: "alpha（1）", count: 1 },
      { value: "/w/beta", label: "beta（1）", count: 1 },
    ]);
  });
});

describe("filterHistoryByProject", () => {
  it("all 返回同一引用；其余按值过滤", () => {
    const entries = [e({ id: 1, cwd: "/w/alpha" }), e({ id: 2, cwd: null })];
    expect(filterHistoryByProject(entries, "all")).toBe(entries);
    expect(filterHistoryByProject(entries, "/w/alpha").map((x) => x.id)).toEqual([1]);
    expect(filterHistoryByProject(entries, HISTORY_NO_PROJECT).map((x) => x.id)).toEqual([2]);
  });
});
