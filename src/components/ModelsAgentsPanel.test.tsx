/**
 * ModelsAgentsPanel 测试：角色卡融合、Agent 实际使用、其他兜底、未知值保留、
 * 部分失败与冲突。保存载荷断言用直连 mockIPC 桩。
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

interface SaveCall {
  key: string;
  value: unknown;
  expected: unknown;
}

/** 直连桩：记录保存载荷；可让指定 key 首次写入失败，或全部冲突。 */
function stubConfig(
  saves: SaveCall[],
  options: { config?: ModelConfig; conflictFirst?: boolean; failKeys?: string[] } = {},
) {
  const config = structuredClone(options.config ?? BASE_CONFIG);
  let conflictLeft = options.conflictFirst ? 1 : 0;
  const failKeys = new Set(options.failKeys ?? []);
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
      if (failKeys.has(call.key)) {
        failKeys.delete(call.key);
        throw { code: "OMP_FAILED", message: "模拟写入失败" };
      }
      (
        config as unknown as Record<string, unknown>
      )[
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

function roleCard(role: string): HTMLElement {
  return screen.getByTestId(`role-card-${role}`);
}

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("主要模型（角色卡融合）", () => {
  it("主模型、按角色兜底、按模型兜底在同一张卡里", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    const card = roleCard("default");
    // 主模型 + thinking。
    expect(within(card).getByRole("button", { name: "主对话的主模型" })).toHaveTextContent(
      "MiMo v2.6 Pro (5438)",
    );
    expect(within(card).getByRole("radio", { name: "high" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 按角色兜底。
    expect(within(card).getByTestId("chain-default")).toBeInTheDocument();
    // 按模型兜底吸附进卡（主模型 base 命中 chain key）。
    const attached = within(card).getByTestId("chain-5438/mimo-v2.6-pro");
    expect(attached).toHaveTextContent("不管哪个角色在用这个模型");
    // 未吸附的 chain 不在卡里。
    expect(within(card).queryByTestId("chain-retired/old")).not.toBeInTheDocument();
  });

  it("未知主模型原样保留，加角色后只写 modelRoles", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    const judge = roleCard("judge");
    expect(within(judge).getByText("typesafe/jev-latest")).toBeInTheDocument();
    expect(within(judge).getByText("未知值 · 保留")).toBeInTheDocument();

    // task 只有兜底也有卡（主模型待配）。
    expect(roleCard("task")).toHaveTextContent("未配置");
    expect(within(roleCard("task")).getByTestId("chain-task")).toBeInTheDocument();

    // 添加 vision 角色并选模型。
    fireEvent.click(screen.getByTestId("expand-role-vision"));
    const vision = roleCard("vision");
    fireEvent.click(within(vision).getByRole("button", { name: "图片理解的主模型" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    fireEvent.click(within(blockOf("主要模型")).getByRole("button", { name: "保存主模型" }));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].key).toBe("modelRoles");
    expect(saves[0].value).toEqual({
      default: "5438/mimo-v2.6-pro:high",
      judge: "typesafe/jev-latest",
      vision: "5438/deepseek-v4.1-flash",
    });
    expect(saves[0].expected).toEqual(BASE_CONFIG.roles);
  });

  it("角色卡改兜底只写兜底，且只改对应 key", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    const chain = within(roleCard("default")).getByTestId("chain-default");
    fireEvent.click(within(chain).getByRole("button", { name: "下移 5438/mimo-v2.6-pro" }));
    fireEvent.click(within(blockOf("主要模型")).getByRole("button", { name: "保存兜底" }));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].key).toBe("retry.fallbackChains");
    expect(saves[0].value).toEqual({
      ...BASE_CONFIG.fallbackChains,
      default: ["factory-droid/gpt-6.1-sol", "5438/mimo-v2.6-pro"],
    });
  });

  it("兜底为空时点名报错，不发请求", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    fireEvent.click(
      within(within(roleCard("judge")).getByTestId("chain-judge")).getByRole("button", {
        name: "添加兜底",
      }),
    );
    fireEvent.click(within(blockOf("主要模型")).getByRole("button", { name: "保存兜底" }));
    expect(
      await screen.findByText("「裁判」的兜底还没有兜底模型：请添加，或删除这条兜底"),
    ).toBeInTheDocument();
    expect(saves).toHaveLength(0);
  });

  it("前一个 key 已写、后一个失败：点名已保存并重载", async () => {
    const saves: SaveCall[] = [];
    const stub = stubConfig(saves, { failKeys: ["retry.fallbackChains"] });
    const onToast = vi.fn();
    render(<ModelsAgentsPanel onToast={onToast} />);
    await screen.findByRole("region", { name: "主要模型" });

    // 同时改主模型与兜底：两个 key 都要写。
    fireEvent.click(
      within(roleCard("judge")).getByRole("button", { name: "裁判的主模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /GPT-6\.1 Sol/ }));
    const chain = within(roleCard("default")).getByTestId("chain-default");
    fireEvent.click(within(chain).getByRole("button", { name: "下移 5438/mimo-v2.6-pro" }));
    fireEvent.click(
      within(blockOf("主要模型")).getByRole("button", { name: "保存主模型与兜底" }),
    );

    expect(await screen.findByText(/「主模型」已保存/)).toHaveTextContent("兜底");
    expect(saves.map((s) => s.key)).toEqual(["modelRoles", "retry.fallbackChains"]);
    // 失败后重新载入（首次 + 失败后）。
    await waitFor(() => expect(stub.configReads).toBeGreaterThanOrEqual(2));
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining("已保存"), "info");
  });
});

describe("Agent", () => {
  it("每行先看当前实际使用的模型", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "Agent" });

    // task：覆盖生效。
    const taskEffective = screen.getByTestId("agent-effective-task");
    expect(taskEffective).toHaveTextContent("MiMo v2.6 Pro (5438)");
    expect(taskEffective).toHaveTextContent("来自「改用模型」");
    // deployer：无默认，跟随会话。
    expect(screen.getByTestId("agent-effective-deployer")).toHaveTextContent(
      "跟随当前会话模型",
    );
  });

  it("「不改用」删除覆盖条目，未改动的 key 不重写", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "Agent" });

    fireEvent.click(screen.getByRole("button", { name: "scout 改用的模型" }));
    fireEvent.click(screen.getByRole("button", { name: "不改用" }));
    fireEvent.click(within(blockOf("Agent")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    const overrides = saves.find((s) => s.key === "task.agentModelOverrides");
    expect(overrides?.value).toEqual({ task: "5438/mimo-v2.6-pro:max" });
    expect(saves.map((s) => s.key)).toEqual(["task.agentModelOverrides"]);
    // 保存重载后，scout 回到 @smol（smol 未配置，沿回退链实际使用 default 的模型）。
    await waitFor(() =>
      expect(screen.getByTestId("agent-effective-scout")).toHaveTextContent(
        "MiMo v2.6 Pro (5438)",
      ),
    );
    expect(screen.getByTestId("agent-effective-scout")).toHaveTextContent("smol未配置");
  });

  it("停用与顾问只写各自配置键", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "Agent" });

    fireEvent.click(screen.getByRole("checkbox", { name: "停用 deployer" }));
    fireEvent.change(screen.getByRole("combobox", { name: "task 的顾问" }), {
      target: { value: "off" },
    });
    fireEvent.click(within(blockOf("Agent")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves.map((s) => s.key)).toEqual(["task.disabledAgents", "task.agentAdvisor"]);
    expect(saves[0].value).toEqual(["deployer"]);
    expect(saves[1].value).toEqual({ task: "off" });
  });
});

