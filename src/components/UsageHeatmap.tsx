import { Fragment } from "react";
import type { CSSProperties } from "react";
import type { UsageTrendPoint } from "../types";
import { usageMoney, usageNumber } from "../format";
import { heatGrid, heatLevels } from "./usageFormat";
import "./Usage.css";

/** 格子边长上限 18px：行宽富余时整组居中，网格与汇总作为整体左右均分空间。 */
const HEAT_CELL_MAX = 18;
/** 与 .heat-grid 的 gap / 标签列宽保持同步（wrap 的 max-width 由此算出）。 */
const HEAT_GAP = 3;
const HEAT_LABEL_COL = 18;

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

export function UsageHeatmap({ days }: { days: UsageTrendPoint[] }) {
  const levels = heatLevels(days.map((d) => d.cost));
  const cols = heatGrid(days.map((d, i) => ({ key: d.key, cost: d.cost, tokens: d.tokens.total, level: levels[i] })));
  const active = days.filter((d) => d.cost > 0).length;
  const monthOf = cols.map((col) => {
    const first = col.find((c) => c !== null);
    return first ? Number(first.key.slice(5, 7)) : 0;
  });
  // 月标签落在该月首列；若相邻两列同为月首只留前者，避免标签重叠。
  const rawShow = monthOf.map((m, ci) => m !== 0 && (ci === 0 || m !== monthOf[ci - 1]));
  const showMonth = rawShow.map((s, ci) => s && (ci === 0 || !rawShow[ci - 1]));
  // 月标签 / 星期 / 格子共用同一套 grid 轨道：标签即普通格子项，按列对齐，缩放永不漂移。
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `${HEAT_LABEL_COL}px repeat(${cols.length}, minmax(10px, 1fr))`,
  };
  const wrapStyle: CSSProperties = {
    maxWidth: HEAT_LABEL_COL + HEAT_GAP + cols.length * HEAT_CELL_MAX + Math.max(0, cols.length - 1) * HEAT_GAP,
  };
  return (
    <div className="heat-wrap" style={wrapStyle}>
      <div className="heat-grid" style={gridStyle} role="img" aria-label={`活跃度热力图：近 26 周，${active} 天有用量`}>
        <span className="heat-corner" aria-hidden="true" />
        {cols.map((_, ci) => (
          <span key={`m-${ci}`} className="heat-month" aria-hidden="true">{showMonth[ci] ? `${monthOf[ci]}月` : null}</span>
        ))}
        {WEEKDAYS.map((label, ri) => (
          <Fragment key={`w-${ri}`}>
            <span className="heat-weekday" aria-hidden="true">{label}</span>
            {cols.map((col, ci) => {
              const cell = col[ri];
              return cell === null ? (
                <span key={`${ci}-${ri}`} className="heat-empty" aria-hidden="true" />
              ) : (
                <span
                  key={`${ci}-${ri}`}
                  className="heat-cell"
                  data-level={cell.level}
                  data-tip={cell.level === 0 ? `${cell.key}\n无用量` : `${cell.key}\n花费 ${usageMoney(cell.cost)} · Token ${usageNumber(cell.tokens)}`}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="heat-foot">
        <HeatLegend />
      </div>
    </div>
  );
}

/** 热力等级图例（0–4）：置于热力图下方，与网格右对齐（GitHub 式）。 */
export function HeatLegend() {
  return (
    <span className="heat-legend" aria-hidden="true">
      <span>少</span>
      {[0, 1, 2, 3, 4].map((l) => (
        <span key={l} className="heat-cell heat-swatch" data-level={l} />
      ))}
      <span>多</span>
    </span>
  );
}
