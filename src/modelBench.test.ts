import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, BenchRound, ModelInfo } from "./types";
import {
  BENCH_BUILTIN_TAGS,
  addToBench,
  removeFromBench,
  classifyBenchError,
  createBenchRunner,
  defaultBenchConfig,
  deriveBenchList,
  deriveTagSet,
  estimateRoundsCost,
  loadBenchConfig,
  recommendChanges,
  saveBenchConfig,
  scoreRows,
  windowStats,
  BENCH_CONFIG_KEY,
  type BenchConfig,
} from "./modelBench";

function round(partial: Partial<BenchRound> & { at: string; selector: string }): BenchRound {
  return {
    total: 8,
    ok: 8,
    ttftP50Ms: 800,
    ttftP95Ms: 1200,
    tpsP50: 30,
    tpsCv: 0.1,
    cost: 0.01,
    errors: [],
    ...partial,
  };
}

const NOW = Date.parse("2026-10-21T00:00:00.000Z");
const hourAgo = (h: number): string => new Date(NOW - h * 3600000).toISOString();

function memStorage(initial?: Record<string, string>): Storage {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("windowStats", () => {
  const SEL = "p/m";
  it("24h 内多轮：成功率累加、延迟取最近一轮", () => {
    const stats = windowStats(
      [
        round({ at: hourAgo(20), selector: SEL, total: 8, ok: 6, tpsP50: 20 }),
        round({ at: hourAgo(1), selector: SEL, total: 8, ok: 8, tpsP50: 40 }),
      ],
      NOW,
    );
    expect(stats).toMatchObject({ rate: 14 / 16, samples: 16, tpsP50: 40, fallback: false });
  });

  it("24h 内无轮次：退化到最近一轮并标记 fallback", () => {
    const stats = windowStats(
      [
        round({ at: hourAgo(50), selector: SEL, total: 8, ok: 8 }),
        round({ at: hourAgo(30), selector: SEL, total: 8, ok: 4, tpsP50: 25 }),
      ],
      NOW,
    );
    expect(stats).toMatchObject({ rate: 0.5, samples: 8, tpsP50: 25, fallback: true });
  });

  it("从没测过返回 null", () => {
    expect(windowStats([], NOW)).toBeNull();
  });
});

describe("scoreRows", () => {
  it("成功率高 + 速度快 + 延迟低者分高；缺项按 0", () => {
    const good = windowStats([round({ at: hourAgo(1), selector: "p/a", tpsP50: 50, ttftP50Ms: 500 })], NOW);
    const bad = windowStats(
      [round({ at: hourAgo(1), selector: "p/b", total: 8, ok: 4, tpsP50: 10, ttftP50Ms: 2000 })],
      NOW,
    );
    const [sa, sb, sn] = scoreRows([good, bad, null]);
    expect(sa).toBeGreaterThan(sb);
    expect(sn).toBe(0);
    expect(sa).toBeLessThanOrEqual(100);
  });
});

describe("recommendChanges", () => {
  const SEL_A = "p/fast";
  const SEL_B = "p/slow";
  const statsOf = (rate: number, samples: number, fallback = false) => ({
    rate,
    samples,
    ttftP50Ms: 500,
    ttftP95Ms: 700,
    tpsP50: 30,
    tpsCv: 0.1,
    cost: 0.01,
    fallback,
  });
  const tags = [{ id: "task", label: "子任务", custom: false, unused: false }];

  it("门槛：24h 样本 ≥5 且成功率 ≥95%，取分最高者", () => {
    const changes = recommendChanges(
      [
        { selector: SEL_A, tags: ["task"], stats: statsOf(1, 16), score: 90 },
        { selector: SEL_B, tags: ["task"], stats: statsOf(1, 16), score: 60 },
      ],
      tags,
      { task: SEL_B },
    );
    expect([...changes]).toEqual([["task", SEL_A]]);
  });

  it("样本不足或成功率不够时不推荐；fallback 样本不认", () => {
    const rows = [
      { selector: SEL_A, tags: ["task"], stats: statsOf(1, 4), score: 90 },
      { selector: SEL_B, tags: ["task"], stats: statsOf(0.9, 16), score: 80 },
    ];
    expect(recommendChanges(rows, tags, { task: "p/other" }).size).toBe(0);
    const fb = [{ selector: SEL_A, tags: ["task"], stats: statsOf(1, 8, true), score: 90 }];
    expect(recommendChanges(fb, tags, { task: "p/other" }).size).toBe(0);
  });

  it("最佳就是当前值时不产生改动；候选包含当前已分配模型", () => {
    const rows = [
      { selector: SEL_A, tags: [], stats: statsOf(1, 16), score: 90 },
      { selector: SEL_B, tags: ["task"], stats: statsOf(1, 16), score: 60 },
    ];
    // 当前值 p/fast 虽然没带 task 标签，仍是候选，且已是最佳 → 无改动。
    expect(recommendChanges(rows, tags, { task: SEL_A }).size).toBe(0);
  });

  it("每个标签独立挑", () => {
    const tags2 = [
      { id: "task", label: "子任务", custom: false, unused: false },
      { id: "smol", label: "轻快", custom: false, unused: false },
    ];
    const changes = recommendChanges(
      [
        { selector: SEL_A, tags: ["task"], stats: statsOf(1, 16), score: 90 },
        { selector: SEL_B, tags: ["smol"], stats: statsOf(1, 16), score: 90 },
      ],
      tags2,
      { task: "p/x", smol: "p/y" },
    );
    expect([...changes]).toEqual([
      ["task", SEL_A],
      ["smol", SEL_B],
    ]);
  });
});

describe("deriveBenchList", () => {
  const cfg = (entries: BenchConfig["entries"], hidden: string[] = []): BenchConfig => ({ entries, customTags: [], intervalMin: 0, hidden });

  it("@别名与逗号列表跳过；角色占用的不可删且带隐式标签", () => {
    const rows = deriveBenchList(
      cfg([{ selector: "p/a", tags: ["task"], monitor: false }]),
      { task: "p/b", smol: "@task", default: "p/c,p/d", plan: 42 },
    );
    expect(rows.map((r) => r.selector).sort()).toEqual(["p/a", "p/b"]);
    const b = rows.find((r) => r.selector === "p/b")!;
    expect(b.tags).toContain("task");
    expect(b.usedByRoles).toEqual(["task"]);
    expect(rows.find((r) => r.selector === "p/a")!.usedByRoles).toEqual([]);
  });

  it("同一模型不同思考强度是两条", () => {
    const rows = deriveBenchList(
      cfg([
        { selector: "p/a:low", tags: [], monitor: false },
        { selector: "p/a:high", tags: [], monitor: false },
      ]),
      {},
    );
    expect(rows.map((r) => r.selector).sort()).toEqual(["p/a:high", "p/a:low"]);
  });

  it("移除：角色占用行记入 hidden 后不再出现，角色语义不变；重新加入恢复原标签", () => {
    const roles = { default: "p/used", task: "p/used2" };
    const base = cfg([{ selector: "p/local", tags: ["smol"], monitor: true }]);
    const withRoles = deriveBenchList(base, roles);
    expect(withRoles.map((r) => r.selector).sort()).toEqual(["p/local", "p/used", "p/used2"]);

    // 移出角色占用行：entries 不动，只加 hidden。
    const removed = removeFromBench(base, "p/used", ["default"]);
    expect(removed.hidden).toEqual(["p/used"]);
    expect(deriveBenchList(removed, roles).map((r) => r.selector).sort()).toEqual(["p/local", "p/used2"]);

    // 重新加入被移除的那行：hidden 清掉，角色语义立刻回来。
    const readded = addToBench(removed, "p/used", []);
    expect(readded.hidden).toEqual([]);
    expect(deriveBenchList(readded, roles).map((r) => r.selector).sort()).toEqual([
      "p/local",
      "p/used",
      "p/used2",
    ]);
    // 加入已有条目：不重复追加，原标签/监控原样保留。
    expect(addToBench(base, "p/local", ["other"]).entries).toEqual(base.entries);
    // 移出非角色占用行：直接删条目，不留 hidden。
    const dropped = removeFromBench(base, "p/local", []);
    expect(dropped).toEqual({ ...base, entries: [] });
  });


  it("能力角色（judge/image 等）整行排除；未知自定义角色按对话角色处理", () => {
    const rows = deriveBenchList(
      cfg([]),
      { judge: "p/j", image: "p/img", myrole: "p/m", task: "p/t" },
    );
    expect(rows.map((r) => r.selector).sort()).toEqual(["p/m", "p/t"]);
    expect(rows.find((r) => r.selector === "p/m")!.tags).toEqual(["myrole"]);
  });
});

describe("deriveTagSet", () => {
  const agents: AgentDefinition[] = [
    { name: "task", description: "", source: "builtin", defaultModel: ["@task"], defaultThinkingLevel: null },
  ];

  it("内置 9 角色 + modelRoles 其他键 + customTags；顺序固定", () => {
    const tags = deriveTagSet(
      { entries: [], customTags: ["test"], intervalMin: 0, hidden: [] },
      { default: "p/a", myrole: "p/b", judge: "p/j", image: "p/img" },
      {},
      agents,
    );
    const ids = tags.map((t) => t.id);
    expect(ids.slice(0, BENCH_BUILTIN_TAGS.length)).toEqual(BENCH_BUILTIN_TAGS);
    expect(ids).toContain("myrole");
    expect(ids).toContain("test");
    expect(ids).not.toContain("judge");
    expect(ids).not.toContain("image");
  });

  it("未使用检测：非内置标签无人引用时标记", () => {
    const tags = deriveTagSet(
      { entries: [], customTags: ["test"], intervalMin: 0, hidden: [] },
      { myrole: "p/b" },
      {},
      agents,
    );
    const byId = new Map(tags.map((t) => [t.id, t]));
    expect(byId.get("test")!.unused).toBe(true);
    expect(byId.get("myrole")!.unused).toBe(true);
    expect(byId.get("task")!.unused).toBe(false);
    // agentOverrides 里以 @名 出现 → 视为使用。
    const tags2 = deriveTagSet(
      { entries: [], customTags: ["test"], intervalMin: 0, hidden: [] },
      { myrole: "p/b" },
      { task: "@myrole" },
      [],
    );
    expect(tags2.find((t) => t.id === "myrole")!.unused).toBe(false);
  });
});

describe("配置读写", () => {
  it("损坏 → 默认值；坏条目只跳过该条", () => {
    expect(loadBenchConfig(memStorage({ [BENCH_CONFIG_KEY]: "{oops" }))).toEqual(defaultBenchConfig());
    expect(loadBenchConfig(memStorage({ [BENCH_CONFIG_KEY]: "[]" }))).toEqual(defaultBenchConfig());
    const mixed = memStorage({
      [BENCH_CONFIG_KEY]: JSON.stringify({
        entries: [
          { selector: "p/a", tags: ["task"], monitor: true },
          { selector: "@bad" },
          "nope",
        ],
        customTags: ["test", "BAD", 42],
        intervalMin: 999,
        // 非字符串 / 非 selector 的 hidden 项被丢弃；旧配置缺 hidden 时回到 []。
        hidden: ["p/b", "@bad", 7],
      }),
    });
    expect(loadBenchConfig(mixed)).toEqual({
      entries: [{ selector: "p/a", tags: ["task"], monitor: true }],
      customTags: ["test"],
      intervalMin: 0,
      hidden: ["p/b"],
    });
    // 旧版本配置没有 hidden 键：读成 []，不因缺字段回到默认值。
    const legacy = memStorage({
      [BENCH_CONFIG_KEY]: JSON.stringify({ entries: [], customTags: [], intervalMin: 30 }),
    });
    expect(loadBenchConfig(legacy)).toEqual({ entries: [], customTags: [], intervalMin: 30, hidden: [] });
  });

  it("写入后可读回", () => {
    const s = memStorage();
    const cfg: BenchConfig = {
      entries: [{ selector: "p/a:high", tags: ["smol"], monitor: true }],
      customTags: ["test"],
      intervalMin: 60,
      hidden: ["p/b"],
    };
    saveBenchConfig(cfg, s);
    expect(loadBenchConfig(s)).toEqual(cfg);
  });
});

describe("classifyBenchError", () => {
  it.each([
    ["超时（6 分钟）", "timeout"],
    ["request timeout", "timeout"],
    ["429 Too Many Requests", "rateLimit"],
    ["rate limit exceeded", "rateLimit"],
    ["403 Forbidden", "auth"],
    ["401 unauthorized", "auth"],
    ["empty response body", "empty"],
    ["返回为空", "empty"],
    ["connection reset", "other"],
  ])("%s → %s", (text, kind) => {
    expect(classifyBenchError(text)).toBe(kind);
  });
});

describe("estimateRoundsCost", () => {
  const models: ModelInfo[] = [
    { selector: "p/a", provider: "p", id: "a", name: "A", thinkingLevels: [], contextWindow: null, maxTokens: null, reasoning: false, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: null, costCacheWrite: null },
    { selector: "p/b", provider: "p", id: "b", name: "B", thinkingLevels: [], contextWindow: null, maxTokens: null, reasoning: false, input: ["text"], costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null },
  ];
  it("单价未知不计入；口径 800 输入 + 2300 输出", () => {
    expect(estimateRoundsCost(["p/a", "p/b"], models)).toBeCloseTo((800 * 1 + 2300 * 4) / 1000000, 10);
  });
});

describe("运行器", () => {
  const okRound = (selector: string): BenchRound =>
    round({ at: hourAgo(0), selector, total: 8, ok: 8 });

  it("同 provider 串行、跨 provider 并行（最多 3 个）、同 selector 去重", async () => {
    let active = 0;
    let maxActive = 0;
    const activeProviders = new Set<string>();
    let providerOverlap = false;
    const resolvers: Record<string, () => void> = {};
    const runFn = vi.fn((selector: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const provider = selector.split("/")[0];
      if (activeProviders.has(provider)) providerOverlap = true;
      activeProviders.add(provider);
      return new Promise<BenchRound>((resolve) => {
        resolvers[selector] = () => {
          active -= 1;
          activeProviders.delete(provider);
          resolve(okRound(selector));
        };
      });
    });
    const runner = createBenchRunner(runFn);
    runner.enqueueMany(["a/1", "a/2", "b/1", "c/1", "a/1"]);
    // 去重：a/1 只跑一次；a/2 被同 provider 挡住，b/1、c/1 立即并行。
    await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(3));
    expect(runner.getSnapshot().running.sort()).toEqual(["a/1", "b/1", "c/1"]);
    expect(runner.getSnapshot().queued).toEqual(["a/2"]);
    expect(providerOverlap).toBe(false);
    // 放行 b/1 → a/2 仍被 a/1 挡住；放行 a/1 → a/2 启动。
    resolvers["b/1"]();
    await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(3));
    expect(runner.getSnapshot().queued).toEqual(["a/2"]);
    resolvers["a/1"]();
    await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(4));
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(providerOverlap).toBe(false);
    for (const sel of ["a/2", "c/1"]) resolvers[sel]();
    await vi.waitFor(() => expect(runner.getSnapshot().completedRuns).toBe(4));
    expect(runner.getSnapshot().running).toEqual([]);
    expect(runner.getSnapshot().queued).toEqual([]);
  });

  it("失败记在该行上，不抛到调用方；成功后清除", async () => {
    const runFn = vi
      .fn()
      .mockRejectedValueOnce({ code: "OMP_FAILED", message: "挂了" })
      .mockResolvedValueOnce(okRound("a/1"));
    const runner = createBenchRunner(runFn);
    runner.enqueue("a/1");
    await vi.waitFor(() => expect(runner.getSnapshot().errors["a/1"]).toBe("挂了"));
    runner.enqueue("a/1");
    await vi.waitFor(() => expect(runner.getSnapshot().completedRuns).toBe(1));
    expect(runner.getSnapshot().errors["a/1"]).toBeUndefined();
  });
});
