import { useEffect, useRef, useState } from "react";
import { getUsageHealth, getUsageStats, normalizeError } from "../api";
import { errorText, formatMs, formatTps, usageMoney, usageNumber } from "../format";
import type { AppError, UsageHealth, UsageRange, UsageStats } from "../types";
import { HealthBoard } from "./HealthBoard";
import { Kpi, TopSessions } from "./UsageCards";
import { TrendChart, type TrendMetric } from "./UsageCharts";
import { Donut } from "./UsageDonut";
import { UsageHeatmap } from "./UsageHeatmap";
import { activitySummary, cacheHitRate, compactNumber, formatDuration, formatHitRate } from "./usageFormat";
import { EmptyState } from "./ui";
import { ChartColumn } from "lucide-react";
import "./Usage.css";

type StatsTab = "cost" | "health";

const TABS: { key: StatsTab; label: string }[] = [
  { key: "cost", label: "总览" },
  { key: "health", label: "运行看板" },
];

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "all", label: "全部" },
];

/**
 * 范围数据请求：alive 标志保证迟到响应不覆盖当前结果；
 * 已加载键命中时跳过（切换标签页回来不重复请求）。
 */
function useRangeData<T>(fetchKey: string, load: () => Promise<T>): {
  data: T | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadedKey = useRef<string | null>(null);
  // 每个范围最后一次成功的数据：切回已加载的范围要立刻有内容，不能等请求。
  const cache = useRef(new Map<string, T>());
  // 上一轮的 fetchKey（不含 nonce）：变了说明换了范围/标签页，旧数据必须立刻让位。
  const prevFetchKey = useRef<string | null>(null);
  useEffect(() => {
    const key = `${fetchKey}#${nonce}`;
    const keyChanged = prevFetchKey.current !== fetchKey;
    prevFetchKey.current = fetchKey;
    // 换范围：不放着上一个范围的数据当结果。已加载过的范围用缓存立刻顶上，
    // 没加载过的清空并显示加载文案。同范围的刷新（nonce 变化）保留旧数据，避免闪一下空图。
    if (keyChanged) setData(cache.current.get(fetchKey) ?? null);
    if (loadedKey.current === key) {
      // 缓存命中（切回已加载的范围，不再请求）：必须复位 loading，
      // 否则上一个未完成请求的 setLoading(true) 会残留，刷新按钮永久禁用。
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void load()
      .then((next) => {
        if (!alive) return;
        loadedKey.current = key;
        cache.current.set(fetchKey, next);
        setData(next);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        loadedKey.current = key;
        setData(null);
        setError(normalizeError(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [fetchKey, nonce]);
  return { data, loading, error, refresh: () => setNonce((n) => n + 1) };
}

function RangeControls({
  range,
  onRange,
  loading,
  onRefresh,
  refreshLabel,
}: {
  range: UsageRange;
  onRange: (r: UsageRange) => void;
  loading: boolean;
  onRefresh: () => void;
  refreshLabel: string;
}) {
  return (
    <div className="usage-controls">
      <div role="group" aria-label="统计范围" className="seg">
        {RANGES.map((r) => (
          <button
            key={r.value}
            type="button"
            className="btn"
            aria-pressed={range === r.value}
            onClick={() => onRange(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn" disabled={loading} onClick={onRefresh}>
        {refreshLabel}
      </button>
    </div>
  );
}

interface StatsRow {
  key: string;
  name: string;
  title?: string;
  cost: number;
  tokens: number;
  cells: string[];
}

function StatsTable({ name, heads, rows, total }: { name: string; heads: string[]; rows: StatsRow[]; total: number }) {
  return <section className="usage-table-section" aria-label={name}>
    <h2>{name}</h2>
    <table className="usage-table">
      <thead><tr><th scope="col">{name.slice(1)}</th><th scope="col">花费（USD）</th><th scope="col">Token</th>{heads.map((h) => <th scope="col" key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key} data-tip={`${row.title ?? row.name}\n花费 ${usageMoney(row.cost)}（占 ${total > 0 ? `${((row.cost / total) * 100).toFixed(1)}%` : "—"}） · Token ${usageNumber(row.tokens)}${row.cells.length ? `\n${row.cells.join(" · ")}` : ""}`}>
        <th scope="row"><span className="usage-row-name">{row.name}</span><span className="usage-bar" aria-hidden="true"><span style={{ width: `${total > 0 ? Math.min(100, row.cost / total * 100) : 0}%` }} /></span></th>
        <td>{usageMoney(row.cost)}</td><td>{usageNumber(row.tokens)}</td>{row.cells.map((c, i) => <td key={i}>{c}</td>)}
      </tr>)}</tbody>
    </table>
  </section>;
}

function OverviewPanel({ range, onRange, sessionTitle, onOpenSession }: { range: UsageRange; onRange: (r: UsageRange) => void; sessionTitle: (path: string) => string | null; onOpenSession: (path: string) => void }) {
  const { data, loading, error, refresh } = useRangeData<UsageStats>(`stats:${range}`, () => getUsageStats({ range }));
  const [metric, setMetric] = useState<TrendMetric>("cost");
  return (
    <div className="usage-body" aria-busy={loading}>
      <RangeControls range={range} onRange={onRange} loading={loading} onRefresh={refresh} refreshLabel="刷新统计" />
      {loading && !data ? <div className="pane-note" role="status">正在扫描用量…</div> : null}
      {error ? <div className="banner banner-error" role="alert">{errorText(error)}<button type="button" className="btn btn-small" onClick={refresh}>重试</button></div> : null}
      {data ? <OverviewBody data={data} metric={metric} onMetric={setMetric} sessionTitle={sessionTitle} onOpenSession={onOpenSession} /> : null}
    </div>
  );
}

function OverviewBody({ data, metric, onMetric, sessionTitle, onOpenSession }: { data: UsageStats; metric: TrendMetric; onMetric: (m: TrendMetric) => void; sessionTitle: (path: string) => string | null; onOpenSession: (path: string) => void }) {
  const { total, timing } = data;
  const active = timing.waitMs + timing.genMs + timing.toolMs;
  const hit = cacheHitRate(total.tokens);
  const activity = activitySummary(data.activity);
  return (<>
    <section className="kpi-grid kpi-grid-6" aria-label="用量总计">
      <Kpi label="会话" value={usageNumber(data.sessions)} subs={[`项目 ${data.byProject.length} 个`]} />
      <Kpi label="累计 Token" value={compactNumber(total.tokens.total)} subs={[`调用 ${usageNumber(total.messages.assistant)} 次`]} />
      <Kpi label="费用" value={usageMoney(total.cost.total)} subs={[`主对话 ${usageMoney(total.cost.main)} · 后台 ${usageMoney(total.cost.background)} · 子代理 ${usageMoney(total.cost.subagent)}`]} />
      <Kpi label="缓存命中" value={formatHitRate(hit)} subs={hit === null ? ["该上游未返回缓存数据"] : [`缓存读 ${compactNumber(total.tokens.cacheRead)} · 写 ${compactNumber(total.tokens.cacheWrite)}`]} />
      <Kpi label="工具调用" value={usageNumber(timing.toolCalls)} subs={[`工具耗时 ${formatDuration(timing.toolMs)}`]} />
      <Kpi label="活跃时长" value={formatDuration(active)} subs={[`模型调用 ${usageNumber(timing.calls)} 次（主对话）`]} />
    </section>
    {!data.byProject.length ? (
      <EmptyState icon={ChartColumn} title="此范围内暂无用量数据">
        换个时间范围试试。
      </EmptyState>
    ) : <>
      <section className="health-card usage-trend" aria-label="用量趋势">
        <div className="card-head">
          <h2>用量趋势</h2>
          <div role="group" aria-label="趋势指标" className="seg">
            <button type="button" className="btn" aria-pressed={metric === "cost"} onClick={() => onMetric("cost")}>花费</button>
            <button type="button" className="btn" aria-pressed={metric === "tokens"} onClick={() => onMetric("tokens")}>Token</button>
          </div>
        </div>
        <TrendChart unit={data.trend.unit} points={data.trend.points} metric={metric} />
      </section>
      <div className="health-grid">
        <section className="health-card" aria-label="Token 构成">
          <h2>Token 构成</h2>
          <Donut
            label="Token 构成"
            center={compactNumber(total.tokens.total)}
            centerSub="总用量"
            slices={[
              { key: "input", label: "输入", value: total.tokens.input, color: "var(--seg-1)", sub: usageNumber(total.tokens.input) },
              { key: "cacheRead", label: "缓存读", value: total.tokens.cacheRead, color: "var(--seg-2)", sub: usageNumber(total.tokens.cacheRead) },
              { key: "cacheWrite", label: "缓存写", value: total.tokens.cacheWrite, color: "var(--seg-3)", sub: usageNumber(total.tokens.cacheWrite) },
              { key: "output", label: "输出", value: total.tokens.output, color: "var(--seg-4)", sub: usageNumber(total.tokens.output) },
            ]}
          />
        </section>
        <section className="health-card" aria-label="耗时构成">
          <div className="card-head">
            <h2>耗时构成</h2>
            <span className="usage-muted">输出速度 {timing.tps === null ? "—" : `${formatTps(timing.tps)} tok/s`}</span>
          </div>
          <Donut
            label="耗时构成"
            center={formatDuration(active)}
            centerSub="活跃时长"
            slices={[
              { key: "wait", label: "模型等待（首字）", value: timing.waitMs, color: "var(--seg-1)", sub: `${formatDuration(timing.waitMs)} · ${timing.calls} 次` },
              { key: "gen", label: "模型生成", value: timing.genMs, color: "var(--seg-4)", sub: `${formatDuration(timing.genMs)} · ${timing.calls} 次` },
              { key: "tool", label: "工具执行", value: timing.toolMs, color: "var(--seg-3)", sub: `${formatDuration(timing.toolMs)} · ${timing.toolCalls} 次` },
            ]}
          />
        </section>
      </div>
      <section className="health-card usage-activity" aria-label="活跃度">
        <div className="card-head">
          <div className="heat-title">
            <h2>活跃度</h2>
            <span className="usage-muted heat-scope">近 26 周 · 按日花费 · 不受上方范围影响</span>
          </div>
        </div>
        <div className="heat-flex">
          <UsageHeatmap days={data.activity} />
          <div className="heat-summary">
            <div className="heat-stat">
              <strong>{activity.activeDays}</strong>
              <span>活跃天数</span>
            </div>
            <div className="heat-stat">
              <strong>{usageMoney(activity.totalCost)}</strong>
              <span>合计花费</span>
            </div>
            <div className="heat-stat">
              <strong>{activity.best === null ? "—" : usageMoney(activity.best.cost)}</strong>
              <span>{activity.best === null ? "最高单日" : `最高单日 · ${activity.best.key.slice(5)}`}</span>
            </div>
            <div className="heat-stat">
              <strong>{activity.streak}</strong>
              <span>连续活跃天数</span>
            </div>
          </div>
        </div>
      </section>
      <section className="health-card usage-top" aria-label="高花费会话">
        <h2>高花费会话</h2>
        <TopSessions sessions={data.topSessions} titleOf={sessionTitle} onOpen={onOpenSession} />
      </section>
      <StatsTable name="按项目" heads={["会话"]} total={data.total.cost.total} rows={data.byProject.map((p) => ({ key: p.cwd, name: p.cwd.split("/").filter(Boolean).pop() ?? p.cwd, title: p.cwd, cost: p.cost, tokens: p.tokens.total, cells: [`${p.sessions} 个会话`] }))} />
      <StatsTable name="按模型" heads={["调用", "速度", "首字延迟"]} total={data.total.cost.total} rows={data.byModel.map((m) => ({ key: JSON.stringify([m.provider, m.model]), name: `${m.provider || "未知提供商"} / ${m.model || "未知模型"}`, cost: m.cost, tokens: m.tokens.total, cells: [`${usageNumber(m.messages)} 次`, m.tps == null ? "—" : `${formatTps(m.tps)} tok/s`, formatMs(m.ttftMs ?? null)] }))} />
    </>}
  </>);
}

function HealthPanel({ range, onRange }: { range: UsageRange; onRange: (r: UsageRange) => void }) {
  const { data, loading, error, refresh } = useRangeData<UsageHealth>(`health:${range}`, () => getUsageHealth({ range }));
  return (
    <div className="usage-body" aria-busy={loading}>
      <RangeControls range={range} onRange={onRange} loading={loading} onRefresh={refresh} refreshLabel="刷新看板" />
      {loading && !data ? <div className="pane-note" role="status">正在汇总运行数据…</div> : null}
      {error ? <div className="banner banner-error" role="alert">{errorText(error)}<button type="button" className="btn btn-small" onClick={refresh}>重试</button></div> : null}
      {data ? <HealthBoard data={data} /> : null}
    </div>
  );
}

export function StatsView({ onBack, sessionTitle, onOpenSession }: { onBack: () => void; sessionTitle: (path: string) => string | null; onOpenSession: (path: string) => void }) {
  const [tab, setTab] = useState<StatsTab>("cost");
  const [costRange, setCostRange] = useState<UsageRange>("today");
  const [healthRange, setHealthRange] = useState<UsageRange>("today");
  // 看板首次访问后常驻（hidden 隐藏）：各自记住范围，切回不重复请求。
  const [healthVisited, setHealthVisited] = useState(false);
  return (
    <main className="detail">
      <header className="detail-head">
        <div className="detail-title-row">
          <h1 className="detail-title">用量统计</h1>
          <span className="detail-actions">
            <button type="button" className="btn" onClick={onBack}>返回</button>
          </span>
        </div>
        <p className="detail-sub">只读统计 · 主对话 + 后台调用 + 子代理 · fork 复制条目只计一次 · USD</p>
      </header>
      <div className="tabs" role="tablist" aria-label="用量统计">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`tab-stats-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`panel-stats-${t.key}`}
            className={tab === t.key ? "tab tab-active" : "tab"}
            onClick={() => {
              setTab(t.key);
              if (t.key === "health") setHealthVisited(true);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="panel-stats-cost" aria-labelledby="tab-stats-cost" hidden={tab !== "cost"} className="usage-panel">
        <OverviewPanel range={costRange} onRange={setCostRange} sessionTitle={sessionTitle} onOpenSession={onOpenSession} />
      </div>
      <div role="tabpanel" id="panel-stats-health" aria-labelledby="tab-stats-health" hidden={tab !== "health"} className="usage-panel">
        {healthVisited ? <HealthPanel range={healthRange} onRange={setHealthRange} /> : null}
      </div>
    </main>
  );
}
