/**
 * 舞台画布：ResizeObserver 量宽、整数倍缩放、rAF（上限 30fps）、
 * 拖拽平移、滚轮切档、悬停/点击命中、名字标签（用 ref 直写 transform）。
 *
 * `getContext("2d") === null`（jsdom）时只渲染外壳，不画也不启动动画。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "../components/usageFormat";
import { W, sceneHeight } from "./layout";
import { drawScene, paletteFor } from "./paint";
import { hitTest, reconcile, sceneRowsFor, step, type Scene } from "./scene";
import { drawSprite, type CharacterId } from "./sprites";
import type { StagePrefs } from "./prefs";
import { STATE_WORD } from "./stateWords";
import type { AgentStage, StageActor, StageActorState } from "../types";
import { Minus, Plus } from "lucide-react";
import { Ico } from "../components/ui";

const ZOOMS = [1, 2, 3] as const;
/** 帧间隔上限：30fps（33ms）。 */
const FRAME_MS = 33;
/** 滚轮切档节流。 */
const WHEEL_THROTTLE_MS = 120;
/** 画布最多占视口高度的比例（给下方卡片/时间线留空间）。 */
const MAX_VIEWPORT_SHARE = 0.62;
/** 自动适配的最大整数倍（再高就靠手动缩放）。 */
const MAX_FIT = 4;
/** 名字标签最多显示到这么多角色，超过只显示选中/悬停项（否则标签互相压）。 */
const LABEL_ALL_LIMIT = 12;
/** 名字标签相对脚底的 y 偏移（逻辑像素）：气泡顶在 -26，标签再高 3px。 */
const LABEL_OFFSET_Y = 29;

export interface StageCanvasProps {
  stage: AgentStage;
  prefs: StagePrefs;
  filter: ReadonlySet<StageActorState> | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenLibrary: () => void;
  /** 主题（`document.documentElement.dataset.theme`），变化时重取调色板。 */
  theme: string | undefined;
}

interface Hover {
  id: string;
  x: number;
  y: number;
}

