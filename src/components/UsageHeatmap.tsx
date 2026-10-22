import type { UsageTrendPoint } from "../types";
import { heatGrid, heatLevels } from "./usageFormat";
import { usageMoney, usageNumber } from "./UsageSummary";
import "./Usage.css";

const CELL = 14;
const GAP = 3;
const LEFT = 26;
const TOP = 16;
const STEP = CELL + GAP;

export function UsageHeatmap({ days }: { days: UsageTrendPoint[] }) {
  const levels = heatLevels(days.map((d) => d.cost));
  const cols = heatGrid(days.map((d, i) => ({ key: d.key, cost: d.cost, tokens: d.tokens.total, level: levels[i] })));
  const active = days.filter((d) => d.cost > 0).length;
  const monthLabels = cols.map((col) => {
    const first = col.find((c) => c !== null);
    return first ? Number(first.key.slice(5, 7)) : 0;
  });
  const showMonth = monthLabels.map((m, ci) => m !== 0 && (ci === 0 || m !== monthLabels[ci - 1]));
  return (
    <div className="heat-wrap">
      <svg viewBox={`0 0 ${LEFT + cols.length * STEP} ${TOP + 7 * STEP}`} className="heat" role="img" aria-label={`活跃度热力图：近 26 周，${active} 天有用量`}>
        {cols.map((col, ci) => (
          <g key={ci}>
            {showMonth[ci] ? <text className="chart-tick" x={LEFT + ci * STEP} y={10}>{monthLabels[ci]}月</text> : null}
            {col.map((cell, ri) =>
              cell === null ? null : (
                <rect
                  key={`${ci}-${ri}`}
                  className="heat-cell"
                  data-level={cell.level}
                  data-tip={cell.level === 0 ? `${cell.key}\n无用量` : `${cell.key}\n花费 ${usageMoney(cell.cost)} · Token ${usageNumber(cell.tokens)}`}
                  x={LEFT + ci * STEP}
                  y={TOP + ri * STEP}
                  width={CELL}
                  height={CELL}
                  rx={2}
                />
              ),
            )}
          </g>
        ))}
        {(["一", "三", "五", "日"] as const).map((t, k) => (
          <text key={t} className="chart-tick" x={0} y={TOP + (k * 2) * STEP + 10}>{t}</text>
        ))}
      </svg>
    </div>
  );
}

/** 热力等级图例（0–4）：放在卡片头右侧，与热力图分离。 */
export function HeatLegend() {
  return (
    <span className="heat-legend" aria-hidden="true">
      <span>少</span>
      {[0, 1, 2, 3, 4].map((l) => (
        <svg key={l} width={12} height={12}><rect className="heat-cell" data-level={l} width={12} height={12} rx={2} /></svg>
      ))}
      <span>多</span>
    </span>
  );
}
