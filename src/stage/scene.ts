/**
 * 场景引擎：把后端 `AgentStage` 转成可绘制的角色位置/姿态，并按时间步进。
 *
 * 纯函数、无 DOM、无 canvas（`scene.test.ts` 全覆盖）。两个入口：
 * - [`reconcile`]：舞台数据变化时重算目标区域与走位路线；
 * - [`step`]：每帧推进走位、动画相位与屏幕位置。
 */
import type { AgentStage, StageActor, StageActorState } from "../types";
import {
  CORRIDOR_Y,
  DESK_COLS,
  DOOR,
  DONE_CAP,
  LOUNGE_CAP,
  QUEUE_CAP,
  BOSS_SEAT,
  deskSlot,
  doneSlot,
  loungeSlot,
  queueSlot,
  route,
  sceneRows,
  type Point,
} from "./layout";
import { toolGlyph, type GlyphName } from "./glyphs";
import { charFor, fnv1a, type StagePrefs } from "./prefs";

/** 角色姿态：静止/动画帧。 */
export type Pose = "idle" | "blink" | "back" | "type" | "walkA" | "walkB" | "sit" | "cheer";

/** 颜色修正：失败红闪 / 失联灰化。 */
export type Tint = "none" | "fail" | "lost";

/** 角色所在区域。 */
export type Zone = "boss" | "desk" | "queue" | "done" | "lounge";

export interface SceneActor {
  id: string;
  kind: StageActor["kind"];
  state: StageActorState;
  /** 当前显示的状态（用于卡片/标签同步）。 */
  charId: string;
  pos: Point;
  /** 当前走位的目的点（用于判断目标是否真的变了）。 */
  target: Point;
  /** 剩余路点（不含当前 `pos`）；空 = 已到位。 */
  path: Point[];
  zone: Zone;
  /** 工位序号（`zone==="desk"` 或曾经占过工位时非 null）。 */
  slot: number | null;
  pose: Pose;
  glyph: GlyphName | null;
  tint: Tint;
  /** 当前姿态开始的时间（ms），用于走路换帧与欢呼计时。 */
  sinceMs: number;
  /** 到位时间（ms）；仍在走时为 null（庆祝从这一刻起算 2 秒）。 */
  arrivedMs: number | null;
  dim: boolean;
  /** 场景内绘制顺序基准（脚底 y）。 */
  sortY: number;
}

export interface Scene {
  actors: Map<string, SceneActor>;
  /** actor id → 已分配工位序号。 */
  deskOf: Map<string, number>;
  /** 会话已结束（回看模式）：全员直接入座，不走路。 */
  reviewMode: boolean;
  rows: number;
}

/** 走路速度（逻辑像素/秒）。 */
export const WALK_SPEED = 40;
/** 走路换帧间隔。 */
const WALK_FRAME_MS = 180;
/** 眨眼周期与时长。 */
const BLINK_PERIOD_MS = 3200;
const BLINK_MS = 120;
/** 完成庆祝时长。 */
export const CHEER_MS = 2000;
/** 敲键盘换帧间隔（在 `type` 与 `back` 之间交替）。 */
export const TYPE_FRAME_MS = 220;

function targetZone(actor: StageActor, reviewMode: boolean): Zone {
  if (actor.kind === "main") return "boss";
  if (reviewMode) {
    // 回看：非 main 一律坐工位（历史状态仍然用颜色/气泡表达）。
    return "desk";
  }
  // advisor 只旁观：直播模式下永远在沙发区，不占工位。
  if (actor.kind === "advisor") return "lounge";
  switch (actor.state) {
    case "queued":
      return "queue";
    case "running":
      return "desk";
    case "done":
      return "done";
    case "idle":
      return "lounge";
    case "failed":
    case "lost":
      // 失败/失联：留在工位（没有工位则临时分配一个），用颜色表达异常。
      return "desk";
    default:
      return "desk";
  }
}

function tintOf(actor: StageActor): Tint {
  if (actor.state === "failed") return "fail";
  if (actor.state === "lost") return "lost";
  return "none";
}

