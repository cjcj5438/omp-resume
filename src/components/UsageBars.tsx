import "./Usage.css";

export interface UsageBar { key: string; name: string; title?: string; share: number; value: string }

/** 横向构成条（设计稿 .bars）：名 / 轨道 / 右对齐值。share 为 0..100 占比。 */
export function UsageBars({ label, rows, note }: { label: string; rows: UsageBar[]; note?: string }) {
  if (rows.length === 0) return <div className="pane-note">此范围内暂无数据</div>;
  return (
    <>
      <div className="bars" role="img" aria-label={`${label}：${rows.map((r) => `${r.name} ${r.value}`).join("，")}`}>
        {rows.map((r) => (
          <div key={r.key} className="bar-row" data-tip={r.title ?? r.name}>
            <span className="name">{r.name}</span>
            <span className="bar-track" aria-hidden="true">
              <span className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, r.share))}%` }} />
            </span>
            <span className="val">{r.value}</span>
          </div>
        ))}
      </div>
      {note !== undefined ? <p className="bars-note">{note}</p> : null}
    </>
  );
}
