/**
 * 引用关系图（CONTRACT §18.10）：选中库内记忆的引用边，SVG 直绘、无依赖。
 * 交互只做核心：悬停高亮邻域、点击选卡、滚轮缩放、拖拽平移/移点、图例过滤。
 * 节点大小按关联数（degree）；悬停提示走全局 `data-tip`（ChartTip worker 提供）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { memoryGraph, normalizeError } from "../api";
import type { MemoryGraph as GraphData, MemoryGraphEdgeKind, MemoryKind } from "../types";
import { errorText, formatFullTime, formatRelativeTime } from "../format";
import { layoutGraph } from "./graphLayout";
import type { ToastFn } from "./useOmpOp";
import "./MemoryPanel.css";

const KIND_LABEL: Record<MemoryGraphEdgeKind, string> = {
  summary: "摘要",
  related: "关联",
  context: "上下文",
};
const NODE_LABEL: Record<MemoryKind, string> = { working: "工作记忆", episodic: "情节摘要" };
const EDGE_COLOR: Record<MemoryGraphEdgeKind, string> = {
  summary: "var(--accent)",
  related: "var(--text-muted)",
  context: "var(--badge-inuse-ink)",
};
const NODE_FILL: Record<MemoryKind, string> = {
  working: "var(--accent)",
  episodic: "var(--badge-label-bg)",
};

const VB_W = 640;
const VB_H = 420;
const MIN_K = 0.35;
const MAX_K = 3.5;

interface Viewport {
  x: number;
  y: number;
  k: number;
}

const HOME_VIEW: Viewport = { x: 0, y: 0, k: 1 };

/** 指针捕获：合成事件等无活动指针时 `setPointerCapture` 会抛错，忽略即可。 */
function capturePointer(e: { currentTarget: Element; pointerId: number }): void {
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch {
    /* 无活动指针（如测试合成事件），拖拽照常走 move/up 即可 */
  }
}

