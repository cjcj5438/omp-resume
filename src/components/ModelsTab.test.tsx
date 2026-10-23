/**
 * ModelsTab 测试：模型库搜索/用途徽章、加入测试、bench 设为角色回填、
 * 规格保存、添加对话框规格预览。用 mockIPC 直桩命令。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BENCH_CONFIG_KEY } from "../modelBench";
import type { BenchRound, ModelConfig, ModelInfo, ModelSpec } from "../types";
import { useModelDraft } from "../modelDraft";
import { ModelsTab } from "./ModelsTab";
import type { ToastFn } from "./useOmpOp";

const MODELS: ModelInfo[] = [
  { selector: "p/fast", provider: "p", id: "fast", name: "Fast", thinkingLevels: ["high", "low"], contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: 0.1, costCacheWrite: 1 },
  { selector: "p/slow", provider: "p", id: "slow", name: "Slow", thinkingLevels: ["high"], contextWindow: 1000000, maxTokens: null, reasoning: false, input: ["text", "image"], costInput: 1, costOutput: 4, costCacheRead: null, costCacheWrite: null },
  { selector: "p/lib-only", provider: "p", id: "lib-only", name: "LibOnly", thinkingLevels: [], contextWindow: 8000, maxTokens: 2000, reasoning: false, input: ["text"], costInput: 0.5, costOutput: 1, costCacheRead: null, costCacheWrite: null },
];

const SPECS: ModelSpec[] = [
  { provider: "p", id: "fast", selector: "p/fast", name: "Fast", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: 0.1, costCacheWrite: 1, costTiered: false },
  { provider: "p", id: "slow", selector: "p/slow", name: "Slow Edited", contextWindow: 1000000, maxTokens: 32000, reasoning: false, input: ["text", "image"], costInput: 2, costOutput: 8, costCacheRead: 0.2, costCacheWrite: 2, costTiered: false },
  // yml 无 cost 块：只改名时补丁里绝不能出现 cost。
  { provider: "p", id: "lib-only", selector: "p/lib-only", name: "LibOnly", contextWindow: 8000, maxTokens: 2000, reasoning: false, input: ["text"], costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null, costTiered: false },
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
  onUpdateSpec?: (args: Record<string, unknown>) => unknown;
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
    if (cmd === "update_model_spec") {
      if (hooks.onUpdateSpec !== undefined) return hooks.onUpdateSpec(args);
      return { revision: "rev-2", spec: structuredClone(SPECS[0]), backupPath: "/mock/models.yml.bak" };
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

function Harness(props: { onToast: ToastFn }) {
  const { onToast } = props;
  const l = useModelDraft(onToast);
  return l.status === "ready" ? <ModelsTab onToast={onToast} state={l.state} /> : null;
}

async function renderTab(): Promise<Mock<ToastFn>> {
  const onToast = vi.fn<ToastFn>();
  render(<Harness onToast={onToast} />);
  await screen.findByRole("region", { name: "模型库" });
  // 模型库与 bench 表都渲染 Fast：等 bench 工具条出现才算两边都就绪。
  await screen.findByRole("button", { name: /测试全部/ });
  return onToast;
}

describe("模型库", () => {
  it("搜索过滤模型库", async () => {
    stub();
    await renderTab();
    const lib = screen.getByRole("region", { name: "模型库" });
    expect(within(lib).getByText("Fast")).toBeInTheDocument();
    expect(within(lib).getByText("Slow")).toBeInTheDocument();

    fireEvent.change(within(lib).getByRole("searchbox", { name: "搜索模型库" }), { target: { value: "slow" } });
    expect(within(lib).queryByText("Fast")).toBeNull();
    expect(within(lib).getByText("Slow")).toBeInTheDocument();
  });

  it("外部改了 models.yml：重新打开与窗口聚焦都会带出新增模型，无需点刷新", async () => {
    const added = (id: string): ModelInfo => ({ ...MODELS[0], selector: `ext/${id}`, provider: "ext", id, name: `Ext ${id}` });
    // 先让进程内缓存记住旧 revision（模型库不含 ext）。
    stub({ revision: "rev-old" });
    await renderTab();
    cleanup();

    // 挂载路径：revision 变了 → 缓存失效，重跑 list_models。
    stub({ revision: "rev-ext-1", models: [...MODELS, added("one")] });
    await renderTab();
    const lib = screen.getByRole("region", { name: "模型库" });
    expect(await within(lib).findByText("Ext one")).toBeInTheDocument();

    // 聚焦路径：同一次挂载内文件再变，回到应用窗口即更新。
    stub({ revision: "rev-ext-2", models: [...MODELS, added("one"), added("two")] });
    expect(within(lib).queryByText("Ext two")).toBeNull();
    fireEvent.focus(window);
    expect(await within(lib).findByText("Ext two")).toBeInTheDocument();
  });

  it("第三个用途折叠为 +N（title 列出剩余）", async () => {
    stub({ roles: { default: "p/slow", task: "p/slow", smol: "p/slow" } });
    await renderTab();
    const lib = screen.getByRole("region", { name: "模型库" });
    const slowRow = within(lib).getByText("Slow").closest("tr");
    if (slowRow === null) throw new Error("找不到 Slow 行");
    const sub = within(slowRow).getByText("p/slow", { selector: ".lib-id" }).closest(".lib-model-sub");
    if (sub === null) throw new Error("找不到 Slow 行的模型第二行");
    expect(within(sub as HTMLElement).getByText("主对话")).toBeInTheDocument();
    expect(within(sub as HTMLElement).getByText("子任务")).toBeInTheDocument();
    const more = within(sub as HTMLElement).getByText("+1");
    expect(more).toHaveAttribute("title", "轻快任务");
  });

  it("加入测试把模型推进受控 bench 列表", async () => {
    stub();
    await renderTab();
    const lib = screen.getByRole("region", { name: "模型库" });
    const slowRow = within(lib).getByText("Slow").closest("tr");
    if (slowRow === null) throw new Error("找不到 Slow 行");
    // p/slow 已被角色占用但不在 entries 里 → 有「加入测试」按钮。
    const addBtn = within(slowRow).queryByRole("button", { name: "加入测试" });
    expect(addBtn).not.toBeNull();
    if (addBtn !== null) fireEvent.click(addBtn);
    // 状态 chips 的测试列表计数 +1（1 → 2）。
    expect(await screen.findByText("测试列表 2")).toBeInTheDocument();
  });

  it("库里独有模型的测试先落 bench 行再入队", async () => {
    stub();
    const onToast = await renderTab();
    const lib = screen.getByRole("region", { name: "模型库" });
    const onlyRow = within(lib).getByText("LibOnly").closest("tr");
    if (onlyRow === null) throw new Error("找不到 LibOnly 行");
    fireEvent.click(within(onlyRow).getByRole("button", { name: "测试 p/lib-only" }));
    expect(onToast).toHaveBeenCalledWith("已加入测试列表并开始测试：p/lib-only", "info");
    // 受控 entries +1（1 → 2），bench 表出现该行。
    expect(await screen.findByText("测试列表 2")).toBeInTheDocument();
    const testSection = screen.getByRole("region", { name: "测试" });
    expect(await within(testSection).findByText("LibOnly")).toBeInTheDocument();
  });

  it("用途徽章包含 agent 覆盖的 agent 名（内联在模型第二行）", async () => {
    mockIPC((cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (cmd === "list_models") return structuredClone(MODELS);
      if (cmd === "get_model_config") {
        const cfg = modelConfig();
        cfg.agentOverrides = { sonic: "p/fast" };
        return cfg;
      }
      if (cmd === "model_bench_history") return structuredClone(historyRounds());
      if (cmd === "model_perf_list") return [];
      if (cmd === "get_model_specs") {
        return { path: "/mock/models.yml", available: true, revision: "rev-1", specs: structuredClone(SPECS), error: null };
      }
      if (cmd === "update_model_config") return { key: args["key"], value: args["value"] };
      if (cmd === "update_model_spec") {
        return { revision: "rev-2", spec: structuredClone(SPECS[0]), backupPath: "/mock/models.yml.bak" };
      }
      throw `no handler for ${cmd}`;
    });
    await renderTab();
    const lib = screen.getByRole("region", { name: "模型库" });
    const fastRow = within(lib).getByText("Fast").closest("tr");
    if (fastRow === null) throw new Error("找不到 Fast 行");
    const sub = within(fastRow).getByText("p/fast", { selector: ".lib-id" }).closest(".lib-model-sub");
    if (sub === null) throw new Error("找不到 Fast 行的模型第二行");
    expect(within(sub as HTMLElement).getByText("sonic")).toBeInTheDocument();
  });

});

describe("测试 → 角色分配", () => {
  it("bench 抽屉设为角色回填到角色草稿，保存写 modelRoles", async () => {
    const calls: Record<string, unknown>[] = [];
    stub({ onUpdateConfig: (args) => {
      calls.push(args);
      return { key: args["key"], value: args["value"] };
    } });
    const onToast = await renderTab();

    // bench 表里点 Fast 行打开抽屉。
    const testSection = screen.getByRole("region", { name: "测试" });
    const fastCell = within(testSection).getByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    fireEvent.click(within(drawer).getByRole("button", { name: "设为 子任务" }));
    expect(onToast).toHaveBeenCalledWith("已加入「角色分配」的待保存修改", "info");

    // 角色分配出现待保存，保存写 modelRoles。
    const rolesSection = screen.getByRole("region", { name: "角色分配" });
    const saveBar = await within(rolesSection).findByRole("status");
    fireEvent.click(within(saveBar).getByRole("button", { name: /保存/ }));
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const rolesCall = calls.find((c) => c["key"] === "modelRoles");
    expect(rolesCall).toBeDefined();
    expect(rolesCall?.["value"]).toMatchObject({ task: "p/fast" });
  });
});

describe("规格抽屉", () => {
  async function openSpecDrawer(name: string): Promise<HTMLElement> {
    const lib = screen.getByRole("region", { name: "模型库" });
    const row = within(lib).getByText(name).closest("tr");
    if (row === null) throw new Error(`找不到 ${name} 行`);
    fireEvent.click(within(row).getByRole("button", { name: "规格" }));
    const selector = name === "Fast" ? "p/fast" : name === "Slow" ? "p/slow" : "p/lib-only";
    return screen.findByRole("complementary", { name: `模型规格 ${selector}` });
  }

  it("只改名：补丁恰为 {name}，不带 cost 等未动字段", async () => {
    const specCalls: Record<string, unknown>[] = [];
    stub({ onUpdateSpec: (args) => {
      specCalls.push(args);
      const next = structuredClone(SPECS[2]);
      next.name = (args["patch"] as Record<string, unknown>)["name"] as string;
      return { revision: "rev-2", spec: next, backupPath: "/mock/models.yml.bak" };
    } });
    await renderTab();
    // LibOnly 的 yml 无 cost 块：改名绝不能顺手插入 cost。
    const drawer = await openSpecDrawer("LibOnly");
    const nameInput = within(drawer).getByDisplayValue("LibOnly");
    fireEvent.change(nameInput, { target: { value: "LibOnly v2" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    await vi.waitFor(() => expect(specCalls).toHaveLength(1));
    expect(specCalls[0]).toMatchObject({ provider: "p", id: "lib-only", expectedRevision: "rev-1" });
    expect(specCalls[0]["patch"]).toEqual({ name: "LibOnly v2" });
  });

  it("改一个价格：发完整四键 cost；未改动时禁用保存且不发请求", async () => {
    const specCalls: Record<string, unknown>[] = [];
    stub({ onUpdateSpec: (args) => {
      specCalls.push(args);
      return { revision: "rev-2", spec: structuredClone(SPECS[0]), backupPath: "/mock/models.yml.bak" };
    } });
    await renderTab();
    const drawer = await openSpecDrawer("Fast");
    // 未改动：保存禁用。
    expect(within(drawer).getByRole("button", { name: "保存规格" })).toBeDisabled();
    // 改一个价格：四个键齐发。
    const inputs = within(drawer).getAllByRole("textbox");
    const costInput = inputs.find((el) => (el as HTMLInputElement).value === "1");
    if (costInput === undefined) throw new Error("找不到输入价框");
    fireEvent.change(costInput, { target: { value: "1.5" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    await vi.waitFor(() => expect(specCalls).toHaveLength(1));
    expect(specCalls[0]["patch"]).toEqual({ cost: { input: 1.5, output: 4, cacheRead: 0.1, cacheWrite: 1 } });
  });

  it("整数校验：1e3/1_000/小数/负数/加号/超大都拒绝", async () => {
    const specCalls: Record<string, unknown>[] = [];
    stub({ onUpdateSpec: (args) => {
      specCalls.push(args);
      return { revision: "rev-2", spec: structuredClone(SPECS[0]), backupPath: "/mock/models.yml.bak" };
    } });
    await renderTab();
    const drawer = await openSpecDrawer("Fast");
    const windowBox = within(drawer).getByDisplayValue("200000");
    for (const bad of ["1e3", "1_000", "12.5", "-5", "+5"]) {
      fireEvent.change(windowBox, { target: { value: bad } });
      fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
      expect(await within(drawer).findByRole("alert")).toHaveTextContent("上下文窗口须为正整数");
    }
    fireEvent.change(windowBox, { target: { value: "9007199254740993" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("数值过大");
    expect(specCalls).toHaveLength(0);
  });

  it("快速连存用返回的 revision；CONFLICT 后重载重试带新 revision 且只发用户字段", async () => {
    const specCalls: Record<string, unknown>[] = [];
    let rev = "rev-1";
    let conflictOnce = true;
    mockIPC((cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (cmd === "list_models") return structuredClone(MODELS);
      if (cmd === "get_model_config") return modelConfig();
      if (cmd === "model_bench_history") return structuredClone(historyRounds());
      if (cmd === "model_perf_list") return [];
      if (cmd === "get_model_specs") {
        return { path: "/mock/models.yml", available: true, revision: rev, specs: structuredClone(SPECS), error: null };
      }
      if (cmd === "update_model_spec") {
        specCalls.push(args);
        if (conflictOnce) {
          conflictOnce = false;
          rev = "rev-2";
          throw { code: "CONFLICT", message: "模型规格文件已被外部修改，请刷新后重试" };
        }
        const next = structuredClone(SPECS[0]);
        next.name = (args["patch"] as Record<string, unknown>)["name"] as string;
        rev = "rev-3";
        return { revision: "rev-3", spec: next, backupPath: "/mock/models.yml.bak" };
      }
      if (cmd === "update_model_config") return { key: args["key"], value: args["value"] };
      throw `no handler for ${cmd}`;
    });
    await renderTab();
    const drawer = await openSpecDrawer("Fast");
    fireEvent.change(within(drawer).getByDisplayValue("Fast"), { target: { value: "Fast v2" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    // 首次 CONFLICT：表单保留，父级重载到 rev-2。
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("表单已保留");
    await vi.waitFor(() => expect(specCalls).toHaveLength(1));
    // 重试：带新 revision，且补丁仍只有用户改的 name。
    const saveBtn = within(drawer).getByRole("button", { name: "保存规格" });
    await vi.waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await vi.waitFor(() => expect(specCalls).toHaveLength(2));
    expect(specCalls[1]).toMatchObject({ expectedRevision: "rev-2" });
    expect(specCalls[1]["patch"]).toEqual({ name: "Fast v2" });
    // 成功后 revision 已顶到 rev-3：等保存完成（spinner 消失）再改一次，直接带 rev-3。
    // 注意：不能等按钮 disabled——保存中按钮也禁用，会误命中中间态。
    await vi.waitFor(() => expect(within(drawer).getByRole("button", { name: "保存规格" }).querySelector(".spinner")).toBeNull());
    fireEvent.change(within(drawer).getByDisplayValue("Fast v2"), { target: { value: "Fast v3" } });
    await vi.waitFor(() => expect(within(drawer).getByRole("button", { name: "保存规格" })).not.toBeDisabled());
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    await vi.waitFor(() => expect(specCalls).toHaveLength(3));
    expect(specCalls[2]).toMatchObject({ expectedRevision: "rev-3" });
  });

  it("N1 外部改名后重试：补丁只含用户碰过的 cost，不回写 name", async () => {
    const specCalls: Record<string, unknown>[] = [];
    let rev = "rev-1";
    let conflictOnce = true;
    // 外部把 Fast 改名为 FastExt：重载返回的新 spec 与用户表单的 name 不同。
    const external = structuredClone(SPECS[0]);
    external.name = "FastExt";
    mockIPC((cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (cmd === "list_models") return structuredClone(MODELS);
      if (cmd === "get_model_config") return modelConfig();
      if (cmd === "model_bench_history") return structuredClone(historyRounds());
      if (cmd === "model_perf_list") return [];
      if (cmd === "get_model_specs") {
        const specs = structuredClone(SPECS);
        if (rev !== "rev-1") specs[0] = structuredClone(external);
        return { path: "/mock/models.yml", available: true, revision: rev, specs, error: null };
      }
      if (cmd === "update_model_spec") {
        specCalls.push(args);
        if (conflictOnce) {
          conflictOnce = false;
          rev = "rev-2";
          throw { code: "CONFLICT", message: "模型规格文件已被外部修改，请刷新后重试" };
        }
        const next = structuredClone(external);
        const patch = args["patch"] as Record<string, unknown>;
        if (patch["name"] !== undefined) next.name = patch["name"] as string;
        rev = "rev-3";
        return { revision: "rev-3", spec: next, backupPath: "/mock/models.yml.bak" };
      }
      if (cmd === "update_model_config") return { key: args["key"], value: args["value"] };
      throw `no handler for ${cmd}`;
    });
    await renderTab();
    const drawer = await openSpecDrawer("Fast");
    // 用户只碰输入价：name 输入框保持 "Fast"，但外部已改成 "FastExt"。
    const inputs = within(drawer).getAllByRole("textbox");
    const costBox = inputs.find((el) => (el as HTMLInputElement).value === "1");
    if (costBox === undefined) throw new Error("找不到输入价框");
    fireEvent.change(costBox, { target: { value: "1.5" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("表单已保留");
    await vi.waitFor(() => expect(specCalls).toHaveLength(1));
    // 重试：即使表单 name("Fast")与新基线("FastExt")不同，也只发 touched 的 cost。
    const saveBtn = within(drawer).getByRole("button", { name: "保存规格" });
    await vi.waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await vi.waitFor(() => expect(specCalls).toHaveLength(2));
    expect(specCalls[1]).toMatchObject({ expectedRevision: "rev-2" });
    const retryPatch = specCalls[1]["patch"] as Record<string, unknown>;
    expect(retryPatch).not.toHaveProperty("name");
    expect(retryPatch).toEqual({ cost: { input: 1.5, output: 4, cacheRead: 0.1, cacheWrite: 1 } });
  });

  it("N1 成功保存后立即再存：touched 已清空，保存禁用", async () => {
    stub({ onUpdateSpec: (args) => {
      const next = structuredClone(SPECS[2]);
      next.name = (args["patch"] as Record<string, unknown>)["name"] as string;
      return { revision: "rev-2", spec: next, backupPath: "/mock/models.yml.bak" };
    } });
    await renderTab();
    const drawer = await openSpecDrawer("LibOnly");
    fireEvent.change(within(drawer).getByDisplayValue("LibOnly"), { target: { value: "LibOnly v2" } });
    const saveBtn = within(drawer).getByRole("button", { name: "保存规格" });
    await vi.waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    // 成功后基线=表单、touched 清空：等 spinner 消失后再断言禁用（避开保存中禁用态）。
    await vi.waitFor(() => expect(within(drawer).getByRole("button", { name: "保存规格" }).querySelector(".spinner")).toBeNull());
    await vi.waitFor(() => expect(within(drawer).getByRole("button", { name: "保存规格" })).toBeDisabled());
  });

  it("N1 碰过又改回原值：补丁省略该键（touched ∩ 语义不同）", async () => {
    const specCalls: Record<string, unknown>[] = [];
    stub({ onUpdateSpec: (args) => {
      specCalls.push(args);
      const next = structuredClone(SPECS[2]);
      const patch = args["patch"] as Record<string, unknown>;
      if (patch["name"] !== undefined) next.name = patch["name"] as string;
      return { revision: "rev-2", spec: next, backupPath: "/mock/models.yml.bak" };
    } });
    await renderTab();
    const drawer = await openSpecDrawer("LibOnly");
    const nameBox = within(drawer).getByDisplayValue("LibOnly");
    // 碰过 name 又改回原值：touched 非空（按钮可用），但补丁为空→不发请求。
    fireEvent.change(nameBox, { target: { value: "LibOnly v2" } });
    fireEvent.change(nameBox, { target: { value: "LibOnly" } });
    const saveBtn = within(drawer).getByRole("button", { name: "保存规格" });
    await vi.waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("没有改动");
    expect(specCalls).toHaveLength(0);
  });

  it("N3 价格严格字面量：1e3/0x10/Infinity/空/负数/符号都拒绝", async () => {
    const specCalls: Record<string, unknown>[] = [];
    stub({ onUpdateSpec: (args) => {
      specCalls.push(args);
      return { revision: "rev-2", spec: structuredClone(SPECS[0]), backupPath: "/mock/models.yml.bak" };
    } });
    await renderTab();
    const drawer = await openSpecDrawer("Fast");
    const inputs = within(drawer).getAllByRole("textbox");
    const costBox = inputs.find((el) => (el as HTMLInputElement).value === "1");
    if (costBox === undefined) throw new Error("找不到输入价框");
    for (const bad of ["1e3", "0x10", "Infinity", "", "-1", "+1", "1_000", "12.5.6"]) {
      fireEvent.change(costBox, { target: { value: bad } });
      fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
      expect(await within(drawer).findByRole("alert")).toHaveTextContent("价格须为 ≥ 0 的数字");
    }
    expect(specCalls).toHaveLength(0);
    // 合法小数可存：四个键齐发。
    fireEvent.change(costBox, { target: { value: "1.5" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    await vi.waitFor(() => expect(specCalls).toHaveLength(1));
    expect(specCalls[0]["patch"]).toEqual({ cost: { input: 1.5, output: 4, cacheRead: 0.1, cacheWrite: 1 } });
  });

  it("N4 空白 no-op 不发请求并提示没有改动；后端空备份也提示没有改动", async () => {
    const specCalls: Record<string, unknown>[] = [];
    stub({ onUpdateSpec: (args) => {
      specCalls.push(args);
      // 后端 no-op 形状：同 revision + 空备份路径（真改动也可能命中，如并发写入相同值）。
      return { revision: "rev-1", spec: structuredClone(SPECS[2]), backupPath: "" };
    } });
    const onToast = await renderTab();
    const drawer = await openSpecDrawer("LibOnly");
    // "Fast "式空白差：touched 非空但语义相等→不发请求。
    fireEvent.change(within(drawer).getByDisplayValue("LibOnly"), { target: { value: "LibOnly " } });
    const saveBtn = within(drawer).getByRole("button", { name: "保存规格" });
    await vi.waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("没有改动");
    expect(specCalls).toHaveLength(0);
    expect(onToast).toHaveBeenCalledWith("没有改动", "info");
    // 真改动但后端返回空备份：toast 没有改动而非已备份。
    fireEvent.change(within(drawer).getByDisplayValue(/LibOnly\s*$/), { target: { value: "LibOnly v2" } });
    await vi.waitFor(() => expect(within(drawer).getByRole("button", { name: "保存规格" })).not.toBeDisabled());
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    await vi.waitFor(() => expect(specCalls).toHaveLength(1));
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith("没有改动", "info"));
    expect(onToast).not.toHaveBeenCalledWith("已写入 models.yml（已备份）", "info");
  });

  it("自定义标签回填后出现角色卡，保存写 modelRoles.<tag>", async () => {
    const calls: Record<string, unknown>[] = [];
    // 该用例的 bench 条目带 test 标签（默认夹具条目带 task 标签）。
    localStorage.setItem(
      BENCH_CONFIG_KEY,
      JSON.stringify({ entries: [{ selector: "p/fast", tags: ["test"], monitor: false }], customTags: ["test"], intervalMin: 0 }),
    );
    stub({ onUpdateConfig: (args) => {
      calls.push(args);
      return { key: args["key"], value: args["value"] };
    } });
    await renderTab();
    // bench 表里点 Fast 行：entries 自带 test 标签 → 抽屉有「设为 test」。
    const testSection = screen.getByRole("region", { name: "测试" });
    const fastCell = within(testSection).getByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    fireEvent.click(within(drawer).getByRole("button", { name: "设为 test" }));
    // 角色分配出现 test 角色卡（不是悄悄写盲键）。
    const rolesSection = screen.getByRole("region", { name: "角色分配" });
    expect(await within(rolesSection).findByTestId("role-card-test")).toBeInTheDocument();
    const saveBar = await within(rolesSection).findByRole("status");
    fireEvent.click(within(saveBar).getByRole("button", { name: /保存/ }));
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const rolesCall = calls.find((c) => c["key"] === "modelRoles");
    expect(rolesCall?.["value"]).toMatchObject({ test: "p/fast" });
  });

  it("回填恒覆盖 thinking：无后缀回默认，非法后缀回默认", async () => {
    const calls: Record<string, unknown>[] = [];
    // task 原值 p/slow:high；bench 条目 p/fast 无后缀 → 回填后须为 p/fast（不残留 high）。
    localStorage.setItem(
      BENCH_CONFIG_KEY,
      JSON.stringify({ entries: [{ selector: "p/fast", tags: ["task"], monitor: false }], customTags: ["test"], intervalMin: 0 }),
    );
    stub({ roles: { default: "p/slow", task: "p/slow:high" }, onUpdateConfig: (args) => {
      calls.push(args);
      return { key: args["key"], value: args["value"] };
    } });
    await renderTab();
    const testSection = screen.getByRole("region", { name: "测试" });
    const fastCell = within(testSection).getByText("Fast");
    fireEvent.click(fastCell.closest("tr") ?? fastCell);
    const drawer = await screen.findByRole("complementary", { name: "模型 p/fast" });
    fireEvent.click(within(drawer).getByRole("button", { name: "设为 子任务" }));
    const rolesSection = screen.getByRole("region", { name: "角色分配" });
    const saveBar = await within(rolesSection).findByRole("status");
    fireEvent.click(within(saveBar).getByRole("button", { name: /保存/ }));
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const rolesCall = calls.find((c) => c["key"] === "modelRoles");
    expect(rolesCall?.["value"]).toMatchObject({ task: "p/fast" });
  });

  it("抽屉开着切到另一行：表单值换成新模型的", async () => {
    stub();
    await renderTab();
    const lib = screen.getByRole("region", { name: "模型库" });
    const rowFor = (name: string): HTMLElement => {
      const row = within(lib).getByText(name).closest("tr");
      if (row === null) throw new Error(`找不到 ${name} 行`);
      return row;
    };
    fireEvent.click(within(rowFor("Fast")).getByRole("button", { name: "规格" }));
    const drawer = await screen.findByRole("complementary", { name: "模型规格 p/fast" });
    expect(within(drawer).getByDisplayValue("Fast")).toBeInTheDocument();
    // 抽屉开着点另一行的「规格」：抽屉实例按 selector 重建，表单换成新值。
    fireEvent.click(within(rowFor("Slow")).getByRole("button", { name: "规格" }));
    const drawer2 = await screen.findByRole("complementary", { name: "模型规格 p/slow" });
    expect(within(drawer2).getByDisplayValue("Slow Edited")).toBeInTheDocument();
    expect(within(drawer2).queryByDisplayValue("Fast")).toBeNull();
  });

  it("D2 保存中锁定表单：输入全禁用，成功后恢复且保存前的值不丢", async () => {
    let resolveSave!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => { resolveSave = resolve; });
    const specCalls: Record<string, unknown>[] = [];
    stub({ onUpdateSpec: (args) => {
      specCalls.push(args);
      return gate;
    } });
    await renderTab();
    const drawer = await openSpecDrawer("Fast");
    fireEvent.change(within(drawer).getByDisplayValue("Fast"), { target: { value: "Fast v2" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存规格" }));
    // 保存 promise 悬挂时：按钮切「保存中…」，同组输入与复选框全部禁用。
    const savingBtn = await within(drawer).findByRole("button", { name: "保存中…" });
    expect(savingBtn).toBeDisabled();
    expect(within(drawer).getByText("正在写入并用 omp 校验，请稍候…")).toBeInTheDocument();
    // Fast 的 present 全为真：标签文本无「目录值仅供参考」后缀，精确匹配。
    expect(within(drawer).getByLabelText("名称")).toBeDisabled();
    expect(within(drawer).getByLabelText("上下文窗口")).toBeDisabled();
    expect(within(drawer).getByLabelText("最大输出")).toBeDisabled();
    expect(within(drawer).getByLabelText("推理模型")).toBeDisabled();
    expect(within(drawer).getByLabelText("text")).toBeDisabled();
    expect(within(drawer).getByLabelText("image")).toBeDisabled();
    expect(within(drawer).getByLabelText("输入价")).toBeDisabled();
    // 关闭也被吞掉（已实现）：点关闭抽屉不消失。
    fireEvent.click(within(drawer).getByRole("button", { name: /关闭/ }));
    expect(screen.getByRole("complementary", { name: "模型规格 p/fast" })).toBeInTheDocument();
    const next = structuredClone(SPECS[0]);
    next.name = "Fast v2";
    resolveSave({ revision: "rev-2", spec: next, backupPath: "/mock/models.yml.bak" });
    // 成功后：按钮回到「保存规格」，输入恢复可用，保存前打的值仍在。
    const doneBtn = await within(drawer).findByRole("button", { name: "保存规格" });
    expect(doneBtn).toBeDisabled();
    expect(within(drawer).getByLabelText("名称")).toBeEnabled();
    expect(within(drawer).getByLabelText("输入价")).toBeEnabled();
    expect(within(drawer).getByDisplayValue("Fast v2")).toBeInTheDocument();
    expect(within(drawer).queryByText("正在写入并用 omp 校验，请稍候…")).toBeNull();
    await vi.waitFor(() => expect(specCalls).toHaveLength(1));
    expect(specCalls[0]["patch"]).toEqual({ name: "Fast v2" });
  });

  it("costTiered 分层价：只读提示、无价格框，改名也不启用保存", async () => {
    const tiered = structuredClone(SPECS[0]);
    tiered.costTiered = true;
    const specCalls: Record<string, unknown>[] = [];
    stub({ specs: [tiered, SPECS[1], SPECS[2]], onUpdateSpec: (args) => {
      specCalls.push(args);
      return { revision: "rev-2", spec: structuredClone(tiered), backupPath: "/mock/models.yml.bak" };
    } });
    await renderTab();
    const drawer = await openSpecDrawer("Fast");
    // 分层价只读：提示在，四个价格框一个都不渲染。
    expect(within(drawer).getByText("分层价格，暂不支持编辑")).toBeInTheDocument();
    expect(within(drawer).queryByLabelText("输入价")).toBeNull();
    expect(within(drawer).queryByLabelText("输出价")).toBeNull();
    expect(within(drawer).queryByLabelText("缓存读")).toBeNull();
    expect(within(drawer).queryByLabelText("缓存写")).toBeNull();
    // 改了名称 touched 非空，保存仍禁用；点也发不出请求。
    fireEvent.change(within(drawer).getByDisplayValue("Fast"), { target: { value: "Fast v2" } });
    const saveBtn = within(drawer).getByRole("button", { name: "保存规格" });
    expect(saveBtn).toBeDisabled();
    expect(saveBtn).toHaveAttribute("title", "分层价格，暂不支持编辑");
    fireEvent.click(saveBtn);
    expect(specCalls).toHaveLength(0);
  });
});

describe("添加模型对话框", () => {
  it("对话框内联渲染选择列表，选中模型显示规格预览", async () => {
    stub();
    await renderTab();
    const testSection = screen.getByRole("region", { name: "测试" });
    fireEvent.click(within(testSection).getByRole("button", { name: "+ 添加模型" }));
    const dialog = await screen.findByRole("dialog", { name: "添加模型" });
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
    const testSection = screen.getByRole("region", { name: "测试" });
    fireEvent.click(within(testSection).getByRole("button", { name: "+ 添加模型" }));
    const dialog = await screen.findByRole("dialog", { name: "添加模型" });
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
