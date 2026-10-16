/**
 * ModelsAgentsPanel 测试：未知值保留、删除条目语义、冲突重载、回退链排序。
 * 有状态场景走 installMockBackend，保存载荷断言用直连 mockIPC 桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentDefinition, ModelConfig, ModelInfo } from "../types";
import { ModelsAgentsPanel } from "./ModelsAgentsPanel";

const MODELS: ModelInfo[] = [
  {
    selector: "5438/mimo-v2.6-pro",
    provider: "5438",
    id: "mimo-v2.6-pro",
    name: "MiMo v2.6 Pro (5438)",
    thinkingLevels: ["low", "high"],
    contextWindow: 200000,
    reasoning: true,
    costInput: 1,
    costOutput: 4,
  },
  {
    selector: "5438/deepseek-v4.1-flash",
    provider: "5438",
    id: "deepseek-v4.1-flash",
    name: "DeepSeek v4.1 Flash",
    thinkingLevels: ["low", "max"],
    contextWindow: 1000000,
    reasoning: true,
    costInput: 0.3,
    costOutput: 1.2,
  },
  {
    selector: "factory-droid/gpt-6.1-sol",
    provider: "factory-droid",
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    thinkingLevels: ["high"],
    contextWindow: 300000,
    reasoning: true,
    costInput: 2,
    costOutput: 10,
  },
];

const AGENTS: AgentDefinition[] = [
  {
    name: "task",
    description: "通用",
    source: "builtin",
    defaultModel: ["@task"],
    defaultThinkingLevel: "auto",
  },
  {
    name: "scout",
    description: "调研",
    source: "builtin",
    defaultModel: ["@smol"],
    defaultThinkingLevel: "medium",
  },
  {
    name: "deployer",
    description: "自定义",
    source: "user",
    defaultModel: [],
    defaultThinkingLevel: null,
  },
];

const BASE_CONFIG: ModelConfig = {
  roles: {
    judge: "typesafe/jev-latest",
    default: "5438/mimo-v2.6-pro:high",
  },
  agentOverrides: {
    task: "5438/mimo-v2.6-pro:max",
    scout: "5438/deepseek-v4.1-flash",
  },
  disabledAgents: [],
  agentAdvisor: { task: "on" },
  fallbackChains: {
    default: ["5438/mimo-v2.6-pro", "factory-droid/gpt-6.1-sol"],
    task: ["5438/deepseek-v4.1-flash"],
  },
  agents: AGENTS,
};

interface SaveCall {
  key: string;
  value: unknown;
  expected: unknown;
}

/** 直连桩：可让 update_model_config 报 CONFLICT，并记录保存载荷。 */
function stubConfig(
  saves: SaveCall[],
  options: { config?: ModelConfig; conflictFirst?: boolean } = {},
) {
  let config = structuredClone(options.config ?? BASE_CONFIG);
  let conflictLeft = options.conflictFirst ? 1 : 0;
  let configReads = 0;
  mockIPC(async (cmd: string, payload?: unknown) => {
    if (cmd === "list_models") return structuredClone(MODELS);
    if (cmd === "get_model_config") {
      configReads += 1;
      return structuredClone(config);
    }
    if (cmd === "update_model_config") {
      const call = payload as SaveCall;
      saves.push(structuredClone(call));
      if (conflictLeft > 0) {
        conflictLeft -= 1;
        throw { code: "CONFLICT", message: "配置已被外部修改，请刷新后重试" };
      }
      (config as unknown as Record<string, unknown>)[
        {
          modelRoles: "roles",
          "task.agentModelOverrides": "agentOverrides",
          "task.disabledAgents": "disabledAgents",
          "task.agentAdvisor": "agentAdvisor",
          "retry.fallbackChains": "fallbackChains",
        }[call.key] ?? call.key
      ] = call.value;
      return { key: call.key, value: structuredClone(call.value) };
    }
    throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
  });
  return {
    get saves() {
      return saves;
    },
    get configReads() {
      return configReads;
    },
  };
}