function glyphOf(actor: StageActor): GlyphName | null {
  switch (actor.state) {
    case "running":
      return toolGlyph(actor.current?.tool ?? null, actor.current?.kind ?? null);
    case "done":
      return "check";
    case "failed":
      return "bang";
    case "lost":
      return "question";
    case "queued":
      return "hourglass";
    case "idle":
      return "zz";
    default:
      return null;
  }
}

function restPose(actor: StageActor, zone: Zone, reviewMode: boolean): Pose {
  if (zone === "boss") {
    if (actor.state === "running") return "type";
    return "back";
  }
  if (zone === "desk") {
    if (actor.state === "running" && !reviewMode) return "type";
    return "back";
  }
  if (zone === "lounge") return "sit";
  return "idle";
}

/**
 * 该舞台需要几行工位（与 [`reconcile`] 的分配结果一致）。
 *
 * 画布高度在 React 渲染期就要定下来，而 `step` 里的行数只减不增，
 * 所以这里独立算一次，避免画布尺寸跟着 rAF 变化抖动。
 */
export function sceneRowsFor(stage: AgentStage): number {
  const reviewMode = !stage.inUse;
  const desks = stage.actors.filter(
    (a) => a.kind !== "main" && targetZone(a, reviewMode) === "desk",
  ).length;
  return sceneRows(Math.max(desks, 1));
}

/** 把 `count` 个候选按容量截断（保留调用方给定的顺序）。 */
function cap<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(0, limit) : items;
}

/** 释放工位（转入非工位区域时）。 */
function releaseDesk(scene: Scene, id: string): void {
  scene.deskOf.delete(id);
}

/** 取最小空闲工位序号。 */
function allocDesk(scene: Scene, slots: number): number {
  const used = new Set(scene.deskOf.values());
  for (let i = 0; i < slots; i += 1) {
    if (!used.has(i)) return i;
  }
  return slots;
}

/**
 * 重算场景：目标区域由状态决定，位置变化时重新计算走位路线。
 *
 * `filter` 非 null 时，不在其中的非 main 角色 `dim`（仍留在场景里）。
 */
