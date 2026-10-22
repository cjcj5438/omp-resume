import "./Usage.css";

export interface DonutSlice { key: string; label: string; value: number; color: string; sub?: string }

const R = 46;
const C = 2 * Math.PI * R;
const GAP = 1.5;

export function Donut({ label, slices, center, centerSub }: { label: string; slices: DonutSlice[]; center: string; centerSub: string }) {
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) return <div className="pane-note">暂无数据</div>;
  const pcts = slices.map((s) => (Math.max(0, s.value) / total) * 100);
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 120 120" className="donut" role="img" aria-label={`${label}：${slices.map((s, i) => `${s.label} ${pcts[i].toFixed(1)}%`).join("，")}`}>
        {slices.map((s, i) => {
          if (s.value <= 0) return null;
          const arc = (s.value / total) * C;
          const len = Math.max(0, arc - GAP);
          const el = (
            <circle
              key={s.key}
              className="donut-seg"
              cx={60}
              cy={60}
              r={R}
              stroke={s.color}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
              data-tip={`${s.label}\n${s.sub ?? ""}\n占 ${pcts[i].toFixed(1)}%`}
            />
          );
          offset += arc;
          return el;
        })}
        <text className="donut-center" x={60} y={58}>{center}</text>
        <text className="donut-center-sub" x={60} y={72}>{centerSub}</text>
      </svg>
      <ul className="donut-legend">
        {slices.map((s, i) => (
          <li key={s.key} data-tip={`${s.label}\n${s.sub ?? ""}\n占 ${pcts[i].toFixed(1)}%`}>
            <i className="legend-swatch" style={{ background: s.color }} />
            <span>{s.label}</span>
            <span className="donut-pct">{pcts[i].toFixed(1)}%</span>
            {s.sub ? <span className="donut-sub">{s.sub}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
