import { useEffect, useRef, useState } from "react";
import { getUsageHealth, getUsageStats, normalizeError } from "../api";
import { errorText } from "../format";
import type { AppError, UsageHealth, UsageRange, UsageStats } from "../types";
import { HealthBoard } from "./HealthBoard";
import { CostTrendChart } from "./UsageCharts";
import { usageMoney, usageNumber } from "./UsageSummary";
import "./Usage.css";

type StatsTab = "cost" | "health";

const TABS: { key: StatsTab; label: string }[] = [
  { key: "cost", label: "花费" },
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
  useEffect(() => {
    const key = `${fetchKey}#${nonce}`;
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
      <div role="group" aria-label="统计范围" className="usage-seg">
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
  detail?: string;
}

function StatsTable({ name, rows, total }: { name: string; rows: StatsRow[]; total: number }) {
  return <section className="usage-table-section" aria-label={name}>
    <h2>{name}</h2>
    <table className="usage-table">
      <thead><tr><th scope="col">{name.slice(1)}</th><th scope="col">花费（USD）</th><th scope="col">Token</th><th scope="col">数量</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <th scope="row" title={row.title ?? row.name}><span className="usage-row-name">{row.name}</span><span className="usage-bar" aria-hidden="true"><span style={{ width: `${total > 0 ? Math.min(100, row.cost / total * 100) : 0}%` }} /></span></th>
        <td>{usageMoney(row.cost)}</td><td>{usageNumber(row.tokens)}</td><td>{row.detail ?? "—"}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}

function CostPanel({ range, onRange }: { range: UsageRange; onRange: (r: UsageRange) => void }) {
  const { data, loading, error, refresh } = useRangeData<UsageStats>(`stats:${range}`, () => getUsageStats({ range }));
  return (
    <div className="usage-body" aria-busy={loading}>
      <RangeControls range={range} onRange={onRange} loading={loading} onRefresh={refresh} refreshLabel="刷新统计" />
      {loading && !data ? <div className="pane-note" role="status">正在扫描用量…</div> : null}
      {error ? <div className="banner banner-error" role="alert">{errorText(error)}<button type="button" className="btn btn-small" onClick={refresh}>重试</button></div> : null}
      {data ? <>
        <section className="usage-overview" aria-label="用量总计"><strong className="usage-total">{usageMoney(data.total.cost.total)}</strong>
          <div>主对话 {usageMoney(data.total.cost.main)} · 后台 {usageMoney(data.total.cost.background)} · 子代理 {usageMoney(data.total.cost.subagent)}</div>
          <div>Token 总计 {usageNumber(data.total.tokens.total)}</div>
          <div className="usage-muted">输入 {usageNumber(data.total.tokens.input)} · 输出 {usageNumber(data.total.tokens.output)} · 缓存读 {usageNumber(data.total.tokens.cacheRead)} / 写 {usageNumber(data.total.tokens.cacheWrite)}</div>
        </section>
        {!data.byProject.length ? <div className="pane-note">此范围内暂无用量数据</div> : <>
          <section className="health-card usage-trend" aria-label="花费趋势">
            <h2>花费趋势</h2>
            <CostTrendChart unit={data.trend.unit} points={data.trend.points} />
          </section>
          <StatsTable name="按项目" total={data.total.cost.total} rows={data.byProject.map((p) => ({ key: p.cwd, name: p.cwd.split("/").filter(Boolean).pop() ?? p.cwd, title: p.cwd, cost: p.cost, tokens: p.tokens.total, detail: `${p.sessions} 个会话` }))} />
          <StatsTable name="按模型" total={data.total.cost.total} rows={data.byModel.map((m) => ({ key: JSON.stringify([m.provider, m.model]), name: `${m.provider || "未知提供商"} / ${m.model || "未知模型"}`, cost: m.cost, tokens: m.tokens.total, detail: `${usageNumber(m.messages)} 次调用` }))} />
        </>}
      </> : null}
    </div>
  );
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

export function StatsView({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<StatsTab>("cost");
  const [costRange, setCostRange] = useState<UsageRange>("30d");
  const [healthRange, setHealthRange] = useState<UsageRange>("today");
  // 看板首次访问后常驻（hidden 隐藏）：各自记住范围，切回不重复请求。
  const [healthVisited, setHealthVisited] = useState(false);
  return (
    <main className="detail usage-view">
      <header className="detail-head">
        <div className="detail-title-row"><h1 className="detail-title">用量统计</h1><button type="button" className="btn" onClick={onBack}>返回会话</button></div>
        <p className="usage-muted">只读统计 · 主对话 + 后台调用 + 子代理 · fork 复制条目只计一次 · USD</p>
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
      </header>
      <div role="tabpanel" id="panel-stats-cost" aria-labelledby="tab-stats-cost" hidden={tab !== "cost"} className="usage-panel">
        <CostPanel range={costRange} onRange={setCostRange} />
      </div>
      <div role="tabpanel" id="panel-stats-health" aria-labelledby="tab-stats-health" hidden={tab !== "health"} className="usage-panel">
        {healthVisited ? <HealthPanel range={healthRange} onRange={setHealthRange} /> : null}
      </div>
    </main>
  );
}
