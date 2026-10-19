import { expect, it } from "vitest";
import {
  ERROR_KIND_NAME,
  barHeights,
  cacheHitSeries,
  formatClock,
  formatErrorRate,
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