export function reconcile(
  prev: Scene | null,
  stage: AgentStage,
  prefs: StagePrefs,
  filter: ReadonlySet<StageActorState> | null,
  nowMs: number,
): Scene {
  const reviewMode = !stage.inUse;
  const scene: Scene = {
    actors: new Map(),
    deskOf: new Map(prev?.deskOf ?? []),
    reviewMode,
    rows: prev?.rows ?? 3,
  };

  // 先决定谁进哪些区域（完成区/排队区/沙发有容量上限）。
  const actors = stage.actors;
  const doneOrder = actors
    .filter((a) => a.kind !== "main" && targetZone(a, reviewMode) === "done")
    .sort((a, b) => {
      const ea = a.endedAt ?? a.lastActivityAt ?? "";
      const eb = b.endedAt ?? b.lastActivityAt ?? "";
      return eb.localeCompare(ea);
    });
  const doneKeep = new Set(cap(doneOrder, DONE_CAP).map((a) => a.id));
  const queueOrder = actors.filter((a) => a.kind !== "main" && targetZone(a, reviewMode) === "queue");
  const queueKeep = new Set(cap(queueOrder, QUEUE_CAP).map((a) => a.id));
  const loungeOrder = actors.filter((a) => a.kind !== "main" && targetZone(a, reviewMode) === "lounge");
  const loungeKeep = new Set(cap(loungeOrder, LOUNGE_CAP).map((a) => a.id));

  // 工位容量按最大规模预留（分配完再回收未用行，见函数末尾）。
  const deskActors = actors.filter((a) => a.kind !== "main" && targetZone(a, reviewMode) === "desk");
  const capacity = Math.max(DESK_COLS, deskActors.length) * 2;
  scene.rows = sceneRows(capacity);

  const zoneIndex: Record<Exclude<Zone, "boss" | "desk">, number> = {
    queue: 0,
    done: 0,
    lounge: 0,
  };

  for (const actor of actors) {
    if (actor.kind !== "main" && targetZone(actor, reviewMode) === "done" && !doneKeep.has(actor.id)) continue;
    if (actor.kind !== "main" && targetZone(actor, reviewMode) === "queue" && !queueKeep.has(actor.id)) continue;
    if (actor.kind !== "main" && targetZone(actor, reviewMode) === "lounge" && !loungeKeep.has(actor.id)) continue;

    const zone = targetZone(actor, reviewMode);
    const old = prev?.actors.get(actor.id) ?? null;
    let target: Point;
    let slot: number | null = old?.slot ?? null;

    if (zone === "boss") {
      target = BOSS_SEAT;
      slot = null;
      if (actor.id !== "main") releaseDesk(scene, actor.id);
    } else if (zone === "desk") {
      if (slot === null || [...scene.deskOf.entries()].some(([k, v]) => k !== actor.id && v === slot)) {
        slot = allocDesk(scene, capacity);
      }
      scene.deskOf.set(actor.id, slot);
      target = deskSlot(slot).seat;
    } else {
      const index = zoneIndex[zone];
      zoneIndex[zone] += 1;
      if (zone === "queue") target = queueSlot(index);
      else if (zone === "done") target = doneSlot(index);
      else target = loungeSlot(index);
      slot = null;
      releaseDesk(scene, actor.id);
    }

    const tint = tintOf(actor);
    const glyph = glyphOf(actor);
    const charId = charFor(prefs, actor);
    // 目标点变了才重算路线：比较 old.target（不是 old.pos，否则每轮都会重走）。
    const moved = old !== null && (old.target.x !== target.x || old.target.y !== target.y);
    const zoneChanged = old === null || old.zone !== zone;

    let pos: Point;
    let path: Point[];
    let pose: Pose;
    let sinceMs = nowMs;
    let arrivedMs: number | null = null;

    if (old === null) {
      // 新角色：回看模式直接落位，直播模式从门口走进来。
      if (reviewMode || zone === "boss") {
        pos = { ...target };
        path = [];
        pose = restPose(actor, zone, reviewMode);
        sinceMs = nowMs;
        arrivedMs = nowMs;
      } else {
        // 从门口进来；按 id 沿走廊错开起跑点，避免多个角色完全重叠成一团。
        const entry = { x: DOOR.x + (fnv1a(actor.id) % 6) * 5, y: CORRIDOR_Y };
        pos = entry;
        path = route(entry, target).slice(1);
        pose = "walkA";
      }
    } else if (moved || zoneChanged) {
      // 目标点/区域变了：从当前位置重新规划路线。
      pos = { ...old.pos };
      path = route(old.pos, target).slice(1);
      if (path.length === 0) {
        pos = { ...target };
        pose = restPose(actor, zone, reviewMode);
        sinceMs = nowMs;
        arrivedMs = nowMs;
      } else {
        pose = "walkA";
        sinceMs = nowMs;
      }
    } else {
      // 目标没变：保留正在走的路线与姿态计时（绝不每轮重走）。
      pos = old.pos;
      path = old.path;
      sinceMs = old.sinceMs;
      arrivedMs = old.arrivedMs;
      if (path.length > 0) {
        pose = old.pose === "type" || old.pose === "back" || old.pose === "sit" ? "walkA" : old.pose;
      } else if (zone === "done" && (arrivedMs === null || nowMs - arrivedMs < CHEER_MS)) {
        pose = "cheer";
        if (arrivedMs === null) {
          arrivedMs = nowMs;
          sinceMs = nowMs;
        }
      } else if (old.pose === "cheer" && nowMs - (arrivedMs ?? 0) < CHEER_MS) {
        pose = "cheer";
      } else {
        const rest = restPose(actor, zone, reviewMode);
        pose = rest;
        if (old.pose !== rest && old.pose !== "back" && old.pose !== "type") sinceMs = nowMs;
      }
    }

    scene.actors.set(actor.id, {
      id: actor.id,
      kind: actor.kind,
      state: actor.state,
      charId,
      pos,
      target,
      path,
      zone,
      slot,
      pose,
      glyph,
      tint,
      sinceMs,
      arrivedMs,
      dim: actor.kind !== "main" && filter !== null && !filter.has(actor.state),
      sortY: pos.y,
    });
  }

  // 清掉已不存在角色的工位。
  for (const id of [...scene.deskOf.keys()]) {
    if (!scene.actors.has(id)) scene.deskOf.delete(id);
  }
  // 只保留实际用到的行：不画整排空工位。
  const maxSlot = Math.max(-1, ...scene.deskOf.values());
  scene.rows = sceneRows(maxSlot + 1);
  return scene;
}

