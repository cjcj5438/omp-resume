import type { UsageHealth } from "../types";
import { usageNumber } from "./UsageSummary";
import { CacheHitChart, RequestsChart } from "./UsageCharts";
import { ERROR_KIND_NAME, cacheHitSeries, formatClock, formatErrorRate, formatHitRate } from "./usageFormat";
import "./Usage.css";

function modelName(provider: string, model: string): string {
  return `${provider || "未知提供商"} / ${model || "未知模型"}`;
}

export function HealthBoard({ data }: { data: UsageHealth }) {
  const cacheValid = cacheHitSeries(data.timeline.points).some((v) => v !== null);
  const maxKind = Math.max(0, ...data.errors.byKind.map((k) => k.count));
  const maxTarget = Math.max(0, ...data.fallbacks.byTarget.map((t) => t.count));
  return (
    <>
      <section className="kpi-grid" aria-label="关键指标">
        <div className="kpi-card">
          <span className="kpi-label">请求数</span>
          <strong className="kpi-value">{usageNumber(data.requests)}</strong>
          <span className="kpi-sub">含失败与用户中断</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">错误数</span>
          <strong className="kpi-value kpi-value-danger">{usageNumber(data.errors.total)}</strong>
          <span className="kpi-sub">错误率 {formatErrorRate(data.errors.total, data.requests)}</span>
          {data.errors.aborted > 0 ? <span className="kpi-sub">另有 {usageNumber(data.errors.aborted)} 次用户中断</span> : null}
        </div>
        <div className="kpi-card">
          <span className="kpi-label">兜底切换</span>
          <strong className="kpi-value">{usageNumber(data.fallbacks.total)}</strong>
          <span className="kpi-sub">占请求 {formatErrorRate(data.fallbacks.total, data.requests)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">缓存命中率</span>
          <strong className="kpi-value">{formatHitRate(data.cache.hitRate)}</strong>
          {data.cache.hitRate === null ? (
            <span className="kpi-sub">该上游未返回缓存数据</span>
          ) : (
            <span className="kpi-sub">缓存读 {usageNumber(data.cache.read)} · 写 {usageNumber(data.cache.write)}</span>
          )}
        </div>
      </section>

      <div className="health-grid">
        <section className="health-card" aria-label="请求趋势">
          <h2>请求趋势</h2>
          {data.requests > 0 ? (
            <>
              <RequestsChart unit={data.timeline.unit} points={data.timeline.points} />
              <div className="chart-legend" aria-hidden="true">
                <span><i className="legend-swatch legend-req" />请求</span>
                <span><i className="legend-swatch legend-err" />错误</span>
                <span><i className="legend-swatch legend-fb" />兜底</span>
              </div>
            </>
          ) : (
            <div className="pane-note">此范围内暂无请求</div>
          )}
        </section>

        <section className="health-card" aria-label="缓存命中率趋势">
          <h2>缓存命中率趋势</h2>
          {cacheValid ? (
            <CacheHitChart unit={data.timeline.unit} points={data.timeline.points} />
          ) : (
            <div className="pane-note">{data.requests === 0 ? "此范围内暂无请求" : "该上游未返回缓存数据"}</div>
          )}
        </section>

        <section className="health-card" aria-label="错误类型分布">
          <h2>错误类型分布</h2>
          {data.errors.byKind.length > 0 ? (
            <ul className="kind-list">
              {data.errors.byKind.map((k) => {
                const pct = data.errors.total > 0 ? `${((k.count / data.errors.total) * 100).toFixed(1)}%` : "—";
                return (
                  <li key={k.kind} data-tip={`${ERROR_KIND_NAME[k.kind] ?? "其他"}\n${usageNumber(k.count)} 次（占 ${pct}）`}>
                    <span className="kind-name">{ERROR_KIND_NAME[k.kind] ?? "其他"}</span>
                    <span className="usage-bar kind-bar" aria-hidden="true">
                      <span style={{ width: `${maxKind > 0 ? (k.count / maxKind) * 100 : 0}%` }} />
                    </span>
                    <span className="kind-count">{usageNumber(k.count)} 次</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="pane-note">此范围内还没有错误</div>
          )}
        </section>

        <section className="health-card" aria-label="兜底去向">
          <h2>兜底去向</h2>
          {data.fallbacks.byTarget.length > 0 ? (
            <>
              <ul className="kind-list">
                {data.fallbacks.byTarget.map((t) => {
                  const name = modelName(t.provider, t.model);
                  const pct = data.fallbacks.total > 0 ? `${((t.count / data.fallbacks.total) * 100).toFixed(1)}%` : "—";
                  return (
                    <li key={JSON.stringify([t.provider, t.model])} data-tip={`${name}\n${usageNumber(t.count)} 次（占 ${pct}）`}>
                      <span className="kind-name">{name}</span>
                      <span className="usage-bar kind-bar" aria-hidden="true">
                        <span style={{ width: `${maxTarget > 0 ? (t.count / maxTarget) * 100 : 0}%` }} />
                      </span>
                      <span className="kind-count">{usageNumber(t.count)} 次</span>
                    </li>
                  );
                })}
              </ul>
              {data.fallbacks.recent.length > 0 ? (
                <ol className="fb-recent" aria-label="最近兜底切换">
                  {data.fallbacks.recent.map((f, i) => (
                    <li key={`${f.time}-${f.to.provider}-${f.to.model}-${i}`}>
                      <span className="usage-muted">{formatClock(f.time)}</span>{" "}
                      {f.from ? modelName(f.from.provider, f.from.model) : "未知来源"} → {modelName(f.to.provider, f.to.model)}
                    </li>
                  ))}
                </ol>
              ) : null}
            </>
          ) : (
            <div className="pane-note">此范围内没有发生兜底切换</div>
          )}
        </section>
      </div>

      <section className="health-card" aria-label="最近错误">
        <h2>最近错误</h2>
        {data.errors.recent.length > 0 ? (
          <ol className="err-list">
            {data.errors.recent.map((e, i) => (
              <li key={`${e.time}-${e.provider}-${e.model}-${e.message}-${i}`} className="err-row" data-tip={`${ERROR_KIND_NAME[e.kind] ?? "其他"} · ${modelName(e.provider, e.model)}\n${formatClock(e.time)} ${e.message}`}>
                <span className="usage-muted err-time">{formatClock(e.time)}</span>
                <span className="err-model">{modelName(e.provider, e.model)}</span>
                <span className="badge badge-danger">{ERROR_KIND_NAME[e.kind] ?? "其他"}</span>
                <span className="err-msg">{e.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="pane-note">此范围内还没有错误</div>
        )}
      </section>

      <section className="usage-table-section" aria-label="按模型缓存命中">
        <h2>按模型缓存命中</h2>
        {data.cache.byModel.length > 0 ? (
          <table className="usage-table">
            <thead><tr><th scope="col">模型</th><th scope="col">请求数</th><th scope="col">命中率</th></tr></thead>
            <tbody>
              {data.cache.byModel.map((m) => {
                const name = modelName(m.provider, m.model);
                const pct = data.requests > 0 ? `${((m.requests / data.requests) * 100).toFixed(1)}%` : "—";
                return (
                  <tr key={JSON.stringify([m.provider, m.model])} data-tip={`${name}\n请求 ${usageNumber(m.requests)} 次（占 ${pct}） · 命中率 ${formatHitRate(m.hitRate)}`}>
                    <th scope="row">
                      <span className="usage-row-name">{name}</span>
                    </th>
                    <td>{usageNumber(m.requests)}</td>
                    <td>{formatHitRate(m.hitRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="pane-note">此范围内暂无模型缓存数据</div>
        )}
      </section>
    </>
  );
}
