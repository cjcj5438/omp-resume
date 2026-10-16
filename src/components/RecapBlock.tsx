/** 会话概要（omp recap，只读）：无 recap 不渲染；默认折叠到若干行，可展开。 */
import { useEffect, useState } from "react";
import { getSessionRecap } from "../api";

export function RecapBlock({ sessionId }: { sessionId: string }) {
  const [recap, setRecap] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRecap(null);
    setOpen(false);
    getSessionRecap(sessionId)
      .then((text) => {
        if (!cancelled) setRecap(text);
      })
      .catch(() => {
        // 概要是附加信息：读取失败静默不显示。
        if (!cancelled) setRecap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!recap) return null;
  return (
    <section className="recap" aria-label="会话概要">
      <div className={open ? "recap-text" : "recap-text recap-collapsed"}>{recap}</div>
      <button
        type="button"
        className="btn btn-small"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起概要" : "展开概要"}
      </button>
    </section>
  );
}