/** 沿路径推进 `dt` 毫秒；`reducedMotion` 时直接落到终点。 */
function advance(actor: SceneActor, dtMs: number, reducedMotion: boolean): void {
  if (actor.path.length === 0) return;
  if (reducedMotion) {
    actor.pos = { ...actor.path[actor.path.length - 1] };
    actor.path = [];
    return;
  }
  let budget = (WALK_SPEED * dtMs) / 1000;
  while (budget > 0 && actor.path.length > 0) {
    const next = actor.path[0];
    const dx = next.x - actor.pos.x;
    const dy = next.y - actor.pos.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dist <= budget || dist === 0) {
      actor.pos = { ...next };
      actor.path.shift();
      budget -= dist;
    } else {
      const ratio = budget / dist;
      actor.pos = { x: actor.pos.x + dx * ratio, y: actor.pos.y + dy * ratio };
      budget = 0;
    }
  }
}

/**
 * 每帧推进：走位、动画相位、`sortY`。
 *
 * 姿态是逻辑态（`type` 由绘制层按时间切「敲键盘/回头」两帧，`blink` 由这里定时插入）。
 * 返回新场景（不修改入参）。
 */
export function step(scene: Scene, dtMs: number, nowMs: number, reducedMotion: boolean): Scene {
  const actors = new Map<string, SceneActor>();
  for (const [id, prev] of scene.actors) {
    const actor: SceneActor = { ...prev, pos: { ...prev.pos }, path: [...prev.path] };
    advance(actor, dtMs, reducedMotion);
    const arrived = actor.path.length === 0;
    if (!arrived) {
      const frame = Math.floor((nowMs - actor.sinceMs) / WALK_FRAME_MS) % 2;
      actor.pose = frame === 0 ? "walkA" : "walkB";
      actor.arrivedMs = null;
    } else {
      if (actor.pose === "walkA" || actor.pose === "walkB" || actor.arrivedMs === null) {
        // 刚刚到位：庆祝/静坐都从现在开始计时。
        actor.sinceMs = nowMs;
        actor.arrivedMs = nowMs;
      }
      actor.pose = settledPose(actor, nowMs, reducedMotion);
    }
    actor.sortY = actor.pos.y;
    actors.set(id, actor);
  }
  return { ...scene, actors };
}

/** 到位后的姿态：庆祝 → 静止；静止时按周期插一帧眨眼；运行中敲键盘。 */
function settledPose(actor: SceneActor, nowMs: number, reducedMotion: boolean): Pose {
  const arrived = actor.arrivedMs ?? nowMs;
  if (actor.zone === "done" && nowMs - arrived < CHEER_MS) return "cheer";
  if (actor.zone === "lounge") return "sit";
  const typing =
    reducedMotion ? "type" : Math.floor(nowMs / TYPE_FRAME_MS) % 2 === 0 ? "type" : "back";
  if (actor.zone === "desk") {
    if (actor.state === "running") return typing;
    return "back";
  }
  if (actor.zone === "boss") return actor.state === "running" ? typing : "back";
  // queue（或其它）：站着等，偶尔眨眼。
  const phase = (nowMs - actor.sinceMs) % BLINK_PERIOD_MS;
  return phase >= BLINK_PERIOD_MS - BLINK_MS ? "blink" : "idle";
}

/** 命中测试：精灵框 `[x-7,x+7] × [y-18,y]`，多个命中取 `y` 最大者（更靠前）。 */
export function hitTest(scene: Scene, x: number, y: number): string | null {
  let best: SceneActor | null = null;
  for (const actor of scene.actors.values()) {
    if (x < actor.pos.x - 7 || x > actor.pos.x + 7) continue;
    if (y < actor.pos.y - 18 || y > actor.pos.y) continue;
    if (best === null || actor.pos.y > best.pos.y) best = actor;
  }
  return best?.id ?? null;
}
