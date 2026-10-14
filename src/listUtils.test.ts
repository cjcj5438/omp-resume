/** 列表过滤 / 选择保持 / focus 节流单测。 */
import { describe, expect, it } from "vitest";
import type { ProjectGroup, SessionSummary } from "./types";
import {
  FOCUS_REFRESH_MIN_INTERVAL_MS,
  canFocusRefresh,
  filterGroups,
  retainExisting,
} from "./listUtils";

function s(over: Partial<SessionSummary> & { path: string }): SessionSummary {
  return {
    id: over.path,
    cwd: "/w/p",
    cwdExists: true,
    title: "t",
    createdAt: "2026-10-14T00:00:00.000Z",
    modifiedAt: "2026-10-14T00:00:00.000Z",
    sizeBytes: 1,
    messageCount: 1,
    branchCount: 1,
    inUse: false,
    probeOk: true,
    fork: null,
    formatSupported: true,
    version: 3,
    badLines: 0,
    firstUserMessage: null,
    ...over,
  };
}

const groups: ProjectGroup[] = [
  {
    cwd: "/Users/chenjing/my/omp-resume",
    dirName: "-my-omp-resume",
    sessions: [
      s({ path: "/p/a.jsonl", cwd: "/Users/chenjing/my/omp-resume", title: "🎛️ DEMO: 构建桌面应用" }),
      s({
        path: "/p/b.jsonl",
        cwd: "/Users/chenjing/my/omp-resume",
        title: "修复代理",
        firstUserMessage: "示例代理 407",
      }),
    ],
  },
  {
    cwd: "/Users/chenjing/my/Obsidian-doc",
    dirName: "-my-Obsidian-doc",
    sessions: [
      s({ path: "/p/c.jsonl", cwd: "/Users/chenjing/my/Obsidian-doc", title: "笔记总结" }),
    ],
  },
];

describe("filterGroups", () => {
  it("按标题、cwd、首条用户消息做大小写不敏感子串匹配", () => {
    expect(filterGroups(groups, "ompgui").map((g) => g.cwd)).toEqual([
      "/Users/chenjing/my/omp-resume",
    ]);
    expect(filterGroups(groups, "示例")[0].sessions.map((x) => x.path)).toEqual([
      "/p/b.jsonl",
    ]);
    // cwd 命中（大小写不敏感）
    expect(filterGroups(groups, "obsidian")[0].sessions).toHaveLength(1);
    // 标题命中
    expect(filterGroups(groups, "笔记")[0].sessions[0].path).toBe("/p/c.jsonl");
  });

  it("空查询返回全部；无命中组隐藏", () => {
    expect(filterGroups(groups, "  ")).toBe(groups);
    expect(filterGroups(groups, "不存在的词")).toEqual([]);
  });
});

describe("retainExisting", () => {
  it("跨刷新只保留仍存在的 path", () => {
    const kept = retainExisting(
      ["/p/a.jsonl", "/p/gone.jsonl", "/p/c.jsonl"],
      new Set(["/p/a.jsonl", "/p/c.jsonl"]),
    );
    expect(kept).toEqual(["/p/a.jsonl", "/p/c.jsonl"]);
  });
});

describe("canFocusRefresh", () => {
  it("加载中跳过", () => {
    expect(canFocusRefresh(true, 0, 10_000)).toBe(false);
  });

  it("距上次加载开始不足最小间隔跳过，超过则允许", () => {
    const t0 = 1_000_000;
    expect(canFocusRefresh(false, t0, t0 + FOCUS_REFRESH_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(canFocusRefresh(false, t0, t0 + FOCUS_REFRESH_MIN_INTERVAL_MS)).toBe(true);
    expect(canFocusRefresh(false, t0, t0 + 5_000)).toBe(true);
  });
});
