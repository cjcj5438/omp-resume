import { expect, it } from "vitest";
import {
  barHeights,
  cacheHitRate,
  compactNumber,
  formatDuration,
  formatHitRate,
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
