import { describe, expect, test } from "vitest";
import type { AgentStage, StageActor, StageActorState } from "../types";
import { CHEER_MS, TYPE_FRAME_MS, hitTest, reconcile, step, type Scene } from "./scene";
import { CORRIDOR_Y, DONE_CAP, DOOR, deskSlot } from "./layout";
import { defaultStagePrefs } from "./prefs";

function actor(over: Partial<StageActor> & { id: string; state: StageActorState }): StageActor {
  return {
    kind: "subagent",
    parentId: null,
    name: over.id,
    agent: "task",
    brief: null,
    statusText: null,
    startedAt: "2026-10-21T01:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-10-21T01:05:00.000Z",
    model: "p/m",
    contextTokens: 100,
    cost: 0.01,
    toolCalls: 3,
    current: null,
    recent: [],
    ...over,
  };
}

function stage(actors: StageActor[], inUse = true): AgentStage {
  return {
    path: "/mock/s.jsonl",
    sessionId: "s",
    title: "t",
    cwd: "/mock",
    inUse,
    probeOk: true,
    updatedAt: "2026-10-21T01:06:00.000Z",
    omitted: 0,
    actors: [actor({ id: "main", kind: "main", name: "管理员", state: inUse ? "running" : "done" }), ...actors],
  };
}

const prefs = defaultStagePrefs();
const t0 = 1_000_000;

/** 一直 step 到没有剩余路点（或超时），模拟「走完」。 */
function settle(scene: Scene, start: number, budgetMs = 60_000): Scene {
  let current = scene;
  let now = start;
  for (let i = 0; i < Math.ceil(budgetMs / 100) && [...current.actors.values()].some((a) => a.path.length > 0); i += 1) {
    now += 100;
    current = step(current, 100, now, false);
  }
  return current;
}

