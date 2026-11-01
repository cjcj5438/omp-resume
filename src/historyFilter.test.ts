/** 提示词历史项目过滤单测。 */
import { describe, expect, it } from "vitest";
import type { PromptHistoryEntry } from "./types";
import { HISTORY_NO_PROJECT, filterHistoryByProject, formatHistoryTime, historyProjects } from "./historyFilter";

function e(over: Partial<PromptHistoryEntry> & { id: number }): PromptHistoryEntry {
  return { prompt: "p", cwd: "/w/alpha", sessionId: "s", createdAt: "2026-10-16T01:00:00Z", useCount: 1, sessionTitle: null, ...over };
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

describe("formatHistoryTime", () => {
  // 2026-10-16 15:04 本地（月份/日期边界用本地构造，避免 TZ 漂移）。
  const now = new Date(2026, 9, 16, 18, 30).getTime();
  const iso = (y: number, m: number, d: number, h: number, min: number): string =>
    new Date(y, m, d, h, min).toISOString();
  it("今天 HH:MM / 昨天 HH:MM / 更早 M月d日", () => {
    expect(formatHistoryTime(iso(2026, 9, 16, 15, 4), now)).toBe("15:04");
    expect(formatHistoryTime(iso(2026, 9, 15, 9, 7), now)).toBe("昨天 09:07");
    expect(formatHistoryTime(iso(2026, 8, 28, 9, 7), now)).toBe("9月28日");
    expect(formatHistoryTime(iso(2025, 11, 31, 23, 59), now)).toBe("12月31日");
  });
  it("无效时间返回空串", () => {
    expect(formatHistoryTime("not-a-time", now)).toBe("");
  });
});
