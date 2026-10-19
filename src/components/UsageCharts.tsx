import type { UsageHealthTimelinePoint, UsageTrendPoint, UsageTrendUnit } from "../types";
import { usageMoney, usageNumber } from "./UsageSummary";
import { barHeights, cacheHitSeries, formatHitRate, sparseIndexes, tickLabel } from "./usageFormat";
import "./Usage.css";

const W = 600;
const H = 200;
const PLOT_X = 8;
const PLOT_W = 584;
const PLOT_TOP = 14;
const PLOT_H = 140;
const BASE_Y = PLOT_TOP + PLOT_H;
const AXIS_Y = 174;

/** 横轴稀疏标注（3 张图共用，行为锁步）。 */
function ChartAxis({ keys, unit, centers }: { keys: string[]; unit: UsageTrendUnit; centers: number[] }) {
  return (
    <g aria-hidden="true">
      {sparseIndexes(keys.length).map((i) => (
        <text key={keys[i]} x={centers[i]} y={AXIS_Y} textAnchor="middle" className="chart-tick">
          {tickLabel(keys[i], unit)}
        </text>
      ))}
    </g>
  );
}

function barStep(count: number): { x: (i: number) => number; w: number; centers: number[] } {
  const step = PLOT_W / Math.max(1, count);
  const gap = count > 20 ? 2 : 4;
  const w = Math.max(2, step - gap);
  const centers = Array.from({ length: count }, (_, i) => PLOT_X + i * step + step / 2);
  return { x: (i: number) => PLOT_X + i * step + (step - w) / 2, w, centers };
}

/** 花费趋势柱状图（hour/day 自适应）。 */
export function CostTrendChart({ unit, points }: { unit: UsageTrendUnit; points: UsageTrendPoint[] }) {
  const heights = barHeights(points.map((p) => p.cost), PLOT_H);
  const { x, w, centers } = barStep(points.length);
  const total = points.reduce((a, p) => a + p.cost, 0);
  const peak = points.reduce<UsageTrendPoint | null>((a, p) => (a === null || p.cost > a.cost ? p : a), null);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={`花费趋势：${points.length} ${unit === "hour" ? "小时" : "天"}，总计 ${usageMoney(total)}${peak && peak.cost > 0 ? `，最高 ${usageMoney(peak.cost)}（${peak.key}）` : ""}`}
    >
      <line x1={PLOT_X} y1={BASE_Y} x2={PLOT_X + PLOT_W} y2={BASE_Y} className="chart-grid" />
      {points.map((p, i) => (
        <rect key={p.key} x={x(i)} y={BASE_Y - heights[i]} width={w} height={heights[i]} className="chart-bar">
          <title>{`${p.key}：${usageMoney(p.cost)}`}</title>
        </rect>
      ))}
      <ChartAxis keys={points.map((p) => p.key)} unit={unit} centers={centers} />
    </svg>
  );
}

/** 请求趋势：请求柱 + 错误叠加（警示色）+ 兜底小圆点。 */
export function RequestsChart({ unit, points }: { unit: UsageTrendUnit; points: UsageHealthTimelinePoint[] }) {
  const heights = barHeights(points.map((p) => p.requests), PLOT_H);
  const { x, w, centers } = barStep(points.length);
  const requests = points.reduce((a, p) => a + p.requests, 0);
  const errors = points.reduce((a, p) => a + p.errors, 0);
  const fallbacks = points.reduce((a, p) => a + p.fallbacks, 0);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={`请求趋势：${points.length} ${unit === "hour" ? "小时" : "天"}，请求 ${usageNumber(requests)} 次，错误 ${usageNumber(errors)} 次，兜底 ${usageNumber(fallbacks)} 次`}
    >
      <line x1={PLOT_X} y1={BASE_Y} x2={PLOT_X + PLOT_W} y2={BASE_Y} className="chart-grid" />
      {points.map((p, i) => {
        const errH = p.requests > 0 && p.errors > 0 ? Math.max(2, Math.round((p.errors / p.requests) * heights[i])) : 0;
        return (
          <g key={p.key}>
            <rect x={x(i)} y={BASE_Y - heights[i]} width={w} height={heights[i]} className="chart-bar-soft">
              <title>{`${p.key}：请求 ${usageNumber(p.requests)} 次 · 错误 ${usageNumber(p.errors)} 次 · 兜底 ${usageNumber(p.fallbacks)} 次`}</title>
            </rect>
            {errH > 0 ? <rect x={x(i)} y={BASE_Y - errH} width={w} height={errH} className="chart-bar-error" /> : null}
            {p.fallbacks > 0 ? (
              <circle cx={x(i) + w / 2} cy={Math.max(PLOT_TOP - 2, BASE_Y - heights[i] - 6)} r={3} className="chart-fb">
                <title>{`${p.key}：兜底 ${usageNumber(p.fallbacks)} 次`}</title>
              </circle>
            ) : null}
          </g>
        );
      })}
      <ChartAxis keys={points.map((p) => p.key)} unit={unit} centers={centers} />
    </svg>
  );
}

/** 缓存命中率折线：无请求的桶断线。 */
export function CacheHitChart({ unit, points }: { unit: UsageTrendUnit; points: UsageHealthTimelinePoint[] }) {
  const series = cacheHitSeries(points);
  const { centers } = barStep(points.length);
  const y = (v: number): number => PLOT_TOP + (1 - v) * PLOT_H;
  const runs: { i: number; v: number }[][] = [];
  series.forEach((v, i) => {
    if (v === null) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].i === i - 1) last.push({ i, v });
    else runs.push([{ i, v }]);
  });
  const valid = series.filter((v): v is number => v !== null);
  const gaps = series.length - valid.length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={`缓存命中率趋势：${valid.length} 个桶有数据${gaps > 0 ? `，${gaps} 个桶无请求断线` : ""}${valid.length > 0 ? `，最高 ${formatHitRate(Math.max(...valid))}` : ""}`}
    >
      {[1, 0.5, 0].map((g) => (
        <g key={g} aria-hidden="true">
          <line x1={PLOT_X} y1={y(g)} x2={PLOT_X + PLOT_W} y2={y(g)} className="chart-grid" />
          <text x={PLOT_X + PLOT_W - 4} y={y(g) - 4} textAnchor="end" className="chart-tick">
            {formatHitRate(g)}
          </text>
        </g>
      ))}
      {runs.map((run, ri) => (
        <polyline
          key={ri}
          points={run.map((p) => `${centers[p.i]},${y(p.v)}`).join(" ")}
          className="chart-line"
        />
      ))}
      {series.map((v, i) =>
        v === null ? null : (
          <circle key={points[i].key} cx={centers[i]} cy={y(v)} r={2.5} className="chart-dot">
            <title>{`${points[i].key}：命中率 ${formatHitRate(v)}`}</title>
          </circle>
        ),
      )}
      <ChartAxis keys={points.map((p) => p.key)} unit={unit} centers={centers} />
    </svg>
  );
}
