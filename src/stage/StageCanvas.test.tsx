import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import type { AgentStage, StageActor, StageActorState } from "../types";
import { StageCanvas } from "./StageCanvas";
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
        onOpenLibrary={() => {}}
        theme="light"
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "4 个角色：运行 2、完成 1、异常 1",
    );
  });
});
