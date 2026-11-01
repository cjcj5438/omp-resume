import { describe, expect, it } from "vitest";
import {
  ERROR_KIND_NAME,
  activitySummary,
  barHeights,
  cacheHitRate,
  cacheHitSeries,
  compactNumber,
  formatDuration,
  formatErrorRate,
  formatHitRate,
  formatMaxDuration,
  prevDelta,
  sparseIndexes,
  tickLabel,
} from "./usageFormat";

it("命中率 null 显示“—”，数值保留一位小数", () => {
  expect(formatHitRate(null)).toBe("—");
  expect(formatHitRate(Number.NaN)).toBe("—");
  expect(formatHitRate(0)).toBe("0.0%");
  expect(formatHitRate(0.625)).toBe("62.5%");
  expect(formatHitRate(1)).toBe("100.0%");
});

it("错误率无请求时显示“—”", () => {
  expect(formatErrorRate(0, 0)).toBe("—");
  expect(formatErrorRate(3, 0)).toBe("—");
  expect(formatErrorRate(1, 200)).toBe("0.5%");
});

it("ErrorKind 七种中文映射齐全", () => {
  expect(ERROR_KIND_NAME).toEqual({
    quota: "额度用尽",
    rate_limit: "触发限流",
    auth: "鉴权失败",
    timeout: "响应超时",
    network: "网络异常",
    server: "服务端错误",
    other: "其他",
  });
});

it("分桶标签：小时取 HH:00，日期去前导零", () => {
  expect(tickLabel("2026-10-19 08", "hour")).toBe("08:00");
  expect(tickLabel("2026-10-19 23", "hour")).toBe("23:00");
  expect(tickLabel("2026-10-19", "day")).toBe("10-19");
  expect(tickLabel("2026-01-05", "day")).toBe("1-5");
});

it("稀疏下标恒含首尾且不超限", () => {
  expect(sparseIndexes(0)).toEqual([]);
  expect(sparseIndexes(3)).toEqual([0, 1, 2]);
  const idx = sparseIndexes(30);
  expect(idx.length).toBeLessThanOrEqual(6);
  expect(idx[0]).toBe(0);
  expect(idx[idx.length - 1]).toBe(29);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  const day = sparseIndexes(24);
  expect(day[0]).toBe(0);
  expect(day[day.length - 1]).toBe(23);
});

it("柱高按最大值归一，非零至少 2px，零保持 0", () => {
  expect(barHeights([0, 0], 100)).toEqual([0, 0]);
  expect(barHeights([], 100)).toEqual([]);
  expect(barHeights([5, 10], 100)).toEqual([50, 100]);
  expect(barHeights([0.01, 100], 100)).toEqual([2, 100]);
  expect(barHeights([3, 6], 0)).toEqual([0, 0]);
});

it("缓存命中序列：无 token 的桶为 null，比例钳制 0..1", () => {
  expect(
    cacheHitSeries([
      { cacheRead: 0, promptTokens: 0 },
      { cacheRead: 60, promptTokens: 100 },
      { cacheRead: 0, promptTokens: 50 },
      { cacheRead: 200, promptTokens: 100 },
    ]),
  ).toEqual([null, 0.6, 0, 1]);
});

it("时长：59s / 15m31s / 1h1m", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(59400)).toBe("59s");
  expect(formatDuration(931000)).toBe("15m31s");
  expect(formatDuration(3660000)).toBe("1h1m");
});

it("紧凑数字：k/M/B 一位小数", () => {
  expect(compactNumber(999)).toBe("999");
  expect(compactNumber(1234)).toBe("1.2k");
  expect(compactNumber(5400000)).toBe("5.4M");
  expect(compactNumber(2.5e9)).toBe("2.5B");
});

it("缓存命中率：无缓存数据时 null", () => {
  expect(cacheHitRate({ input: 50, output: 0, cacheRead: 40, cacheWrite: 10, total: 100 })).toBe(0.4);
  expect(cacheHitRate({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0, total: 60 })).toBeNull();
  expect(cacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })).toBeNull();
});

it("较上一周期涨跌：prev≤0 或缺省为 null", () => {
  expect(prevDelta(110, 100)).toBeCloseTo(0.1, 10);
  expect(prevDelta(90, 100)).toBeCloseTo(-0.1, 10);
  expect(prevDelta(5, 0)).toBeNull();
  expect(prevDelta(null, 100)).toBeNull();
  expect(prevDelta(5, null)).toBeNull();
  expect(prevDelta(5, undefined)).toBeNull();
});

it("最长单次：59s / 16m12s / 1h1m（整分不补零）", () => {
  expect(formatMaxDuration(null)).toBe("—");
  expect(formatMaxDuration(-5)).toBe("—");
  expect(formatMaxDuration(59000)).toBe("59s");
  expect(formatMaxDuration(972000)).toBe("16m12s");
  expect(formatMaxDuration(3660000)).toBe("1h1m");
  expect(formatMaxDuration(3600000)).toBe("1h");
});

