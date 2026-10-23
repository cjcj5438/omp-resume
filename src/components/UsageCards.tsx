import type { ReactNode } from "react";
import type { UsageSession } from "../types";
import { formatRelativeTime, usageMoney, usageNumber } from "../format";
import { compactNumber } from "./usageFormat";
import "./Usage.css";

export function Kpi({ label, value, subs = [], danger = false }: { label: string; value: string; subs?: (string | null | false)[]; danger?: boolean }) {
  return (
    <div className="kpi-card">
      <span className="kpi-label">{label}</span>
      <strong className={danger ? "kpi-value kpi-value-danger" : "kpi-value"}>{value}</strong>
      {subs.filter(Boolean).map((s, i) => (
        <span key={i} className="kpi-sub">{s}</span>
      ))}
    </div>
  );
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

export function TopSessions({ sessions, titleOf, onOpen }: { sessions: UsageSession[]; titleOf: (path: string) => string | null; onOpen: (path: string) => void }) {
  if (sessions.length === 0) return <div className="pane-note">此范围内暂无会话</div>;
  const max = sessions[0].cost;
  return (
    <ol className="top-list">
      {sessions.map((s) => {
        const title = titleOf(s.path);
        const shown = title ?? `${projectName(s.cwd)} · ${s.id.slice(0, 8)}`;
        const inner: ReactNode = (
          <>
            <span className="top-title">{shown}</span>
            <span className="top-cost">{usageMoney(s.cost)}</span>
            <span className="top-meta">{`${projectName(s.cwd)} · ${formatRelativeTime(new Date(s.lastMs).toISOString())} · ${s.calls} 次调用 · ${compactNumber(s.tokens)} Token`}</span>
            <span className="usage-bar" aria-hidden="true"><span style={{ width: `${max > 0 ? Math.min(100, (s.cost / max) * 100) : 0}%` }} /></span>
          </>
        );
        const tip = `${shown}\n${s.cwd}\n花费 ${usageMoney(s.cost)} · Token ${usageNumber(s.tokens)} · ${s.calls} 次调用${title ? "" : "\n会话已不在列表中"}`;
        return (
          <li key={s.id}>
            {title ? (
              <button type="button" className="top-row" data-tip={tip} onClick={() => onOpen(s.path)}>{inner}</button>
            ) : (
              <div className="top-row" data-tip={tip}>{inner}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
