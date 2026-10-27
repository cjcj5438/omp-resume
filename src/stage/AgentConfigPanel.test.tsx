import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { AgentDetail, ModelConfig, ModelInfo, StageActor } from "../types";
import { AgentConfigPanel } from "./AgentConfigPanel";
import type { AgentCatalog } from "./agentCatalog";

// 面板是纯渲染组件：catalog 对象直接当 props 传，不 mock api。
const MODEL: ModelInfo = {
  selector: "p/m",
  provider: "p",
  id: "m",
  name: "M",
  thinkingLevels: ["medium"],
  contextWindow: 100000,
  maxTokens: 8000,
  reasoning: false,
  input: ["text"],
  costInput: null,
  costOutput: null,
  costCacheRead: null,
  costCacheWrite: null,
};

function config(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    roles: {},
    agentOverrides: {},
    disabledAgents: [],
    agentAdvisor: {},
    fallbackChains: {},
    agents: [],
    retryStatus: { modelFallback: null, fallbackOn: null, fallbackRevertPolicy: null },
    ...over,
  };
}

function catalog(over: Partial<AgentCatalog> = {}): AgentCatalog {
  return { loading: false, config: null, models: [], details: [], error: null, ...over };
}

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    name: "scout",
    description: "",
    source: "builtin",
    defaultModel: ["p/m"],
    defaultThinkingLevel: null,
    tools: ["read", "grep"],
    spawns: null,
    systemPrompt: "SP",
    ...over,
  };
}

function stageActor(over: Partial<StageActor> = {}): StageActor {
  return {
    id: "scout-1",
    kind: "subagent",
    parentId: null,
    name: "scout-1",
    agent: "scout",
    brief: "调研",
    state: "done",
    statusText: null,
    startedAt: null,
    endedAt: null,
    lastActivityAt: null,
    model: "p/m",
    contextTokens: 0,
    cost: 0,
    toolCalls: 0,
    current: null,
    recent: [],
    ...over,
  };
}

/** 只读契约：任何渲染都不出现写操作按钮。 */
function expectNoWriteButtons() {
  const bad = screen
    .queryAllByRole("button")
    .filter((b) => /保存|修改|删除|停止/.test(b.textContent ?? ""));
  expect(bad).toHaveLength(0);
}

describe("AgentConfigPanel", () => {
  test("加载中显示读取提示", () => {
    render(<AgentConfigPanel entryKey="scout" actor={null} catalog={catalog({ loading: true })} />);
    expect(screen.getByText("读取 omp agent 配置…")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("读取失败且无定义：报错但不崩", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({ error: { code: "OMP_FAILED", message: "x" } })}
      />,
    );
    expect(screen.getByText(/读取 omp 配置失败/)).toBeInTheDocument();
    expect(screen.getByText(/未找到该 agent 的定义/)).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("main：显示 default 角色的友好名", () => {
    render(
      <AgentConfigPanel
        entryKey="main"
        actor={null}
        catalog={catalog({ config: config({ roles: { default: "p/m" } }), models: [MODEL] })}
      />,
    );
    expect(screen.getByText("管理员 · 主会话")).toBeInTheDocument();
    expect(screen.getByText(/default 角色/)).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("main：config 为空时只有标题没有角色行", () => {
    render(<AgentConfigPanel entryKey="main" actor={null} catalog={catalog()} />);
    expect(screen.getByText("管理员 · 主会话")).toBeInTheDocument();
    expect(screen.queryByText(/default 角色/)).toBeNull();
    expectNoWriteButtons();
  });

  test("advisor：只列出开启顾问的 agent", () => {
    render(
      <AgentConfigPanel
        entryKey="advisor"
        actor={null}
        catalog={catalog({ config: config({ agentAdvisor: { scout: "on", task: "off" } }) })}
      />,
    );
    expect(screen.getByText("scout")).toBeInTheDocument();
    expect(screen.queryByText("task")).toBeNull();
    expectNoWriteButtons();
  });

  test("advisor：无开启时显示无", () => {
    render(
      <AgentConfigPanel entryKey="advisor" actor={null} catalog={catalog({ config: config() })} />,
    );
    expect(screen.getByText("无")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("scout：工具 chips、spawns 未声明、提示词字数", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({ config: config(), models: [MODEL], details: [detail()] })}
      />,
    );
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("grep")).toBeInTheDocument();
    expect(screen.getByText("未声明")).toBeInTheDocument();
    expect(screen.getByText("系统提示词（2 字）")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("tools 为空数组显示无", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({ config: config(), models: [MODEL], details: [detail({ tools: [] })] })}
      />,
    );
    expect(screen.getByText("无")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("tools 为 null 显示默认工具集", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({ config: config(), models: [MODEL], details: [detail({ tools: null })] })}
      />,
    );
    expect(screen.getByText("默认工具集")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("spawns 含 * 显示任意 agent", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({ config: config(), models: [MODEL], details: [detail({ spawns: ["*"] })] })}
      />,
    );
    expect(screen.getByText("任意 agent")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("spawns 为空数组显示无", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({ config: config(), models: [MODEL], details: [detail({ spawns: [] })] })}
      />,
    );
    expect(screen.getByText("无")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("只有 config.agents 定义时提示未读取到系统提示词", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({
          config: config({
            agents: [
              {
                name: "scout",
                description: "",
                source: "builtin",
                defaultModel: ["p/m"],
                defaultThinkingLevel: null,
              },
            ],
          }),
          models: [MODEL],
        })}
      />,
    );
    expect(screen.getByText(/未读取到系统提示词/)).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("停用的 agent 打已停用标", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={null}
        catalog={catalog({
          config: config({ disabledAgents: ["scout"] }),
          models: [MODEL],
          details: [detail()],
        })}
      />,
    );
    expect(screen.getByText("已停用")).toBeInTheDocument();
    expectNoWriteButtons();
  });

  test("本次运行模型显示友好名", () => {
    render(
      <AgentConfigPanel
        entryKey="scout"
        actor={stageActor({ model: "p/m" })}
        catalog={catalog({ config: config(), models: [MODEL], details: [detail()] })}
      />,
    );
    expect(screen.getByText("本次运行模型：M")).toBeInTheDocument();
    expectNoWriteButtons();
  });
});
