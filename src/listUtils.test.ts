/** 列表过滤 / 选择保持 / focus 节流单测。 */
import { describe, expect, it } from "vitest";
import type { ProjectGroup, SessionSummary } from "./types";
import {
  FOCUS_REFRESH_MIN_INTERVAL_MS,
  applyPins,
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
    occupant: null,
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
    expect(filterGroups(groups, "demo").map((g) => g.cwd)).toEqual([
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

describe("applyPins", () => {
  const group = (cwd: string, paths: string[]): ProjectGroup => ({
    cwd,
    dirName: cwd,
    sessions: paths.map((p) => s({ path: p, cwd })),
  });
  const order = (gs: ProjectGroup[]) => gs.map((g) => [g.cwd, ...g.sessions.map((x) => x.path)]);
  const base = [
    group("/w/a", ["/p/a1", "/p/a2"]),
    group("/w/b", ["/p/b1", "/p/b2"]),
    group("/w/c", ["/p/c1", "/p/c2"]),
  ];

  it("置顶项之间保持后端顺序（不按置顶先后排序），其余保持原顺序", () => {
    const out = applyPins(base, { projects: ["/w/c", "/w/a"], sessions: [] });
    expect(out.map((g) => g.cwd)).toEqual(["/w/a", "/w/c", "/w/b"]);
  });

  it("两级排序：会话置顶只在其所属项目组内上浮，不改变项目顺序", () => {
    const out = applyPins(base, { projects: [], sessions: ["/p/b2"] });
    expect(order(out)).toEqual([
      ["/w/a", "/p/a1", "/p/a2"],
      ["/w/b", "/p/b2", "/p/b1"],
      ["/w/c", "/p/c1", "/p/c2"],
    ]);
  });

  it("不修改入参", () => {
    const snapshot = order(base);
    const out = applyPins(base, { projects: ["/w/c"], sessions: ["/p/a2"] });
    expect(out).not.toBe(base);
    expect(order(base)).toEqual(snapshot);
  });

  it("空置顶保持原有顺序", () => {
    expect(applyPins(base, { projects: [], sessions: [] })).toEqual(base);
  });

  it("忽略无对应项的置顶键", () => {
    const out = applyPins(base, { projects: ["/w/none"], sessions: ["/p/none"] });
    expect(out).toEqual(base);
  });
});
