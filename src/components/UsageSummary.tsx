/** 会话级用量概览：顶部一行紧凑指标（花费 / Token / 消息 / 模型），无外框。
 *  切换会话时丢弃上一会话的迟到结果（path+revision 双校验）。 */
import { useEffect, useState } from "react";
import { getSessionUsage } from "../api";
import { usageMoney, usageNumber } from "../format";
import type { SessionUsage } from "../types";
import "./Usage.css";

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return usageNumber(n);
}

export function UsageSummary({ path, supported, revision }: { path: string; supported: boolean; revision: string }) {
  const [result, setResult] = useState<{ path: string; revision: string; data: SessionUsage } | null>(null);
  useEffect(() => {
    let alive = true;
    setResult(null);
    if (supported) {
      void getSessionUsage({ path }).then((data) => {
        if (alive) setResult({ path, revision, data });
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [path, supported, revision]);
  if (!supported || result?.path !== path || result.revision !== revision) return null;
  const { data } = result;
  const tokens = data.tokens.input + data.tokens.output + data.tokens.cacheRead + data.tokens.cacheWrite;
  return (
    <section className="usage-summary" aria-label="会话用量与花费">
      <div className="usage-metric">
        <span className="usage-metric-label">花费</span>
        <strong className="usage-metric-value usage-metric-accent">{usageMoney(data.cost.total)}</strong>
        <span className="usage-metric-sub">
          <span className="usage-part">主 {usageMoney(data.cost.main)}</span>
          <span className="usage-part">后台 {usageMoney(data.cost.background)}</span>
          <span className="usage-part">子代理 {usageMoney(data.cost.subagent)}</span>
        </span>
      </div>
      <div className="usage-metric">
        <span className="usage-metric-label">Token</span>
        <strong className="usage-metric-value">{compact(tokens)}</strong>
        <span className="usage-metric-sub">
          <span className="usage-part">入 {compact(data.tokens.input)}</span>
          <span className="usage-part">出 {compact(data.tokens.output)}</span>
          <span className="usage-part">缓存 {compact(data.tokens.cacheRead + data.tokens.cacheWrite)}</span>
        </span>
      </div>
      <div className="usage-metric">
        <span className="usage-metric-label">消息</span>
        <strong className="usage-metric-value usage-metric-pair">
          {usageNumber(data.messages.user)}<span className="usage-metric-unit">问</span>
          {usageNumber(data.messages.assistant)}<span className="usage-metric-unit">答</span>
        </strong>
        <span className="usage-metric-sub">全历史，含子代理与 fork</span>
      </div>
      <p className="usage-models usage-metric-wide">
        <span className="usage-metric-label">模型</span>
        {data.models.length
          ? data.models.map((m) => `${m.provider || "未知提供商"} / ${m.model || "未知模型"}`).join("、")
          : "—"}
      </p>
    </section>
  );
}
