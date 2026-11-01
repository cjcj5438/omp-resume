import "./Usage.css";

export interface DonutSlice { key: string; label: string; value: number; color: string; sub?: string }

/**
 * 环形构成图（设计稿 donut：viewBox 132、r50、stroke 14）。
 * 中心默认「N% + 首片占比」（长名截断）；centerMain/centerSub 显式传入时覆盖
 * （供 Token/耗时扩展 donut 传格式化值）。
 */
export function Donut({ label, slices, centerMain, centerSub }: { label: string; slices: DonutSlice[]; centerMain?: string; centerSub?: string }) {
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) return <div className="pane-note">暂无数据</div>;
  const pcts = slices.map((s) => (Math.max(0, s.value) / total) * 100);
  const r = 50;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const top = slices.reduce((best, s, i) => (s.value > slices[best].value ? i : best), 0);
  const shortTop = slices[top].label.length > 12 ? `${slices[top].label.slice(0, 11)}…` : slices[top].label;
  const main = centerMain ?? `${pcts[top].toFixed(0)}%`;
  const sub = centerSub ?? `${shortTop} 占比`;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 132 132" className="donut" role="img" aria-label={`${label}：${slices.map((s, i) => `${s.label} ${pcts[i].toFixed(1)}%`).join("，")}`}>
        <circle cx={66} cy={66} r={r} fill="none" stroke="var(--bg-raised)" strokeWidth={14} />
        {slices.map((s, i) => {
          if (s.value <= 0) return null;
          const len = (pcts[i] / 100) * c;
          const el = (
            <circle
              key={s.key}
              className="donut-seg"
              cx={66}
              cy={66}
              r={r}
              stroke={s.color}
              strokeDasharray={`${len.toFixed(2)} ${(c - len).toFixed(2)}`}
              strokeDashoffset={(-offset).toFixed(2)}
              transform="rotate(-90 66 66)"
              data-tip={`${s.label}\n${s.sub ?? ""}\n占 ${pcts[i].toFixed(1)}%`}
            />
          );
          offset += len;
          return el;
        })}
        <text className="donut-center" x={66} y={62}>{main}</text>
        <text className="donut-center-sub" x={66} y={78}>{sub}</text>
      </svg>
      <div className="donut-legend">
        {slices.map((s, i) => (
          <div key={s.key} className="dl-row" data-tip={`${s.label}\n${s.sub ?? ""}\n占 ${pcts[i].toFixed(1)}%`}>
            <span className="swatch" style={{ background: s.color }} />
            <span className="nm">{s.label}</span>
            <span className="pc">{pcts[i].toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
