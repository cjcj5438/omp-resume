/**
 * roleCards 测试：chain 归属、Agent 实际模型解析、兜底文案、草稿往返无损。
 * 纯函数行为测试，不碰 IPC。
 */
import { describe, expect, it } from "vitest";
import type { AgentDefinition, ModelConfig, ModelInfo } from "./types";
import {
  attachedChainKeys,
  buildAdvisor,
  buildChains,
  buildDisabled,
  buildRecord,
  classifyChainKey,
  COMMON_ROLES,
  describeRetryStatus,
  describeRoleFallback,
  draftFromConfig,
  resolveRoleFallback,
  formatContextWindow,
  formatCost,
  orderNumeral,
  parseRoleAlias,
  resolveAgentEffective,
  roleInfo,
  selectorBase,
  wildcardTitle,
} from "./roleCards";

const MODELS: ModelInfo[] = [
  {
    selector: "p1/fast",
    provider: "p1",
    id: "fast",
    name: "Fast One",
    thinkingLevels: ["low", "high"],
    contextWindow: 1_000_000,
    reasoning: true,
    costInput: 0.3,
    costOutput: 1.2,
  },
  {
    selector: "p1/big",
    provider: "p1",
    id: "big",
    name: "Big One",
    thinkingLevels: ["high", "max"],
    contextWindow: 200_000,
    reasoning: true,
    costInput: null,
    costOutput: null,
  },
  {
    selector: "p2/other",
    provider: "p2",
    id: "other",
    name: "Other",
    thinkingLevels: [],
    contextWindow: null,
    reasoning: false,
    costInput: 1,
    costOutput: null,
  },
];

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "scout",
    description: "调研",
    source: "builtin",
    defaultModel: ["@smol"],
    defaultThinkingLevel: null,
    ...overrides,
  };
}

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    roles: {},
    agentOverrides: {},
    disabledAgents: [],
    agentAdvisor: {},
    fallbackChains: {},
    agents: [],
    retryStatus: { modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "cooldown-expiry" },
    ...overrides,
  };
}

describe("chain key 分类", () => {
  it("角色名 / 模型 selector / 通配区分开", () => {
    expect(classifyChainKey("default")).toBe("role");
    expect(classifyChainKey("sonic")).toBe("role");
    expect(classifyChainKey("p1/fast")).toBe("model");
    expect(classifyChainKey("p1/fast:high")).toBe("model");
    expect(classifyChainKey("p1/*")).toBe("wildcard");
    expect(classifyChainKey("p1/prefix/*")).toBe("wildcard");
  });

  it("兜底条目 base 比较忽略 thinking 后缀", () => {
    expect(selectorBase("p1/fast:high")).toBe("p1/fast");
    expect(selectorBase("p1/fast")).toBe("p1/fast");
    expect(selectorBase("@smol")).toBe("@smol");
  });
});

describe("角色别名", () => {
  it("@role 与 pi/role 解析出角色与 thinking", () => {
    expect(parseRoleAlias("@smol")).toEqual({ role: "smol", thinking: "" });
    expect(parseRoleAlias("@smol:high")).toEqual({ role: "smol", thinking: "high" });
    expect(parseRoleAlias("pi/task")).toEqual({ role: "task", thinking: "" });
  });

  it("非别名写法返回 null", () => {
    expect(parseRoleAlias("p1/fast")).toBeNull();
    expect(parseRoleAlias("smol")).toBeNull();
    expect(parseRoleAlias("@")).toBeNull();
    expect(parseRoleAlias("@a/b")).toBeNull();
  });
});