/** 片段截断（锁步：节点下标签 14 字、相邻/边提示 24 字统一走这里）。 */
function truncSnippet(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function MemoryGraph(props: {
  bank: string;
  displayName: string;
  onOpenInList: (id: string) => void;
  onToast: ToastFn;
}): ReactNode {
  const { bank, displayName, onOpenInList, onToast } = props;
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<Viewport>(HOME_VIEW);
  const [pos, setPos] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Record<MemoryGraphEdgeKind, boolean>>({
    summary: false,
    related: false,
    context: false,
  });
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    | { mode: "pan"; startX: number; startY: number; origX: number; origY: number; moved: boolean }
    | { mode: "node"; id: string; dx: number; dy: number; moved: boolean }
    | null
  >(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setSelectedId(null);
    setHoverId(null);
    setView(HOME_VIEW);
    memoryGraph({ bank })
      .then((g) => {
        if (!alive) return;
        setData(g);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const text = errorText(normalizeError(e));
        setLoadError(text);
        onToast(`加载关系图失败：${text}`, "error");
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [bank, onToast]);

  const visibleEdges = useMemo(
    () => (data === null ? [] : data.edges.filter((e) => !hidden[e.kind])),
    [data, hidden],
  );
  // 全量边参与布局，图例只控制显隐，开关不过度跳动。
  // 小库收缩布局盒（按 sqrt(n)，上限全画布）再居中，避免几个点被扯满屏。
  const basePos = useMemo(() => {
    if (data === null) return new Map<string, { x: number; y: number }>();
    const s = Math.min(1, Math.sqrt(Math.max(data.nodes.length, 1) / 30));
    const w = Math.max(240, VB_W * s);
    const h = Math.max(200, VB_H * s);
    const m = layoutGraph(
      data.nodes.map((n) => n.id),
      data.edges.map((e) => ({ source: e.source, target: e.target })),
      { width: w, height: h },
    );
    for (const p of m.values()) {
      p.x += (VB_W - w) / 2;
      p.y += (VB_H - h) / 2;
    }
    return m;
  }, [data]);

  useEffect(() => {
    setPos(new Map(basePos));
  }, [basePos]);

  const neighbors = useMemo(() => {
    const map = new Map<string, { id: string; kind: MemoryGraphEdgeKind }[]>();
    for (const e of visibleEdges) {
      if (!map.has(e.source)) map.set(e.source, []);
      if (!map.has(e.target)) map.set(e.target, []);
      map.get(e.source)?.push({ id: e.target, kind: e.kind });
      map.get(e.target)?.push({ id: e.source, kind: e.kind });
    }
    return map;
  }, [visibleEdges]);

  const nodeById = useMemo(
    () => new Map((data?.nodes ?? []).map((n) => [n.id, n])),
    [data],
  );
  const focusId = hoverId ?? selectedId;
  const focusSet = useMemo(() => {
    if (focusId === null) return null;
    const set = new Set<string>([focusId]);
    for (const nb of neighbors.get(focusId) ?? []) set.add(nb.id);
    return set;
  }, [focusId, neighbors]);

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const vx = ((clientX - rect.left) / rect.width) * VB_W;
    const vy = ((clientY - rect.top) / rect.height) * VB_H;
    return { x: (vx - view.x) / view.k, y: (vy - view.y) / view.k };
  }

  // 滚轮缩放（围绕光标，需非被动监听以阻止页面滚动）。
  // svg 随数据到达后才挂载，loading 翻 false 时（重）绑；卸载时清理。
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const vx = ((e.clientX - rect.left) / rect.width) * VB_W;
      const vy = ((e.clientY - rect.top) / rect.height) * VB_H;
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-e.deltaY * 0.0015)));
        const wx = (vx - v.x) / v.k;
        const wy = (vy - v.y) / v.k;
        return { k, x: vx - wx * k, y: vy - wy * k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [loading]);

  function resetView(): void {
    setView(HOME_VIEW);
    setPos(new Map(basePos));
  }

  if (loading) return <div className="pane-note">关系图加载中…</div>;
  if (loadError !== null) return <div className="pane-note">关系图加载失败：{loadError}</div>;
  if (data === null) return null;

  const selected = selectedId === null ? null : nodeById.get(selectedId) ?? null;
  const selectedNeighbors = selectedId === null ? [] : (neighbors.get(selectedId) ?? []);

  return (
    <section className="mem-graph" aria-label={`${displayName}的引用关系图`}>
      <div className="mem-list-head">
        <h3 className="mem-list-title">{displayName} 的关系图</h3>
        <button type="button" className="btn btn-small" onClick={resetView}>
          重置视图
        </button>
      </div>
      {data.totalNodes === 0 ? (
        <div className="pane-note">该库暂无记忆，没有可展示的关系。</div>
      ) : data.nodes.length === 0 ? (
        <div className="pane-note">
          该库暂无引用关系（另有 {data.unlinkedCount} 条记忆没有引用关系）。
        </div>
      ) : (
        <>
          <p className="muted mem-graph-count" aria-live="polite">
            显示 {data.nodes.length} / 共 {data.totalNodes} 条记忆 · {visibleEdges.length} 条引用边
            {data.truncated ? "（已按关联度取前 200）" : ""}
            {data.unlinkedCount > 0 ? ` · 另有 ${data.unlinkedCount} 条记忆没有引用关系` : ""}
          </p>
          <div className="mem-graph-wrap">
            <div className="mem-graph-main">
              <svg
                ref={svgRef}
                className="mem-graph-canvas"
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                role="img"
                aria-label="记忆引用关系图，滚轮缩放，拖拽平移"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  // 只消费本次 Esc：关掉选中卡，不要冒泡到 Drawer（否则抽屉一起关）。
                  // 没有选中卡时不拦截，Esc 照常关闭抽屉。
                  if (selectedId === null) return;
                  e.stopPropagation();
                  setSelectedId(null);
                }}
                onPointerDown={(e) => {
                  capturePointer(e);
                  dragRef.current = {
                    mode: "pan",
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: view.x,
                    origY: view.y,
                    moved: false,
                  };
                }}
                onPointerMove={(e) => {
                  const drag = dragRef.current;
                  if (!drag) return;
                  if (drag.mode === "pan") {
                    const svg = svgRef.current;
                    if (!svg) return;
                    const rect = svg.getBoundingClientRect();
                    const dx = ((e.clientX - drag.startX) / rect.width) * VB_W;
                    const dy = ((e.clientY - drag.startY) / rect.height) * VB_H;
                    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
                    if (drag.moved) setView((v) => ({ ...v, x: drag.origX + dx, y: drag.origY + dy }));
                  } else {
                    const w = toWorld(e.clientX, e.clientY);
                    const nx = w.x - drag.dx;
                    const ny = w.y - drag.dy;
                    const cur = pos.get(drag.id);
                    if (cur && Math.abs(nx - cur.x) + Math.abs(ny - cur.y) > 1) drag.moved = true;
                    if (drag.moved) {
                      setPos((prev) => {
                        const next = new Map(prev);
                        next.set(drag.id, {
                          x: Math.min(VB_W - 24, Math.max(24, nx)),
                          y: Math.min(VB_H - 24, Math.max(24, ny)),
                        });
                        return next;
                      });
                    }
                  }
                }}
                onPointerUp={() => {
                  const drag = dragRef.current;
                  dragRef.current = null;
                  if (drag && !drag.moved && drag.mode === "pan") setSelectedId(null);
                  if (drag && !drag.moved && drag.mode === "node") setSelectedId(drag.id);
                }}
              >
                <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                  {visibleEdges.map((e, i) => {
                    const a = pos.get(e.source);
                    const b = pos.get(e.target);
                    if (!a || !b) return null;
                    const active = focusSet === null || (focusSet.has(e.source) && focusSet.has(e.target));
                    const tip =
                      `${KIND_LABEL[e.kind]}\n` +
                      `${truncSnippet(nodeById.get(e.source)?.snippet ?? e.source, 24)} → ` +
                      truncSnippet(nodeById.get(e.target)?.snippet ?? e.target, 24);
                    return (
                      <g key={`${e.source}|${e.target}|${e.kind}|${i}`} opacity={active ? 0.9 : 0.12} data-tip={tip}>
                        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={8} style={{ pointerEvents: "stroke" }} />
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke={EDGE_COLOR[e.kind]}
                          strokeWidth={active ? 2 : 1}
                          pointerEvents="none"
                        />
                      </g>
                    );
                  })}
                  {data.nodes.map((n) => {
                    const p = pos.get(n.id);
                    if (!p) return null;
                    const inFocus = focusSet !== null && focusSet.has(n.id);
                    const r = 6 + Math.min(10, n.degree * 1.5);
                    return (
                      <g
                        key={n.id}
                        transform={`translate(${p.x} ${p.y})`}
                        opacity={focusSet !== null && !inFocus ? 0.25 : 1}
                        onPointerEnter={() => setHoverId(n.id)}
                        onPointerLeave={() => setHoverId((cur) => (cur === n.id ? null : cur))}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          capturePointer(e);
                          const w = toWorld(e.clientX, e.clientY);
                          dragRef.current = { mode: "node", id: n.id, dx: w.x - p.x, dy: w.y - p.y, moved: false };
                        }}
                        data-tip={`${NODE_LABEL[n.kind]} · ${n.createdAt === null ? "时间未知" : formatRelativeTime(n.createdAt)}\n${n.snippet}\n关联 ${n.degree} 条`}
                      >
                        <circle
                          r={r}
                          fill={NODE_FILL[n.kind]}
                          stroke={selectedId === n.id ? "var(--accent)" : "var(--bg-card)"}
                          strokeWidth={selectedId === n.id ? 3 : 1.5}
                          style={{ cursor: "grab" }}
                        />
                        {inFocus ? (
                          <text y={r + 11} textAnchor="middle" fontSize={9} fill="var(--text-muted)" pointerEvents="none">
                            {truncSnippet(n.snippet, 14)}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}
                </g>
              </svg>
              <div className="mem-graph-legend" aria-label="图例">
                <span className="mem-graph-legend-item">
                  <i className="mem-graph-dot" style={{ background: NODE_FILL.working }} />
                  工作记忆
                </span>
                <span className="mem-graph-legend-item">
                  <i className="mem-graph-dot" style={{ background: NODE_FILL.episodic }} />
                  情节摘要
                </span>
                <span className="mem-chips" role="group" aria-label="边种类过滤">
                  {(Object.keys(KIND_LABEL) as MemoryGraphEdgeKind[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="btn btn-small"
                      aria-pressed={!hidden[k]}
                      onClick={() => setHidden((prev) => ({ ...prev, [k]: !prev[k] }))}
                    >
                      <i className="mem-graph-edgekey" style={{ background: EDGE_COLOR[k] }} />
                      {KIND_LABEL[k]}
                    </button>
                  ))}
                </span>
                <span className="muted">节点大小按关联数</span>
              </div>
            </div>
            {selected !== null ? (
              <aside className="mem-graph-side" aria-label="选中记忆">
                <div className="mem-row">
                  <span className={`mem-pill mem-pill-${selected.kind}`}>{NODE_LABEL[selected.kind]}</span>
                  <span className="mem-row-meta">
                    <span title={selected.createdAt === null ? undefined : formatFullTime(selected.createdAt)}>
                      {selected.createdAt === null ? "时间未知" : formatRelativeTime(selected.createdAt)}
                    </span>
                  </span>
                </div>
                <p className="mem-graph-snippet">{selected.snippet}</p>
                <dl className="mem-meta mem-graph-meta">
                  <div>
                    <dt>召回</dt>
                    <dd>{selected.recallCount} 次</dd>
                  </div>
                  <div>
                    <dt>关联</dt>
                    <dd>{selected.degree} 条</dd>
                  </div>
                  <div>
                    <dt>重要度</dt>
                    <dd>{selected.importance === null ? "—" : selected.importance.toFixed(2)}</dd>
                  </div>
                </dl>
                {selectedNeighbors.length > 0 ? (
                  <div className="mem-facts">
                    <h4>相邻记忆（{selectedNeighbors.length}）</h4>
                    <ul>
                      {selectedNeighbors.map((nb) => {
                        const target = nodeById.get(nb.id);
                        return (
                          <li key={`${nb.kind}-${nb.id}`}>
                            <button
                              type="button"
                              className="btn btn-small mem-graph-nblink"
                              onClick={() => setSelectedId(nb.id)}
                              title={target?.snippet ?? nb.id}
                            >
                              {KIND_LABEL[nb.kind]} · {truncSnippet(target?.snippet ?? nb.id, 24)}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                <div className="mem-detail-actions">
                  <button type="button" className="btn btn-small" onClick={() => onOpenInList(selected.id)}>
                    在列表中打开
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setSelectedId(null)}>
                    取消选择
                  </button>
                </div>
              </aside>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
