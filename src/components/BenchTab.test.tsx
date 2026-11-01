/**
 * BenchTab 测试：bench 页独立渲染（PageHeader + ModelTesterPanel + 规格抽屉），
 * 与 models 页共享同一草稿实例；bench 设为角色回填到角色草稿。
 * 用 mockIPC 直桩命令。
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BENCH_CONFIG_KEY } from "../modelBench";
import type { BenchRound, ModelConfig, ModelInfo, ModelSpec } from "../types";
import { useModelDraft, useModelSpecs } from "../modelDraft";
import { BenchTab } from "./BenchTab";
import type { ToastFn } from "./useOmpOp";

const MODELS: ModelInfo[] = [
  { selector: "p/fast", provider: "p", id: "fast", name: "Fast", thinkingLevels: ["high", "low"], contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: 0.1, costCacheWrite: 1 },
  { selector: "p/slow", provider: "p", id: "slow", name: "Slow", thinkingLevels: ["high"], contextWindow: 1000000, maxTokens: null, reasoning: false, input: ["text", "image"], costInput: 1, costOutput: 4, costCacheRead: null, costCacheWrite: null },
];

const SPECS: ModelSpec[] = [
  { provider: "p", id: "fast", selector: "p/fast", name: "Fast", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: 0.1, costCacheWrite: 1, costTiered: false },
];

const ROLES = { default: "p/slow", task: "p/slow" };

function modelConfig(roles: Record<string, unknown> = ROLES): ModelConfig {
  return {
    roles,
    agentOverrides: {},
    disabledAgents: [],
    agentAdvisor: {},
    fallbackChains: {},
    agents: [],
    retryStatus: { modelFallback: true, fallbackOn: "any", fallbackRevertPolicy: "cooldown-expiry" },
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
      ttftP50Ms: 500 + i * 10,
      ttftP95Ms: 900,
      tpsP50: selector === "p/fast" ? 60 : 20,
      tpsCv: 0.05,
      cost: 0.001,
      errors: [],
    })),
  );
}

function stub(hooks: {
  onUpdateConfig?: (args: Record<string, unknown>) => unknown;
  roles?: Record<string, unknown>;
  specs?: ModelSpec[];
  revision?: string;
  models?: ModelInfo[];
} = {}) {
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (cmd === "list_models") return structuredClone(hooks.models ?? MODELS);
    if (cmd === "get_model_config") return modelConfig(hooks.roles);
    if (cmd === "model_bench_history") return structuredClone(historyRounds());
    if (cmd === "model_perf_list") return [];
    if (cmd === "get_model_specs") {
      return { path: "/mock/models.yml", available: true, revision: hooks.revision ?? "rev-1", specs: structuredClone(hooks.specs ?? SPECS), error: null };
    }
    if (cmd === "update_model_config") {
      if (hooks.onUpdateConfig !== undefined) return hooks.onUpdateConfig(args);
      return { key: args["key"], value: args["value"] };
    }
    throw `no handler for ${cmd}`;
  });
}

beforeEach(() => {
  clearMocks();
  localStorage.clear();
  localStorage.setItem(
    BENCH_CONFIG_KEY,
    JSON.stringify({ entries: [{ selector: "p/fast", tags: ["task"], monitor: false }], customTags: ["test"], intervalMin: 0 }),
  );
  vi.useRealTimers();
});
describe("测试 → 角色分配", () => {
  it("bench 抽屉设为角色回填到共享草稿（models 页角色分配可见待保存）", async () => {
    stub();
    const onToast = await renderTab();
    const fastCell = screen.getByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    fireEvent.click(within(drawer).getByRole("button", { name: "设为 子任务" }));
    expect(onToast).toHaveBeenCalledWith("已加入「角色分配」的待保存修改", "info");
  });
  it("自定义标签回填到共享草稿（models 页出现角色卡，保存写 modelRoles.<tag>）", async () => {
    // 该用例的 bench 条目带 test 标签（默认夹具条目带 task 标签）。
    localStorage.setItem(
      BENCH_CONFIG_KEY,
      JSON.stringify({ entries: [{ selector: "p/fast", tags: ["test"], monitor: false }], customTags: ["test"], intervalMin: 0 }),
    );
    stub();
    const onToast = await renderTab();
    const fastCell = screen.getByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    fireEvent.click(within(drawer).getByRole("button", { name: "设为 test" }));
    expect(onToast).toHaveBeenCalledWith("已加入「角色分配」的待保存修改", "info");
  });
  it("回填恒覆盖 thinking：无后缀回默认", async () => {
    // task 原值 p/slow:high；bench 条目 p/fast 无后缀 → 回填后须为 p/fast（不残留 high）。
    localStorage.setItem(
      BENCH_CONFIG_KEY,
      JSON.stringify({ entries: [{ selector: "p/fast", tags: ["task"], monitor: false }], customTags: ["test"], intervalMin: 0 }),
    );
    stub({ roles: { default: "p/slow", task: "p/slow:high" } });
    const onToast = await renderTab();
    const fastCell = screen.getByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    fireEvent.click(within(drawer).getByRole("button", { name: "设为 子任务" }));
    expect(onToast).toHaveBeenCalledWith("已加入「角色分配」的待保存修改", "info");
  });
});

function Harness(props: { onToast: ToastFn }) {
  const { onToast } = props;
  const l = useModelDraft(onToast);
  const specs = useModelSpecs(l.status === "ready" ? (force?: boolean) => void l.state.loadModels(force ?? false) : () => {});
  return l.status === "ready" ? <BenchTab onToast={onToast} state={l.state} specs={specs} /> : null;
}

async function renderTab(): Promise<Mock<ToastFn>> {
  const onToast = vi.fn<ToastFn>();
  render(<Harness onToast={onToast} />);
  await screen.findByRole("button", { name: /测试全部/ });
  return onToast;
}

describe("bench 页头", () => {
  it("渲染独立页头与环境徽章", async () => {
    stub();
    await renderTab();
    expect(screen.getByRole("heading", { name: "模型测试" })).toBeInTheDocument();
    expect(screen.getByText("本机 · macOS arm64")).toBeInTheDocument();
  });
});

describe("加入测试对话框", () => {
  it("对话框内联渲染选择列表，选中模型显示规格预览", async () => {
    stub();
    await renderTab();
    fireEvent.click(screen.getByRole("button", { name: "+ 加入测试" }));
    const dialog = await screen.findByRole("dialog", { name: "加入测试" });
    // 行为断言：选择列表内联渲染在对话框里（不是浮层），预览区与列表同屏。
    const listbox = within(dialog).getByRole("listbox", { name: "选择模型" });
    expect(listbox).toBeInTheDocument();
    expect(within(dialog).getByLabelText("规格预览")).toBeInTheDocument();
    // 列表默认内联展开：直接点 p/slow → 右侧预览出现上下文与目录价。
    fireEvent.click(await within(dialog).findByRole("button", { name: /Slow/ }));
    expect(within(dialog).getByLabelText("规格预览").textContent).toContain("1M 上下文");
    expect(within(dialog).getByLabelText("规格预览").textContent).toContain("输入 $1 / 输出 $4");
  });

  it("徽章区分已加入与已有变体", async () => {
    // entries 已有 p/fast（默认变体）：默认档位下 Fast=已加入。
    stub();
    await renderTab();
    fireEvent.click(screen.getByRole("button", { name: "+ 加入测试" }));
    const dialog = await screen.findByRole("dialog", { name: "加入测试" });
    const listbox = within(dialog).getByRole("listbox", { name: "选择模型" });
    const fastBtn = await within(listbox).findByRole("button", { name: /Fast/ });
    expect(fastBtn.textContent).toContain("已加入");
    // 先选 Fast（出现 high 档位），再切 high：精确变体 p/fast:high 不在列表 → 降级为已有变体。
    fireEvent.click(fastBtn);
    fireEvent.click(await within(dialog).findByRole("radio", { name: "high" }));
    const fastBtn2 = await within(listbox).findByRole("button", { name: /Fast/ });
    expect(fastBtn2.textContent).toContain("已有变体");
    expect(fastBtn2.textContent).not.toContain("已加入");
  });
});