describe("兜底 chip 的信息展示", () => {
  it("条目显示 provider 徽章；裸条目显示「继承」档位徽章", async () => {
    stubConfig([]);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    const chips = within(within(roleCard("default")).getByTestId("chain-default")).getAllByRole(
      "listitem",
    );
    expect(chips).toHaveLength(2);
    expect(within(chips[0]).getByTitle("供应商")).toHaveTextContent("5438");
    expect(within(chips[0]).getByTitle(/继承/)).toHaveTextContent("继承");
    expect(within(chips[0]).queryByTitle("思考强度")).not.toBeInTheDocument();
    expect(within(chips[1]).getByTitle("供应商")).toHaveTextContent("factory-droid");
    expect(within(chips[1]).getByTitle(/继承/)).toHaveTextContent("继承");
  });

  it("带后缀条目显示档位徽章；未知 selector 无 provider 徽章", async () => {
    stubConfig([]);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "其他模型的兜底" });
    fireEvent.click(screen.getByText(/共 2 条/));

    const chips = within(screen.getByTestId("chain-retired/old")).getAllByRole("listitem");
    expect(within(chips[0]).getByTitle("供应商")).toHaveTextContent("5438");
    expect(within(chips[0]).getByTitle("思考强度")).toHaveTextContent("max");
    expect(within(chips[1]).queryByTitle("供应商")).not.toBeInTheDocument();
    expect(within(chips[1]).getByTitle(/继承/)).toHaveTextContent("继承");
    expect(within(chips[1]).getByText("未知值 · 保留")).toBeInTheDocument();
  });
});