export function StageCanvas({
  stage,
  prefs,
  filter,
  selectedId,
  onSelect,
  onOpenLibrary,
  theme,
}: StageCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const sceneRef = useRef<Scene | null>(null);
  const sceneKey = useRef<string>("");
  const panRef = useRef({ x: 0, y: 0 });
  const [zoomIdx, setZoomIdx] = useState(0);
  const [cssW, setCssW] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const reduced = useRef(false);

  const zoom = ZOOMS[zoomIdx];
  // 画布高度由「需要几张工位」决定（与 reconcile 同规则），不随 rAF 抖动。
  const H = sceneHeight(sceneRowsFor(stage));

  // 容器宽度（ResizeObserver）。
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setCssW(entry.contentRect.width);
    });
    ro.observe(el);
    setCssW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // 减少动效偏好。
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mq.matches;
    const onChange = (e: MediaQueryListEvent): void => {
      reduced.current = e.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 适配倍率：整数倍（像素画必须整数放大），宽高同时受限 → 整间办公室一屏可见；
  // 手动放大超出后靠拖拽平移查看。
  const fitScale = useMemo(() => {
    if (cssW <= 0) return 1;
    const byWidth = cssW / W;
    const byHeight = (window.innerHeight * MAX_VIEWPORT_SHARE) / H;
    const fit = Math.floor(Math.min(byWidth, byHeight));
    return Math.max(1, Math.min(MAX_FIT, Number.isFinite(fit) ? fit : 1));
  }, [cssW, H]);

  // 画布区高度：场景高 × 有效倍率；手动放大后超出部分靠拖拽平移查看。
  const cssH = Math.min(H * fitScale * zoom, window.innerHeight * MAX_VIEWPORT_SHARE);
  const dpr = typeof window === "undefined" ? 1 : Math.min(3, window.devicePixelRatio || 1);
  const effective = fitScale * zoom;

  // 内容超出可视区时（宽或高）允许拖拽平移；否则居中并禁用拖拽。
  const pannable = W * effective > cssW + 1 || H * effective > cssH + 1;
  const clampPan = useCallback(
    (pan: { x: number; y: number }) => {
      const maxX = Math.max(0, W * effective - cssW);
      const maxY = Math.max(0, H * effective - cssH);
      return {
        x: Math.round(Math.min(0, Math.max(-maxX, pan.x))),
        y: Math.round(Math.min(0, Math.max(-maxY, pan.y))),
      };
    },
    [effective, cssW, cssH, H],
  );

  // 尺寸/倍率变化时重新居中（内容小于可视区 → 居中；否则贴左上并夹住）。
  useEffect(() => {
    panRef.current = clampPan({
      x: Math.min(0, (cssW - W * effective) / 2),
      y: Math.min(0, (cssH - H * effective) / 2),
    });
  }, [clampPan, cssW, cssH, effective, H]);

  // 主循环的输入全部走 ref：轮询/选中/主题变化时不再重建画布、不重启 rAF。
  const inputsRef = useRef({
    stage,
    filter,
    prefs,
    selectedId,
    palette: paletteFor(theme),
    dark: theme === "dark",
    accent: readAccent(),
  });
  const dirtyRef = useRef(true);

  // 输入同步：只在数据/筛选/选中/主题变化时更新 ref（`getComputedStyle` 也只在这里调用）。
  useEffect(() => {
    inputsRef.current = {
      stage,
      filter,
      prefs,
      selectedId,
      palette: paletteFor(theme),
      dark: theme === "dark",
      accent: readAccent(),
    };
    const key = stageKeyOf(stage, filter, prefs);
    if (sceneKey.current !== key) {
      sceneKey.current = key;
      dirtyRef.current = true;
    }
  }, [stage, filter, prefs, selectedId, theme]);

  // 主循环：reconcile + step + draw。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const totalW = W * effective;
    const totalH = H * effective;
    canvas.width = Math.round(totalW * dpr);
    canvas.height = Math.round(totalH * dpr);

    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    let disposed = false;

    const frame = (now: number): void => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (document.visibilityState === "hidden") return;
      if (now - lastDraw < FRAME_MS) return;
      const dt = Math.min(200, now - last);
      last = now;
      lastDraw = now;

      const {
        stage: stageIn,
        filter: filterIn,
        prefs: prefsIn,
        selectedId: selectedIn,
        palette,
        dark,
        accent,
      } = inputsRef.current;
      if (dirtyRef.current || sceneRef.current === null) {
        sceneRef.current = reconcile(sceneRef.current, stageIn, prefsIn, filterIn, now);
        dirtyRef.current = false;
      }
      const next = step(sceneRef.current, dt, now, reduced.current);
      sceneRef.current = next;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(effective * dpr, effective * dpr);
      ctx.translate(panRef.current.x / effective, panRef.current.y / effective);
      drawScene(
        ctx,
        next,
        {
          t: now,
          palette,
          dark,
          reducedMotion: reduced.current,
          selectedId: selectedIn,
          scale: effective,
        },
        accent,
      );
      ctx.restore();

      // 名字标签：ref 直写 transform，不触发 React 重渲染。
      for (const [id, el] of labelRefs.current) {
        const actor = next.actors.get(id);
        if (!actor) {
          el.style.opacity = "0";
          continue;
        }
        // 标签贴在气泡上方 3px（气泡占 foot y-26..y-17），不盖住角色的头。
        const px = actor.pos.x * effective + panRef.current.x;
        const py = (actor.pos.y - LABEL_OFFSET_Y) * effective + panRef.current.y;
        el.style.opacity = "1";
        el.style.transform = `translate(${px}px, ${py}px) translateX(-50%)`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, [effective, dpr, H]);

  // 滚轮：ctrlKey（触控板捏合）或普通滚轮都切档，节流 120ms。
  const lastWheel = useRef(0);
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const now = performance.now();
    if (now - lastWheel.current < WHEEL_THROTTLE_MS) return;
    lastWheel.current = now;
    e.preventDefault();
    const dir = (e.ctrlKey ? -e.deltaY : e.deltaY) > 0 ? 1 : -1;
    setZoomIdx((i) => Math.max(0, Math.min(ZOOMS.length - 1, i + dir)));
  }, []);

  // 拖拽平移（内容超出可视区时）。
  const dragging = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const logical = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - panRef.current.x) / effective,
        y: (clientY - rect.top - panRef.current.y) / effective,
      };
    },
    [effective],
  );

  const hit = useCallback(
    (clientX: number, clientY: number): string | null => {
      const scene = sceneRef.current;
      if (scene === null) return null;
      const p = logical(clientX, clientY);
      return hitTest(scene, p.x, p.y);
    },
    [logical],
  );

  const actors = stage.actors;
  const counts = useMemo(() => {
    const c = { running: 0, done: 0, bad: 0 };
    for (const a of actors) {
      if (a.state === "running" || a.state === "queued") c.running += 1;
      else if (a.state === "done") c.done += 1;
      else if (a.state === "failed" || a.state === "lost") c.bad += 1;
    }
    return c;
  }, [actors]);

  const zoomIn = () => setZoomIdx((i) => Math.min(ZOOMS.length - 1, i + 1));
  const zoomOut = () => setZoomIdx((i) => Math.max(0, i - 1));
  const resetZoom = () => {
    setZoomIdx(0);
    // 归零后由居中 effect 重新夹住（这里不直接算，避免用旧的 effective）。
    panRef.current = { x: 0, y: 0 };
  };

  return (
    <div className="stage-canvas-wrap" ref={wrapRef} data-pannable={pannable}>
      <div className="stage-canvas-tools">
        <button type="button" className="btn btn-small" onClick={zoomIn} aria-label="放大"><Ico icon={Plus} size={12} /></button>
        <button type="button" className="btn btn-small" onClick={zoomOut} aria-label="缩小"><Ico icon={Minus} size={12} /></button>
        <button type="button" className="btn btn-small" onClick={resetZoom}>复位</button>
        <button type="button" className="btn btn-small" onClick={onOpenLibrary}>Agent 库</button>
      </div>
      <div
        className="stage-canvas-box"
        style={{
          height: `${cssH}px`,
          width: `${Math.min(cssW, W * effective)}px`,
        }}
      >
        <div
          className="stage-canvas-frame"
          style={{ width: `${W * effective}px`, height: `${H * effective}px` }}
        >
          <canvas
            ref={canvasRef}
            className={pannable ? "stage-canvas stage-canvas-grab" : "stage-canvas"}
            role="img"
            aria-label={`${actors.length} 个角色：运行 ${counts.running}、完成 ${counts.done}、异常 ${counts.bad}`}
            style={{ width: `${W * effective}px`, height: `${H * effective}px` }}
            onWheel={onWheel}
            onPointerDown={(e) => {
              if (!pannable) return;
              dragging.current = {
                x: e.clientX,
                y: e.clientY,
                px: panRef.current.x,
                py: panRef.current.y,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (dragging.current !== null) {
                const d = dragging.current;
                panRef.current = clampPan({
                  x: d.px + (e.clientX - d.x),
                  y: d.py + (e.clientY - d.y),
                });
                return;
              }
              const id = hit(e.clientX, e.clientY);
              if (id === null) {
                setHover(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setHover({ id, x: e.clientX - rect.left, y: e.clientY - rect.top });
            }}
            onPointerUp={(e) => {
              if (dragging.current !== null) {
                dragging.current = null;
                e.currentTarget.releasePointerCapture(e.pointerId);
                return;
              }
              onSelect(hit(e.clientX, e.clientY));
            }}
            onPointerLeave={() => {
              dragging.current = null;
              setHover(null);
            }}
          />
          <div className="stage-labels" aria-hidden="true">
            {actors.map((a) => {
              const shown =
                actors.length <= LABEL_ALL_LIMIT || a.id === selectedId || a.id === hover?.id;
              return (
                <div
                  key={a.id}
                  className={a.id === selectedId ? "stage-label stage-label-selected" : "stage-label"}
                  ref={(el) => {
                    if (el !== null && shown) labelRefs.current.set(a.id, el);
                    else labelRefs.current.delete(a.id);
                  }}
                >
                  {shown ? a.name : ""}
                </div>
              );
            })}
          </div>
        </div>
        {hover !== null ? (
          <HoverTip actor={actors.find((a) => a.id === hover.id)} x={hover.x} y={hover.y} />
        ) : null}
      </div>
    </div>
  );
}

/** 场景键：数据/筛选/角色偏好任一变化就重算目标区域。 */
function stageKeyOf(stage: AgentStage, filter: ReadonlySet<StageActorState> | null, prefs: StagePrefs): string {
  const filterKey = filter === null ? "*" : [...filter].sort().join(",");
  const actors = stage.actors
    .map((a) => `${a.id}:${a.state}:${a.current?.tool ?? ""}:${a.endedAt ?? ""}`)
    .join("|");
  return `${stage.inUse}|${filterKey}|${JSON.stringify(prefs.chars)}|${actors}`;
}

function HoverTip({ actor, x, y }: { actor: StageActor | undefined; x: number; y: number }) {
  if (actor === undefined) return null;
  const elapsedMs =
    actor.startedAt === null
      ? null
      : (actor.endedAt === null ? Date.now() : Date.parse(actor.endedAt)) -
        Date.parse(actor.startedAt);
  return (
    <div className="stage-tip" style={{ left: `${x + 12}px`, top: `${y + 12}px` }} role="tooltip">
      <strong>{actor.name}</strong>
      <span>{STATE_WORD[actor.state]}{actor.statusText !== null ? ` · ${actor.statusText}` : ""}</span>
      {actor.model !== null ? <span className="stage-tip-mono">{actor.model}</span> : null}
      {actor.current !== null && actor.current.text !== "" ? <span>{actor.current.text}</span> : null}
      {elapsedMs !== null && !Number.isNaN(elapsedMs) ? (
        <span className="stage-tip-mono">已用时 {formatDuration(elapsedMs)}</span>
      ) : null}
      <span className="stage-tip-mono">工具 {actor.toolCalls}</span>
    </div>
  );
}

/** 从 CSS 变量取强调色（画布不能用 CSS 变量，只能读计算值）。 */
function readAccent(): string {
  if (typeof window === "undefined") return "#3b82f6";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return v === "" ? "#3b82f6" : v;
}

/** 卡片头像：把角色 IDLE 帧放大到 28×36。 */
export function CharacterAvatar({ charId }: { charId: CharacterId }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    drawSprite(ctx, charId, "idle", "none", 14, 36, 2);
  }, [charId]);
  return <canvas ref={ref} width={28} height={36} className="stage-avatar" aria-hidden="true" />;
}