describe("Agent 实际使用模型", () => {
  const roles = { smol: "p1/fast:low", task: "p1/big" };

  it("改用模型优先，友好名 + 覆盖来源", () => {
    const got = resolveAgentEffective(agent(), "p1/big:max", roles, MODELS);
    expect(got).toEqual({
      modelText: "Big One",
      modelUnknown: false,
      sourceText: "来自「改用模型」",
      thinking: "max",
    });
  });

  it("覆盖里的 @别名跟随该角色的当前模型", () => {
    const got = resolveAgentEffective(agent(), "@smol:high", roles, MODELS);
    expect(got.modelText).toBe("Fast One");
    expect(got.modelUnknown).toBe(false);
    expect(got.sourceText).toBe("来自「改用模型」@smol → 轻快任务角色");
    expect(got.thinking).toBe("high");
  });

  it("覆盖里的未知 selector 原样保留", () => {
    const got = resolveAgentEffective(agent(), "retired/old:high", roles, MODELS);
    expect(got.modelText).toBe("retired/old:high");
    expect(got.modelUnknown).toBe(true);
    expect(got.thinking).toBe("high");
  });

  it("覆盖无 thinking 后缀时沿用 Agent 默认 thinking", () => {
    const got = resolveAgentEffective(
      agent({ defaultThinkingLevel: "medium" }),
      "p1/big",
      roles,
      MODELS,
    );
    expect(got.thinking).toBe("medium");
  });

  it("@别名跟随角色当前模型", () => {
    const got = resolveAgentEffective(agent(), undefined, roles, MODELS);
    expect(got).toEqual({
      modelText: "Fast One",
      modelUnknown: false,
      sourceText: "内置默认 @smol → 轻快任务角色",
      thinking: "low",
    });
  });

  it("别名指向未配置角色时如实说明", () => {
    const got = resolveAgentEffective(agent(), undefined, {}, MODELS);
    expect(got.modelText).toBe("轻快任务角色未配置，用 omp 内置默认");
    expect(got.modelUnknown).toBe(false);
    expect(got.sourceText).toBe("内置默认 @smol");
  });

  it("别名上的 thinking 优先于角色自带后缀", () => {
    const got = resolveAgentEffective(
      agent({ defaultModel: ["@smol:high"] }),
      undefined,
      roles,
      MODELS,
    );
    expect(got.thinking).toBe("high");
  });

  it("不认识的 @别名按未知值原样保留", () => {
    const got = resolveAgentEffective(
      agent({ defaultModel: ["@nope"] }),
      undefined,
      roles,
      MODELS,
    );
    expect(got.modelText).toBe("@nope");
    expect(got.modelUnknown).toBe(true);
  });

  it("直接指定的字面模型与多备选说明", () => {
    const got = resolveAgentEffective(
      agent({ defaultModel: ["p2/other", "p1/fast"] }),
      undefined,
      roles,
      MODELS,
    );
    expect(got.modelText).toBe("Other");
    expect(got.sourceText).toBe("内置默认（直接指定模型）（首选，其后还有 1 个备选）");
  });

  it("无内置默认时跟随当前会话模型", () => {
    const got = resolveAgentEffective(agent({ defaultModel: [] }), undefined, roles, MODELS);
    expect(got.modelText).toBe("跟随当前会话模型");
    expect(got.sourceText).toBe("该 Agent 未指定默认模型");
  });
});

