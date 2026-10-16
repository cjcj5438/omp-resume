/** 列表过滤 / 标签过滤 / 选择保持 / focus 节流单测。 */
import { describe, expect, it } from "vitest";
import type { MetaSnapshot, ProjectGroup, SessionSummary } from "./types";
import {
  FOCUS_REFRESH_MIN_INTERVAL_MS,
  applyPins,
  canFocusRefresh,
  collectTagCounts,
  filterByTags,
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

  it("命中别名 / 标签 / 备注；meta 缺失时不影响原有匹配", () => {
    const meta: MetaSnapshot = {
      revision: 1,
      sessions: {
        "/p/a.jsonl": { alias: "我的别名", tags: ["待跟进"], note: null, updatedAt: "t" },
        "/p/c.jsonl": { alias: null, tags: [], note: "上线前复查", updatedAt: "t" },
      },
    };
    // 别名命中（原标题/cwd/首条消息都不含该词）。
    expect(filterGroups(groups, "我的别名", meta)[0].sessions.map((x) => x.path)).toEqual([
      "/p/a.jsonl",
    ]);
    // 标签命中。
    expect(filterGroups(groups, "待跟进", meta)[0].sessions.map((x) => x.path)).toEqual([
      "/p/a.jsonl",
    ]);
    // 备注命中。
    expect(filterGroups(groups, "上线前复查", meta)[0].sessions.map((x) => x.path)).toEqual([
      "/p/c.jsonl",
    ]);
    // meta 缺失时原有匹配不变。
    expect(filterGroups(groups, "demo", null)[0].sessions).toHaveLength(1);
    expect(filterGroups(groups, "demo")[0].sessions).toHaveLength(1);
  });
});

describe("filterByTags", () => {
  const meta: MetaSnapshot = {
    revision: 1,
    sessions: {
      "/p/a.jsonl": { alias: null, tags: ["bug", "高优"], note: null, updatedAt: "t" },
      "/p/b.jsonl": { alias: null, tags: ["bug"], note: null, updatedAt: "t" },
    },
  };

  it("多选为 AND：只保留同时带全部标签的会话", () => {
    const one = filterByTags(groups, ["bug"], meta);
    expect(one.flatMap((g) => g.sessions.map((x) => x.path)).sort()).toEqual([
      "/p/a.jsonl",
      "/p/b.jsonl",
    ]);
    const both = filterByTags(groups, ["bug", "高优"], meta);
    expect(both.flatMap((g) => g.sessions.map((x) => x.path))).toEqual(["/p/a.jsonl"]);
    // 无交集 → 空。
    expect(filterByTags(groups, ["bug", "不存在"], meta)).toEqual([]);
  });

  it("空选中返回原引用；精确匹配（子串不算）", () => {
    expect(filterByTags(groups, [], meta)).toBe(groups);
    expect(filterByTags(groups, ["bu"], meta)).toEqual([]);
  });
});

describe("collectTagCounts", () => {
  it("统计各标签的会话数，按计数倒序、标签名升序", () => {
    const meta: MetaSnapshot = {
      revision: 1,
      sessions: {
        "/p/a.jsonl": { alias: null, tags: ["bug", "高优"], note: null, updatedAt: "t" },
        "/p/b.jsonl": { alias: null, tags: ["bug"], note: null, updatedAt: "t" },
        "/ghost.jsonl": { alias: null, tags: ["孤儿"], note: null, updatedAt: "t" },
      },
    };
    // 孤儿条目（不在列表中）不计入。
    expect(collectTagCounts(groups, meta)).toEqual([
      { tag: "bug", count: 2 },
      { tag: "高优", count: 1 },
    ]);
    expect(collectTagCounts(groups, null)).toEqual([]);
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
