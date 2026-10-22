import { expect, it } from "vitest";
import {
  ERROR_KIND_NAME,
  barHeights,
  cacheHitRate,
  cacheHitSeries,
  compactNumber,
  formatClock,
  formatDuration,
  formatErrorRate,
  formatHitRate,
  heatGrid,
  heatLevels,
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

it("时钟用本地 M月D日 HH:MM", () => {
  expect(formatClock(new Date(2026, 9, 19, 8, 5).getTime())).toBe("10月19日 08:05");
  expect(formatClock(new Date(2026, 0, 3, 23, 59).getTime())).toBe("1月3日 23:59");
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

it("热力等级按非零秩分四档", () => {
  expect(heatLevels([0, 5, 1, 3, 9])).toEqual([0, 3, 1, 2, 4]);
  expect(heatLevels([0, 0])).toEqual([0, 0]);
  expect(heatLevels([7])).toEqual([4]);
});

it("热力列：周一为行 0，首尾补 null 至整列", () => {
  const days = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(2026, 9, 14 + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { key, cost: 1, tokens: 10, level: 1 };
  });
  const cols = heatGrid(days);
  expect(cols).toHaveLength(2);
  expect(cols[0][0]).toBeNull();
  expect(cols[0][1]).toBeNull();
  expect(cols[0][2]?.key).toBe("2026-10-14");
  expect(cols[1][0]?.key).toBe("2026-10-19");
  expect(cols[1][1]?.key).toBe("2026-10-20");
  expect(cols[1][2]?.key).toBe("2026-10-21");
  expect(cols[1].slice(3)).toEqual([null, null, null, null]);
});
