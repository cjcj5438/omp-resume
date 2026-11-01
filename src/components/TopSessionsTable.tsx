import type { UsageSession } from "../types";
import { formatRelativeTime, usageMoney } from "../format";
import { compactNumber } from "./usageFormat";
import "./Usage.css";

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** 高花费会话明细（次级 panel）：三列表格，行可点进会话，无标题的行纯展示。 */
export function TopSessionsTable({ sessions, titleOf, onOpen }: { sessions: UsageSession[]; titleOf: (path: string) => string | null; onOpen: (path: string) => void }) {
  if (sessions.length === 0) return <div className="pane-note">此范围内暂无会话</div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">会话</th>
            <th scope="col" className="r">成本</th>
            <th scope="col" className="r">Token</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const title = titleOf(s.path);
            const shown = title ?? `${projectName(s.cwd)} · ${s.id.slice(0, 8)}`;
            const tip = `${shown}\n${s.cwd}\n花费 ${usageMoney(s.cost)} · Token ${s.tokens.toLocaleString("zh-CN")} · ${s.calls} 次调用${title ? "" : "\n会话已不在列表中"}`;
            return (
              <tr key={s.id} data-tip={tip} className={title ? "is-click" : undefined} onClick={title ? () => onOpen(s.path) : undefined} onKeyDown={title ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(s.path); } } : undefined} tabIndex={title ? 0 : undefined} role={title ? "button" : undefined}>
                <td>
                  <span className="strong">{shown}</span>
                  <span className="sub">{`${projectName(s.cwd)} · ${formatRelativeTime(new Date(s.lastMs).toISOString())} · ${s.calls} 次调用`}</span>
                </td>
                <td className="r mono">{usageMoney(s.cost)}</td>
                <td className="r mono" style={{ color: "var(--text-faint)" }}>{compactNumber(s.tokens)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
