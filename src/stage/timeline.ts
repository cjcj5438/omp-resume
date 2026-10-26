/**
 * 甘特时间线数据（纯函数）：每个角色一根条，按 `startedAt` 起。
 *
 * 本数据源只有 main → 子代理两层（`parentId` 要么 null 要么子目录路径），
 * 所以用甘特表达并行/耗时比放射关系图有信息量。
 */
import type { StageActor, StageActorState } from "../types";

export interface TimelineBar {
  fromMs: number;
  toMs: number;
  state: StageActorState;
}

export interface TimelineRow {
  id: string;
  name: string;
  depth: number;
  bars: TimelineBar[];
}

export interface TimelineTick {
  ms: number;
  label: string;
}

export interface Timeline {
  startMs: number;
  endMs: number;
  ticks: TimelineTick[];
  rows: TimelineRow[];
}

/** 仍在进行中的状态（右端随 now 增长）。 */
const OPEN_STATES: Record<string, true> = {
  running: true,
  queued: true,
  idle: true,
};

/** 时长标签：0s / 59s / 15m31s / 1h1m（与 `usageFormat.formatDuration` 同规则）。 */
export function durationLabel(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 构造时间线；`nowMs` 给进行中的条提供右端。 */
export function buildTimeline(actors: StageActor[], nowMs: number): Timeline {
  const rows: TimelineRow[] = [];
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const actor of actors) {
    const from = ms(actor.startedAt);
    if (from === null) continue;
    const open = OPEN_STATES[actor.state] === true;
    const to = open ? nowMs : (ms(actor.endedAt) ?? ms(actor.lastActivityAt) ?? from);
    const bar: TimelineBar = { fromMs: from, toMs: Math.max(from, to), state: actor.state };
    rows.push({
      id: actor.id,
      name: actor.name,
      depth: actor.parentId === null ? 0 : 1,
      bars: [bar],
    });
    startMs = Math.min(startMs, bar.fromMs);
    endMs = Math.max(endMs, bar.toMs);
  }

  if (rows.length === 0) {
    return { startMs: nowMs, endMs: nowMs, ticks: [], rows: [] };
  }
  if (endMs <= startMs) endMs = startMs + 1000;

  const ticks: TimelineTick[] = [];
  for (let i = 0; i < 5; i += 1) {
    const at = startMs + ((endMs - startMs) * i) / 4;
    ticks.push({ ms: at, label: durationLabel(at - startMs) });
  }
  return { startMs, endMs, ticks, rows };
}

/** 条在 `[startMs,endMs]` 上的百分比区间（0–100）。 */
export function barSpan(bar: TimelineBar, tl: Timeline): { left: number; width: number } {
  const total = tl.endMs - tl.startMs;
  if (total <= 0) return { left: 0, width: 100 };
  const left = ((bar.fromMs - tl.startMs) / total) * 100;
  const width = ((bar.toMs - bar.fromMs) / total) * 100;
  return { left: Math.max(0, Math.min(100, left)), width: Math.max(0.5, Math.min(100, width)) };
}
