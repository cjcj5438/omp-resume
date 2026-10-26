/** 甘特时间线（SVG）：每行一根条，选中行加粗，点击行即选中。 */
import { barSpan, type Timeline } from "./timeline";

export interface TimelineProps {
  timeline: Timeline;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** 行高与左侧名字列宽（SVG 内部坐标）。 */
const ROW_H = 16;
const NAME_W = 96;
const RIGHT_PAD = 8;

export function TimelineChart({ timeline, selectedId, onSelect }: TimelineProps) {
  if (timeline.rows.length === 0) {
    return <p className="stage-empty-note">暂无时间线数据（缺少开始时间）。</p>;
  }
  const height = timeline.rows.length * ROW_H + 18;
  const width = 520;
  const plotW = width - NAME_W - RIGHT_PAD;
  const span = timeline.endMs - timeline.startMs;
  const xOf = (ms: number) => NAME_W + (span <= 0 ? 0 : ((ms - timeline.startMs) / span) * plotW);

  return (
    <svg
      className="stage-timeline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="角色时间线"
      preserveAspectRatio="xMinYMin meet"
    >
      {timeline.ticks.map((tick, i) => (
        <g key={tick.ms}>
          <line
            x1={xOf(tick.ms)}
            y1={12}
            x2={xOf(tick.ms)}
            y2={height - 4}
            className="stage-tl-grid"
          />
          <text x={xOf(tick.ms)} y={9} className="stage-tl-tick" textAnchor={i === 0 ? "start" : i === timeline.ticks.length - 1 ? "end" : "middle"}>
            {tick.label}
          </text>
        </g>
      ))}
      {timeline.rows.map((row, index) => {
        const y = 14 + index * ROW_H;
        const active = row.id === selectedId;
        return (
          <g
            key={row.id}
            className={active ? "stage-tl-row stage-tl-row-active" : "stage-tl-row"}
            onClick={() => onSelect(row.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(row.id);
              }
            }}
            aria-label={`${row.name} 时间线`}
          >
            <rect x={0} y={y} width={width} height={ROW_H} className="stage-tl-hover" />
            <text x={row.depth === 0 ? 2 : 12} y={y + 11} className="stage-tl-name">
              {row.name}
            </text>
            {row.bars.map((bar, bi) => {
              const { left, width: w } = barSpan(bar, timeline);
              return (
                <rect
                  key={bi}
                  x={NAME_W + (left / 100) * plotW}
                  y={y + 4}
                  width={Math.max(2, (w / 100) * plotW)}
                  height={active ? 8 : 6}
                  rx={2}
                  className={`stage-tl-bar stage-tl-${bar.state}`}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