describe("未配置角色实际用谁", () => {
  const fallbackRoles = { default: "p1/big", smol: "p1/fast:low" };

  it("已配置的角色返回自己（via 为空）", () => {
    expect(resolveRoleFallback("smol", fallbackRoles)).toEqual({
      selector: "p1/fast:low",
      via: null,
    });
  });

  it("memory→tiny→smol 逐级找已配置的", () => {
    expect(resolveRoleFallback("memory", fallbackRoles)).toEqual({
      selector: "p1/fast:low",
      via: "smol",
    });
    expect(resolveRoleFallback("tiny", fallbackRoles)).toEqual({
      selector: "p1/fast:low",
      via: "smol",
    });
  });

  it("smol 未配置时用 default", () => {
    expect(resolveRoleFallback("smol", { default: "p1/big" })).toEqual({
      selector: "p1/big",
      via: "default",
    });
  });

  it("advisor 只认已配置的 slow（configuredOnly）", () => {
    expect(resolveRoleFallback("advisor", { slow: "p1/fast", default: "p1/big" })).toEqual({
      selector: "p1/fast",
      via: "slow",
    });
    expect(resolveRoleFallback("advisor", { default: "p1/big" })).toBeNull();
  });

  it("都不满足时返回 null（omp 内置默认）", () => {
    expect(resolveRoleFallback("plan", fallbackRoles)).toBeNull();
    expect(resolveRoleFallback("default", {})).toBeNull();
    expect(resolveRoleFallback("nope", fallbackRoles)).toBeNull();
  });

  it("紧凑行文案带出来源角色", () => {
    expect(describeRoleFallback("memory", fallbackRoles, MODELS)).toEqual({
      modelText: "Fast One · low",
      modelUnknown: false,
      viaDisplay: "轻快任务",
    });
    expect(describeRoleFallback("plan", fallbackRoles, MODELS)).toEqual({
      modelText: "omp 内置默认",
      modelUnknown: false,
      viaDisplay: null,
    });
  });

  it("Agent 别名沿回退链解析出来源", () => {
    const got = resolveAgentEffective(
      agent({ defaultModel: ["@memory"] }),
      undefined,
      fallbackRoles,
      MODELS,
    );
    expect(got.modelText).toBe("Fast One");
    expect(got.sourceText).toBe("内置默认 @memory → 轻快任务角色（memory未配置）");
    expect(got.thinking).toBe("low");
  });
});

describe("兜底状态文案", () => {
  it("枚举值翻译成人话", () => {
    expect(
      describeRetryStatus({ modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "cooldown-expiry" }),
    ).toEqual({ enabled: true, trigger: "任何错误都切换", revert: "主模型恢复后自动切回" });
    expect(
      describeRetryStatus({ modelFallback: false, fallbackOn: "usage-limit", fallbackRevertPolicy: "never" }),
    ).toEqual({ enabled: false, trigger: "仅用尽额度时切换", revert: "切走后不再自动切回" });
    expect(describeRetryStatus({ modelFallback: null, fallbackOn: "except-usage-limit", fallbackRevertPolicy: null }).trigger).toBe(
      "除用尽额度外都切换",
    );
  });

  it("读不到显示未知，未知枚举原样展示", () => {
    expect(
      describeRetryStatus({ modelFallback: null, fallbackOn: null, fallbackRevertPolicy: null }),
    ).toEqual({ enabled: null, trigger: "未知", revert: "未知" });
    expect(
      describeRetryStatus({ modelFallback: true, fallbackOn: "future", fallbackRevertPolicy: "future" }),
    ).toEqual({ enabled: true, trigger: "未知（future）", revert: "未知（future）" });
  });
});

describe("按模型的兜底吸附", () => {
  const keys = ["default", "p1/fast", "p1/fast:high", "p1/*", "p1/sub/*", "p2/*", "other"];

  it("同模型 key（忽略 thinking）与命中 provider 的通配被吸附", () => {
    expect(attachedChainKeys("p1/fast:max", keys)).toEqual(["p1/fast", "p1/fast:high", "p1/*"]);
  });

  it("id 前缀通配只吸附命中前缀的主模型", () => {
    expect(attachedChainKeys("p1/sub/model:low", keys)).toEqual(["p1/*", "p1/sub/*"]);
  });

  it("主模型为空或别名时不吸附", () => {
    expect(attachedChainKeys(null, keys)).toEqual([]);
    expect(attachedChainKeys("@smol", keys)).toEqual([]);
  });

  it("通配标题有人话", () => {
    expect(wildcardTitle("p1/*")).toBe("「p1」旗下所有模型的兜底");
    expect(wildcardTitle("p1/sub/*")).toBe("「p1」旗下「sub」开头的兜底");
  });
});

describe("角色元信息", () => {
  it("常见角色是 10 个对话角色，default 首位", () => {
    expect(COMMON_ROLES).toEqual([
      "default",
      "smol",
      "slow",
      "vision",
      "plan",
      "commit",
      "tiny",
      "memory",
      "task",
      "advisor",
    ]);
  });

  it("能力角色与自定义角色区分", () => {
    expect(roleInfo("judge")?.kind).toBe("capability");
    expect(roleInfo("default")?.name).toBe("主对话");
    expect(roleInfo("my-role")).toBeNull();
  });
});

