/**
 * AgentsTab 测试：页头 + 交互流程图 + Vibe + Agent 行；stale-effective 回归
 * （改 picker 后「当前使用」立即更新，不必等保存）；revert 分块语义由
 * modelDraft.test.ts 的纯函数测试覆盖，这里补一条组件级还原隔离。
 */
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useModelDraft, type ModelDraftState } from "../modelDraft";
import type { AgentDefinition, ModelConfig, ModelInfo } from "../types";
import { AgentsTab } from "./AgentsTab";
import type { ToastFn } from "./useOmpOp";

const MODELS: ModelInfo[] = [
  {
    selector: "5438/mimo-v2.6-pro",
    provider: "5438",
    id: "mimo-v2.6-pro",
    name: "MiMo v2.6 Pro (5438)",
    thinkingLevels: ["low", "high"],
    contextWindow: 200000,
    maxTokens: null,
    reasoning: true,
    input: ["text"],
    costInput: 1,
    costOutput: 4,
    costCacheRead: null,
    costCacheWrite: null,
  },
  {
    selector: "5438/deepseek-v4.1-flash",
    provider: "5438",
    id: "deepseek-v4.1-flash",
    name: "DeepSeek v4.1 Flash",
    thinkingLevels: ["low", "max"],
    contextWindow: 1000000,
    maxTokens: null,
    reasoning: true,
    input: ["text"],
    costInput: 0.3,
    costOutput: 1.2,
    costCacheRead: null,
    costCacheWrite: null,
  },
  {
    selector: "factory-droid/gpt-6.1-sol",
    provider: "factory-droid",
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    thinkingLevels: ["high"],
    contextWindow: 300000,
    maxTokens: null,
    reasoning: true,
    input: ["text"],
    costInput: 2,
    costOutput: 10,
    costCacheRead: null,
    costCacheWrite: null,
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
    default: "5438/mimo-v2.6-pro:high",
    judge: "typesafe/jev-latest",
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
    "5438/mimo-v2.6-pro": ["factory-droid/gpt-6.1-sol"],
    "retired/old": ["5438/deepseek-v4.1-flash:max", "retired/older"],
    sonic: ["5438/deepseek-v4.1-flash"],
  },
  agents: AGENTS,
  retryStatus: { modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "cooldown-expiry" },
};

function stubConfig(config: ModelConfig = BASE_CONFIG): void {
  const snapshot = structuredClone(config);
  mockIPC(async (cmd: string) => {
    if (cmd === "list_models") return structuredClone(MODELS);
    if (cmd === "get_model_config") return structuredClone(snapshot);
    throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
  });
}

function Harness(props: { onToast: ToastFn }) {
  const l = useModelDraft(props.onToast);
  return l.status === "ready" ? <AgentsTab state={l.state} /> : null;
}

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("AgentsTab 页头", () => {
  it("停用后 chips 计数同步", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    fireEvent.click(screen.getByLabelText("停用 task"));
    expect(screen.getByRole("status", { name: "Agent 状态" })).toHaveTextContent("停用 1");
  });

  it("渲染 Vibe 卡 + 流程图 + Agent 行 + 生效提示", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    expect(screen.getByTestId("vibe-card")).toBeInTheDocument();
    expect(screen.getByTestId("agent-row-task")).toBeInTheDocument();
    expect(screen.getByTestId("agent-row-scout")).toBeInTheDocument();
    expect(screen.getByTestId("agent-row-deployer")).toBeInTheDocument();
    // 流程图只渲染一次（AgentsTab 的可交互图；AgentsSection 不再渲染）。
    expect(screen.getAllByTestId("agent-flow")).toHaveLength(1);
    expect(screen.getByText(/新开的 omp 会话使用新配置/)).toBeInTheDocument();
  });
  it("兜底总开关关闭时显示警告", async () => {
    stubConfig({
      ...structuredClone(BASE_CONFIG),
      retryStatus: { modelFallback: false, fallbackOn: "any", fallbackRevertPolicy: "never" },
    });
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");
    expect(screen.getByText(/兜底已关闭/)).toHaveTextContent("不会生效");
  });
});

