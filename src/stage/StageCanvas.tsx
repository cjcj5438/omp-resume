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
/** 名字标签避让 lane 数与步进（stage-P1-12：5 lane × 14px，实测宽碰撞）。 */
const LABEL_LANES = 5;
const LABEL_LANE_STEP = 14;
/** 名字标签相对脚底的 y 偏移（逻辑像素）：气泡顶在 -26，标签再高 3px。 */
const LABEL_OFFSET_Y = 29;

export interface StageCanvasProps {
  stage: AgentStage;
  prefs: StagePrefs;
  filter: ReadonlySet<StageActorState> | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
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
  theme,
}: StageCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const moreRef = useRef<HTMLDivElement>(null);
  const moreTipRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const sceneKey = useRef<string>("");
  const panRef = useRef({ x: 0, y: 0 });
  const [zoomIdx, setZoomIdx] = useState(0);
  const [cssW, setCssW] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [moreHover, setMoreHover] = useState(false);
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
    hoverId: null as string | null,
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
      hoverId: hover?.id ?? null,
      palette: paletteFor(theme),
      dark: theme === "dark",
      accent: readAccent(),
    };
    const key = stageKeyOf(stage, filter, prefs);
    if (sceneKey.current !== key) {
      sceneKey.current = key;
      dirtyRef.current = true;
    }
  }, [stage, filter, prefs, selectedId, hover, theme]);

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
        hoverId,
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
      // 墙面时钟：主会话（actors[0]）已运行时长；startedAt 缺失/非法时隐藏。
      const mainStarted = stageIn.actors[0]?.startedAt ?? null;
      const mainMs = mainStarted === null ? Number.NaN : Date.parse(mainStarted);
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
          sessionElapsed: Number.isFinite(mainMs) ? Math.max(0, now - mainMs) : null,
        },
        accent,
      );
      ctx.restore();

      // 名字标签：ref 直写 transform，不触发 React 重渲染。
      // 按优先级占 5 lane（layoutLabels 纯函数），实测宽碰撞；溢出收进 +N。
      const byId = new Map(stageIn.actors.map((a) => [a.id, a]));
      const anchors = new Map<string, { px: number; py: number }>();
      const candidates: LabelCandidate[] = [];
      for (const [id, el] of labelRefs.current) {
        const actor = next.actors.get(id);
        const src = byId.get(id);
        if (!actor || !src) {
          el.style.opacity = "0";
          continue;
        }
        // 标签贴在气泡上方 3px（气泡占 foot y-26..y-17），不盖住角色的头。
        const px = actor.pos.x * effective + panRef.current.x;
        const py = (actor.pos.y - LABEL_OFFSET_Y) * effective + panRef.current.y;
        anchors.set(id, { px, py });
        const pinned = id === selectedIn || id === hoverId;
        const rank =
          (src.state === "running" ? 500 : src.state === "failed" ? 400 : src.state === "lost" ? 300 : 0) +
          (id === selectedIn ? 200 : 0) +
          (id === hoverId ? 100 : 0);
        // 实测宽高（含选中描边）：隐藏态 offsetWidth 为 0 时用 96/14 兜底。
        const halfW = Math.max(8, (el.offsetWidth || 96) / 2 + 2);
        candidates.push({ id, px, py, halfW, h: el.offsetHeight || 14, rank, pinned });
      }
      const { placements, overflow } = layoutLabels(candidates);
      const laneOf = new Map(placements.map((p) => [p.id, p.lane]));
      const overflowSet = new Set(overflow);
      for (const [id, el] of labelRefs.current) {
        const a = anchors.get(id);
        const lane = laneOf.get(id);
        if (!a || lane === undefined || overflowSet.has(id)) {
          el.style.opacity = "0";
          continue;
        }
        el.style.opacity = "1";
        el.style.transform = `translate(${a.px}px, ${a.py - lane * LABEL_LANE_STEP}px) translateX(-50%)`;
      }
      // +N 标记：放在溢出簇的形心上方；名单进 title（hover 显示被收起者）。
      const more = moreRef.current;
      const moreTip = moreTipRef.current;
      if (more) {
        if (overflow.length === 0) {
          more.style.opacity = "0";
          more.style.pointerEvents = "none";
        } else {
          let sx = 0;
          let sy = 0;
          let n = 0;
          for (const id of overflow) {
            const a = anchors.get(id);
            if (!a) continue;
            sx += a.px;
            sy += a.py;
            n += 1;
          }
          const cx = n > 0 ? sx / n : 0;
          const cy = n > 0 ? sy / n : 0;
          more.style.opacity = "1";
          more.style.pointerEvents = "auto";
          // 夹在 frame 内：上方越界会被工具条/画布外元素挡住 hover。
          const my = Math.max(20, Math.min(H * effective - 20, cy - LABEL_LANES * LABEL_LANE_STEP));
          more.style.transform = `translate(${cx}px, ${my}px) translateX(-50%)`;
          const names = overflow.map((id) => byId.get(id)?.name ?? id).join("、");
          // 首个文本节点是计数（tip span 不能被 textContent  wipe 掉）。
          const first = more.firstChild;
          const label = `+${overflow.length}`;
          if (first && first.nodeType === 3) first.textContent = label;
          else more.insertBefore(document.createTextNode(label), more.firstChild);
          more.setAttribute("title", names);
          more.setAttribute("aria-label", `还有 ${overflow.length} 个角色：${names}`);
          if (moreTip) moreTip.textContent = names;
        }
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
            {actors.map((a) => (
              <div
                key={a.id}
                className={a.id === selectedId ? "stage-label stage-label-selected" : "stage-label"}
                ref={(el) => {
                  if (el !== null) labelRefs.current.set(a.id, el);
                  else labelRefs.current.delete(a.id);
                }}
              >
                {a.name}
              </div>
            ))}
            <div
              className={moreHover ? "stage-label-more is-on" : "stage-label-more"}
              ref={moreRef}
              role="status"
              onPointerEnter={() => setMoreHover(true)}
              onPointerLeave={() => setMoreHover(false)}
            >
              <span className="stage-label-more-tip" ref={moreTipRef} />
            </div>
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
/** 标签避让输入（一帧内所有候选标签的锚点与实测半宽）。 */
export interface LabelCandidate {
  id: string;
  px: number;
  py: number;
  halfW: number;
  /** 标签盒高（实测 offsetHeight；兜底 14）。 */
  h: number;
  /** 优先级（越大越先占 lane）：运行中 > 失败 > 失联 > 选中 > 悬停 > 其余。 */
  rank: number;
  /** 选中/悬停永不收起。 */
  pinned: boolean;
}

export interface LabelPlacement {
  id: string;
  lane: number;
}

/**
 * 纯函数标签排布（stage-P1-12，供单测与主循环共用）。
 * 按优先级逐个占 lane：lane 位移后的矩形与已占矩形相交则换下一 lane；
 * 5 lane 用尽仍相交 → 非 pinned 收进 overflow（pinned 挤占 lane 0 并踢走相交的非 pinned）。
 * 返回 placements（保证两两不重叠）与 overflow（按 rank 倒序，供 +N 名单）。
 */
export function layoutLabels(candidates: LabelCandidate[]): { placements: LabelPlacement[]; overflow: string[] } {
  const boxes: { id: string; left: number; right: number; top: number; bottom: number; lane: number }[] = [];
  const placements: LabelPlacement[] = [];
  const overflow: { id: string; rank: number }[] = [];
  const ordered = [...candidates].sort((a, b) => b.rank - a.rank || a.px - b.px);
  for (const c of ordered) {
    let lane = -1;
    for (let i = 0; i < LABEL_LANES; i += 1) {
      const top = c.py - i * LABEL_LANE_STEP - c.h;
      const bottom = top + c.h;
      const left = c.px - c.halfW;
      const right = c.px + c.halfW;
      const collides = boxes.some((o) => left < o.right && o.left < right && top < o.bottom && o.top < bottom);
      if (!collides) {
        lane = i;
        break;
      }
    }
    if (lane < 0) {
      if (c.pinned) {
        // pinned 无 lane 可用：挤 lane 0（把与其相交的非 pinned 踢进 overflow）。
        const top = c.py - c.h;
        const bottom = top + c.h;
        const left = c.px - c.halfW;
        const right = c.px + c.halfW;
        const evicted = boxes.filter(
          (o) =>
            left < o.right && o.left < right && top < o.bottom && o.top < bottom &&
            ordered.find((x) => x.id === o.id)?.pinned !== true,
        );
        for (const v of evicted) {
          const bi = boxes.findIndex((b) => b.id === v.id);
          if (bi >= 0) boxes.splice(bi, 1);
          const pi = placements.findIndex((p) => p.id === v.id);
          if (pi >= 0) placements.splice(pi, 1);
          const victim = ordered.find((x) => x.id === v.id);
          overflow.push({ id: v.id, rank: victim?.rank ?? 0 });
        }
        lane = 0;
      } else {
        overflow.push({ id: c.id, rank: c.rank });
        continue;
      }
    }
    const top = c.py - lane * LABEL_LANE_STEP - c.h;
    boxes.push({ id: c.id, left: c.px - c.halfW, right: c.px + c.halfW, top, bottom: top + c.h, lane });
    placements.push({ id: c.id, lane });
  }
  overflow.sort((a, b) => a.rank - b.rank);
  return { placements, overflow: overflow.map((o) => o.id) };
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
