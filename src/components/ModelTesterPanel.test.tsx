/**
 * ModelTesterPanel 测试：推荐 → 待保存 → 保存合并写回，以及 CONFLICT 路径。
 * 用 mockIPC 直桩 5 个命令；localStorage 用真 jsdom 实现（每测清理）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ModelTesterPanel } from "./ModelTesterPanel";
import { BENCH_CONFIG_KEY, benchRunner } from "../modelBench";
import type { BenchRound, ModelConfig, ModelInfo } from "../types";

const MODELS: ModelInfo[] = [
  { selector: "p/fast", provider: "p", id: "fast", name: "Fast", thinkingLevels: [], contextWindow: null, maxTokens: null, reasoning: false, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: null, costCacheWrite: null },
  { selector: "p/slow", provider: "p", id: "slow", name: "Slow", thinkingLevels: [], contextWindow: null, maxTokens: null, reasoning: false, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: null, costCacheWrite: null },
];

const ROLES = { default: "p/slow", task: "p/slow" };

function modelConfig(roles: Record<string, unknown> = ROLES): ModelConfig {
  return {
    roles,
    agentOverrides: {},
    disabledAgents: [],
    agentAdvisor: {},
    fallbackChains: {},
    agents: [{ name: "task", description: "", source: "builtin", defaultModel: ["@task"], defaultThinkingLevel: null }],
    retryStatus: { modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "x" },
  };
}

function historyRounds(): BenchRound[] {
  const now = Date.now();
  const at = (h: number): string => new Date(now - h * 3600000).toISOString();
  return ["p/fast", "p/slow"].flatMap((selector) =>
    [1, 5].map((h, i) => ({
      at: at(h),
      selector,
      total: 8,
      ok: 8,
      ttftP50Ms: selector === "p/fast" ? 500 : 1500,
      ttftP95Ms: selector === "p/fast" ? 700 : 2000,
      tpsP50: selector === "p/fast" ? 50 : 20,
      tpsCv: 0.1,
      cost: 0.01 + i * 0.001,
      errors: [],
    })),
  );
}

function stub(updateImpl: (args: Record<string, unknown>) => unknown) {
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (cmd === "list_models") return structuredClone(MODELS);
    if (cmd === "get_model_config") return modelConfig();
    if (cmd === "model_bench_history") return structuredClone(historyRounds());
    if (cmd === "model_perf_list") return [];
    if (cmd === "update_model_config") return updateImpl(args);
    throw `no handler for ${cmd}`;
  });
}

beforeEach(() => {
  clearMocks();
  localStorage.clear();
  // p/fast 通过 entries 进列表并带 task 标签；p/slow 被 default/task 角色占用。
  localStorage.setItem(
    BENCH_CONFIG_KEY,
    JSON.stringify({ entries: [{ selector: "p/fast", tags: ["task"], monitor: false }], customTags: ["test"], intervalMin: 0 }),
  );
  vi.useRealTimers();
});
describe("推荐 → 保存", () => {
  it("一键推荐把改动放进待保存底栏；保存调 update_model_config 合并写回并清空", async () => {
    const calls: Record<string, unknown>[] = [];
    stub((args) => {
      calls.push(args);
      return { key: args["key"], value: args["value"] };
    });
    const onToast = vi.fn();
    render(<ModelTesterPanel onToast={onToast} />);
    await screen.findByText("Fast");

    fireEvent.click(screen.getByRole("button", { name: "一键推荐" }));
    // task 当前 p/slow，p/fast 分更高 → 待保存出现 task 改动。
    const bar = await screen.findByRole("status");
    expect(within(bar).getByText(/待保存 1 项/)).toBeInTheDocument();
    expect(bar.textContent).toContain("子任务");
    expect(bar.textContent).toContain("p/slow");
    expect(bar.textContent).toContain("p/fast");

    fireEvent.click(within(bar).getByRole("button", { name: "保存到 omp" }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      key: "modelRoles",
      value: { default: "p/slow", task: "p/fast" },
      expected: ROLES,
    });
    await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("CONFLICT 时提示并重新载入、清空待保存", async () => {
    let gets = 0;
    mockIPC((cmd) => {
      if (cmd === "list_models") return structuredClone(MODELS);
      if (cmd === "get_model_config") {
        gets += 1;
        return modelConfig();
      }
      if (cmd === "model_bench_history") return structuredClone(historyRounds());
      if (cmd === "model_perf_list") return [];
      if (cmd === "update_model_config") throw { code: "CONFLICT", message: "配置已被外部修改" };
      throw `no handler for ${cmd}`;
    });
    const onToast = vi.fn();
    render(<ModelTesterPanel onToast={onToast} />);
    await screen.findByText("Fast");

    fireEvent.click(screen.getByRole("button", { name: "一键推荐" }));
    const bar = await screen.findByRole("status");
    fireEvent.click(within(bar).getByRole("button", { name: "保存到 omp" }));
    await vi.waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining("配置已被外部修改"), "error"),
    );
    // 重新载入：初次 1 次 + 冲突后 1 次。
    await vi.waitFor(() => expect(gets).toBe(2));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("localStorage", () => {
  it("损坏的配置不炸面板，回默认值", async () => {
    localStorage.setItem(BENCH_CONFIG_KEY, "{bad json");
    stub((args) => ({ key: args["key"], value: args["value"] }));
    render(<ModelTesterPanel onToast={vi.fn()} />);
    // 回默认值：entries 为空，列表只剩角色占用的 p/slow。
    await screen.findByText("Slow");
    expect(screen.queryByText("Fast")).toBeNull();
    expect(screen.getByRole("button", { name: /^全部/ }).textContent).toContain("1");
  });
});

describe("受控嵌入", () => {
  it("父级下发 models/modelConfig 时跳过 getModelConfig/listModels", async () => {
    const seen: string[] = [];
    mockIPC((cmd) => {
      seen.push(cmd);
      if (cmd === "list_models") return structuredClone(MODELS);
      if (cmd === "get_model_config") return modelConfig();
      if (cmd === "model_bench_history") return structuredClone(historyRounds());
      if (cmd === "model_perf_list") return [];
      throw `no handler for ${cmd}`;
    });
    render(<ModelTesterPanel onToast={vi.fn()} embedded models={MODELS} modelConfig={modelConfig()} config={{ entries: [{ selector: "p/fast", tags: ["task"], monitor: false }], customTags: ["test"], intervalMin: 0 }} />);
    await screen.findByText("Fast");
    expect(seen).not.toContain("list_models");
    expect(seen).not.toContain("get_model_config");
    expect(seen).toContain("model_bench_history");
    expect(seen).toContain("model_perf_list");
  });

  it("rolesOverride 决定设为-disabled：草稿已是该值时禁用", async () => {
    mockIPC((cmd) => {
      if (cmd === "model_bench_history") return structuredClone(historyRounds());
      if (cmd === "model_perf_list") return [];
      throw `no handler for ${cmd}`;
    });
    // 保存值 task=p/slow，草稿已回填 p/fast → 设为 task 应禁用（防重复回填）。
    render(
      <ModelTesterPanel
        onToast={vi.fn()}
        embedded
        models={MODELS}
        modelConfig={modelConfig()}
        rolesOverride={{ default: "p/slow", task: "p/fast" }}
        config={{ entries: [{ selector: "p/fast", tags: ["task"], monitor: false }], customTags: ["test"], intervalMin: 0 }}
        onApplyRoles={() => {}}
      />,
    );
    const fastCell = await screen.findByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    expect(within(drawer).getByRole("button", { name: "设为 子任务" })).toBeDisabled();
  });
});

describe("测试记录删除", () => {
  function stubWithDelete(historyCalls: { count: number }, deletedCalls: Record<string, unknown>[]): void {
    mockIPC((cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (cmd === "list_models") return structuredClone(MODELS);
      if (cmd === "get_model_config") return modelConfig();
      if (cmd === "model_bench_history") {
        historyCalls.count += 1;
        return structuredClone(historyRounds());
      }
      if (cmd === "model_perf_list") return [];
      if (cmd === "model_bench_delete") {
        deletedCalls.push(args);
        return 1;
      }
      if (cmd === "update_model_config") return { key: args["key"], value: args["value"] };
      throw `no handler for ${cmd}`;
    });
  }

  it("抽屉里的测试记录可删单轮与清空，删除后重载历史", async () => {
    const historyCalls = { count: 0 };
    const deletedCalls: Record<string, unknown>[] = [];
    stubWithDelete(historyCalls, deletedCalls);
    render(<ModelTesterPanel onToast={vi.fn()} />);
    const fastCell = await screen.findByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    expect(within(drawer).getByText("测试记录（2 轮）")).toBeInTheDocument();

    // 历史是 now 相对生成的（每次调用时间戳不同），删除目标取列表里渲染出来的那一轮。
    const delBtn = within(drawer).getAllByRole("button", { name: /^删除 .+ 这一轮记录$/ })[0];
    const target = (delBtn.getAttribute("aria-label") ?? "").slice("删除 ".length, -" 这一轮记录".length);
    expect(target).not.toBe("");
    const before = historyCalls.count;
    fireEvent.click(delBtn);
    await vi.waitFor(() => expect(deletedCalls).toEqual([{ selector: "p/fast", at: target }]));
    // onChanged → 再次拉历史。
    await vi.waitFor(() => expect(historyCalls.count).toBe(before + 1));

    fireEvent.click(within(drawer).getByRole("button", { name: "清空记录…" }));
    const modal = await screen.findByRole("dialog", { name: "清空测试记录" });
    expect(modal.textContent).toContain("将删除该模型的 2 轮记录，不可撤销。");
    fireEvent.click(within(modal).getByRole("button", { name: "清空" }));
    await vi.waitFor(() => expect(deletedCalls[1]).toEqual({ selector: "p/fast", at: null }));
  });
});

describe("键盘可达", () => {
  it("Enter/Space 打开抽屉，行内测试按钮 stopPropagation", async () => {
    stub((args) => ({ key: args["key"], value: args["value"] }));
    render(<ModelTesterPanel onToast={vi.fn()} />);
    const fastCell = await screen.findByText("Fast");
    const row = fastCell.closest("tr");
    if (row === null) throw new Error("找不到 Fast 行");
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(await screen.findByRole("complementary", { name: "模型 p/fast" })).toBeInTheDocument();
    // Esc 关抽屉（Drawer 行为），再用空格打开。
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("complementary", { name: "模型 p/fast" })).toBeNull());
    fireEvent.keyDown(row, { key: " " });
    expect(await screen.findByRole("complementary", { name: "模型 p/fast" })).toBeInTheDocument();
  });

  it("N2 行内 ▶ 按钮上按 Enter：只触发按钮，不切换抽屉", async () => {
    stub((args) => ({ key: args["key"], value: args["value"] }));
    const enqueue = vi.spyOn(benchRunner, "enqueue");
    try {
      render(<ModelTesterPanel onToast={vi.fn()} />);
      const fastCell = await screen.findByText("Fast");
      const row = fastCell.closest("tr");
      if (row === null) throw new Error("找不到 Fast 行");
      const runBtn = within(row).getByRole("button", { name: "测试 p/fast" });
      // 原生语义：按钮上的 Enter 由浏览器合成 click；fireEvent 只发 keyDown，需手动补 click。
      fireEvent.keyDown(runBtn, { key: "Enter" });
      fireEvent.click(runBtn);
      // (a) 抽屉没被行 keyDown 误开（按钮 keyDown 冒泡到行时 target≠currentTarget）。
      expect(screen.queryByRole("complementary", { name: "模型 p/fast" })).toBeNull();
      // (b) 按钮自己的 click 照常入队：与鼠标点击同一路径。
      expect(enqueue).toHaveBeenCalledWith("p/fast");
      // 回归对照：鼠标点行仍开关抽屉（行 click 行为不受影响）。
      fireEvent.click(row);
      expect(await screen.findByRole("complementary", { name: "模型 p/fast" })).toBeInTheDocument();
      fireEvent.keyDown(row, { key: "Enter" });
      await vi.waitFor(() => expect(screen.queryByRole("complementary", { name: "模型 p/fast" })).toBeNull());
    } finally {
      enqueue.mockRestore();
    }
  });
});
