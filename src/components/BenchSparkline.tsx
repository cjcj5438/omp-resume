/**
 * bench 表格小件：标签中文名 + 对比基线倍率 + tok/s 趋势 sparkline。
 * 从 ModelTesterPanel.tsx 逐字拆出，无行为变化。
 */
import type { ReactNode } from "react";
import type { BenchRound } from "../types";
import { roleInfo } from "../roleCards";

/** 标签中文名：角色名取 roleCards，否则原文。 */
export function tagLabel(id: string): string {
  return roleInfo(id)?.name ?? id;
}

/** 「对比主模型」倍率：≥1.1× 成功色，≤0.9× 警示色（语义变量，无绿色时用 accent）。 */
export function RatioCell({ ratio }: { ratio: number | null }): ReactNode {
  if (ratio === null) return <span className="muted">—</span>;
  const cls = ratio >= 1.1 ? "bench-ratio bench-ratio-fast" : ratio <= 0.9 ? "bench-ratio bench-ratio-slow" : "bench-ratio";
  return <span className={cls}>{ratio.toFixed(2)}×</span>;
}

/** 内联 sparkline：该模型最近 14 轮的 tok/s（无值断开，不断成 0）。 */
export function Sparkline({ rounds }: { rounds: BenchRound[] }): ReactNode {
  const tail = rounds.slice(-14);
  const values = tail.map((r) => r.tpsP50);
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return <span className="muted">—</span>;
  const W = 96;
  const H = 22;
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const span = max - min > 0 ? max - min : 1;
  const pts = values.map((v, i) => {
    const cx = values.length === 1 ? W / 2 : (i / (values.length - 1)) * W;
    return v === null ? null : { x: cx, y: 2 + (1 - (v - min) / span) * (H - 4) };
  });
  const d: string[] = [];
  pts.forEach((p, i) => {
    if (p === null) return;
    const prev = i > 0 ? pts[i - 1] : null;
    d.push(`${prev === null ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  });
  // 只有一个点时画圆点：单点路径只有 M 段，不可见。
  const single = pts.length === 1 ? pts[0] : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="bench-spark" role="img" aria-label={`tok/s 趋势：最近 ${tail.length} 轮`}>
      {single === null ? (
        <path d={d.join(" ")} className="bench-spark-line" />
      ) : (
        <circle cx={single.x.toFixed(1)} cy={single.y.toFixed(1)} r="2.5" className="bench-spark-dot" />
      )}
    </svg>
  );
}
