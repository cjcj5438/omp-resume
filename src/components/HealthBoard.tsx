import { useEffect, useState } from "react";
import { Activity, CircleAlert, Info, ScrollText, Terminal, Zap } from "lucide-react";
import type { ErrorKind, UsageHealth } from "../types";
import { usageNumber } from "../format";
import { Badge, EmptyState } from "./ui";
import { Kpi, Panel, Seg } from "./page";
import { CacheHitChart, RequestsChart } from "./UsageCharts";
import { ERROR_KIND_NAME, cacheHitSeries, formatErrorRate, formatHitRate } from "./usageFormat";
import "./Usage.css";

function modelName(provider: string, model: string): string {
  return `${provider || "未知提供商"} / ${model || "未知模型"}`;
}

function modelShort(provider: string, model: string): string {
  return model || provider || "未知模型";
}

/** 错误 badge 语义：超时/服务端/网络/认证 → danger；限流/额度/其他 → warn。 */
function kindTone(kind: ErrorKind): "danger" | "warn" {
  return kind === "timeout" || kind === "server" || kind === "network" || kind === "auth" ? "danger" : "warn";
}

/** HH:MM:SS 本地时间（设计稿 log 时间列）。 */
function clockS(time: number): string {
  const d = new Date(time);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 延迟毫秒 → "1.9s"/"640ms"（KPI 脚注用）。 */
function latencyText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function HealthBoard({ data, rangeLabel }: { data: UsageHealth; rangeLabel: string }) {
  const cacheValid = cacheHitSeries(data.timeline.points).some((v) => v !== null);
  const maxKind = Math.max(0, ...data.errors.byKind.map((k) => k.count));
  const maxTarget = Math.max(0, ...data.fallbacks.byTarget.map((t) => t.count));
  const [kind, setKind] = useState<ErrorKind | "all">("all");
  // data 变化后当前 kind 已不在其中：重置为 all。
  useEffect(() => {
    if (kind !== "all" && !data.errors.byKind.some((k) => k.kind === kind)) setKind("all");
  }, [data, kind]);
  const filtered = kind === "all" ? data.errors.recent : data.errors.recent.filter((e) => e.kind === kind);
  const fbFrom = data.fallbacks.recent.find((f) => f.from !== null)?.from ?? null;
  const fbTo = data.fallbacks.recent[0]?.to ?? data.fallbacks.byTarget[0] ?? null;
  const topKind = data.errors.byKind.reduce<{ kind: ErrorKind; count: number } | null>(
    (best, k) => (best === null || k.count > best.count ? k : best),
    null,
  );
  return (
    <div className="section-stack">
      <section className="grid-4" aria-label="关键指标" style={{ marginBottom: 16 }}>
        <Kpi
          label="请求"
          value={usageNumber(data.requests)}
          foot={<><span className="dot ok" aria-hidden="true" />最近{rangeLabel}</>}
        />
        <Kpi
          label="错误"
          value={<>{usageNumber(data.errors.total)} <small>{formatErrorRate(data.errors.total, data.requests)}</small></>}
          foot={data.errors.aborted > 0 ? `另有 ${usageNumber(data.errors.aborted)} 次用户中断` : "含失败与用户中断"}
        />
        <Kpi
          label="回退切换"
          value={usageNumber(data.fallbacks.total)}
          foot={fbFrom && fbTo ? `${modelShort(fbFrom.provider, fbFrom.model)} → ${modelShort(fbTo.provider, fbTo.model)}` : "占请求 " + formatErrorRate(data.fallbacks.total, data.requests)}
        />
        <Kpi
          label="缓存命中"
          value={formatHitRate(data.cache.hitRate)}
          foot={data.latencyMs === null ? "p50 — · p95 —" : `p50 ${latencyText(data.latencyMs.p50)} · p95 ${latencyText(data.latencyMs.p95)}`}
        />
      </section>

      <div className="grid-2">
        <Panel title="错误类型" icon={CircleAlert} meta={`${usageNumber(data.errors.total)} 次 · ${rangeLabel}`}>
          {data.errors.byKind.length > 0 ? (
            <>
              <div className="bars" role="img" aria-label={`错误类型分布：${data.errors.byKind.map((k) => `${ERROR_KIND_NAME[k.kind]} ${usageNumber(k.count)} 次`).join("，")}`}>
                {data.errors.byKind.map((k) => (
                  <div key={k.kind} className="bar-row" style={{ gridTemplateColumns: "120px minmax(0, 1fr) 60px" }} data-tip={`${ERROR_KIND_NAME[k.kind] ?? "其他"}\n${usageNumber(k.count)} 次`}>
                    <span className="name">{ERROR_KIND_NAME[k.kind] ?? "其他"}</span>
                    <span className="bar-track" aria-hidden="true">
                      <span className="bar-fill" style={{ width: `${maxKind > 0 ? (k.count / maxKind) * 100 : 0}%`, background: k.count > 3 ? "var(--danger)" : "var(--warn)" }} />
                    </span>
                    <span className="val">{k.count} 次</span>
                  </div>
                ))}
              </div>
              {topKind !== null ? (
                <div className="inline-note" style={{ marginTop: 16 }}>
                  <Info size={13} aria-hidden="true" />
                  <span>{`${ERROR_KIND_NAME[topKind.kind]}最多（${usageNumber(topKind.count)} 次），${data.fallbacks.total > 0 ? `已触发 ${usageNumber(data.fallbacks.total)} 次兜底切换` : "未触发兜底切换"}；重试恢复情况见下方日志的重试列。`}</span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="pane-note">此范围内还没有错误</div>
          )}
        </Panel>

        <Panel title="缓存命中趋势" icon={Activity} meta={rangeLabel}>
          {cacheValid ? (
            <CacheHitChart unit={data.timeline.unit} points={data.timeline.points} />
          ) : (
            <div className="pane-note">{data.requests === 0 ? "此范围内暂无请求" : "该上游未返回缓存数据"}</div>
          )}
          {data.cache.byModel.length > 0 ? (
            <div className="tbl-wrap" style={{ marginTop: 12 }}>
              <table className="tbl">
                <thead><tr><th scope="col">模型</th><th scope="col" className="r">命中率</th><th scope="col" className="r">请求</th></tr></thead>
                <tbody>
                  {data.cache.byModel.map((m) => (
                    <tr key={JSON.stringify([m.provider, m.model])} data-tip={`${modelName(m.provider, m.model)}\n请求 ${usageNumber(m.requests)} 次 · 命中率 ${formatHitRate(m.hitRate)}`}>
                      <td className="mono" style={{ fontSize: 11 }}>{modelName(m.provider, m.model)}</td>
                      <td className="r mono">{formatHitRate(m.hitRate)}</td>
                      <td className="r mono" style={{ color: "var(--text-faint)" }}>{usageNumber(m.requests)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="pane-note">此范围内暂无模型缓存数据</div>
          )}
        </Panel>
      </div>

      <Panel
        title={<>最近错误 <span className="usage-muted">{filtered.length}/{data.errors.recent.length} 条</span></>}
        icon={Terminal}
        actions={
          <Seg
            label="错误类型筛选"
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: "全部" },
              ...data.errors.byKind.map((k) => ({
                value: k.kind as ErrorKind | "all",
                label: ERROR_KIND_NAME[k.kind],
                count: k.count,
              })),
            ]}
          />
        }
        body="flush"
      >
        {filtered.length > 0 ? (
          <div role="list" aria-label="错误日志">
            {filtered.map((e, i) => (
              <div
                key={`${e.time}-${e.provider}-${e.model}-${e.message}-${i}`}
                className="log-row"
                role="listitem"
                data-tip={`${ERROR_KIND_NAME[e.kind] ?? "其他"} · ${modelName(e.provider, e.model)}\n${clockS(e.time)} ${e.message}${e.retry ? `\n${e.retry}` : ""}`}
              >
                <span className="lg-time">{clockS(e.time)}</span>
                <span className="lg-model">{modelShort(e.provider, e.model)}</span>
                <span className="lg-msg"><Badge tone={kindTone(e.kind)}>{ERROR_KIND_NAME[e.kind] ?? "其他"}</Badge> {e.message}</span>
                <span className="lg-retry">{e.retry ?? ""}</span>
              </div>
            ))}
          </div>
        ) : kind === "all" ? (
          <EmptyState icon={Terminal} title="此范围内还没有错误">
            换个时间范围试试。
          </EmptyState>
        ) : (
          <EmptyState icon={Terminal} title="没有此类错误">
            切换筛选查看其他错误类型。
          </EmptyState>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="请求趋势" icon={Zap} meta="扩展">
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
        </Panel>

        <Panel title="兜底去向" icon={ScrollText} meta="扩展">
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
                      <span className="usage-muted">{clockS(f.time)}</span>{" "}
                      {f.from ? modelName(f.from.provider, f.from.model) : "未知来源"} → {modelName(f.to.provider, f.to.model)}
                    </li>
                  ))}
                </ol>
              ) : null}
            </>
          ) : (
            <div className="pane-note">此范围内没有发生兜底切换</div>
          )}
        </Panel>
      </div>
    </div>
  );
}