describe("scene", () => {
  test("新角色从门口入场，走完后坐到工位", () => {
    const s = reconcile(null, stage([actor({ id: "a", state: "running" })]), prefs, null, t0);
    const entering = s.actors.get("a");
    // 入场点在门口一带（按 id 沿走廊错开几像素，避免多个角色重叠）。
    expect(entering?.pos.y).toBe(CORRIDOR_Y);
    expect(Math.abs((entering?.pos.x ?? 0) - DOOR.x)).toBeLessThanOrEqual(25);
    expect(entering?.path.length).toBeGreaterThan(0);
    expect(entering?.zone).toBe("desk");

    const settled = settle(s, t0);
    const a = settled.actors.get("a");
    expect(a?.path).toEqual([]);
    expect(a?.slot).toBe(0);
    expect(a?.pos).toEqual(deskSlot(0).seat);
    expect(["type", "back"]).toContain(a?.pose);
  });

  test("Running → Done 换区、释放工位、甘特/欢呼", () => {
    const base = reconcile(null, stage([actor({ id: "a", state: "running" })]), prefs, null, t0);
    const settled = settle(base, t0);
    expect(settled.deskOf.get("a")).toBe(0);

    const doneStage = stage([
      actor({
        id: "a",
        state: "done",
        endedAt: "2026-10-21T01:10:00.000Z",
      }),
    ]);
    const next = reconcile(settled, doneStage, prefs, null, t0 + 10_000);
    const a = next.actors.get("a");
    expect(a?.zone).toBe("done");
    expect(next.deskOf.has("a")).toBe(false);
    expect(a?.glyph).toBe("check");

    const walked = settle(next, t0 + 10_000 + 1);
    const arrived = walked.actors.get("a");
    expect(arrived?.path).toEqual([]);
    // 到位后的头 2 秒是欢呼，之后回到 idle。
    expect(arrived?.pose).toBe("cheer");
    const later = walkTo(walked, arrived?.sinceMs ?? 0, CHEER_MS + 50);
    expect(later.actors.get("a")?.pose).toBe("idle");
  });

  function walkTo(scene: Scene, now: number, ms: number): Scene {
    let current = scene;
    let t = now;
    const until = now + ms;
    while (t < until) {
      t += 100;
      current = step(current, 100, t, false);
    }
    return current;
  }

  test("回看模式：非 main 直接落位、path 为空", () => {
    const s = reconcile(
      null,
      stage([actor({ id: "a", state: "done" }), actor({ id: "b", state: "running" })], false),
      prefs,
      null,
      t0,
    );
    for (const id of ["a", "b"]) {
      const a = s.actors.get(id);
      expect(a?.path).toEqual([]);
      expect(a?.zone).toBe("desk");
      expect(a?.pos).toEqual(deskSlot(a?.slot ?? 0).seat);
    }
    expect(s.reviewMode).toBe(true);
    // 回看时无人敲键盘。
    expect(s.actors.get("b")?.pose).toBe("back");
  });

  test("失败/失联留在工位并带色调", () => {
    const s = reconcile(
      null,
      stage([actor({ id: "bad", state: "failed" }), actor({ id: "gone", state: "lost" })]),
      prefs,
      null,
      t0,
    );
    expect(s.actors.get("bad")?.zone).toBe("desk");
    expect(s.actors.get("bad")?.tint).toBe("fail");
    expect(s.actors.get("gone")?.tint).toBe("lost");
    expect(s.actors.get("gone")?.glyph).toBe("question");
  });

  test("advisor 直播模式永远在沙发区，不占工位", () => {
    for (const state of ["running", "idle", "queued"] as StageActorState[]) {
      const s = reconcile(
        null,
        stage([actor({ id: "__advisor", kind: "advisor", state, agent: null })]),
        prefs,
        null,
        t0,
      );
      const a = s.actors.get("__advisor");
      expect(a?.zone, state).toBe("lounge");
      expect(a?.slot, state).toBeNull();
      // 正在走向沙发（首帧还在门口），到位后坐下。
      expect(settle(s, t0).actors.get("__advisor")?.pose, state).toBe("sit");
    }
  });

  test("排队与待命分区；区域满员只保留前 N 个", () => {
    const queued = Array.from({ length: 10 }, (_, i) => actor({ id: `q${i}`, state: "queued" }));
    const s = reconcile(null, stage(queued), prefs, null, t0);
    const inScene = [...s.actors.keys()].filter((k) => k !== "main");
    expect(inScene.length).toBe(8);
    expect(s.actors.get("q0")?.zone).toBe("queue");

    const done = Array.from({ length: 10 }, (_, i) =>
      actor({ id: `d${i}`, state: "done", endedAt: `2026-10-21T01:0${i}:00.000Z` }),
    );
    const d = reconcile(null, stage(done), prefs, null, t0);
    const doneIds = [...d.actors.values()].filter((a) => a.zone === "done").map((a) => a.id);
    expect(doneIds).toHaveLength(DONE_CAP);
    // 保留的是最新结束的 8 个（d9…d2）。
    expect(doneIds).toContain("d9");
    expect(doneIds).not.toContain("d0");
  });

  test("25 个角色时行数增长，工位不重复", () => {
    const many = Array.from({ length: 25 }, (_, i) => actor({ id: `w${i}`, state: "running" }));
    const s = reconcile(null, stage(many), prefs, null, t0);
    expect(s.rows).toBe(Math.max(3, Math.ceil(25 / 4)));
    const slots = [...s.deskOf.values()];
    expect(new Set(slots).size).toBe(slots.length);
    expect(Math.max(...slots)).toBeLessThan(s.rows * 4);
  });

  test("筛选把未命中的角色标 dim，main 永不 dim", () => {
    const filter = new Set<StageActorState>(["done"]);
    const s = reconcile(
      null,
      stage([actor({ id: "run", state: "running" }), actor({ id: "fin", state: "done" })]),
      prefs,
      filter,
      t0,
    );
    expect(s.actors.get("run")?.dim).toBe(true);
    expect(s.actors.get("fin")?.dim).toBe(false);
    expect(s.actors.get("main")?.dim).toBe(false);
  });

  test("hitTest 重叠时取 y 更大者，框外为 null", () => {
    const s = reconcile(
      null,
      stage([actor({ id: "back", state: "done" }), actor({ id: "front", state: "done" })]),
      prefs,
      null,
      t0,
    );
    const b = s.actors.get("back");
    const f = s.actors.get("front");
    expect(b).toBeDefined();
    expect(f).toBeDefined();
    if (!b || !f) return;
    // 手工构造重叠：把 back 移到 front 的位置偏上。
    b.pos = { x: f.pos.x, y: f.pos.y - 4 };
    expect(hitTest(s, f.pos.x, f.pos.y - 2)).toBe("front");
    expect(hitTest(s, -100, -100)).toBeNull();
  });

  test("reducedMotion 下直接落位", () => {
    const s = reconcile(null, stage([actor({ id: "a", state: "running" })]), prefs, null, t0);
    const stepped = step(s, 16, t0 + 16, true);
    expect(stepped.actors.get("a")?.path).toEqual([]);
  });

  test("走路时在 walkA/walkB 间交替", () => {
    const s = reconcile(null, stage([actor({ id: "a", state: "running" })]), prefs, null, t0);
    const a = step(s, 16, t0 + 200, false).actors.get("a");
    expect(a?.pose === "walkA" || a?.pose === "walkB").toBe(true);
    const b = step(s, 16, t0 + 400, false).actors.get("a");
    expect(b?.pose === "walkA" || b?.pose === "walkB").toBe(true);
  });

  test("运行中敲键盘在 type/back 间交替，减少动效时固定 type", () => {
    const s = reconcile(null, stage([actor({ id: "a", state: "running" })]), prefs, null, t0);
    const settled = settle(s, t0);
    const at = (now: number, reduced: boolean) =>
      step(settled, 16, now, reduced).actors.get("a")?.pose;
    const base = t0 + 10 * TYPE_FRAME_MS;
    expect(at(base, false)).not.toBe(at(base + TYPE_FRAME_MS, false));
    expect(at(base, true)).toBe("type");
    expect(at(base + TYPE_FRAME_MS, true)).toBe("type");
  });
});
