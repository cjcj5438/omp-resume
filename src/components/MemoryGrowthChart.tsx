/** 记忆库增长图：工作记忆 / 情节摘要堆叠日柱（手写 SVG，无图表库）。 */
import type { MemoryGrowthPoint } from "../types";
import { barHeights, sparseIndexes, tickLabel } from "./usageFormat";
import "./Usage.css";
import "./MemoryPanel.css";

const W = 600;
const H = 200;
const PLOT_X = 8;
const PLOT_W = 584;
const PLOT_TOP = 14;
const PLOT_H = 140;
const BASE_Y = PLOT_TOP + PLOT_H;
const AXIS_Y = 174;

export function MemoryGrowthChart({ points }: { points: MemoryGrowthPoint[] }) {
  const totals = points.map((p) => p.working + p.episodic);
  const heights = barHeights(totals, PLOT_H);
  const step = PLOT_W / Math.max(1, points.length);
  const gap = points.length > 20 ? 2 : 4;
  const w = Math.max(2, step - gap);
  const x = (i: number): number => PLOT_X + i * step + (step - w) / 2;
  const centers = points.map((_, i) => PLOT_X + i * step + step / 2);
  const working = points.reduce((a, p) => a + p.working, 0);
  const episodic = points.reduce((a, p) => a + p.episodic, 0);
  return (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label={`记忆增长：${points.length} 天，新增工作记忆 ${working} 条、情节摘要 ${episodic} 条`}
      >
        <line x1={PLOT_X} y1={BASE_Y} x2={PLOT_X + PLOT_W} y2={BASE_Y} className="chart-grid" />
        {points.map((p, i) => {
          const total = totals[i];
          const h = heights[i];
          const episodicH = total > 0 && p.episodic > 0 ? Math.max(1, Math.round((p.episodic / total) * h)) : 0;
          const workingH = h - episodicH;
          return (
            <g key={p.date}>
              {workingH > 0 ? (
                <rect x={x(i)} y={BASE_Y - h} width={w} height={workingH} className="chart-bar">
                  <title>{`${p.date}：工作记忆 ${p.working} 条 · 情节摘要 ${p.episodic} 条`}</title>
                </rect>
              ) : null}
              {episodicH > 0 ? (
                <rect x={x(i)} y={BASE_Y - episodicH} width={w} height={episodicH} className="chart-bar-episodic">
                  <title>{`${p.date}：工作记忆 ${p.working} 条 · 情节摘要 ${p.episodic} 条`}</title>
                </rect>
              ) : null}
            </g>
          );
        })}
        <g aria-hidden="true">
          {sparseIndexes(points.length).map((i) => {
            const first = i === 0;
            const last = i === points.length - 1;
            return (
              <text
                key={points[i].date}
                x={first ? PLOT_X : last ? W - 4 : centers[i]}
                y={AXIS_Y}
                textAnchor={first ? "start" : last ? "end" : "middle"}
                className="chart-tick"
              >
                {tickLabel(points[i].date, "day")}
              </text>
            );
          })}
        </g>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        <span>
          <i className="legend-swatch legend-working" /> 工作记忆
        </span>
        <span>
          <i className="legend-swatch legend-episodic" /> 情节摘要
        </span>
      </div>
      <table className="mem-sr-only">
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{p.date}</th>
              <td>工作记忆 {p.working} 条</td>
              <td>情节摘要 {p.episodic} 条</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