function blockOf(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("模型角色", () => {
  it("未知值原样保留：只改其他角色时写回不认识的键与值", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByText("模型角色");

    // 未知值带标记展示，用户不动就不改写。
    expect(within(blockOf("模型角色")).getByText("typesafe/jev-latest")).toBeInTheDocument();
    expect(within(blockOf("模型角色")).getAllByText(/未知值/).length).toBeGreaterThan(0);

    // 只给 memory 行选一个模型。
    fireEvent.click(screen.getByRole("button", { name: "memory 的模型" }));
    fireEvent.click(screen.getByRole("button", { name: /MiMo v2\.6 Pro/ }));
    fireEvent.click(within(blockOf("模型角色")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].key).toBe("modelRoles");
    expect(saves[0].value).toEqual({
      judge: "typesafe/jev-latest",
      default: "5438/mimo-v2.6-pro:high",
      memory: "5438/mimo-v2.6-pro",
    });
    expect(saves[0].expected).toEqual(BASE_CONFIG.roles);
    // 保存后重载：未触碰的 `:thinking` 后缀保留在 thinking 档位里。
    await waitFor(() =>
      expect(
        within(blockOf("模型角色")).getByRole("button", { name: "保存" }),
      ).toBeDisabled(),
    );
    expect(
      within(blockOf("模型角色")).getByRole("button", { name: "default 的模型" }),
    ).toHaveTextContent("5438/mimo-v2.6-pro");
    expect(
      within(blockOf("模型角色")).getByRole("combobox", {
        name: "default 的模型 thinking 档位",
      }),
    ).toHaveValue("high");
  });
});

describe("Agent 表", () => {
  it("「不覆盖」删除该 agent 的覆盖条目，其余条目原样保留", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "Agent 配置" });

    fireEvent.click(screen.getByRole("button", { name: "scout 的模型覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "不覆盖" }));
    fireEvent.click(within(blockOf("Agent 配置")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    const overrides = saves.find((s) => s.key === "task.agentModelOverrides");
    expect(overrides?.value).toEqual({ task: "5438/mimo-v2.6-pro:max" });
    // 未改动的 key 不重写（只写有变化的配置键）。
    expect(saves.map((s) => s.key)).toEqual(["task.agentModelOverrides"]);
  });

  it("禁用与 advisor 只写各自配置键", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "Agent 配置" });

    fireEvent.click(screen.getByRole("checkbox", { name: "禁用 deployer" }));
    fireEvent.change(screen.getByRole("combobox", { name: "task 的 advisor" }), {
      target: { value: "off" },
    });
    fireEvent.click(within(blockOf("Agent 配置")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves.map((s) => s.key)).toEqual([
      "task.disabledAgents",
      "task.agentAdvisor",
    ]);
    expect(saves[0].value).toEqual(["deployer"]);
    expect(saves[1].value).toEqual({ task: "off" });
  });
});

describe("回退链", () => {
  it("上移/删除直接反映在保存载荷（删除即不含该项）", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByText("回退链");

    fireEvent.click(screen.getByRole("button", { name: "下移 5438/mimo-v2.6-pro" }));
    fireEvent.click(within(blockOf("回退链")).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].key).toBe("retry.fallbackChains");
    expect(saves[0].value).toEqual({
      default: ["factory-droid/gpt-6.1-sol", "5438/mimo-v2.6-pro"],
      task: ["5438/deepseek-v4.1-flash"],
    });

    // 删除某项 = 写不含该项的 record。
    await waitFor(() =>
      expect(
        within(blockOf("回退链")).getByRole("button", { name: "保存" }),
      ).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除 factory-droid/gpt-6.1-sol" }));
    fireEvent.click(within(blockOf("回退链")).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].value).toEqual({
      default: ["5438/mimo-v2.6-pro"],
      task: ["5438/deepseek-v4.1-flash"],
    });
  });
});

describe("冲突处理", () => {
  it("CONFLICT 提示并重新载入最新配置", async () => {
    const saves: SaveCall[] = [];
    const stub = stubConfig(saves, { conflictFirst: true });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByText("模型角色");

    fireEvent.click(screen.getByRole("button", { name: "memory 的模型" }));
    fireEvent.click(screen.getByRole("button", { name: /GPT-6\.1 Sol/ }));
    fireEvent.click(within(blockOf("模型角色")).getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/配置已被外部修改/)).toBeInTheDocument();
    // 冲突后重新读取配置（首次 + 冲突后各一次）。
    await waitFor(() => expect(stub.configReads).toBeGreaterThanOrEqual(2));
    // 草稿已还原到后端最新值：dirty 消失、保存按钮回到禁用。
    await waitFor(() =>
      expect(
        within(blockOf("模型角色")).getByRole("button", { name: "保存" }),
      ).toBeDisabled(),
    );
  });
});
