import type { UsageTrendPoint, UsageTrendUnit } from "../types";
import { usageMoney } from "../format";
import { compactNumber, tickLabel, type TrendMetric } from "./usageFormat";
import "./Usage.css";

/** 面积趋势图：照抄设计稿 areaChart（720×210、max×1.18、4 网格线、隔点圆点、末端光晕）。 */
export function AreaChart({ unit, points, metric }: { unit: UsageTrendUnit; points: UsageTrendPoint[]; metric: TrendMetric }) {
  const values = points.map((p) => (metric === "cost" ? p.cost : p.tokens.total));
  const totalCost = points.reduce((a, p) => a + p.cost, 0);
  const totalTokens = points.reduce((a, p) => a + p.tokens.total, 0);
  const rawMax = Math.max(0, ...values);
  const w = 720;
  const h = 210;
  const pad = { l: 40, r: 12, t: 14, b: 24 };
  const max = rawMax * 1.18 || 1;
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const step = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const px = (i: number): number => pad.l + i * step;
  const py = (v: number): number => pad.t + innerH - (v / max) * innerH;
  const line = values.map((v, i) => `${i > 0 ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const baseY = pad.t + innerH;
  const lastX = px(points.length - 1);
  const lastY = py(values[points.length - 1] ?? 0);
  const area = `${line} L${lastX.toFixed(1)} ${baseY} L${pad.l.toFixed(1)} ${baseY} Z`;
  const fmtAxis = (v: number): string => {
    if (metric !== "cost") return compactNumber(v);
    return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  };
  const skip = Math.ceil(points.length / 7);
  const peak = values.reduce<number>((best, v, i) => (v > values[best] ? i : best), 0);
  const label = metric === "cost"
    ? `花费趋势：${points.length} ${unit === "hour" ? "小时" : "天"}，总计 ${usageMoney(totalCost)}${rawMax > 0 ? `，最高 ${usageMoney(rawMax)}（${points[peak]?.key ?? ""}）` : ""}`
    : `Token 趋势：${points.length} ${unit === "hour" ? "小时" : "天"}，总计 ${compactNumber(totalTokens)}${rawMax > 0 ? `，最高 ${compactNumber(rawMax)}（${points[peak]?.key ?? ""}）` : ""}`;
  if (points.length === 0 || rawMax <= 0) {
    return <div className="pane-note">{`${metric === "cost" ? "花费" : "Token"}在该范围内为 0`}</div>;
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label={label}>
      {[0, 0.33, 0.66, 1].map((r) => {
        const y = pad.t + innerH * r;
        return (
          <g key={r} aria-hidden="true">
            <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke="var(--border)" strokeWidth={1} />
            <text className="axis-label" x={pad.l - 8} y={y + 3} textAnchor="end">{fmtAxis(max * (1 - r))}</text>
          </g>
        );
      })}
      <path d={area} fill="var(--accent-soft)" aria-hidden="true" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" />
      {values.map((v, i) =>
        i % 2 === 0 || i === values.length - 1
          ? <circle key={points[i].key} cx={px(i)} cy={py(v)} r={2.2} fill="var(--accent)" opacity={i === values.length - 1 ? 1 : 0.5} aria-hidden="true" />
          : null,
      )}
      <circle cx={lastX} cy={lastY} r={5} fill="var(--accent)" opacity={0.18} aria-hidden="true" />
      <g aria-hidden="true">
        {points.map((p, i) => {
          if (i % skip !== 0 && i !== points.length - 1) return null;
          return (
            <text
              key={p.key}
              className="axis-label"
              x={px(i)}
              y={h - 6}
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            >
              {tickLabel(p.key, unit)}
            </text>
          );
        })}
      </g>
    </svg>
  );
}
