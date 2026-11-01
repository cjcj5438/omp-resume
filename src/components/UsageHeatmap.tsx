import type { UsageActivityPoint } from "../types";
import { usageMoney, usageNumber } from "../format";
import { compactNumber, type HeatMetric } from "./usageFormat";
import "./Usage.css";

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", "日"] as const;

interface HeatCellDay {
  key: string;
  month: number;
  isoDow: number;
  requests: number;
  tokens: number;
  cost: number;
}

function parseDay(key: string): { month: number; isoDow: number } {
  const [y, m, day] = key.slice(0, 10).split("-").map(Number);
  const d = new Date(y, m - 1, day);
  return { month: d.getMonth() + 1, isoDow: (d.getDay() + 6) % 7 };
}

const heatValue = (d: HeatCellDay, metric: HeatMetric): number =>
  metric === "tokens" ? d.tokens : metric === "cost" ? d.cost : d.requests;

export function heatTextOf(day: { requests: number; tokens: number; cost: number }, metric: HeatMetric): string {
  if (metric === "tokens") return compactNumber(day.tokens);
  if (metric === "cost") return usageMoney(day.cost);
  return day.requests.toLocaleString("zh-CN");
}

/**
 * 活动热力图（设计稿形态）：13px 格 / 5 级 color-mix 实色 / 52 周横向滚动 /
 * 月份 8.5px mono / 星期隔行 / 选中 inset 环 / 底部 scale。
 * 列按周一切分：activity 是连续日序列，第一天所在列的前缀空格 + 未来日虚线。
 */
export function UsageHeatmap({
  days,
  metric,
  selectedKey,
  onSelect,
}: {
  days: UsageActivityPoint[];
  metric: HeatMetric;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const cells: HeatCellDay[] = days.map((d) => {
    const { month, isoDow } = parseDay(d.key);
    return { key: d.key, month, isoDow, requests: d.requests, tokens: d.tokens.total, cost: d.cost };
  });
  // 今天：取序列最后一天（后端保证 activity 末键为今天）。
  const lastKey = cells.length > 0 ? cells[cells.length - 1].key : "";
  const max = Math.max(1, ...cells.map((d) => heatValue(d, metric)));
  const levelOf = (d: HeatCellDay): number =>
    d.requests > 0 ? 1 + Math.min(3, Math.floor((heatValue(d, metric) / max) * 4)) : 0;
  // 周列：第一列前面补空格（周一为行 0）。
  const lead = cells.length > 0 ? cells[0].isoDow : 0;
  const slots: (HeatCellDay | null)[] = [...Array<null>(lead).fill(null), ...cells];
  while (slots.length % 7 !== 0) slots.push(null);
  const cols: (HeatCellDay | null)[][] = [];
  for (let c = 0; c < slots.length; c += 7) cols.push(slots.slice(c, c + 7));
  const monthAt = cols.map((col) => {
    const first = col.find((c) => c !== null);
    return first ? first.month : 0;
  });
  // 月标签：该月首列展示，后续同月列合并 span。
  const monthLabels: { col: number; label: string; span: number }[] = [];
  monthAt.forEach((m, i) => {
    if (m === 0) return;
    const last = monthLabels[monthLabels.length - 1];
    if (last && monthAt[last.col] === m && last.col + last.span === i) last.span += 1;
    else monthLabels.push({ col: i, label: `${m} 月`, span: 1 });
  });
  const active = cells.filter((d) => d.requests > 0).length;
  const metricName = metric === "tokens" ? "Token" : metric === "cost" ? "成本" : "请求";
  return (
    <div className="heat-scroll">
      <div className="heat-inner" style={{ ["--weeks" as string]: cols.length }}>
        <div className="heat-months" aria-hidden="true">
          {monthLabels.map((m) => (
            <span key={m.col} className="heat-month" style={{ gridColumn: `${m.col + 1} / span ${m.span}` }}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="heat-body">
          <div className="heat-days" aria-hidden="true">
            {WEEKDAY_LABELS.map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div className="heat-grid" role="group" aria-label={`活跃度热力图：近 52 周，${active} 天有请求，按${metricName}着色`}>
            {cols.map((col, ci) =>
              col.map((cell, ri) => {
                if (cell === null) {
                  return <span key={`${ci}-${ri}`} className="heat-empty" aria-hidden="true" />;
                }
                const future = cell.key > lastKey;
                const lv = levelOf(cell);
                const label = `${cell.month} 月 ${Number(cell.key.slice(8, 10))} 日 · ${cell.requests} 次请求 · ${compactNumber(cell.tokens)} token · ${usageMoney(cell.cost)}`;
                return (
                  <button
                    key={`${ci}-${ri}`}
                    type="button"
                    className={`heat-cell${lv > 0 ? ` l${lv}` : ""}${future ? " is-future" : ""}${cell.key === selectedKey ? " is-on" : ""}`}
                    disabled={future}
                    aria-pressed={cell.key === selectedKey}
                    aria-label={`${cell.key} ${lv === 0 ? "无请求" : label}`}
                    data-tip={lv === 0 && !future ? `${cell.key}\n无请求` : `${cell.key}\n请求 ${usageNumber(cell.requests)} 次 · Token ${usageNumber(cell.tokens)} · 花费 ${usageMoney(cell.cost)}`}
                    tabIndex={cell.key === selectedKey && !future ? 0 : -1}
                    onClick={() => onSelect(cell.key)}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 热力等级 scale（少 → 多），放 heat-foot 右侧。 */
export function HeatScale() {
  return (
    <span className="heat-scale" aria-hidden="true">
      <span>少</span>
      <i />
      <i className="l1" />
      <i className="l2" />
      <i className="l3" />
      <i className="l4" />
      <span>多</span>
    </span>
  );
}
