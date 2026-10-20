/** 记忆增长图：堆叠高度、稀疏横轴、空数据。 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MemoryGrowthPoint } from "../types";
import { MemoryGrowthChart } from "./MemoryGrowthChart";

function heightsOf(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll("rect"), (r) => Number(r.getAttribute("height")));
}

describe("MemoryGrowthChart", () => {
  it("工作与情节按当日总量堆叠，段高按比例分配", () => {
    const points: MemoryGrowthPoint[] = [
      { date: "2026-10-01", working: 2, episodic: 1 },
      { date: "2026-10-02", working: 0, episodic: 4 },
      { date: "2026-10-03", working: 0, episodic: 0 },
    ];
    const { container } = render(<MemoryGrowthChart points={points} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "记忆增长：3 天，新增工作记忆 2 条、情节摘要 5 条",
    );
    expect(heightsOf(container)).toEqual([70, 35, 140]);
    const rects = container.querySelectorAll("rect");
    expect(rects[0]).toHaveClass("chart-bar");
    expect(rects[1]).toHaveClass("chart-bar-episodic");
    expect(rects[2]).toHaveClass("chart-bar-episodic");
    expect(rects[1].querySelector("title")?.textContent).toBe(
      "2026-10-01：工作记忆 2 条 · 情节摘要 1 条",
    );
  });

  it("密集日期只标注稀疏刻度，数据表保留每一天", () => {
    const points: MemoryGrowthPoint[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      working: i === 29 ? 1 : 0,
      episodic: 0,
    }));
    const { container } = render(<MemoryGrowthChart points={points} />);
    expect(container.querySelectorAll("svg > g:not([aria-hidden])").length).toBe(30);
    const ticks = Array.from(container.querySelectorAll(".chart-tick"), (t) => t.textContent);
    expect(ticks.length).toBe(6);
    expect(ticks[0]).toBe("9-1");
    expect(ticks[ticks.length - 1]).toBe("9-30");
    expect(container.querySelectorAll(".mem-sr-only tbody tr").length).toBe(30);
  });

  it("空数据不画柱也不崩溃", () => {
    const { container } = render(<MemoryGrowthChart points={[]} />);
    expect(screen.getByRole("img")).toHaveAccessibleName("记忆增长：0 天，新增工作记忆 0 条、情节摘要 0 条");
    expect(container.querySelectorAll("rect").length).toBe(0);
    expect(container.querySelectorAll(".chart-tick").length).toBe(0);
    expect(container.querySelectorAll(".mem-sr-only tbody tr").length).toBe(0);
  });
});
