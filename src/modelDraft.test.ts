/**
 * modelDraft 纯函数测试：configFromDraft 草稿视角、revertBlock 分块还原。
 * 不碰 IPC/DOM；hook 行为由组件测试覆盖。
 */
import { describe, expect, it } from "vitest";
import type { AgentDefinition, ModelConfig, ModelInfo } from "./types";
import { configFromDraft, deriveChangeCounts, deriveDirty, othersKeysOf, revertBlock } from "./modelDraft";
import { draftFromConfig, type ChainDraft, type ModelDrafts } from "./roleCards";

const MODELS: ModelInfo[] = [
  {
    selector: "p1/fast",
    provider: "p1",
    id: "fast",
    name: "Fast One",
    thinkingLevels: ["low", "high"],
    contextWindow: 1_000_000,
    maxTokens: null,
    reasoning: true,
    input: ["text"],
    costInput: 0.3,
    costOutput: 1.2,
    costCacheRead: null,
    costCacheWrite: null,
  },
  {
    selector: "p1/big",
    provider: "p1",
    id: "big",
    name: "Big One",
    thinkingLevels: ["high", "max"],
    contextWindow: 200_000,
    maxTokens: null,
    reasoning: true,
    input: ["text"],
    costInput: null,
    costOutput: null,
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
    defaultThinkingLevel: null,
  },
  {
    name: "scout",
    description: "调研",
    source: "builtin",
    defaultModel: ["@smol"],
    defaultThinkingLevel: null,
  },
];

const BASE_CONFIG: ModelConfig = {
  roles: { default: "p1/fast:high", task: "p1/big" },
  agentOverrides: { task: "p1/big:max", scout: "p1/fast" },
  disabledAgents: [],
  agentAdvisor: { task: "on" },
  fallbackChains: {
    default: ["p1/fast", "p1/big"],
    task: ["p1/fast"],
    "p1/big": ["p1/fast"],
    "retired/old": ["p1/fast"],
  },
  agents: AGENTS,
  retryStatus: { modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "cooldown-expiry" },
};

function cloneDraft(draft: ModelDrafts): ModelDrafts {
  return {
    roles: new Map(draft.roles),
    overrides: new Map(draft.overrides),
    disabled: new Set(draft.disabled),
    advisor: new Map(draft.advisor),
    advisorTouched: new Set(draft.advisorTouched),
    chains: new Map(draft.chains),
    shownRoles: [...draft.shownRoles],
  };
}

function chain(key: string, entries: unknown[]): ChainDraft {
  return { key, entries, touched: true };
}

describe("configFromDraft", () => {
  it("未触碰时与原配置深相等（未知值原样保留）", () => {
    const config: ModelConfig = {
      ...structuredClone(BASE_CONFIG),
      roles: { default: "p1/fast", weird: { nested: [1, "x"] } },
      agentOverrides: { task: "@smol", ghost: 42 },
    };
    const view = configFromDraft(config, draftFromConfig(config));
    expect(view.roles).toEqual(config.roles);
    expect(view.agentOverrides).toEqual(config.agentOverrides);
    expect(view.disabledAgents).toEqual(config.disabledAgents);
    expect(view.agentAdvisor).toEqual(config.agentAdvisor);
    expect(view.fallbackChains).toEqual(config.fallbackChains);
  });

  it("触碰的角色/覆盖行按草稿重算，未触碰的键不动", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("default", { selector: "p1/big", thinking: "max", touched: true });
    draft.overrides.set("scout", { selector: null, thinking: "", touched: true });

    const view = configFromDraft(BASE_CONFIG, draft);
    expect(view.roles).toEqual({ default: "p1/big:max", task: "p1/big" });
    expect(view.agentOverrides).toEqual({ task: "p1/big:max" });
  });

  it("停用/顾问/chains 按草稿重算", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.disabled.add("scout");
    draft.advisor.set("scout", "off");
    draft.advisorTouched.add("scout");
    draft.chains.set("task", chain("task", ["p1/big"]));

    const view = configFromDraft(BASE_CONFIG, draft);
    expect(view.disabledAgents).toEqual(["scout"]);
    expect(view.agentAdvisor).toEqual({ task: "on", scout: "off" });
    expect(view.fallbackChains["task"]).toEqual(["p1/big"]);
    expect(view.fallbackChains["default"]).toEqual(BASE_CONFIG.fallbackChains["default"]);
  });

  it("模型列表参数不影响（只读视角不查模型名）", () => {
    void MODELS;
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("default", { selector: "gone/model", thinking: "", touched: true });
    const view = configFromDraft(BASE_CONFIG, draft);
    expect(view.roles["default"]).toBe("gone/model");
  });
});

