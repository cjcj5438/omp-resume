import { ChartNoAxesColumn } from "lucide-react";
import { usageNumber } from "../format";
import { Panel } from "./page";
import "./Usage.css";

const pad2 = (h: number): string => String(h).padStart(2, "0");

/** 按小时请求分布面板：24 柱 + 峰值高亮 + 00/06/12/18/23 轴（设计稿 .hourly）。 */
export function HourlyChart({ hourly, rangeLabel }: { hourly: number[]; rangeLabel: string }) {
  const buckets = Array.from({ length: 24 }, (_, h) => hourly[h] ?? 0);
  const rawMax = Math.max(...buckets);
  const max = Math.max(1, rawMax);
  // 同值取最早（indexOf 语义），与设计稿 U.hourly.indexOf(hMax) 一致。
  const peak = buckets.indexOf(rawMax);
  const total = buckets.reduce((a, b) => a + b, 0);
  return (
    <Panel
      title="按小时请求"
      icon={ChartNoAxesColumn}
      meta={`${rangeLabel} · 24 小时分布`}
      foot={
        <>
          <span>{total > 0 ? `峰值 ${pad2(peak)}:00 · ${usageNumber(rawMax)} 次请求` : "该范围内暂无请求"}</span>
          <span className="mono">{usageNumber(total)} 次 / {rangeLabel}</span>
        </>
      }
    >
      <div className="hourly" role="img" aria-label={`按小时请求分布，峰值 ${pad2(peak)}:00 ${usageNumber(rawMax)} 次`}>
        {buckets.map((v, h) => (
          <span
            key={h}
            className={h === peak && v > 0 ? "hb peak" : "hb"}
            data-tip={`${pad2(h)}:00 · ${usageNumber(v)} 次请求`}
            aria-hidden="true"
          >
            <i style={{ height: `${v > 0 ? Math.max(3, (v / max) * 100) : 0}%` }} />
          </span>
        ))}
      </div>
      <div className="hourly-axis" aria-hidden="true">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
    </Panel>
  );
}
