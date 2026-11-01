import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChartNoAxesColumn, Copy, Cpu, Folder, RefreshCw, ScrollText } from "lucide-react";
import { getUsageHealth, getUsageStats, normalizeError } from "../api";
import { errorText, formatMs, formatTps, usageMoney, usageNumber } from "../format";
import type { AppError, UsageHealth, UsageRange, UsageStats } from "../types";
import { copyText } from "../clipboard";
import { AreaChart } from "./AreaChart";
import { HealthBoard } from "./HealthBoard";
import { HourlyChart } from "./HourlyChart";
import { Donut } from "./UsageDonut";
import { UsageBars } from "./UsageBars";
import { UsageHeatmap, HeatScale, heatTextOf } from "./UsageHeatmap";
import { Trend } from "./Trend";
import { TopSessionsTable } from "./TopSessionsTable";
import {
  activitySummary,
  cacheHitRate,
  compactNumber,
  formatDuration,
  formatHitRate,
  formatMaxDuration,
  heatDayDetail,
  prevDelta,
  usageSummaryText,
  type HeatMetric,
  type TrendMetric,
} from "./usageFormat";
import { EmptyState } from "./ui";
import { Kpi, PageHeader, Panel, Seg } from "./page";
import "./Usage.css";

export type StatsRoute = "usage" | "health";

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "all", label: "全部" },
];

const rangeLabel = (range: UsageRange): string => RANGES.find((r) => r.value === range)?.label ?? range;

const DONUT_COLORS = [
  "var(--accent)",
  "color-mix(in srgb, var(--accent) 62%, var(--bg-raised))",
  "color-mix(in srgb, var(--accent) 36%, var(--bg-raised))",
  "var(--text-faint)",
] as const;

/**
 * 范围数据请求：alive 标志保证迟到响应不覆盖当前结果；
 * 已加载键命中时跳过（切换标签页回来不重复请求）。
 */
function useRangeData<T>(fetchKey: string, load: () => Promise<T>): {
  data: T | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => void;
  /** 已落定的请求轮次（成功/失败都计）：调用方可据此判断"本轮刷新结束了"。 */
  settled: number;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState(0);
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
        if (!alive) return;
        setLoading(false);
        setSettled((n) => n + 1);
      });
    return () => {
      alive = false;
    };
  }, [fetchKey, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh, settled };
}

function OverviewPanel({
  range,
  onRange,
  onControls,
  sessionTitle,
  onOpenSession,
  onData,
}: {
  range: UsageRange;
  onRange: (r: UsageRange) => void;
  /** 页头控件（range seg + 刷新）：页头在 StatsView 层，数据层把控件递上去。 */
  onControls: (controls: ReactNode) => void;
  sessionTitle: (path: string) => string | null;
  onOpenSession: (path: string) => void;
  onData: (d: UsageStats | null) => void;
}) {
  const { data, loading, error, refresh } = useRangeData<UsageStats>(`stats:${range}`, () => getUsageStats({ range }));
  const [metric, setMetric] = useState<TrendMetric>("cost");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("requests");
  const [heatSelected, setHeatSelected] = useState<string | null>(null);
  useEffect(() => {
    onData(data);
  }, [data, onData]);
  useEffect(() => {
    onControls(
      <>
        <Seg
          label="统计范围"
          value={range}
          onChange={onRange}
          options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
        <button type="button" className="btn btn-ghost" disabled={loading} onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          刷新统计
        </button>
      </>,
    );
  }, [range, onRange, loading, refresh, onControls]);
  // 选中日默认取 activity 最后一项；数据刷新后 key 不在则回落。
  const lastKey = data?.activity.length ? data.activity[data.activity.length - 1].key : null;
  const effectiveSelected = heatSelected !== null && data?.activity.some((d) => d.key === heatSelected) ? heatSelected : lastKey;
  return (
    <div className="usage-body" aria-busy={loading}>
      {loading && !data ? <div className="pane-note" role="status">正在扫描用量…</div> : null}
      {error ? <div className="banner banner-error" role="alert">{errorText(error)}<button type="button" className="btn btn-small" onClick={refresh}>重试</button></div> : null}
      {data ? (
        <OverviewBody
          data={data}
          range={range}
          metric={metric}
          onMetric={setMetric}
          sessionTitle={sessionTitle}
          onOpenSession={onOpenSession}
          heatMetric={heatMetric}
          onHeatMetric={setHeatMetric}
          heatSelected={effectiveSelected}
          onHeatSelect={setHeatSelected}
        />
      ) : null}
    </div>
  );
}

