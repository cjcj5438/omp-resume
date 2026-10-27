import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentDetail,
  AgentStage,
  ModelConfig,
  ModelInfo,
  RunningSession,
  StageActor,
  StageActorState,
} from "../types";

// 舞台数据层由本测试完全替代：断言的是渲染/筛选/选中的交互契约。
const getAgentStage = vi.fn<(path: string) => Promise<AgentStage>>();
const listRunningSessions = vi.fn<() => Promise<RunningSession[]>>();
const getModelConfig = vi.fn<() => Promise<ModelConfig>>();
const listModels = vi.fn<() => Promise<ModelInfo[]>>();
const listAgentDetails = vi.fn<() => Promise<AgentDetail[]>>();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentStage: (path: string) => getAgentStage(path),
    listRunningSessions: () => listRunningSessions(),
    getModelConfig: () => getModelConfig(),
    listModels: () => listModels(),
    listAgentDetails: () => listAgentDetails(),
  };
});

vi.mock("./StageCanvas", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // 场景绘制与命中测试由 scene 单测覆盖；这里只保留外壳与按钮。
    StageCanvas: (props: {
      stage: AgentStage;
      onOpenLibrary: () => void;
      onSelect: (id: string | null) => void;
    }) => (
      <div data-testid="stage-canvas">
        {props.stage.actors.map((a) => (
          <button key={a.id} type="button" onClick={() => props.onSelect(a.id)}>
            hit-{a.name}
          </button>
        ))}
        <button type="button" onClick={props.onOpenLibrary}>
          打开 Agent 库
        </button>
      </div>
    ),
  };
});

import { StageView } from "./StageView";

function actor(id: string, state: StageActorState, over: Partial<StageActor> = {}): StageActor {
  return {
    id,
    kind: id === "main" ? "main" : "subagent",
    parentId: null,
    name: id,
    agent: id === "main" ? null : "task",
    brief: id === "main" ? null : `任务 ${id}`,
    state,
    statusText: null,
    startedAt: "2026-10-21T01:00:00.000Z",
    endedAt: state === "done" ? "2026-10-21T01:04:00.000Z" : null,
    lastActivityAt: "2026-10-21T01:05:00.000Z",
    model: "p/m",
    contextTokens: 1000,
    cost: 0.01,
    toolCalls: 4,
    current: state === "running" ? { at: "2026-10-21T01:05:00.000Z", kind: "tool", tool: "read", text: "读配置" } : null,
    recent:
      state === "running"
        ? [{ at: "2026-10-21T01:05:00.000Z", kind: "tool", tool: "read", text: "读配置" }]
        : [{ at: "2026-10-21T01:04:00.000Z", kind: "state", tool: null, text: "完成" }],
    ...over,
  };
}

function stage(actors: StageActor[], inUse = true): AgentStage {
  return {
    path: "/mock/s.jsonl",
    sessionId: "s1",
    title: "mock 舞台会话",
    cwd: "/mock",
    inUse,
    probeOk: true,
    updatedAt: "2026-10-21T01:06:00.000Z",
    omitted: 0,
    actors: [actor("main", inUse ? "running" : "done"), ...actors],
  };
}

const RUNNING_ONE: RunningSession = {
  id: "s1",
  path: "/mock/s.jsonl",
  title: "mock 舞台会话",
  status: "working",
  statusText: "工作中",
  subagents: 2,
  durationSecs: 300,
  app: "iTerm2",
};

const MODEL: ModelInfo = {
  selector: "p/smol",
  provider: "p",
  id: "smol",
  name: "Smol",
  thinkingLevels: ["low", "high"],
  contextWindow: 100000,
  maxTokens: 8000,
  reasoning: true,
  input: ["text"],
  costInput: 0.1,
  costOutput: 0.2,
  costCacheRead: 0,
  costCacheWrite: 0,
};

const CONFIG: ModelConfig = {
  roles: { default: "@smol", smol: "p/smol" },
  agentOverrides: {},
  disabledAgents: [],
  agentAdvisor: {},
  fallbackChains: {},
  agents: [
    { name: "task", description: "通用", source: "builtin", defaultModel: ["@task"], defaultThinkingLevel: null },
    { name: "scout", description: "调研", source: "builtin", defaultModel: ["@smol"], defaultThinkingLevel: "medium" },
  ],
  retryStatus: { modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "x" },
};