describe("revertBlock", () => {
  it("roles 还原：角色行与全部 chain 恢复，agents 草稿保留", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("default", { selector: "p1/big", thinking: "", touched: true });
    draft.chains.set("task", chain("task", ["p1/big"]));
    draft.overrides.set("scout", { selector: "p1/big", thinking: "", touched: true });
    draft.disabled.add("scout");

    const next = revertBlock(BASE_CONFIG, draft, "roles", ["retired/old"]);
    expect(next.roles.get("default")).toEqual({ selector: "p1/fast", thinking: "high", touched: false });
    expect(next.chains.get("task")).toEqual({ key: "task", entries: ["p1/fast"], touched: false });
    // agents 块不动。
    expect(next.overrides.get("scout")).toEqual({ selector: "p1/big", thinking: "", touched: true });
    expect(next.disabled.has("scout")).toBe(true);
  });

  it("roles 还原：新增的角色展示与新增 chain 被删掉，删掉的 chain 恢复", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("vision", { selector: "p1/fast", thinking: "", touched: true });
    draft.shownRoles = [...draft.shownRoles, "vision"];
    draft.chains.set("p1/*", chain("p1/*", ["p1/fast"]));
    draft.chains.delete("task");

    const next = revertBlock(BASE_CONFIG, draft, "roles", ["retired/old", "p1/*"]);
    expect(next.roles.has("vision")).toBe(false);
    expect(next.shownRoles).not.toContain("vision");
    expect(next.chains.has("p1/*")).toBe(false);
    expect(next.chains.get("task")).toEqual({ key: "task", entries: ["p1/fast"], touched: false });
  });

  it("agents 还原：只恢复覆盖/停用/顾问，roles 与 chains 保留", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("default", { selector: "p1/big", thinking: "", touched: true });
    draft.chains.set("task", chain("task", ["p1/big"]));
    draft.overrides.set("scout", { selector: null, thinking: "", touched: true });
    draft.disabled.add("scout");
    draft.advisor.set("scout", "off");
    draft.advisorTouched.add("scout");

    const next = revertBlock(BASE_CONFIG, draft, "agents", ["retired/old"]);
    expect(next.overrides.get("scout")).toEqual({ selector: "p1/fast", thinking: "", touched: false });
    expect(next.disabled.has("scout")).toBe(false);
    expect(next.advisor.get("scout")).toBe("default");
    expect(next.advisorTouched.has("scout")).toBe(false);
    // roles/chains 块不动。
    expect(next.roles.get("default")).toEqual({ selector: "p1/big", thinking: "", touched: true });
    expect(next.chains.get("task")).toEqual({ key: "task", entries: ["p1/big"], touched: true });
  });

  it("others 还原：只恢复 others 列表里的 chain", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.chains.set("retired/old", chain("retired/old", ["p1/big"]));
    draft.chains.set("task", chain("task", ["p1/big"]));
    draft.chains.set("brand/new", chain("brand/new", ["p1/fast"]));

    const next = revertBlock(BASE_CONFIG, draft, "others", ["retired/old", "brand/new"]);
    expect(next.chains.get("retired/old")).toEqual({
      key: "retired/old",
      entries: ["p1/fast"],
      touched: false,
    });
    // 新增的 others chain 还原即删除…
    expect(next.chains.has("brand/new")).toBe(false);
    // …角色卡的 chain 不动。
    expect(next.chains.get("task")).toEqual({ key: "task", entries: ["p1/big"], touched: true });
  });

  it("others 还原：被删掉的 others chain 恢复", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.chains.delete("retired/old");

    const next = revertBlock(BASE_CONFIG, draft, "others", ["retired/old"]);
    expect(next.chains.get("retired/old")).toEqual({
      key: "retired/old",
      entries: ["p1/fast"],
      touched: false,
    });
  });

  it("others 还原：删掉的 others chain 恢复（旧 othersKeys 根本看不到它）", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.chains.delete("retired/old");
    // 旧行为：othersKeys 只从草稿派生，删掉的 key 不在列表里。
    expect(othersKeysOf([...draft.chains.keys()], draft.roles)).not.toContain("retired/old");
    const next = revertBlock(
      BASE_CONFIG,
      draft,
      "others",
      othersKeysOf([...draft.chains.keys()], draft.roles),
    );
    expect(next.chains.get("retired/old")).toEqual({
      key: "retired/old",
      entries: ["p1/fast"],
      touched: false,
    });
  });

  it("others 还原：新增的 others chain 被删除", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.chains.set("brand/new", chain("brand/new", ["p1/fast"]));
    const next = revertBlock(
      BASE_CONFIG,
      draft,
      "others",
      othersKeysOf([...draft.chains.keys()], draft.roles),
    );
    expect(next.chains.has("brand/new")).toBe(false);
  });

  it("others 还原：角色卡的 chain 与展示顺序不动，dirty/counts 归零", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("default", { selector: "p1/big", thinking: "", touched: true });
    draft.chains.set("task", chain("task", ["p1/big"]));
    draft.overrides.set("scout", { selector: "p1/big", thinking: "", touched: true });
    draft.chains.set("retired/old", chain("retired/old", ["p1/big"]));
    const next = revertBlock(
      BASE_CONFIG,
      draft,
      "others",
      othersKeysOf([...draft.chains.keys()], draft.roles),
    );
    // 角色块与 Agent 块的编辑保留。
    expect(next.roles.get("default")).toEqual({ selector: "p1/big", thinking: "", touched: true });
    expect(next.chains.get("task")).toEqual({ key: "task", entries: ["p1/big"], touched: true });
    expect(next.overrides.get("scout")).toEqual({
      selector: "p1/big",
      thinking: "",
      touched: true,
    });
    // others 恢复：其余 chains 仍脏时 others 块 dirty 仍为 true（与展示一致）。
    expect(next.chains.get("retired/old")).toEqual({
      key: "retired/old",
      entries: ["p1/fast"],
      touched: false,
    });
    expect(deriveDirty(BASE_CONFIG, next).others).toBe(true);
  });

  it("others 还原：只改 others 时 dirty/counts 全部归零", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.chains.set("retired/old", chain("retired/old", ["p1/big"]));
    expect(deriveDirty(BASE_CONFIG, draft).others).toBe(true);
    const next = revertBlock(
      BASE_CONFIG,
      draft,
      "others",
      othersKeysOf([...draft.chains.keys()], draft.roles),
    );
    expect(deriveDirty(BASE_CONFIG, next)).toEqual({ roles: false, agents: false, others: false });
    expect(deriveChangeCounts(BASE_CONFIG, next)).toEqual({ roles: 0, agents: 0, chains: 0 });
  });

  it("roles 还原：删掉的角色附属 chain 恢复，dirty/counts 归零", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("task", { selector: "p1/big", thinking: "", touched: true });
    draft.chains.delete("p1/big");
    const next = revertBlock(BASE_CONFIG, draft, "roles", []);
    expect(next.chains.get("p1/big")).toEqual({
      key: "p1/big",
      entries: ["p1/fast"],
      touched: false,
    });
    expect(next.roles.get("task")).toEqual({ selector: "p1/big", thinking: "", touched: false });
    expect(deriveDirty(BASE_CONFIG, next)).toEqual({ roles: false, agents: false, others: false });
    expect(deriveChangeCounts(BASE_CONFIG, next)).toEqual({ roles: 0, agents: 0, chains: 0 });
  });

  it("agents 还原：chains 与 roles 不动，agents 的 dirty/count 归零", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.roles.set("default", { selector: "p1/big", thinking: "", touched: true });
    draft.chains.set("task", chain("task", ["p1/big"]));
    draft.overrides.set("scout", { selector: "p1/big", thinking: "", touched: true });
    draft.disabled.add("scout");
    draft.advisor.set("scout", "off");
    draft.advisorTouched.add("scout");
    const next = revertBlock(BASE_CONFIG, draft, "agents", []);
    expect(next.roles.get("default")).toEqual({ selector: "p1/big", thinking: "", touched: true });
    expect(next.chains.get("task")).toEqual({ key: "task", entries: ["p1/big"], touched: true });
    const dirty = deriveDirty(BASE_CONFIG, next);
    expect(dirty.agents).toBe(false);
    expect(dirty.roles).toBe(true);
    const counts = deriveChangeCounts(BASE_CONFIG, next);
    expect(counts.agents).toBe(0);
    expect(counts.roles).toBe(2);
    expect(counts.chains).toBe(1);
  });

  it("othersKeysOf 与 hook 一致：吸附链/展示角色 key 排除，未展示角色 key 保留", () => {
    const draft = draftFromConfig(BASE_CONFIG);
    // p1/big 吸附到 task 卡（task 主模型 p1/big），default/task 是展示角色自己的 key。
    expect(othersKeysOf([...draft.chains.keys()], draft.roles)).toEqual(["retired/old"]);
  });

  it("不污染原草稿（返回新对象）", () => {
    const draft = cloneDraft(draftFromConfig(BASE_CONFIG));
    draft.overrides.set("scout", { selector: null, thinking: "", touched: true });
    const next = revertBlock(BASE_CONFIG, draft, "agents", []);
    expect(next).not.toBe(draft);
    expect(next.overrides).not.toBe(draft.overrides);
    expect(draft.overrides.get("scout")).toEqual({ selector: null, thinking: "", touched: true });
  });
});