const HEAT_METRIC_META: Record<HeatMetric, { label: string; unit: string }> = {
  requests: { label: "请求", unit: "次" },
  tokens: { label: "Token", unit: "" },
  cost: { label: "成本", unit: "" },
};

/** 选中日详情 aside：大标题 + 30px 值 + 趋势行 + 4 行 dl（含主要项目）。 */
function HeatDetail({ days, selectedKey, metric }: { days: UsageStats["activity"]; selectedKey: string; metric: HeatMetric }) {
  const detail = heatDayDetail(days, selectedKey);
  if (detail === null) return null;
  const meta = HEAT_METRIC_META[metric];
  const empty = detail.requests === 0;
  const delta = metric === "tokens" ? detail.tokensDelta : metric === "cost" ? detail.costDelta : detail.requestsDelta;
  const [, m, day] = detail.key.slice(0, 10).split("-").map(Number);
  const topName = detail.topProject === null ? "—" : (detail.topProject.split("/").filter(Boolean).pop() ?? detail.topProject);
  return (
    <aside className="heat-detail" aria-label="选中日">
      <div className="heat-detail-head">
        <span className="heat-detail-date">{`${m} 月 ${day} 日`}</span>
        <span className="heat-detail-dow">{`${detail.weekday}${detail.key > days[days.length - 1].key ? " · 未发生" : ""}`}</span>
      </div>
      <div className={`heat-detail-value${empty ? " is-empty" : ""}`}>
        {empty ? "—" : heatTextOf(detail, metric)}
        {empty || meta.unit === "" ? null : <span>{meta.unit}</span>}
      </div>
      <div className={`heat-detail-trend${empty ? "" : delta !== null && delta !== 0 ? (delta > 0 ? " up" : " down") : ""}`}>
        {empty
          ? "当天无请求记录"
          : delta === null
            ? "暂无前 7 天均值可比"
            : `较前 7 天日均 ${delta > 0 ? "+" : delta < 0 ? "−" : ""}${delta === 0 ? "0" : Math.abs(Math.round(delta * 100))}%`}
      </div>
      <dl className="detail-list">
        <div className="detail-row"><dt>请求</dt><dd className="mono">{detail.requests} 次</dd></div>
        <div className="detail-row"><dt>Token</dt><dd className="mono">{compactNumber(detail.tokens)}</dd></div>
        <div className="detail-row"><dt>成本</dt><dd className="mono">{usageMoney(detail.cost)}</dd></div>
        <div className="detail-row"><dt>主要项目</dt><dd title={detail.topProject ?? undefined}>{topName}</dd></div>
      </dl>
    </aside>
  );
}

