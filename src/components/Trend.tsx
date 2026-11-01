import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import "./Usage.css";

/** 涨跌箭头（设计稿 .trend：up 绿 / down 红 / flat 弱）。null 显示中性横线。 */
export function Trend({ delta }: { delta: number | null }) {
  if (delta === null || !Number.isFinite(delta) || delta === 0) {
    return (
      <span className="trend flat">
        <Minus className="ico" size={11} aria-hidden="true" />
        {"—"}
      </span>
    );
  }
  const up = delta > 0;
  const pct = `${up ? "+" : "−"}${Math.abs(delta * 100).toFixed(1)}%`;
  return (
    <span className={up ? "trend up" : "trend down"}>
      {up ? <TrendingUp className="ico" size={11} aria-hidden="true" /> : <TrendingDown className="ico" size={11} aria-hidden="true" />}
      {pct}
    </span>
  );
}