it("活跃度汇总：活跃天数、合计、最高单日（同价取最早）、末尾连续、最长连续", () => {
  expect(activitySummary([])).toEqual({ activeDays: 0, totalCost: 0, best: null, streak: 0, longest: 0 });
  expect(
    activitySummary(["2026-01-01", "2026-01-02", "2026-01-03"].map((key) => ({ key, cost: 0 }))),
  ).toEqual({ activeDays: 0, totalCost: 0, best: null, streak: 0, longest: 0 });
  const days = [10, 0, 5, 7].map((cost, i) => ({ key: `2026-01-0${i + 1}`, cost }));
  const sum = activitySummary(days);
  expect(sum.activeDays).toBe(3);
  expect(sum.totalCost).toBe(22);
  // 最高单日只看花费；末尾 5、7 连续 ⇒ streak 2（中间那天的 0 是断点但不影响末尾）。
  expect(sum.best).toEqual({ key: "2026-01-01", cost: 10 });
  expect(sum.streak).toBe(2);
  expect(sum.longest).toBe(2);
  // 同价取最早。
  expect(activitySummary([{ key: "a", cost: 3 }, { key: "b", cost: 3 }]).best).toEqual({ key: "a", cost: 3 });
  expect(activitySummary([{ key: "a", cost: 3 }, { key: "b", cost: 3 }]).longest).toBe(2);
});

describe("heatDayDetail", () => {
  it("delta = (当日 − 前 7 条目均值) / 均值；不足 7 条用实有条目", async () => {
    const { heatDayDetail } = await import("./usageFormat");
    const days = [10, 10, 10, 10, 10, 10, 10, 20].map((cost, i) => ({
      key: `2026-01-0${i + 1}`,
      cost,
      tokens: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    }));
    const d = heatDayDetail(days, "2026-01-08");
    expect(d?.weekday).toBe("周四");
    expect(d?.costDelta).toBeCloseTo(1, 5);
    expect(d?.tokensDelta).toBeCloseTo(1, 5);
    // 前序只有 2 条：均值 10，当日 5 → −50%。
    const short = heatDayDetail(days.slice(0, 3).map((x, i) => (i === 2 ? { ...x, cost: 5, tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 } } : x)), "2026-01-03");
    expect(short?.costDelta).toBeCloseTo(-0.5, 5);
  });

  it("均值为 0 或无前序条目时 delta 为 null；key 不存在返回 null", async () => {
    const { heatDayDetail } = await import("./usageFormat");
    const days = [0, 0, 5].map((cost, i) => ({
      key: `2026-02-0${i + 1}`,
      cost,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }));
    expect(heatDayDetail(days, "2026-02-03")?.costDelta).toBeNull();
    expect(heatDayDetail(days, "2026-02-01")?.costDelta).toBeNull();
    expect(heatDayDetail(days, "2026-03-01")).toBeNull();
  });

  it("请求数与主要项目透传；请求 delta 同口径", async () => {
    const { heatDayDetail } = await import("./usageFormat");
    const mk = (key: string, requests: number, top: string | null) => ({
      key,
      cost: requests,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      requests,
      topProject: top,
    });
    const days = [mk("2026-03-01", 10, "/a"), mk("2026-03-02", 10, "/a"), mk("2026-03-03", 20, "/b")];
    const d = heatDayDetail(days, "2026-03-03");
    expect(d?.requests).toBe(20);
    expect(d?.topProject).toBe("/b");
    expect(d?.requestsDelta).toBeCloseTo(1, 5);
    // 缺字段的旧 trend 点：按 0/null 处理。
    const legacy = heatDayDetail([{ key: "2026-03-01", cost: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }], "2026-03-01");
    expect(legacy?.requests).toBe(0);
    expect(legacy?.topProject).toBeNull();
  });
});

describe("usageSummaryText", () => {
  it("前 3 项目按花费排序；各行格式固定", async () => {
    const { usageSummaryText } = await import("./usageFormat");
    const { mockUsageStats } = await import("../dev/usageMock");
    const stats = mockUsageStats("30d");
    const text = usageSummaryText(stats, "近 30 天");
    const lines = text.split("\n");
    expect(lines[0]).toBe("omp 用量（近 30 天）");
    expect(lines[1]).toMatch(/^会话 .* · 项目 .*$/);
    expect(lines[2]).toMatch(/^费用 .*（主对话 .* · 后台 .* · 子代理 .*）$/);
    expect(lines[4]).toMatch(/^缓存命中 /);
    expect(lines[5]).toMatch(/^工具调用 .* · 活跃时长 /);
    // 花费最高项目行：按 cost 倒序取前 3。
    const expected = [...stats.byProject]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 3)
      .map((p) => p.cwd.split("/").filter(Boolean).pop() ?? p.cwd);
    expect(lines[6].startsWith("花费最高项目：")).toBe(true);
    let last = -1;
    for (const name of expected) {
      const at = lines[6].indexOf(name, last + 1);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });
});