function OverviewBody({
  data,
  range,
  metric,
  onMetric,
  sessionTitle,
  onOpenSession,
  heatMetric,
  onHeatMetric,
  heatSelected,
  onHeatSelect,
}: {
  data: UsageStats;
  range: UsageRange;
  metric: TrendMetric;
  onMetric: (m: TrendMetric) => void;
  sessionTitle: (path: string) => string | null;
  onOpenSession: (path: string) => void;
  heatMetric: HeatMetric;
  onHeatMetric: (m: HeatMetric) => void;
  heatSelected: string | null;
  onHeatSelect: (key: string) => void;
}) {
  const { total, timing } = data;
  const active = timing.waitMs + timing.genMs + timing.toolMs;
  const hit = cacheHitRate(total.tokens);
  const activity = activitySummary(data.activity.map((d) => ({ key: d.key, cost: d.requests })));
  const label = rangeLabel(range);
  const costDelta = prevDelta(total.cost.total, data.prev?.cost);
  const peakCost = Math.max(0, ...data.trend.points.map((p) => p.cost));
  const peakTokens = Math.max(0, ...data.trend.points.map((p) => p.tokens.total));
  const bestDay = activity.best;
  const heatScope = data.activity.length;
  return (
    <div className="section-stack">
      <section className="grid-3" aria-label="用量总计" style={{ marginBottom: 16 }}>
        <Kpi
          label="成本"
          value={usageMoney(total.cost.total)}
          foot={<><Trend delta={costDelta} /> 较上一周期</>}
        />
        <Kpi
          label="Token"
          value={compactNumber(total.tokens.total)}
          foot={<span className="muted">输入 + 输出 · 含缓存读</span>}
        />
        <Kpi
          label="请求数"
          value={usageNumber(data.requests)}
          foot={`${label} · 含重试`}
        />
        <Kpi
          label="缓存命中"
          value={formatHitRate(hit)}
          foot="缓存读取 / 总输入"
        />
        <Kpi
          label="工具耗时"
          value={formatDuration(timing.toolMs)}
          foot={`按工具调用累计 · ${usageNumber(timing.toolCalls)} 次`}
        />
        <Kpi
          label="最长单次"
          value={formatMaxDuration(timing.maxDurationMs)}
          foot="单次请求 · 来自 usage"
        />
      </section>
      {!data.byProject.length ? (
        <EmptyState icon={ChartNoAxesColumn} title="此范围内暂无用量数据">
          换个时间范围试试。
        </EmptyState>
      ) : (
        <>
          <HourlyChart hourly={data.hourly} rangeLabel={label} />
          <div className="grid-2">
            <Panel
              title={metric === "cost" ? "成本趋势" : "Token 趋势"}
              icon={ChartNoAxesColumn}
              actions={
                <div className="trend-head-tools">
                  <div className="chart-legend" aria-hidden="true">
                    <span>
                      <i className="legend-swatch legend-trend" />
                      {`每${data.trend.unit === "hour" ? "小时" : range === "all" || range === "30d" ? "段" : "日"}${metric === "cost" ? "成本" : "Token"}`}
                    </span>
                  </div>
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
              }
              foot={
                <>
                  <span>{metric === "cost" ? `峰值 ${usageMoney(peakCost)}` : `峰值 ${compactNumber(peakTokens)}`}</span>
                  <span className="mono">{label}</span>
                </>
              }
            >
              <AreaChart unit={data.trend.unit} points={data.trend.points} metric={metric} />
            </Panel>
            <Panel title="项目构成" icon={Folder} meta="按成本">
              <UsageBars
                label="项目构成"
                rows={data.byProject.map((p) => ({
                  key: p.cwd,
                  name: p.cwd.split("/").filter(Boolean).pop() ?? p.cwd,
                  title: `${p.cwd}\n花费 ${usageMoney(p.cost)} · Token ${usageNumber(p.tokens.total)} · ${p.sessions} 个会话`,
                  share: total.cost.total > 0 ? (p.cost / total.cost.total) * 100 : 0,
                  value: total.cost.total > 0 ? `${((p.cost / total.cost.total) * 100).toFixed(0)}%` : "—",
                }))}
                note={`${data.byProject.length} 个项目 · ${usageNumber(data.sessions)} 个会话`}
              />
            </Panel>
          </div>
          <div className="grid-2">
            <Panel title="模型构成" icon={Cpu} meta={label}>
              <Donut
                label="模型构成"
                slices={data.byModel.map((m, i) => ({
                  key: JSON.stringify([m.provider, m.model]),
                  label: m.model || "未知模型",
                  value: m.cost,
                  color: DONUT_COLORS[Math.min(i, DONUT_COLORS.length - 1)],
                  sub: `${usageMoney(m.cost)} · ${usageNumber(m.messages)} 次`,
                }))}
              />
            </Panel>
            <Panel title="成本最高的会话" icon={ScrollText} meta="点按进入">
              <TopSessionsTable sessions={data.topSessions} titleOf={sessionTitle} onOpen={onOpenSession} />
            </Panel>
          </div>
          <Panel title="Token 与耗时构成" icon={Cpu} meta="扩展">
            <div className="grid-2-even">
              <div aria-label="Token 构成">
                <Donut
                  label="Token 构成"
                  centerMain={compactNumber(total.tokens.total)}
                  centerSub="总用量"
                  slices={[
                    { key: "input", label: "输入", value: total.tokens.input, color: "var(--seg-1)", sub: usageNumber(total.tokens.input) },
                    { key: "cacheRead", label: "缓存读", value: total.tokens.cacheRead, color: "var(--seg-2)", sub: usageNumber(total.tokens.cacheRead) },
                    { key: "cacheWrite", label: "缓存写", value: total.tokens.cacheWrite, color: "var(--seg-3)", sub: usageNumber(total.tokens.cacheWrite) },
                    { key: "output", label: "输出", value: total.tokens.output, color: "var(--seg-4)", sub: usageNumber(total.tokens.output) },
                  ]}
                />
              </div>
              <div aria-label="耗时构成">
                <div className="usage-muted">输出速度 {timing.tps === null ? "—" : `${formatTps(timing.tps)} tok/s`}</div>
                <Donut
                  label="耗时构成"
                  centerMain={formatDuration(active)}
                  centerSub="活跃时长"
                  slices={[
                    { key: "wait", label: "模型等待（首字）", value: timing.waitMs, color: "var(--seg-1)", sub: `${formatDuration(timing.waitMs)} · ${timing.calls} 次` },
                    { key: "gen", label: "模型生成", value: timing.genMs, color: "var(--seg-4)", sub: `${formatDuration(timing.genMs)} · ${timing.calls} 次` },
                    { key: "tool", label: "工具执行", value: timing.toolMs, color: "var(--seg-3)", sub: `${formatDuration(timing.toolMs)} · ${timing.toolCalls} 次` },
                  ]}
                />
              </div>
            </div>
          </Panel>
          <Panel
            title="活动热力图"
            icon={ChartNoAxesColumn}
            actions={
              <div className="heat-head-tools">
                <span className="panel-meta">最近 52 周 · 按{HEAT_METRIC_META[heatMetric].label}着色</span>
                <Seg
                  label="热力指标"
                  value={heatMetric}
                  onChange={onHeatMetric}
                  options={[
                    { value: "requests", label: "请求" },
                    { value: "tokens", label: "Token" },
                    { value: "cost", label: "花费" },
                  ]}
                />
              </div>
            }
          >
            <div className="heat-stats" aria-label="活跃度汇总">
              <div className="heat-stat">
                <span className="heat-stat-label">活跃天数</span>
                <span className="heat-stat-value">{activity.activeDays}<small> / {heatScope}</small></span>
                <span className="heat-stat-sub">近 52 周有请求的日期</span>
              </div>
              <div className="heat-stat">
                <span className="heat-stat-label">当前连续</span>
                <span className="heat-stat-value">{activity.streak}<small> 天</small></span>
                <span className="heat-stat-sub">截至今天</span>
              </div>
              <div className="heat-stat">
                <span className="heat-stat-label">最长连续</span>
                <span className="heat-stat-value">{activity.longest}<small> 天</small></span>
                <span className="heat-stat-sub">近 52 周最长</span>
              </div>
              <div className="heat-stat">
                <span className="heat-stat-label">峰值单日</span>
                <span className="heat-stat-value">{bestDay === null ? "—" : usageNumber(bestDay.cost)}<small> 次</small></span>
                <span className="heat-stat-sub">{bestDay === null ? "近 52 周无请求" : `${Number(bestDay.key.slice(5, 7))}/${Number(bestDay.key.slice(8, 10))} · 单日请求`}</span>
              </div>
            </div>
            <div className="heat-layout">
              <div className="heat-main">
                <UsageHeatmap days={data.activity} metric={heatMetric} selectedKey={heatSelected} onSelect={onHeatSelect} />
                <div className="heat-foot">
                  <span>{heatScope} 天中活跃 {activity.activeDays} 天 · 空白表示无请求</span>
                  <HeatScale />
                </div>
              </div>
              {heatSelected !== null ? <HeatDetail days={data.activity} selectedKey={heatSelected} metric={heatMetric} /> : null}
            </div>
          </Panel>
          <Panel title="明细" icon={Folder} meta="按项目 · 按模型">
            <div className="section-stack">
              <div className="tbl-wrap" aria-label="按项目">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">项目</th>
                      <th scope="col" className="r">花费（USD）</th>
                      <th scope="col" className="r">Token</th>
                      <th scope="col" className="r">会话</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byProject.map((p) => (
                      <tr key={p.cwd} data-tip={`${p.cwd}\n花费 ${usageMoney(p.cost)}（占 ${total.cost.total > 0 ? `${((p.cost / total.cost.total) * 100).toFixed(1)}%` : "—"}） · Token ${usageNumber(p.tokens.total)}`}>
                        <th scope="row"><span className="strong">{p.cwd.split("/").filter(Boolean).pop() ?? p.cwd}</span><span className="sub">{p.cwd}</span></th>
                        <td className="r mono">{usageMoney(p.cost)}</td>
                        <td className="r mono">{usageNumber(p.tokens.total)}</td>
                        <td className="r mono">{p.sessions} 个会话</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="tbl-wrap" aria-label="按模型">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      <th scope="col" className="r">花费（USD）</th>
                      <th scope="col" className="r">Token</th>
                      <th scope="col" className="r">调用</th>
                      <th scope="col" className="r">速度</th>
                      <th scope="col" className="r">首字延迟</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((m) => (
                      <tr key={JSON.stringify([m.provider, m.model])} data-tip={`${m.provider || "未知提供商"} / ${m.model || "未知模型"}\n花费 ${usageMoney(m.cost)} · Token ${usageNumber(m.tokens.total)}`}>
                        <th scope="row"><span className="strong">{`${m.provider || "未知提供商"} / ${m.model || "未知模型"}`}</span></th>
                        <td className="r mono">{usageMoney(m.cost)}</td>
                        <td className="r mono">{usageNumber(m.tokens.total)}</td>
                        <td className="r mono">{usageNumber(m.messages)} 次</td>
                        <td className="r mono">{m.tps == null ? "—" : `${formatTps(m.tps)} tok/s`}</td>
                        <td className="r mono">{formatMs(m.ttftMs ?? null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function HealthPanel({
  range,
  onRange,
  onControls,
  onToast,
}: {
  range: UsageRange;
  onRange: (r: UsageRange) => void;
  onControls: (controls: ReactNode) => void;
  onToast: (text: string, kind: "info" | "error") => void;
}) {
  const { data, loading, error, refresh, settled } = useRangeData<UsageHealth>(`health:${range}`, () => getUsageHealth({ range }));
  // 手动刷新成功才 toast；初次加载/切范围/失败不打扰（health-P0-1 刷新文案子项）。
  // 以 settled 轮次配对"点击时那一轮"：刷新点击后 settled +1 且无错才算成功。
  const toastRef = useRef<{ waitSettled: number; label: string } | null>(null);
  useEffect(() => {
    const pending = toastRef.current;
    if (pending === null || settled < pending.waitSettled) return;
    toastRef.current = null;
    if (error === null && data !== null) onToast(`健康数据已刷新 · ${pending.label}`, "info");
  }, [settled, error, data, onToast]);
  const refreshWithToast = useCallback(() => {
    toastRef.current = { waitSettled: settled + 1, label: rangeLabel(range) };
    refresh();
  }, [range, refresh, settled]);
  useEffect(() => {
    onControls(
      <>
        <Seg
          label="统计范围"
          value={range}
          onChange={onRange}
          options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
        <button type="button" className="btn btn-ghost" disabled={loading} onClick={refreshWithToast}>
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </>,
    );
  }, [range, onRange, loading, refreshWithToast, onControls]);
  return (
    <div className="usage-body" aria-busy={loading}>
      {loading && !data ? <div className="pane-note" role="status">正在汇总运行数据…</div> : null}
      {error ? <div className="banner banner-error" role="alert">{errorText(error)}<button type="button" className="btn btn-small" onClick={refresh}>重试</button></div> : null}
      {data ? <HealthBoard data={data} rangeLabel={rangeLabel(range)} /> : null}
    </div>
  );
}

export function StatsView({ tab, sessionTitle, onOpenSession, onToast }: { tab: StatsRoute; sessionTitle: (path: string) => string | null; onOpenSession: (path: string) => void; onToast: (text: string, kind: "info" | "error") => void }) {
  const [costRange, setCostRange] = useState<UsageRange>("7d");
  const [healthRange, setHealthRange] = useState<UsageRange>("7d");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [usageControls, setUsageControls] = useState<ReactNode>(null);
  const [healthControls, setHealthControls] = useState<ReactNode>(null);
  // 看板首次访问后常驻（hidden 隐藏）：各自记住范围，切回不重复请求。
  const [healthVisited, setHealthVisited] = useState(false);
  useEffect(() => {
    if (tab === "health") setHealthVisited(true);
  }, [tab]);

  async function copySummary() {
    if (stats === null) return;
    if (await copyText(usageSummaryText(stats, rangeLabel(costRange)))) onToast("已复制用量摘要", "info");
    else onToast("复制失败：剪贴板不可用", "error");
  }

  return (
    <div className="view">
      {tab === "usage" ? (
        <PageHeader
          kicker="分析 · 来自 usage 记录"
          title="用量"
          sub="成本、token、缓存与工具耗时全部由会话文件里的 usage 记录推导，不额外估算。"
          actions={
            <>
              <button type="button" className="btn btn-ghost" disabled={stats === null} onClick={() => void copySummary()}>
                <Copy size={14} aria-hidden="true" />
                复制摘要
              </button>
              {usageControls}
            </>
          }
        />
      ) : (
        <PageHeader
          kicker="分析 · 来自 usage 记录"
          title="运行健康"
          sub="请求、错误、兜底切换与缓存命中，上游是否不稳一眼可见。"
          actions={healthControls}
        />
      )}
      <div role="tabpanel" id="panel-stats-cost" aria-label="用量" hidden={tab !== "usage"} className="usage-panel">
        <OverviewPanel range={costRange} onRange={setCostRange} onControls={setUsageControls} sessionTitle={sessionTitle} onOpenSession={onOpenSession} onData={setStats} />
      </div>
      <div role="tabpanel" id="panel-stats-health" aria-label="运行健康" hidden={tab !== "health"} className="usage-panel">
        {healthVisited ? <HealthPanel range={healthRange} onRange={setHealthRange} onControls={setHealthControls} onToast={onToast} /> : null}
      </div>
    </div>
  );
}
