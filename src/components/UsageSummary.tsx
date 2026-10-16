import { useEffect, useState } from "react";
import { getSessionUsage } from "../api";
import type { SessionUsage } from "../types";
import "./Usage.css";

export const usageNumber = (value: number) => value.toLocaleString("zh-CN");
export const usageMoney = (value: number) => `$${value.toFixed(2)}`;

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
  return <section className="usage-summary" aria-label="会话用量与花费">
    <div className="usage-summary-line">
      <strong>{usageMoney(data.cost.total)}</strong>
      <span>主对话 {usageMoney(data.cost.main)} · 后台 {usageMoney(data.cost.background)} · 子代理 {usageMoney(data.cost.subagent)}</span>
    </div>
    <div>消息：用户 {usageNumber(data.messages.user)} / 助手 {usageNumber(data.messages.assistant)} <span className="usage-muted">（全历史，含子代理；fork 复制归父会话）</span></div>
    <div>Token：输入 {usageNumber(data.tokens.input)} · 输出 {usageNumber(data.tokens.output)} · 缓存读 {usageNumber(data.tokens.cacheRead)} / 写 {usageNumber(data.tokens.cacheWrite)}</div>
    <div className="usage-models">模型：{data.models.length ? data.models.map((m) => `${m.provider || "未知提供商"} / ${m.model || "未知模型"}`).join("、") : "—"}</div>
  </section>;
}
