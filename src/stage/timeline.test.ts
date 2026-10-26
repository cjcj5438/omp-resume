import { describe, expect, test } from "vitest";
import type { StageActor } from "../types";
import { barSpan, buildTimeline, durationLabel } from "./timeline";

function actor(id: string, over: Partial<StageActor> = {}): StageActor {
  return {
    id,
    kind: "subagent",
    parentId: null,
    name: id,
    agent: "task",
    brief: null,
    state: "running",
    statusText: null,
    startedAt: "2026-10-21T01:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-10-21T01:05:00.000Z",
    model: null,
    contextTokens: 0,
    cost: 0,
    toolCalls: 0,
    current: null,
    recent: [],
    ...over,
  };
}

const T0 = Date.parse("2026-10-21T01:00:00.000Z");
const NOW = Date.parse("2026-10-21T01:10:00.000Z");

describe("timeline", () => {
  test("进行中的条右端跟随 now，已结束的条用 endedAt", () => {
    const tl = buildTimeline(
      [
        actor("run"),
        actor("done", { state: "done", endedAt: "2026-10-21T01:04:00.000Z" }),
        actor("lost", { state: "lost", endedAt: null, lastActivityAt: "2026-10-21T01:02:00.000Z" }),
      ],
      NOW,
    );
    expect(tl.startMs).toBe(T0);
    expect(tl.endMs).toBe(NOW);
    const run = tl.rows.find((r) => r.id === "run");
    expect(run?.bars[0].toMs).toBe(NOW);
    const done = tl.rows.find((r) => r.id === "done");
    expect(done?.bars[0].toMs).toBe(Date.parse("2026-10-21T01:04:00.000Z"));
    const lost = tl.rows.find((r) => r.id === "lost");
    expect(lost?.bars[0].toMs).toBe(Date.parse("2026-10-21T01:02:00.000Z"));
  });

  test("缺 startedAt 的行被跳过；空输入返回零宽时间线", () => {
    const tl = buildTimeline([actor("nostart", { startedAt: null })], NOW);
    expect(tl.rows).toEqual([]);
    expect(tl.startMs).toBe(NOW);
    expect(tl.endMs).toBe(NOW);
  });

  test("depth 由 parentId 决定，ticks 有 5 个等分点", () => {
    const tl = buildTimeline(
      [actor("main", { kind: "main", parentId: null }), actor("child", { parentId: "dir" })],
      NOW,
    );
    expect(tl.rows.map((r) => r.depth)).toEqual([0, 1]);
    expect(tl.ticks).toHaveLength(5);
    expect(tl.ticks[0].ms).toBe(tl.startMs);
    expect(tl.ticks[4].ms).toBe(tl.endMs);
    expect(tl.ticks[0].label).toBe("0s");
    expect(tl.ticks[2].label).toBe("5m0s");
  });

  test("barSpan 在 0–100 之间且至少 0.5 宽", () => {
    const tl = buildTimeline([actor("a"), actor("b")], NOW);
    const bar = tl.rows[0].bars[0];
    const span = barSpan(bar, tl);
    expect(span.left).toBeGreaterThanOrEqual(0);
    expect(span.left).toBeLessThanOrEqual(100);
    expect(span.width).toBeGreaterThanOrEqual(0.5);
    expect(span.left + span.width).toBeLessThanOrEqual(100.0001);
    // 退化（总时长为 0）时不崩。
    const zero = { startMs: 0, endMs: 0, ticks: [], rows: [] };
    expect(barSpan({ fromMs: 0, toMs: 0, state: "done" }, zero)).toEqual({ left: 0, width: 100 });
  });

  test("durationLabel 与用量统计同规则", () => {
    expect(durationLabel(0)).toBe("0s");
    expect(durationLabel(59_000)).toBe("59s");
    expect(durationLabel(931_000)).toBe("15m31s");
    expect(durationLabel(3_660_000)).toBe("1h1m");
  });
});
