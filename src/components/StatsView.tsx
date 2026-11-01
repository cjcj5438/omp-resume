import { useEffect, useRef, useState } from "react";
import { getUsageHealth, getUsageStats, normalizeError } from "../api";
import { errorText, formatMs, formatTps, usageMoney, usageNumber } from "../format";
import type { AppError, UsageHealth, UsageRange, UsageStats } from "../types";
import { copyText } from "../clipboard";
import { HealthBoard } from "./HealthBoard";
import { Kpi, TopSessions } from "./UsageCards";
import { TrendChart, type TrendMetric } from "./UsageCharts";
import { Donut } from "./UsageDonut";
import { UsageHeatmap } from "./UsageHeatmap";
import { activitySummary, cacheHitRate, compactNumber, formatDuration, formatHitRate, heatDayDetail, usageSummaryText, type HeatMetric } from "./usageFormat";
import { EmptyState } from "./ui";
import { PageHeader, Seg } from "./page";
import { ChartColumn } from "lucide-react";
import "./Usage.css";

export type StatsRoute = "usage" | "health";
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
      <Seg
        label="统计范围"
        value={range}
        onChange={onRange}
        options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
      />
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

function OverviewPanel({ range, onRange, sessionTitle, onOpenSession, onData }: { range: UsageRange; onRange: (r: UsageRange) => void; sessionTitle: (path: string) => string | null; onOpenSession: (path: string) => void; onData: (d: UsageStats | null) => void }) {
  const { data, loading, error, refresh } = useRangeData<UsageStats>(`stats:${range}`, () => getUsageStats({ range }));
  const [metric, setMetric] = useState<TrendMetric>("cost");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("cost");
  const [heatSelected, setHeatSelected] = useState<string | null>(null);
  useEffect(() => {
    onData(data);
  }, [data, onData]);
  // 选中日默认取 activity 最后一项；数据刷新后 key 不在则回落。
  const lastKey = data?.activity.length ? data.activity[data.activity.length - 1].key : null;
  const effectiveSelected = heatSelected !== null && data?.activity.some((d) => d.key === heatSelected) ? heatSelected : lastKey;
  return (
    <div className="usage-body" aria-busy={loading}>
      <RangeControls range={range} onRange={onRange} loading={loading} onRefresh={refresh} refreshLabel="刷新统计" />
      {loading && !data ? <div className="pane-note" role="status">正在扫描用量…</div> : null}
      {error ? <div className="banner banner-error" role="alert">{errorText(error)}<button type="button" className="btn btn-small" onClick={refresh}>重试</button></div> : null}
      {data ? <OverviewBody data={data} metric={metric} onMetric={setMetric} sessionTitle={sessionTitle} onOpenSession={onOpenSession} heatMetric={heatMetric} onHeatMetric={setHeatMetric} heatSelected={effectiveSelected} onHeatSelect={setHeatSelected} /> : null}
    </div>
  );
}

function formatDelta(delta: number | null): string {
  if (delta === null) return "—";
  const pct = delta * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** 选中日块：日期 + 花费/Token + 较前 7 天日均涨跌。 */
function HeatDayBlock({ days, selectedKey }: { days: UsageStats["activity"]; selectedKey: string }) {
  const detail = heatDayDetail(days, selectedKey);
  if (detail === null) return null;
  return (
    <div className="heat-day" aria-label="选中日">
      <span className="heat-day-date">{detail.key} {detail.weekday}</span>
      <span>花费 {usageMoney(detail.cost)}</span>
      <span>Token {usageNumber(detail.tokens)}</span>
      <span className="usage-muted">较前 7 天日均：花费 {formatDelta(detail.costDelta)} · Token {formatDelta(detail.tokensDelta)}</span>
    </div>
  );
}

function OverviewBody({ data, metric, onMetric, sessionTitle, onOpenSession, heatMetric, onHeatMetric, heatSelected, onHeatSelect }: { data: UsageStats; metric: TrendMetric; onMetric: (m: TrendMetric) => void; sessionTitle: (path: string) => string | null; onOpenSession: (path: string) => void; heatMetric: HeatMetric; onHeatMetric: (m: HeatMetric) => void; heatSelected: string | null; onHeatSelect: (key: string) => void }) {
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
          <Seg
            label="趋势指标"
            value={metric}
            onChange={onMetric}
            options={[
              { value: "cost", label: "花费" },
              { value: "tokens", label: "Token" },
            ]}
          />
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
            <span className="usage-muted heat-scope">近 26 周 · 按日{heatMetric === "cost" ? "花费" : "Token"} · 不受上方范围影响</span>
          </div>
          <Seg
            label="热力指标"
            value={heatMetric}
            onChange={onHeatMetric}
            options={[
              { value: "cost", label: "花费" },
              { value: "tokens", label: "Token" },
            ]}
          />
        </div>
        <div className="heat-flex">
          <UsageHeatmap days={data.activity} metric={heatMetric} selectedKey={heatSelected} onSelect={onHeatSelect} />
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
        {heatSelected !== null ? <HeatDayBlock days={data.activity} selectedKey={heatSelected} /> : null}
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

export function StatsView({ tab, sessionTitle, onOpenSession, onToast }: { tab: StatsRoute; sessionTitle: (path: string) => string | null; onOpenSession: (path: string) => void; onToast: (text: string, kind: "info" | "error") => void }) {
  const [costRange, setCostRange] = useState<UsageRange>("today");
  const [healthRange, setHealthRange] = useState<UsageRange>("today");
  const [stats, setStats] = useState<UsageStats | null>(null);
  // 看板首次访问后常驻（hidden 隐藏）：各自记住范围，切回不重复请求。
  const [healthVisited, setHealthVisited] = useState(false);
  useEffect(() => {
    if (tab === "health") setHealthVisited(true);
  }, [tab]);

  async function copySummary() {
    if (stats === null) return;
    const label = RANGES.find((r) => r.value === costRange)?.label ?? costRange;
    if (await copyText(usageSummaryText(stats, label))) onToast("已复制用量摘要", "info");
    else onToast("复制失败：剪贴板不可用", "error");
  }

  return (
    <div className="view">
      {tab === "usage" ? (
        <PageHeader
          kicker="分析 · 来自 usage 记录"
          title="用量"
          sub="只读统计 · 主对话 + 后台调用 + 子代理 · fork 复制条目只计一次 · USD"
          actions={
            <button type="button" className="btn" disabled={stats === null} onClick={() => void copySummary()}>
              复制摘要
            </button>
          }
        />
      ) : (
        <PageHeader
          kicker="分析 · 来自 usage 记录"
          title="运行健康"
          sub="请求、错误、兜底切换与缓存命中，上游是否不稳一眼可见。"
        />
      )}
      <div role="tabpanel" id="panel-stats-cost" aria-label="用量" hidden={tab !== "usage"} className="usage-panel">
        <OverviewPanel range={costRange} onRange={setCostRange} sessionTitle={sessionTitle} onOpenSession={onOpenSession} onData={setStats} />
      </div>
      <div role="tabpanel" id="panel-stats-health" aria-label="运行健康" hidden={tab !== "health"} className="usage-panel">
        {healthVisited ? <HealthPanel range={healthRange} onRange={setHealthRange} /> : null}
      </div>
    </div>
  );
}
