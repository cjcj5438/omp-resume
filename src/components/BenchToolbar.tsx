/**
 * bench 工具条：添加模型 / 测试全部 / 监控间隔 / 一键推荐。
 * 从 ModelTesterPanel.tsx 逐字拆出，无行为变化。
 */
import type { ReactNode } from "react";
import { formatUsd } from "../format";
import { benchRunner, type BenchConfig, type BenchIntervalMin } from "../modelBench";

const INTERVAL_OPTIONS: { value: BenchIntervalMin; label: string }[] = [
  { value: 0, label: "关" },
  { value: 30, label: "30分" },
  { value: 60, label: "1时" },
  { value: 360, label: "6时" },
];

export interface BenchToolbarProps {
  benchCount: number;
  selectors: string[];
  estimateAll: number;
  dailyEstimate: number;
  config: BenchConfig;
  onUpdateConfig: (next: BenchConfig) => void;
  onAdd: () => void;
  onRecommend: () => void;
}

export function BenchToolbar(props: BenchToolbarProps): ReactNode {
  const { benchCount, selectors, estimateAll, dailyEstimate, config, onUpdateConfig, onAdd, onRecommend } = props;
  return (
    <div className="bench-toolbar">
      <div className="bench-actions">
        <button type="button" className="btn" onClick={onAdd}>+ 添加模型</button>
        <button
          type="button"
          className="btn btn-accent"
          disabled={benchCount === 0}
          onClick={() => benchRunner.enqueueMany(selectors)}
          title={benchCount === 0 ? "先添加模型" : `共 ${benchCount} 个模型依次测试`}
        >
          ▶ 测试全部 ≈{formatUsd(estimateAll)}
        </button>
      </div>
      <div className="bench-monitor">
        <span className="muted">监控</span>
        <div className="bench-segment" role="radiogroup" aria-label="监控间隔">
          {INTERVAL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={config.intervalMin === opt.value}
              className={
                config.intervalMin === opt.value ? "segment-item segment-item-active" : "segment-item"
              }
              onClick={() => onUpdateConfig({ ...config, intervalMin: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="muted bench-estimate" title="每轮花费 × 每天轮数 × 被监控的模型数">
          ≈{formatUsd(dailyEstimate)}/天
        </span>
      </div>
      <button type="button" className="btn" onClick={onRecommend}>一键推荐</button>
    </div>
  );
}
