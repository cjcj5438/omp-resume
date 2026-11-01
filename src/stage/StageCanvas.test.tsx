import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import type { AgentStage, StageActor, StageActorState } from "../types";
import { layoutLabels, StageCanvas } from "./StageCanvas";
import { defaultStagePrefs } from "./prefs";
function actor(id: string, state: StageActorState): StageActor {
  return {
    id,
    kind: id === "main" ? "main" : "subagent",
    parentId: null,
    name: id,
    agent: id === "main" ? null : "task",
    brief: null,
    state,
    statusText: null,
    startedAt: "2026-10-21T01:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-10-21T01:05:00.000Z",
    model: null,
    contextTokens: 0,
    cost: 0,
    provenance: null,
    toolCalls: 0,
    current: null,
    recent: [],
  };
}

function stage(actors: StageActor[]): AgentStage {
  return {
    path: "/mock/s.jsonl",
    sessionId: "s1",
    title: "t",
    cwd: "/mock",
    inUse: true,
    probeOk: true,
    updatedAt: "2026-10-21T01:06:00.000Z",
    omitted: 0,
    actors: [actor("main", "running"), ...actors],
  };
}

beforeEach(() => {
  // jsdom 没有 canvas 实现：组件只渲染外壳，不启动动画。
  HTMLCanvasElement.prototype.getContext = () => null;
  // jsdom 也没有 ResizeObserver：给一个只回调一次的空实现。
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: (entries: { contentRect: { width: number } }[]) => void) {}
    observe(): void {
      this.cb([{ contentRect: { width: 640 } }]);
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

describe("StageCanvas", () => {
  test("可访问名汇总角色状态计数", () => {
    render(
      <StageCanvas
        stage={stage([actor("a", "running"), actor("b", "done"), actor("c", "failed")])}
        prefs={defaultStagePrefs()}
        filter={null}
        selectedId={null}
        onSelect={() => {}}
        theme="light"
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "4 个角色：运行 2、完成 1、异常 1",
    );
  });
});

describe("layoutLabels", () => {
  test("6 角色密集场景：两两不重叠、溢出收进 +N", () => {
    // 同一锚点、宽标签：5 lane 只能放 5 个，第 6 个必须溢出。
    const candidates = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({
      id,
      px: 100 + i * 4,
      py: 200,
      halfW: 48,
      h: 14,
      rank: 10 - i,
      pinned: false,
    }));
    const { placements, overflow } = layoutLabels(candidates);
    expect(placements).toHaveLength(5);
    expect(overflow).toHaveLength(1);
    // 两两不重叠：用 getBoundingClientRect 语义断言位移后的矩形不交。
    const candById = new Map(candidates.map((c) => [c.id, c]));
    const boxes = placements.map((p) => {
      const c = candById.get(p.id)!;
      const top = c.py - p.lane * 14 - c.h;
      return { left: c.px - c.halfW, right: c.px + c.halfW, top, bottom: top + c.h };
    });
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        expect(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).toBe(false);
      }
    }
  });

  test("y 错开的两行不再误判碰撞", () => {
    // 同 x 但 y 差 40：lane 0 矩形本就不交，应全部放下。
    const candidates = ["a", "b"].map((id, i) => ({
      id,
      px: 100,
      py: 200 + i * 40,
      halfW: 48,
      h: 14,
      rank: 10 - i,
      pinned: false,
    }));
    const { placements, overflow } = layoutLabels(candidates);
    expect(placements).toHaveLength(2);
    expect(overflow).toHaveLength(0);
    expect(placements.map((p) => p.lane)).toEqual([0, 0]);
  });

  test("选中角色即使最低优先级也不被收起", () => {
    const candidates = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      px: 100,
      py: 200,
      halfW: 48,
      h: 14,
      rank: 10,
      pinned: false,
    }));
    candidates.push({ id: "sel", px: 100, py: 200, halfW: 48, h: 14, rank: 0, pinned: true });
    const { placements, overflow } = layoutLabels(candidates);
    expect(placements.map((p) => p.id)).toContain("sel");
    expect(overflow).not.toContain("sel");
    expect(placements).toHaveLength(5);
    expect(overflow).toHaveLength(1);
  });

  test("优先级：运行中先占 lane，低优先级先进 overflow", () => {
    const candidates = [
      { id: "low", px: 100, py: 200, halfW: 48, h: 14, rank: 1, pinned: false },
      { id: "run", px: 100, py: 200, halfW: 48, h: 14, rank: 500, pinned: false },
      { id: "fail", px: 100, py: 200, halfW: 48, h: 14, rank: 400, pinned: false },
      { id: "lost", px: 100, py: 200, halfW: 48, h: 14, rank: 300, pinned: false },
      { id: "idle1", px: 100, py: 200, halfW: 48, h: 14, rank: 0, pinned: false },
      { id: "idle2", px: 100, py: 200, halfW: 48, h: 14, rank: 0, pinned: false },
    ];
    const { placements, overflow } = layoutLabels(candidates);
    const ids = placements.map((p) => p.id);
    expect(ids).toContain("run");
    expect(ids).toContain("fail");
    expect(ids).toContain("lost");
    expect(overflow).toHaveLength(1);
    expect(["idle1", "idle2", "low"]).toContain(overflow[0]);
  });
});
