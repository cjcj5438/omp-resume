import { useEffect, useState } from "react";
import { getUsageStats, normalizeError } from "../api";
import { errorText } from "../format";
import type { AppError, UsageStats } from "../types";
import { usageMoney, usageNumber } from "./UsageSummary";
import "./Usage.css";

interface StatsRow {
  key: string;
  name: string;
  title?: string;
  cost: number;
  tokens: number;
  detail?: string;
}

function StatsTable({ name, rows, total }: { name: string; rows: StatsRow[]; total: number }) {
  return <section className="usage-table-section">
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

export function StatsView({ onBack }: { onBack: () => void }) {
  const [sinceDays, setSinceDays] = useState<number | null>(30);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    void getUsageStats({ sinceDays }).then((next) => {
      if (alive) setData(next);
    }).catch((e: unknown) => {
      if (alive) setError(normalizeError(e));
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [sinceDays, refresh]);
  return <main className="detail usage-view">
    <header className="detail-head"><div className="detail-title-row"><h1 className="detail-title">用量统计</h1><button type="button" className="btn" onClick={onBack}>返回会话</button></div>
      <p className="usage-muted">只读统计 · 主对话 + 后台调用 + 子代理 · fork 复制条目只计一次 · USD</p>
      <div className="usage-controls" role="group" aria-label="统计范围">
        <button type="button" className="btn" aria-pressed={sinceDays === 30} onClick={() => setSinceDays(30)}>近 30 天</button>
        <button type="button" className="btn" aria-pressed={sinceDays === null} onClick={() => setSinceDays(null)}>全部</button>
        <button type="button" className="btn" disabled={loading} onClick={() => setRefresh((v) => v + 1)}>刷新统计</button>
      </div>
    </header>
    <div className="usage-body" aria-busy={loading}>
      {loading ? <div className="pane-note" role="status">正在扫描用量…</div> : null}
      {error ? <div className="banner banner-error" role="alert">{errorText(error)}<button type="button" className="btn btn-small" onClick={() => setRefresh((v) => v + 1)}>重试</button></div> : null}
      {data && !loading ? <>
        <section className="usage-overview" aria-label="用量总计"><strong className="usage-total">{usageMoney(data.total.cost.total)}</strong>
          <div>主对话 {usageMoney(data.total.cost.main)} · 后台 {usageMoney(data.total.cost.background)} · 子代理 {usageMoney(data.total.cost.subagent)}</div>
          <div>Token 总计 {usageNumber(data.total.tokens.total)}</div>
          <div className="usage-muted">输入 {usageNumber(data.total.tokens.input)} · 输出 {usageNumber(data.total.tokens.output)} · 缓存读 {usageNumber(data.total.tokens.cacheRead)} / 写 {usageNumber(data.total.tokens.cacheWrite)}</div>
        </section>
        {!data.byProject.length ? <div className="pane-note">此范围内暂无用量数据</div> : <>
          <StatsTable name="按项目" total={data.total.cost.total} rows={data.byProject.map((p) => ({ key: p.cwd, name: p.cwd.split("/").filter(Boolean).pop() ?? p.cwd, title: p.cwd, cost: p.cost, tokens: p.tokens.total, detail: `${p.sessions} 个会话` }))} />
          <StatsTable name="按模型" total={data.total.cost.total} rows={data.byModel.map((m) => ({ key: JSON.stringify([m.provider, m.model]), name: `${m.provider || "未知提供商"} / ${m.model || "未知模型"}`, cost: m.cost, tokens: m.tokens.total, detail: `${usageNumber(m.messages)} 次调用` }))} />
          <StatsTable name="按天" total={data.total.cost.total} rows={data.byDay.map((d) => ({ key: d.date, name: d.date, cost: d.cost, tokens: d.tokens.total }))} />
        </>}
      </> : null}
    </div>
  </main>;
}