describe("草稿往返", () => {
  it("角色卡顺序：default 首位 + 配置原顺序", () => {
    const draft = draftFromConfig(config({ roles: { task: "p1/big", default: "p1/fast" } }));
    expect(draft.shownRoles).toEqual(["default", "task"]);
    const missing = draftFromConfig(config({ roles: { task: "p1/big" } }));
    expect(missing.shownRoles).toEqual(["default", "task"]);
    expect(missing.roles.get("default")).toEqual({ selector: null, thinking: "", touched: false });
  });

  it("只有兜底的常见角色也有卡，不认识的角色 key 不成卡", () => {
    const draft = draftFromConfig(
      config({
        roles: { default: "p1/fast" },
        fallbackChains: { task: ["p1/big"], sonic: ["p1/fast"] },
      }),
    );
    expect(draft.shownRoles).toEqual(["default", "task"]);
    expect(draft.roles.get("task")).toEqual({ selector: null, thinking: "", touched: false });
  });

  it("非数组 chain 值包成单条保留", () => {
    const draft = draftFromConfig(config({ fallbackChains: { default: "p1/fast" } }));
    expect(draft.chains.get("default")?.entries).toEqual(["p1/fast"]);
  });

  it("buildRecord 只改触碰过的键，未知键值原样保留", () => {
    const base = { default: "p1/fast", custom: { weird: 1 } };
    const rows = new Map([
      ["default", { selector: "p1/big", thinking: "max", touched: true }],
      ["task", { selector: null, thinking: "", touched: true }],
    ]);
    expect(buildRecord(base, rows)).toEqual({ default: "p1/big:max", custom: { weird: 1 } });
  });

  it("buildChains 未触碰返回原值引用，角色卡改兜底只改对应 key", () => {
    const cfg = config({
      fallbackChains: { default: ["p1/fast"], task: ["p1/big"], "p1/fast": ["p2/other"] },
    });
    const draft = draftFromConfig(cfg);
    draft.chains.get("task")!.entries.push("p1/fast");
    draft.chains.get("task")!.touched = true;
    const built = buildChains(cfg, draft.chains);
    expect(built).toEqual({
      default: ["p1/fast"],
      task: ["p1/big", "p1/fast"],
      "p1/fast": ["p2/other"],
    });
    expect(built["default"]).toBe(cfg.fallbackChains["default"]);
    expect(built["p1/fast"]).toBe(cfg.fallbackChains["p1/fast"]);
  });

  it("buildDisabled 保持原顺序，未知成员保留", () => {
    const cfg = config({
      agents: [agent({ name: "a" }), agent({ name: "b" })],
      disabledAgents: ["ghost", "b"],
    });
    expect(buildDisabled(cfg, new Set(["a"]))).toEqual(["ghost", "a"]);
  });

  it("buildAdvisor 默认删键，未触碰保留脏值", () => {
    const base = { a: "on", b: "bogus" };
    const advisor = new Map([
      ["a", "default"],
      ["b", "default"],
    ] as const);
    expect(buildAdvisor(base, new Map(advisor), new Set(["a"]))).toEqual({ b: "bogus" });
  });
});

describe("展示格式", () => {
  it("顺序号与上下文/价格", () => {
    expect(orderNumeral(0)).toBe("①");
    expect(orderNumeral(19)).toBe("⑳");
    expect(orderNumeral(20)).toBe("21.");
    expect(formatContextWindow(1_000_000)).toBe("1M 上下文");
    expect(formatContextWindow(1_048_576)).toBe("1.05M 上下文");
    expect(formatContextWindow(200_000)).toBe("200K 上下文");
    expect(formatContextWindow(null)).toBeNull();
    expect(formatCost(0.3, 1.2)).toBe("输入 $0.3 / 输出 $1.2");
    expect(formatCost(null, 5)).toBe("输入 – / 输出 $5");
    expect(formatCost(null, null)).toBeNull();
  });
});
