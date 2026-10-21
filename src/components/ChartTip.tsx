/** 全应用共享悬浮提示：`data-tip="第一行\n第二行…"` 的元素悬停/聚焦时显示统一样式浮层（首行加粗）。文档级委托，App 根部挂载一次。 */
import { useEffect, useState } from "react";
import "./ChartTip.css";
export function ChartTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let current: Element | null = null;
    const of = (t: EventTarget | null): Element | null =>
      t instanceof Element ? t.closest("[data-tip]") : null;
    const show = (el: Element, x: number, y: number): void => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      current = el;
      setTip({ text, x, y });
    };
    const hide = (): void => {
      current = null;
      setTip(null);
    };
    const onOver = (e: PointerEvent): void => {
      const el = of(e.target);
      if (el === null) hide();
      else show(el, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent): void => {
      if (current !== null && current.contains(of(e.target))) {
        const text = current.getAttribute("data-tip");
        if (text !== null) setTip({ text, x: e.clientX, y: e.clientY });
      }
    };
    const onOut = (e: PointerEvent): void => {
      const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (current !== null && (to === null || !current.contains(to))) hide();
    };
    const onFocus = (e: FocusEvent): void => {
      const el = of(e.target);
      if (el === null) return;
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.bottom);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (tip === null) return null;
  const nl = tip.text.indexOf("\n");
  const first = nl < 0 ? tip.text : tip.text.slice(0, nl);
  const rest = nl < 0 ? "" : tip.text.slice(nl + 1);
  // 按象限翻转：浮层永远收进视口内，无需测尺寸。
  const flipX = tip.x > window.innerWidth - 300;
  const flipY = tip.y > window.innerHeight - 160;
  return (
    <div
      className="chart-tip"
      role="tooltip"
      style={{
        left: flipX ? undefined : tip.x + 14,
        right: flipX ? window.innerWidth - tip.x + 14 : undefined,
        top: flipY ? undefined : tip.y + 16,
        bottom: flipY ? window.innerHeight - tip.y + 12 : undefined,
      }}
    >
      <strong>{first}</strong>
      {rest === "" ? null : rest}
    </div>
  );
}