describe("其他模型的兜底", () => {
  it("折叠展示未吸附 chain，不认识的 key 有说明", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "其他模型的兜底" });

    // 默认折叠：只见条数（details 收起）。
    expect(screen.getByText(/共 2 条/)).toBeInTheDocument();
    const details = screen.getByTestId("others-details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText(/共 2 条/));
    expect(details).toHaveAttribute("open");
    expect(screen.getByTestId("chain-retired/old")).toBeInTheDocument();
    const sonic = screen.getByTestId("chain-sonic");
    expect(sonic).toHaveTextContent("omp 可能不会使用这条配置");
    // 已吸附的不在这里。
    expect(screen.queryAllByTestId("chain-5438/mimo-v2.6-pro")).toHaveLength(1);
  });

  it("改完保存只写兜底", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "其他模型的兜底" });
    fireEvent.click(screen.getByText(/共 2 条/));

    const chain = screen.getByTestId("chain-sonic");
    fireEvent.click(within(chain).getByRole("button", { name: "＋ 添加兜底模型" }));
    fireEvent.click(within(chain).getByRole("button", { name: "使用自定义值…" }));
    const manual = within(chain).getByLabelText(/手动输入/);
    fireEvent.change(manual, { target: { value: "p1/extra" } });
    fireEvent.keyDown(manual, { key: "Enter" });
    fireEvent.click(
      within(chain).getByRole("button", { name: "删除 5438/deepseek-v4.1-flash" }),
    );
    fireEvent.click(within(blockOf("其他模型的兜底")).getByRole("button", { name: "保存兜底" }));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].key).toBe("retry.fallbackChains");
    expect((saves[0].value as Record<string, unknown>)["sonic"]).toEqual(["p1/extra"]);
    // 其他 chain 原样保留。
    expect((saves[0].value as Record<string, unknown>)["retired/old"]).toEqual(
      BASE_CONFIG.fallbackChains["retired/old"],
    );
  });
});

