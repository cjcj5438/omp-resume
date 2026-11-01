/** 列表过滤 / 标签过滤 / 置顶拆分 / 三态勾选 / 选择保持 / focus 节流单测。 */
import { describe, expect, it } from "vitest";
import type { MetaSnapshot, ProjectGroup, SessionSummary } from "./types";
import {
  FOCUS_REFRESH_MIN_INTERVAL_MS,
  applyPins,
  canFocusRefresh,
  collectTagCounts,
  checkState,
  filterByTags,
  filterGroups,
  filterSessions,
  filterSessionsByTags,
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
    cwd: "/Users/demo/my/omp-resume",
    dirName: "-my-omp-resume",
    sessions: [
      s({ path: "/p/a.jsonl", cwd: "/Users/demo/my/omp-resume", title: "🎛️ DEMO: 构建桌面应用" }),
      s({
        path: "/p/b.jsonl",
        cwd: "/Users/demo/my/omp-resume",
        title: "修复代理",
        firstUserMessage: "示例代理 407",
      }),
    ],
  },
  {
    cwd: "/Users/demo/my/notes-app",
    dirName: "-my-notes-app",
    sessions: [
      s({ path: "/p/c.jsonl", cwd: "/Users/demo/my/notes-app", title: "笔记总结" }),
    ],
  },
];