const DETAILS: AgentDetail[] = [
  {
    name: "scout",
    description: "调研",
    source: "builtin",
    defaultModel: ["@smol"],
    defaultThinkingLevel: "medium",
    tools: ["read", "grep"],
    spawns: null,
    systemPrompt: "SP",
  },
];

beforeEach(() => {
  localStorage.clear();
  getAgentStage.mockReset();
  listRunningSessions.mockReset();
  getModelConfig.mockReset().mockResolvedValue(CONFIG);
  listModels.mockReset().mockResolvedValue([MODEL]);
  listAgentDetails.mockReset().mockResolvedValue(DETAILS);
  // jsdom 无 canvas 实现：明确返回 null，验证「只渲染外壳」路径。
  HTMLCanvasElement.prototype.getContext = () => null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StageView", () => {
  test("无运行会话且无选中会话 → 空态", async () => {
    listRunningSessions.mockResolvedValue([]);
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    expect(
      await screen.findByText("没有运行中的会话。在左侧选择一个会话，可回看它的子代理舞台。"),
    ).toBeInTheDocument();
    expect(getAgentStage).not.toHaveBeenCalled();
  });

  test("按状态筛选后卡片行只剩命中项", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockResolvedValue(
      stage([actor("api", "done"), actor("tests", "running"), actor("docs", "failed")]),
    );
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    const cards = await screen.findByRole("group", { name: "角色卡片" });
    expect(within(cards).getByRole("button", { name: /api/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^完成 / }));
    await waitFor(() => {
      expect(within(cards).queryByRole("button", { name: /tests/ })).not.toBeInTheDocument();
    });
    expect(within(cards).getByRole("button", { name: /api/ })).toBeInTheDocument();
    // main 永不被筛掉。
    expect(within(cards).getByRole("button", { name: /main/ })).toBeInTheDocument();
  });

  test("点卡片后活动流只含该角色，Esc 清选", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockResolvedValue(
      stage([actor("api", "done"), actor("tests", "running", { recent: [{ at: "2026-10-21T01:05:30.000Z", kind: "reply", tool: null, text: "唯一一条" }] })]),
    );
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    const cards = await screen.findByRole("group", { name: "角色卡片" });
    fireEvent.click(within(cards).getByRole("button", { name: /tests/ }));
    expect(await screen.findByText("唯一一条")).toBeInTheDocument();
    expect(screen.queryByText("完成")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    // 清选后回到「全部角色」。
    await waitFor(() => {
      expect(screen.getByText(/全部角色 · /)).toBeInTheDocument();
    });
  });

  test("已完成角色的 statusText 与状态词重复时只显示一次", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockResolvedValue(
      stage([actor("api", "done", { statusText: "已结束" }), actor("idle1", "idle", { statusText: "等待输入" })]),
    );
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    const cards = await screen.findByRole("group", { name: "角色卡片" });
    const done = within(cards).getByRole("button", { name: /api/ });
    expect(done.textContent).toContain("已完成");
    expect(done.textContent).not.toContain("已结束");
    // 非重复的说明仍然显示。
    expect(within(cards).getByRole("button", { name: /idle1/ }).textContent).toContain("等待输入");
  });

  test("NOT_FOUND 显示专用文案", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockRejectedValue({ code: "NOT_FOUND", message: "会话文件不存在：/x" });
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    // 连续 2 次失败才置错误（偶发失败不该闪错误）；1.5s 一次轮询。
    expect(
      await screen.findByText("会话文件不存在（可能已被删除）", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(getAgentStage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("只有主会话时提示没有子代理，并标记回看", async () => {
    listRunningSessions.mockResolvedValue([]);
    getAgentStage.mockResolvedValue(stage([], false));
    render(
      <StageView
        onBack={() => {}}
        selectedPath="/mock/s.jsonl"
        stageTarget={null}
        selectedTitle="回看会话"
        onOpenSession={() => {}}
      />,
    );
    expect(await screen.findByText("该会话没有子代理。")).toBeInTheDocument();
    expect(screen.getByText("回看")).toBeInTheDocument();
    // 回看模式下头部显示「已结束」。
    expect(screen.getByText("已结束")).toBeInTheDocument();
  });

  test("Agent 库可打开、切换形象并落 localStorage（只读配置）", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockResolvedValue(stage([actor("api", "running")]));
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 Agent 库" }));
    const dialog = await screen.findByRole("dialog", { name: "Agent 库" });
    expect(within(dialog).getByText(/形象只保存在本应用/)).toBeInTheDocument();
    const row = await within(dialog).findByRole("button", { name: /scout/ });
    fireEvent.click(row);
    fireEvent.change(within(dialog).getByLabelText("scout 的形象"), { target: { value: "ops" } });
    expect(localStorage.getItem("omp-resume:stage:v2")).toContain("\"scout\":\"ops\"");
    // 只读：对话框里没有保存类按钮。
    expect(within(dialog).queryByRole("button", { name: /保存/ })).toBeNull();
  });

  test("选中角色后显示它的 agent 配置（只读）", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockResolvedValue(stage([actor("api", "running", { agent: "scout" })]));
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    const cards = await screen.findByRole("group", { name: "角色卡片" });
    fireEvent.click(within(cards).getByRole("button", { name: /api/ }));
    expect(await screen.findByText("Agent 配置 · scout")).toBeInTheDocument();
    expect(await screen.findByTestId("stage-agent-effective")).toBeInTheDocument();
    // 工具与系统提示词来自只读详情（活动流里也有 read 标记，所以限定在配置面板内）。
    const summary = screen.getByText("Agent 配置 · scout");
    const panel = summary.closest("details");
    expect(panel).not.toBeNull();
    const scoped = within(panel as HTMLElement);
    expect(scoped.getByText("read")).toBeInTheDocument();
    expect(scoped.getByText(/系统提示词（2 字）/)).toBeInTheDocument();
  });

  test("状态变化用中文播报（不限选中角色）", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage
      .mockResolvedValueOnce(stage([actor("api", "running")]))
      .mockResolvedValue(stage([actor("api", "done", { statusText: "已结束" })]));
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={() => {}} />);
    await screen.findByRole("group", { name: "角色卡片" });
    await waitFor(
      () => {
        const live = document.querySelector('[aria-live="polite"]');
        expect(live?.textContent).toContain("api 已完成");
      },
      { timeout: 5000 },
    );
  });

  test("挂载时不重放上次进舞台留下的旧请求", async () => {
    // App 的 stageTarget 从不清空：上次在舞台内点过 old（seq 3），退出后又选中 s
    // 再进舞台。旧请求不得覆盖「运行列表为空 → 落到 selectedPath」的默认选择。
    listRunningSessions.mockResolvedValue([]);
    getAgentStage.mockResolvedValue(stage([actor("api", "running")]));
    const { rerender } = render(
      <StageView
        onBack={() => {}}
        selectedPath="/mock/s.jsonl"
        selectedTitle="回看会话"
        onOpenSession={() => {}}
        stageTarget={{ path: "/mock/old.jsonl", seq: 3 }}
      />,
    );
    await screen.findByRole("group", { name: "角色卡片" });
    expect(getAgentStage).toHaveBeenCalledWith("/mock/s.jsonl");
    expect(getAgentStage).not.toHaveBeenCalledWith("/mock/old.jsonl");
    // 挂载后发出的新请求（seq 4）必须正常消费。
    getAgentStage.mockClear();
    rerender(
      <StageView
        onBack={() => {}}
        selectedPath="/mock/old.jsonl"
        selectedTitle="旧会话"
        onOpenSession={() => {}}
        stageTarget={{ path: "/mock/old.jsonl", seq: 4 }}
      />,
    );
    await waitFor(() => {
      expect(getAgentStage).toHaveBeenCalledWith("/mock/old.jsonl");
    });
  });

  test("侧栏点击会话时舞台切换过去（不离开舞台）", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockResolvedValue(stage([actor("api", "running")]));
    const props = {
      onBack: () => {},
      selectedTitle: "另一个会话",
      onOpenSession: () => {},
    };
    const { rerender } = render(
      <StageView {...props} selectedPath={null} stageTarget={null} />,
    );
    await screen.findByRole("group", { name: "角色卡片" });
    getAgentStage.mockClear();
    // App 把侧栏点击翻译成 stageTarget 请求（含 seq）。
    rerender(
      <StageView
        {...props}
        selectedPath="/mock/other.jsonl"
        stageTarget={{ path: "/mock/other.jsonl", seq: 0 }}
      />,
    );
    await waitFor(() => {
      expect(getAgentStage).toHaveBeenCalledWith("/mock/other.jsonl");
    });
    // 仍在舞台视图（头部标题还在）。
    expect(screen.getByText("舞台")).toBeInTheDocument();
  });

  test("同一会话在侧栏被再次点击时舞台仍切换过去", async () => {
    // 回放真实复现：打开舞台时还没有选中任何会话（selectedPath=null），
    // 运行列表先回 B，舞台首选 B；用户在侧栏选中 A（A 非运行中），
    // 切到舞台内别的会话后，再点一次 A ——path 没变，但舞台也必须切回 A。
    const runningB: RunningSession = { ...RUNNING_ONE, id: "b", path: "/mock/b.jsonl", title: "运行中的 B" };
    const gate = Promise.withResolvers<RunningSession[]>();
    listRunningSessions
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue([runningB]);
    getAgentStage.mockImplementation((path: string) =>
      Promise.resolve({
        ...stage([actor("api", "running")]),
        path,
        title: path === "/mock/a.jsonl" ? "回看的 A" : "运行中的 B",
      }),
    );
    const base = {
      onBack: () => {},
      selectedTitle: "回看的 A",
      onOpenSession: () => {},
    };
    const { rerender } = render(<StageView {...base} selectedPath={null} stageTarget={null} />);
    // 运行列表回 B：首选 B。
    await act(async () => {
      gate.resolve([runningB]);
    });
    await screen.findByRole("group", { name: "角色卡片" });
    expect(getAgentStage).toHaveBeenCalledWith("/mock/b.jsonl");
    // 侧栏点 A（此前没选过任何会话）：切到 A。
    rerender(
      <StageView {...base} selectedPath="/mock/a.jsonl" stageTarget={{ path: "/mock/a.jsonl", seq: 0 }} />,
    );
    await waitFor(() => {
      expect(getAgentStage).toHaveBeenCalledWith("/mock/a.jsonl");
    });
    const headTitle = () => document.querySelector(".stage-head-title")?.textContent;
    await waitFor(() => {
      expect(headTitle()).toBe("回看的 A");
    });
    // 舞台内又切到别的会话（点左栏运行中的 B），A 仍是侧栏选中行。
    fireEvent.click(screen.getByRole("button", { name: /运行中的 B/ }));
    await waitFor(() => {
      expect(headTitle()).toBe("运行中的 B");
    });
    getAgentStage.mockClear();
    // 侧栏再点一次 A：selectedPath 从头到尾都是 A（prevSelected 方案在这里失效），
    // 但这是一次新的点击请求，舞台必须切回 A。
    rerender(
      <StageView {...base} selectedPath="/mock/a.jsonl" stageTarget={{ path: "/mock/a.jsonl", seq: 1 }} />,
    );
    await waitFor(() => {
      expect(getAgentStage).toHaveBeenCalledWith("/mock/a.jsonl");
    });
    await waitFor(() => {
      expect(headTitle()).toBe("回看的 A");
    });
  });

  test("查看会话按钮回报当前 path", async () => {
    listRunningSessions.mockResolvedValue([RUNNING_ONE]);
    getAgentStage.mockResolvedValue(stage([actor("api", "running")]));
    const onOpenSession = vi.fn<(path: string) => void>();
    render(<StageView onBack={() => {}} selectedPath={null} stageTarget={null} selectedTitle={null} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看会话" }));
    expect(onOpenSession).toHaveBeenCalledWith("/mock/s.jsonl");
  });
});