describe("兜底总开关与冲突", () => {
  it("兜底关闭时有醒目提示", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves, {
      config: {
        ...structuredClone(BASE_CONFIG),
        retryStatus: { modelFallback: false, fallbackOn: "usage-limit", fallbackRevertPolicy: "never" },
      },
    });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });
    expect(screen.getByText(/兜底已关闭/)).toHaveTextContent("不会生效");
    expect(screen.getByText(/兜底：关/)).toHaveTextContent("仅用尽额度时切换");
  });

  it("CONFLICT 提示并重新载入最新配置", async () => {
    const saves: SaveCall[] = [];
    const stub = stubConfig(saves, { conflictFirst: true });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    fireEvent.click(screen.getByTestId("expand-role-vision"));
    fireEvent.click(within(roleCard("vision")).getByRole("button", { name: "图片理解的主模型" }));
    fireEvent.click(screen.getByRole("button", { name: /GPT-6\.1 Sol/ }));
    fireEvent.click(within(blockOf("主要模型")).getByRole("button", { name: "保存主模型" }));

    expect(await screen.findByText(/配置已被外部修改/)).toBeInTheDocument();
    await waitFor(() => expect(stub.configReads).toBeGreaterThanOrEqual(2));
    // 冲突后重新载入：草稿还原，吸底保存条消失。
    await waitFor(() =>
      expect(
        within(blockOf("主要模型")).queryByRole("button", { name: "保存主模型" }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("未配置角色与吸底保存条", () => {
  it("紧凑行显示实际使用，点「设置」展开成卡、可再收起", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    // memory 沿回退链用 default 的模型；advisor 只认已配置的 slow，走内置。
    const memory = screen.getByTestId("role-compact-memory");
    expect(memory).toHaveTextContent("未单独设置");
    expect(memory).toHaveTextContent("MiMo v2.6 Pro (5438) · high");
    expect(memory).toHaveTextContent("（主对话角色）");
    expect(screen.getByTestId("role-compact-advisor")).toHaveTextContent("omp 内置默认");

    fireEvent.click(within(memory).getByRole("button", { name: "设置" }));
    const card = screen.getByTestId("role-card-memory");
    expect(card).toBeInTheDocument();
    // 展开后可收起回紧凑行。
    fireEvent.click(within(card).getByRole("button", { name: "收起" }));
    expect(screen.queryByTestId("role-card-memory")).not.toBeInTheDocument();
    expect(screen.getByTestId("role-compact-memory")).toBeInTheDocument();
  });

  it("改一个角色出现吸底保存条并计数，保存后消失", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "主要模型" });

    // 未修改时没有保存条。
    expect(within(blockOf("主要模型")).queryByText(/处未保存修改/)).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId("role-compact-memory")).getByRole("button", { name: "设置" }));
    fireEvent.click(within(roleCard("memory")).getByRole("button", { name: "记忆助手的主模型" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));

    const bar = within(blockOf("主要模型")).getByRole("status");
    expect(bar).toHaveTextContent("1 处未保存修改");
    fireEvent.click(within(bar).getByRole("button", { name: "保存主模型" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    await waitFor(() =>
      expect(within(blockOf("主要模型")).queryByRole("status")).not.toBeInTheDocument(),
    );
  });
});

describe("Agent 编排流程图", () => {
  it("主代理显示 default 角色当前模型；节点显示中文职责与当前使用", async () => {
    stubConfig([]);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "Agent" });

    const flow = screen.getByTestId("agent-flow");
    const orchestrator = within(flow).getByTestId("agent-flow-node-orchestrator");
    expect(orchestrator).toHaveTextContent("主代理");
    expect(orchestrator).toHaveTextContent("编排器");
    expect(orchestrator).toHaveTextContent("MiMo v2.6 Pro (5438) · high");

    // 内置 agent：中文职责（fixture 里的英文/占位描述换成职责文案）。
    const task = within(flow).getByTestId("agent-flow-node-task");
    expect(task).toHaveTextContent("完整能力的通用子代理，执行多步委派任务");
    expect(task).toHaveTextContent("当前使用：");
    // 自定义 agent：保留 frontmatter 描述，打「自定义」标签。
    const deployer = within(flow).getByTestId("agent-flow-node-deployer");
    expect(deployer).toHaveTextContent("自定义");
  });

  it("停用后流程图节点标注「已停用」", async () => {
    stubConfig([]);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByRole("region", { name: "Agent" });

    fireEvent.click(screen.getByLabelText("停用 task"));
    expect(
      within(screen.getByTestId("agent-flow-node-task")).getByText("已停用"),
    ).toBeInTheDocument();
  });
});

describe("Vibe 工作会话", () => {
  const VIBE_AGENTS: AgentDefinition[] = [
    ...AGENTS,
    {
      name: "sonic",
      description: "机械",
      source: "builtin",
      defaultModel: ["@smol"],
      defaultThinkingLevel: "medium",
    },
  ];

  function vibeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return { ...structuredClone(BASE_CONFIG), agents: VIBE_AGENTS, ...overrides };
  }

  it("两档展示当前生效模型，@别名解析到底层模型", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves, {
      config: vibeConfig({
        roles: { ...BASE_CONFIG.roles, smol: "5438/deepseek-v4.1-flash:low" },
        agentOverrides: { ...BASE_CONFIG.agentOverrides, sonic: "@smol" },
      }),
    });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    // fast：别名展开到底层模型展示，注明跟随链路与底层档位。
    const fast = screen.getByTestId("vibe-effective-fast");
    expect(fast).toHaveTextContent("DeepSeek v4.1 Flash");
    expect(fast).toHaveTextContent("来自「改用模型」@smol → 轻快任务角色");
    expect(fast).toHaveTextContent("思考强度 low");
    // good：字面覆盖直接展示。
    const good = screen.getByTestId("vibe-effective-good");
    expect(good).toHaveTextContent("MiMo v2.6 Pro (5438)");
    expect(good).toHaveTextContent("来自「改用模型」");
    expect(good).toHaveTextContent("思考强度 max");
  });

  it("在卡片改 fast 后保存：只写 sonic 覆盖，其余键原样不动", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves, { config: vibeConfig() });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    const tier = screen.getByTestId("vibe-tier-fast");
    fireEvent.click(
      within(tier).getByRole("button", { name: "Vibe 快速工作会话（fast）改用的模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    fireEvent.click(within(tier).getByRole("radio", { name: "low" }));
    fireEvent.click(within(blockOf("Agent")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    // 只发 overrides 一个 key（停用/顾问没动就不发）。
    expect(saves.map((s) => s.key)).toEqual(["task.agentModelOverrides"]);
    expect(saves[0].value).toEqual({
      task: "5438/mimo-v2.6-pro:max",
      scout: "5438/deepseek-v4.1-flash",
      sonic: "5438/deepseek-v4.1-flash:low",
    });
  });

  it("别名覆盖保存时不被展开改写", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves, {
      config: vibeConfig({
        roles: { ...BASE_CONFIG.roles, smol: "5438/deepseek-v4.1-flash:low" },
        agentOverrides: { ...BASE_CONFIG.agentOverrides, sonic: "@smol" },
      }),
    });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    // 只动 good 档，保存后 fast 的别名必须原样保留。
    const tier = screen.getByTestId("vibe-tier-good");
    fireEvent.click(
      within(tier).getByRole("button", { name: "Vibe 强力工作会话（good）改用的模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /GPT-6\.1 Sol/ }));
    fireEvent.click(within(blockOf("Agent")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves[0].value).toEqual({
      task: "factory-droid/gpt-6.1-sol",
      scout: "5438/deepseek-v4.1-flash",
      sonic: "@smol",
    });
  });

  it("卡片与 Agent 行双向同步（同一份草稿）", async () => {
    stubConfig([], { config: vibeConfig() });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    // 卡片改 good → sonic…task 的 Agent 行同步。
    const tier = screen.getByTestId("vibe-tier-good");
    fireEvent.click(
      within(tier).getByRole("button", { name: "Vibe 强力工作会话（good）改用的模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    const agentPicker = within(screen.getByTestId("agent-row-task")).getByRole("button", {
      name: "task 改用的模型",
    });
    expect(agentPicker).toHaveTextContent("DeepSeek v4.1 Flash");

    // Agent 行改回 → 卡片同步。
    fireEvent.click(agentPicker);
    const agentRow = screen.getByTestId("agent-row-task");
    fireEvent.click(
      within(agentRow).getByRole("button", { name: /MiMo v2\.6 Pro/ }),
    );
    expect(
      within(tier).getByRole("button", { name: "Vibe 强力工作会话（good）改用的模型" }),
    ).toHaveTextContent("MiMo v2.6 Pro (5438)");
  });

  it("Agent 定义缺失时档位仍可展示与保存（托底）", async () => {
    const saves: SaveCall[] = [];
    // BASE_CONFIG 里没有 sonic：展示走托底，保存照写 sonic 覆盖。
    stubConfig(saves);
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    expect(screen.getByTestId("vibe-effective-fast")).toHaveTextContent("跟随当前会话模型");
    const tier = screen.getByTestId("vibe-tier-fast");
    fireEvent.click(
      within(tier).getByRole("button", { name: "Vibe 快速工作会话（fast）改用的模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    fireEvent.click(within(blockOf("Agent")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves.map((s) => s.key)).toEqual(["task.agentModelOverrides"]);
    expect(saves[0].value).toEqual({
      task: "5438/mimo-v2.6-pro:max",
      scout: "5438/deepseek-v4.1-flash",
      sonic: "5438/deepseek-v4.1-flash",
    });
  });

  it("指挥者行只读展示主对话模型，并注明共用与 /vibe 入口", async () => {
    stubConfig([], { config: vibeConfig() });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    const conductor = screen.getByTestId("vibe-conductor");
    expect(conductor).toHaveTextContent("MiMo v2.6 Pro (5438) · high");
    // 只读：没有任何可点控件。
    expect(within(conductor).queryByRole("button")).not.toBeInTheDocument();
    expect(within(conductor).queryByRole("combobox")).not.toBeInTheDocument();

    const card = screen.getByTestId("vibe-card");
    expect(card).toHaveTextContent("在 omp 中输入 /vibe 进入该模式");
    expect(card).toHaveTextContent(
      "这两个档位与『机械处理』『通用执行』子代理共用模型，修改会同时影响普通子代理",
    );
  });

  it("清空主对话主模型后指挥者行回落到内置默认，不再显示旧值", async () => {
    stubConfig([], { config: vibeConfig() });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");
    expect(screen.getByTestId("vibe-conductor")).toHaveTextContent("MiMo v2.6 Pro (5438) · high");

    fireEvent.click(within(roleCard("default")).getByRole("button", { name: "主对话的主模型" }));
    fireEvent.click(screen.getByRole("button", { name: "未设置" }));

    const conductor = screen.getByTestId("vibe-conductor");
    expect(conductor).toHaveTextContent("omp 内置默认");
    expect(conductor).not.toHaveTextContent("MiMo v2.6 Pro");
    expect(within(conductor).queryByText("未知值 · 保留")).toBeNull();
  });

  it("改主对话角色时指挥者行同步，且不参与任何保存键", async () => {
    const saves: SaveCall[] = [];
    stubConfig(saves, { config: vibeConfig() });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    // 在角色卡里换主对话模型 → Vibe 卡的指挥者行立即跟随（同一份草稿）。
    fireEvent.click(within(roleCard("default")).getByRole("button", { name: "主对话的主模型" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek v4\.1 Flash/ }));
    expect(screen.getByTestId("vibe-conductor")).toHaveTextContent("DeepSeek v4.1 Flash");

    // 保存落在 modelRoles，不会因为展示了指挥者就多写 overrides。
    fireEvent.click(within(blockOf("主要模型")).getByRole("button", { name: "保存主模型" }));
    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves.map((s) => s.key)).toEqual(["modelRoles"]);
  });

  it("真实形态多覆盖保存：只改 sonic，其余多项与未知值原样保留", async () => {
    const saves: SaveCall[] = [];
    // 贴近本机 ~/.omp/agent/config.yml：5 项覆盖 + reviewer 用已下线模型。
    const agents: AgentDefinition[] = [
      ...VIBE_AGENTS,
      { name: "reviewer", description: "评审", source: "builtin", defaultModel: ["@slow"], defaultThinkingLevel: null },
      { name: "security-reviewer", description: "安全", source: "builtin", defaultModel: [], defaultThinkingLevel: null },
    ];
    stubConfig(saves, {
      config: vibeConfig({
        agents,
        agentOverrides: {
          task: "5438/mimo-v2.6-pro:max",
          sonic: "5438/deepseek-v4.1-flash:max",
          scout: "5438/deepseek-v4.1-flash",
          reviewer: "retired/old:max",
          "security-reviewer": "5438/mimo-v2.6-pro",
        },
      }),
    });
    render(<ModelsAgentsPanel onToast={vi.fn()} />);
    await screen.findByTestId("vibe-card");

    const tier = screen.getByTestId("vibe-tier-fast");
    fireEvent.click(
      within(tier).getByRole("button", { name: "Vibe 快速工作会话（fast）改用的模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /GPT-6\.1 Sol/ }));
    fireEvent.click(within(tier).getByRole("radio", { name: "high" }));
    fireEvent.click(within(blockOf("Agent")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves.map((s) => s.key)).toEqual(["task.agentModelOverrides"]);
    expect(saves[0].value).toEqual({
      task: "5438/mimo-v2.6-pro:max",
      sonic: "factory-droid/gpt-6.1-sol:high",
      scout: "5438/deepseek-v4.1-flash",
      reviewer: "retired/old:max",
      "security-reviewer": "5438/mimo-v2.6-pro",
    });
  });
});