describe("filterGroups", () => {
  it("按标题、cwd、首条用户消息做大小写不敏感子串匹配", () => {
    expect(filterGroups(groups, "demo:").map((g) => g.cwd)).toEqual([
      "/Users/demo/my/omp-resume",
    ]);
    expect(filterGroups(groups, "示例")[0].sessions.map((x) => x.path)).toEqual([
      "/p/b.jsonl",
    ]);
    // cwd 命中（大小写不敏感）
    expect(filterGroups(groups, "notes")[0].sessions).toHaveLength(1);
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
    expect(filterGroups(groups, "demo:", null)[0].sessions).toHaveLength(1);
    expect(filterGroups(groups, "demo:")[0].sessions).toHaveLength(1);
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
  const group = (cwd: string, paths: string[], minute = 0): ProjectGroup => ({
    cwd,
    dirName: cwd,
    sessions: paths.map((p, i) =>
      s({ path: p, id: p, cwd, modifiedAt: `2026-10-14T00:0${minute}:0${i}.000Z` }),
    ),
  });
  const order = (gs: ProjectGroup[]) => gs.map((g) => [g.cwd, ...g.sessions.map((x) => x.path)]);
  const base = [
    group("/w/a", ["/p/a1", "/p/a2"], 1),
    group("/w/b", ["/p/b1", "/p/b2"], 2),
    group("/w/c", ["/p/c1", "/p/c2"], 3),
  ];

  it("项目置顶上浮；置顶之间保持后端顺序，其余保持原顺序", () => {
    const out = applyPins(base, { projects: ["/w/c", "/w/a"], sessions: [] });
    expect(out.groups.map((g) => g.cwd)).toEqual(["/w/a", "/w/c", "/w/b"]);
    expect(out.pinnedSessions).toEqual([]);
  });

  it("会话置顶跨项目聚合，并从原组移出（不出现两次）", () => {
    const out = applyPins(base, { projects: [], sessions: ["/p/a2", "/p/c1"] });
    expect(order(out.groups)).toEqual([
      ["/w/a", "/p/a1"],
      ["/w/b", "/p/b1", "/p/b2"],
      ["/w/c", "/p/c2"],
    ]);
    expect(out.pinnedSessions.map((x) => x.path)).toEqual(["/p/c1", "/p/a2"]);
  });

  it("置顶区按修改时间新→旧，与置顶先后无关", () => {
    const out = applyPins(base, { projects: [], sessions: ["/p/a1", "/p/c2", "/p/b2"] });
    expect(out.pinnedSessions.map((x) => x.path)).toEqual(["/p/c2", "/p/b2", "/p/a1"]);
  });

  it("会话全部置顶后保留空组壳（组头入口不丢）", () => {
    const out = applyPins(base, { projects: [], sessions: ["/p/b1", "/p/b2"] });
    expect(out.groups.map((g) => [g.cwd, g.sessions.length])).toEqual([
      ["/w/a", 2],
      ["/w/b", 0],
      ["/w/c", 2],
    ]);
  });

  it("不修改入参", () => {
    const snapshot = order(base);
    const out = applyPins(base, { projects: ["/w/c"], sessions: ["/p/a2"] });
    expect(out.groups).not.toBe(base);
    expect(order(base)).toEqual(snapshot);
  });

  it("空置顶保持原有顺序", () => {
    expect(applyPins(base, { projects: [], sessions: [] }).groups).toEqual(base);
  });

  it("忽略无对应项的置顶键", () => {
    const out = applyPins(base, { projects: ["/w/none"], sessions: ["/p/none"] });
    expect(out.groups).toEqual(base);
    expect(out.pinnedSessions).toEqual([]);
  });
});

describe("checkState", () => {
  it("全选 / 部分 / 无三态，组外路径不影响", () => {
    const checks = new Set(["/p/a1", "/p/other"]);
    expect(checkState(["/p/a1", "/p/a2"], checks)).toBe("some");
    expect(checkState(["/p/a1"], checks)).toBe("all");
    expect(checkState(["/p/a2"], checks)).toBe("none");
    expect(checkState([], checks)).toBe("none");
  });
});

describe("置顶区的会话级过滤", () => {
  const pinned = [
    s({ path: "/p/a1", id: "a1", title: "构建桌面应用", cwd: "/w/a" }),
    s({ path: "/p/c1", id: "c1", title: "笔记总结", cwd: "/w/c" }),
  ];

  it("文本过滤与分组同一口径（标题 / cwd / 首条用户消息 / 别名）", () => {
    expect(filterSessions(pinned, "", null)).toBe(pinned);
    expect(filterSessions(pinned, "构建", null).map((x) => x.path)).toEqual(["/p/a1"]);
    expect(filterSessions(pinned, "w/c", null).map((x) => x.path)).toEqual(["/p/c1"]);
    const meta: MetaSnapshot = {
      revision: 1,
      sessions: { c1: { alias: "周报素材", tags: ["文档"], note: null, updatedAt: "" } },
    };
    expect(filterSessions(pinned, "周报", meta).map((x) => x.path)).toEqual(["/p/c1"]);
  });

  it("标签过滤：多选为 AND，空选中返回同一引用", () => {
    const meta: MetaSnapshot = {
      revision: 1,
      sessions: {
        a1: { alias: null, tags: ["bug", "高优"], note: null, updatedAt: "" },
        c1: { alias: null, tags: ["文档"], note: null, updatedAt: "" },
      },
    };
    expect(filterSessionsByTags(pinned, [], meta)).toBe(pinned);
    expect(filterSessionsByTags(pinned, ["bug"], meta).map((x) => x.path)).toEqual(["/p/a1"]);
    expect(filterSessionsByTags(pinned, ["bug", "文档"], meta)).toEqual([]);
  });
});

describe("sessionIssues", () => {
  it("四种来源依次检出", async () => {
    const { sessionIssues } = await import("./listUtils");
    expect(sessionIssues(s({ path: "/p/ok.jsonl" }))).toEqual([]);
    expect(sessionIssues(s({ path: "/p/a.jsonl", formatSupported: false })).map((i) => i.code)).toEqual([
      "format",
    ]);
    expect(sessionIssues(s({ path: "/p/b.jsonl", cwdExists: false })).map((i) => i.code)).toEqual(["cwd"]);
    const bad = sessionIssues(s({ path: "/p/c.jsonl", badLines: 7 }));
    expect(bad.map((i) => i.code)).toEqual(["badLines"]);
    expect(bad[0].label).toBe("7 行损坏");
    expect(sessionIssues(s({ path: "/p/d.jsonl", probeOk: false })).map((i) => i.code)).toEqual(["probe"]);
    // 多问题按 format → cwd → badLines → probe 顺序。
    const multi = sessionIssues(
      s({ path: "/p/e.jsonl", formatSupported: false, cwdExists: false, badLines: 2, probeOk: false }),
    );
    expect(multi.map((i) => i.code)).toEqual(["format", "cwd", "badLines", "probe"]);
  });
});

describe("filterGroupsByStatus", () => {
  it("all 返回同一引用；pinned 保留置顶会话与整组置顶项目；非 all 丢弃空组", async () => {
    const { filterGroupsByStatus } = await import("./listUtils");
    const gs: ProjectGroup[] = [
      {
        cwd: "/w/p1",
        dirName: "p1",
        sessions: [
          s({ path: "/p/run.jsonl", cwd: "/w/p1", inUse: true }),
          s({ path: "/p/idle.jsonl", cwd: "/w/p1" }),
        ],
      },
      {
        cwd: "/w/p2",
        dirName: "p2",
        sessions: [s({ path: "/p/other.jsonl", cwd: "/w/p2" })],
      },
    ];
    const pins = { projects: ["/w/p2"], sessions: ["/p/idle.jsonl"] };
    expect(filterGroupsByStatus(gs, "all", pins)).toBe(gs);

    const running = filterGroupsByStatus(gs, "running", pins);
    expect(running).toHaveLength(1);
    expect(running[0].sessions.map((x) => x.path)).toEqual(["/p/run.jsonl"]);

    const pinned = filterGroupsByStatus(gs, "pinned", pins);
    // p1 只留被置顶的 idle；p2 整组保留。
    expect(pinned).toHaveLength(2);
    expect(pinned[0].sessions.map((x) => x.path)).toEqual(["/p/idle.jsonl"]);
    expect(pinned[1]).toBe(gs[1]);
  });

  it("issues 只留有问题的会话", async () => {
    const { filterGroupsByStatus } = await import("./listUtils");
    const gs: ProjectGroup[] = [
      {
        cwd: "/w/p",
        dirName: "p",
        sessions: [
          s({ path: "/p/ok.jsonl", cwd: "/w/p" }),
          s({ path: "/p/bad.jsonl", cwd: "/w/p", badLines: 3 }),
        ],
      },
    ];
    const out = filterGroupsByStatus(gs, "issues", { projects: [], sessions: [] });
    expect(out).toHaveLength(1);
    expect(out[0].sessions.map((x) => x.path)).toEqual(["/p/bad.jsonl"]);
  });
});

describe("filterSessionsByStatus / statusCounts", () => {
  it("pinned 原样返回；counts 在全量上计数", async () => {
    const { filterSessionsByStatus, statusCounts } = await import("./listUtils");
    const sessions = [
      s({ path: "/p/a.jsonl", inUse: true }),
      s({ path: "/p/b.jsonl", badLines: 1 }),
      s({ path: "/p/c.jsonl" }),
    ];
    const pins = { projects: [], sessions: ["/p/c.jsonl"] };
    expect(filterSessionsByStatus(sessions, "pinned", pins)).toBe(sessions);
    expect(filterSessionsByStatus(sessions, "running", pins).map((x) => x.path)).toEqual(["/p/a.jsonl"]);
    const gs: ProjectGroup[] = [{ cwd: "/w/p", dirName: "p", sessions }];
    expect(statusCounts(gs, pins)).toEqual({ all: 3, running: 1, pinned: 1, issues: 1 });
  });
});
