/** ModePicker 单测：按钮文案、名称校验、切换带 expected、冲突后重拉并提示。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModePicker } from "./ModePicker";
import { __resetPresetsStore } from "../modelPresets";
import type { ModelPreset, ModelPresetsState } from "../types";

const snapshot = { modelRoles: { default: "acme/big" }, agentModelOverrides: {}, defaultThinkingLevel: "high" };

function preset(over: Partial<ModelPreset> = {}): ModelPreset {
  return {
    name: "A",
    modelRoles: { default: "acme/big" },
    defaultThinkingLevel: "high",
    agentModelOverrides: null,
    invalidReason: null,
    ...over,
  };
}

function state(over: Partial<ModelPresetsState> = {}): ModelPresetsState {
  return {
    presets: [preset()],
    active: "A",
    current: snapshot,
    rawPresets: { A: {} },
    ...over,
  };
}

interface Handler {
  list: () => ModelPresetsState;
  /** true = 切换命令返回 CONFLICT（后端视为已被外部修改）。 */
  switchFails?: boolean;
}

function installIpc(handler: Handler): { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "list_model_presets":
        return handler.list();
      case "switch_model_preset":
        if (handler.switchFails === true) {
          throw { code: "CONFLICT", message: "模型配置已被外部修改" };
        }
        return state();
      default:
        throw new Error(`未预期的命令：${cmd}`);
    }
  });
  return { calls };
}

function renderPicker() {
  const onToast = vi.fn<(text: string, kind: "info" | "error") => void>();
  render(<ModePicker onToast={onToast} />);
  return { onToast };
}

beforeEach(() => {
  clearMocks();
  __resetPresetsStore();
});

describe("ModePicker", () => {
  it("激活模式时按钮显示模式名，点击后打开弹层", async () => {
    installIpc({ list: () => state() });
    renderPicker();
    const button = await screen.findByRole("button", { name: "模型模式" });
    expect(button.textContent).toBe("模式：A");
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "模型模式" })).toBeInTheDocument();
  });

  it("没有激活模式时显示「模式：自定义」并提示未保存", async () => {
    installIpc({ list: () => state({ active: null }) });
    renderPicker();
    const button = await screen.findByRole("button", { name: "模型模式" });
    expect(button.textContent).toBe("模式：自定义");
    fireEvent.click(button);
    expect(await screen.findByText("当前配置未保存为模式")).toBeInTheDocument();
  });

  it("非法名称时保存按钮禁用并显示规则文案", async () => {
    installIpc({ list: () => state() });
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: "模型模式" }));
    fireEvent.click(await screen.findByRole("button", { name: "将当前配置存为模式…" }));
    const input = screen.getByRole("textbox", { name: "模式名" });
    fireEvent.change(input, { target: { value: "1bad" } });
    expect(screen.getByText(/需以字母开头/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Good" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("点击其他模式调用 switch_model_preset 并带上 expected", async () => {
    const other = preset({ name: "B", modelRoles: { default: "acme/small" } });
    const { calls } = installIpc({ list: () => state({ presets: [preset(), other] }) });
    const { onToast } = renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: "模型模式" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^B/ }));
    await waitFor(() => expect(onToast).toHaveBeenCalled());
    const call = calls.find(([cmd]) => cmd === "switch_model_preset");
    expect(call?.[1]).toMatchObject({ name: "B", expected: snapshot });
    expect(onToast).toHaveBeenCalledWith("已切换到模式「B」", "info");
  });

  it("CONFLICT 时重新拉取列表并提示重试", async () => {
    let listCalls = 0;
    const { calls } = installIpc({
      list: () => {
        listCalls += 1;
        return state({ presets: [preset(), preset({ name: "B" })] });
      },
      switchFails: true,
    });
    const { onToast } = renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: "模型模式" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^B/ }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("omp 配置已被外部修改，已刷新，请重试", "error"),
    );
    expect(listCalls).toBeGreaterThan(1);
    expect(calls.filter(([cmd]) => cmd === "list_model_presets").length).toBeGreaterThan(1);
  });

  it("格式无效的条目禁用并展示原因", async () => {
    installIpc({
      list: () =>
        state({
          presets: [preset({ name: "bad", invalidReason: "不是映射" })],
          active: null,
        }),
    });
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: "模型模式" }));
    const row = await screen.findByRole("menuitemradio", { name: /^bad/ });
    expect(row).toBeDisabled();
    expect(row.textContent).toContain("格式无效：不是映射");
  });
});
