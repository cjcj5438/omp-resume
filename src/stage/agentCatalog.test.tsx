import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentDetail, ModelConfig, ModelInfo } from "../types";
import { useAgentCatalog } from "./agentCatalog";

const getModelConfig = vi.fn<() => Promise<ModelConfig>>();
const listModels = vi.fn<() => Promise<ModelInfo[]>>();
const listAgentDetails = vi.fn<() => Promise<AgentDetail[]>>();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getModelConfig: () => getModelConfig(),
    listModels: () => listModels(),
    listAgentDetails: () => listAgentDetails(),
  };
});

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
  ],
  retryStatus: { modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "x" },
};

const DETAILS: AgentDetail[] = [
  {
    name: "task",
    description: "通用",
    source: "builtin",
    defaultModel: ["@task"],
    defaultThinkingLevel: null,
    tools: ["read", "grep"],
    spawns: null,
    systemPrompt: "SP",
  },
];

beforeEach(() => {
  getModelConfig.mockReset();
  listModels.mockReset().mockResolvedValue([MODEL]);
  listAgentDetails.mockReset().mockResolvedValue(DETAILS);
});

describe("useAgentCatalog", () => {
  test("加载中途先关后开：结果仍落盘，不卡 loading", async () => {
    const gate = Promise.withResolvers<ModelConfig>();
    getModelConfig.mockImplementationOnce(() => gate.promise);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAgentCatalog(enabled),
      { initialProps: { enabled: false } },
    );
    expect(result.current.loading).toBe(false);

    // 选中角色 → 开始加载。
    rerender({ enabled: true });
    expect(result.current.loading).toBe(true);
    // 请求还在飞时取消选中（Esc / 点空白画布）。
    rerender({ enabled: false });

    // 后端返回（getModelConfig 要拉起多个 omp 子进程，本来就慢）。
    await act(async () => {
      gate.resolve(CONFIG);
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // 再次选中 → 直接拿到已加载的数据，不再发请求。
    rerender({ enabled: true });
    expect(result.current.loading).toBe(false);
    expect(result.current.config).toEqual(CONFIG);
    expect(result.current.models).toEqual([MODEL]);
    expect(result.current.details).toEqual(DETAILS);
    expect(result.current.error).toBeNull();
    expect(getModelConfig).toHaveBeenCalledTimes(1);
  });

  test("StrictMode 挂载双调用 effect 时仍能正常加载", async () => {
    getModelConfig.mockResolvedValue(CONFIG);
    const { result } = renderHook(() => useAgentCatalog(true), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      ),
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.config).toEqual(CONFIG);
    expect(result.current.details).toEqual(DETAILS);
  });
});
