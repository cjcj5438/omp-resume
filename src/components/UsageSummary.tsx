/** 会话级用量概览（设计稿 4 行 detail-list：输入/输出/缓存命中/成本）。
 * 切换会话时丢弃上一会话的迟到结果（path+revision 双校验）。
 */
import { useEffect, useState } from "react";
import { getSessionUsage } from "../api";
import { usageMoney } from "../format";
import { cacheHitRate, compactNumber, formatHitRate } from "./usageFormat";
import type { SessionUsage } from "../types";

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
  return (
    <dl className="detail-list" aria-label="会话用量与花费">
      <div className="detail-row">
        <dt>输入</dt>
        <dd className="mono">{compactNumber(data.tokens.input)}</dd>
      </div>
      <div className="detail-row">
        <dt>输出</dt>
        <dd className="mono">{compactNumber(data.tokens.output)}</dd>
      </div>
      <div className="detail-row">
        <dt>缓存命中</dt>
        <dd className="mono">{formatHitRate(cacheHitRate(data.tokens))}</dd>
      </div>
      <div className="detail-row">
        <dt>成本</dt>
        <dd className="mono">{usageMoney(data.cost.total)}</dd>
      </div>
    </dl>
  );
}