describe("流程图交互", () => {
  it("节点可聚焦可点击：点击后滚动到对应行并高亮约 1.6s", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    const node = screen.getByTestId("agent-flow-node-task");
    expect(node).toHaveAttribute("role", "button");
    expect(node).toHaveAttribute("tabindex", "0");

    const row = screen.getByTestId("agent-row-task");
    const scrollSpy = vi.fn();
    row.scrollIntoView = scrollSpy;
    fireEvent.click(node);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(row.classList.contains("agent-row-flash")).toBe(true);
    expect(node).toHaveAttribute("aria-pressed", "true");
  });

  it("高亮一段时间后自动移除", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    vi.useFakeTimers();
    try {
      const row = screen.getByTestId("agent-row-task");
      row.scrollIntoView = vi.fn();
      fireEvent.click(screen.getByTestId("agent-flow-node-task"));
      expect(row.classList.contains("agent-row-flash")).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(row.classList.contains("agent-row-flash")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("键盘 Enter/Space 同样定位", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    const row = screen.getByTestId("agent-row-scout");
    const scrollSpy = vi.fn();
    row.scrollIntoView = scrollSpy;
    fireEvent.keyDown(screen.getByTestId("agent-flow-node-scout"), { key: "Enter" });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(row.classList.contains("agent-row-flash")).toBe(true);
  });
});

describe("stale-effective 回归", () => {
  it("改 Agent picker 后「当前使用」立即更新，不必等保存", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    expect(screen.getByTestId("agent-effective-task")).toHaveTextContent("MiMo v2.6 Pro (5438)");
    fireEvent.click(screen.getByRole("button", { name: "task 改用的模型" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    // 没点保存：effective 行已跟随草稿。
    expect(screen.getByTestId("agent-effective-task")).toHaveTextContent("DeepSeek v4.1 Flash");
  });

  it("Vibe 档位同理：改 picker 后档位行与指挥者吸附立即更新", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    const tier = screen.getByTestId("vibe-tier-good");
    fireEvent.click(
      within(tier).getByRole("button", { name: "Vibe 强力工作会话（good）改用的模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    // 没点保存：档位 effective 已跟随草稿；吸附链也按新模型重算。
    expect(screen.getByTestId("vibe-effective-good")).toHaveTextContent("DeepSeek v4.1 Flash");
    const block = screen.getByTestId("vibe-fallback-good");
    expect(block).not.toHaveTextContent("「MiMo v2.6 Pro (5438)」的兜底");
  });

  it("清掉覆盖（不改用）后按无覆盖重算，不再显示旧值", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    fireEvent.click(screen.getByRole("button", { name: "scout 改用的模型" }));
    fireEvent.click(screen.getByRole("button", { name: "不改用" }));
    // scout 内置默认 @smol → smol 未配置 → 沿回退链用 default 的模型。
    const effective = screen.getByTestId("agent-effective-scout");
    expect(effective).toHaveTextContent("MiMo v2.6 Pro (5438)");
    expect(effective).toHaveTextContent("smol未配置");
  });
});

describe("刷新按钮", () => {
  it("干净时可用：点刷新重读模型与配置", async () => {
    let modelsReads = 0;
    let configReads = 0;
    const snapshot = structuredClone(BASE_CONFIG);
    mockIPC(async (cmd: string) => {
      if (cmd === "list_models") {
        modelsReads += 1;
        return structuredClone(MODELS);
      }
      if (cmd === "get_model_config") {
        configReads += 1;
        return structuredClone(snapshot);
      }
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");
    // 模型命中进程内缓存时挂载不读 list_models：只断言刷新带来的增量。
    const modelsBefore = modelsReads;
    const configBefore = configReads;

    const button = screen.getByRole("button", { name: "刷新" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(modelsReads).toBe(modelsBefore + 1));
    await waitFor(() => expect(configReads).toBe(configBefore + 1));
  });

  it("有未保存修改时禁用并提示先保存或还原", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("停用 deployer"));
    const button = screen.getByRole("button", { name: "刷新" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "有未保存修改，先保存或还原");
  });
});

/** 把 hook state 递出来的探针：测 saveBlock 双击竞态，不经过保存按钮。 */
function SaveProbe(props: { onState: (s: ModelDraftState) => void; onToast: ToastFn }) {
  const loaded = useModelDraft(props.onToast);
  const { onState } = props;
  useEffect(() => {
    if (loaded.status === "ready") onState(loaded.state);
  }, [loaded, onState]);
  return null;
}

describe("还原隔离（组件级）", () => {
  it("Agent 还原不丢 Vibe/覆盖以外的展示（保存条按块独立出现）", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    fireEvent.click(screen.getByLabelText("停用 deployer"));
    const bar = within(screen.getByRole("region", { name: "Agent" })).getByRole("status");
    expect(bar).toHaveTextContent("1 处未保存修改");
    fireEvent.click(within(bar).getByRole("button", { name: "还原" }));
    expect(
      within(screen.getByRole("region", { name: "Agent" })).queryByRole("status"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("停用 deployer")).not.toBeChecked();
  });

  it("改 picker 后「当前使用」跟随草稿，还原后回到保存值", async () => {
    stubConfig();
    render(<Harness onToast={vi.fn()} />);
    await screen.findByTestId("agent-flow");

    const effective = screen.getByTestId("agent-effective-task");
    expect(effective).toHaveTextContent("MiMo v2.6 Pro (5438)");
    fireEvent.click(screen.getByRole("button", { name: "task 改用的模型" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    expect(effective).toHaveTextContent("DeepSeek v4.1 Flash");
    const bar = within(screen.getByRole("region", { name: "Agent" })).getByRole("status");
    fireEvent.click(within(bar).getByRole("button", { name: "还原" }));
    expect(effective).toHaveTextContent("MiMo v2.6 Pro (5438)");
    expect(
      within(screen.getByRole("region", { name: "Agent" })).queryByRole("status"),
    ).not.toBeInTheDocument();
  });
});

describe("saveBlock 双击竞态（A5）", () => {
  it("两次同步调用只发一次 update_model_config", async () => {
    const saves: unknown[] = [];
    const snapshot = structuredClone(BASE_CONFIG);
    mockIPC(async (cmd: string, payload?: unknown) => {
      if (cmd === "list_models") return structuredClone(MODELS);
      if (cmd === "get_model_config") return structuredClone(snapshot);
      if (cmd === "update_model_config") {
        saves.push(payload);
        return { key: "task.disabledAgents", value: ["scout"] };
      }
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    const captured: { state: ModelDraftState | null } = { state: null };
    render(<SaveProbe onToast={vi.fn()} onState={(s) => { captured.state = s; }} />);
    await waitFor(() => expect(captured.state).not.toBe(null));
    const state = captured.state;
    if (state === null) throw new Error("hook 未就绪");

    // 两次调用之间不让出：旧实现读 stale busyBlock 会发两次。
    const first = state.saveBlock("agents", [
      { key: "task.disabledAgents", value: ["scout"], expected: [] },
    ]);
    const second = state.saveBlock("agents", [
      { key: "task.disabledAgents", value: ["scout"], expected: [] },
    ]);
    await Promise.all([first, second]);
    expect(saves).toHaveLength(1);
  });
});
