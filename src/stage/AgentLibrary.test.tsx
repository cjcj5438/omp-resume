import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentLibrary } from "./AgentLibrary";
import type { AgentCatalog } from "./agentCatalog";
import { defaultStagePrefs, STAGE_PREFS_KEY } from "./prefs";

// catalog 对象直接当 props 传，不 mock api。
function catalog(over: Partial<AgentCatalog> = {}): AgentCatalog {
  return { loading: false, config: null, models: [], details: [], error: null, ...over };
}

beforeEach(() => {
  // jsdom 无 canvas 实现：明确返回 null，只渲染外壳。
  HTMLCanvasElement.prototype.getContext = () => null;
});

describe("AgentLibrary", () => {
  test("空 catalog 时用默认清单 + 舞台 extras，各出现一次", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <AgentLibrary
        prefs={defaultStagePrefs()}
        onChange={onChange}
        onClose={onClose}
        catalog={catalog()}
        stageAgents={["deployer", "scout"]}
      />,
    );
    for (const key of [
      "main",
      "task",
      "scout",
      "sonic",
      "reviewer",
      "security-reviewer",
      "advisor",
      "deployer",
    ]) {
      const matches = screen.getAllByText(key, { selector: ".mono" });
      expect(matches, key).toHaveLength(1);
    }
  });

  test("切换形象：回调收到全量偏好并写 localStorage", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <AgentLibrary
        prefs={defaultStagePrefs()}
        onChange={onChange}
        onClose={onClose}
        catalog={catalog()}
        stageAgents={[]}
      />,
    );
    // 先选中 scout 行，再切它的形象。
    fireEvent.click(screen.getByRole("button", { name: /scout/ }));
    fireEvent.change(screen.getByLabelText("scout 的形象"), { target: { value: "ops" } });
    expect(onChange).toHaveBeenCalledWith({ chars: { scout: "ops" } });
    expect(localStorage.getItem(STAGE_PREFS_KEY)).toBe(JSON.stringify({ chars: { scout: "ops" } }));
  });

  test("恢复默认形象只在有覆盖时出现，点击后删掉该键", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <AgentLibrary
        prefs={defaultStagePrefs()}
        onChange={onChange}
        onClose={onClose}
        catalog={catalog()}
        stageAgents={[]}
      />,
    );
    // 无覆盖：默认选中的 main 没有覆盖 → 不出现。
    expect(screen.queryByRole("button", { name: "恢复默认形象" })).toBeNull();

    rerender(
      <AgentLibrary
        prefs={{ chars: { main: "ops" } }}
        onChange={onChange}
        onClose={onClose}
        catalog={catalog()}
        stageAgents={[]}
      />,
    );
    const reset = screen.getByRole("button", { name: "恢复默认形象" });
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith({ chars: {} });
    expect(localStorage.getItem(STAGE_PREFS_KEY)).toBe(JSON.stringify({ chars: {} }));
  });

  test("原型键名 agent 无覆盖时不显示恢复默认形象", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <AgentLibrary
        prefs={defaultStagePrefs()}
        onChange={onChange}
        onClose={onClose}
        catalog={catalog()}
        stageAgents={["constructor"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /constructor/ }));
    expect(screen.queryByRole("button", { name: "恢复默认形象" })).toBeNull();
  });

  test("原型键名 agent 的覆盖可恢复默认", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <AgentLibrary
        prefs={{ chars: { constructor: "ops" as const } }}
        onChange={onChange}
        onClose={onClose}
        catalog={catalog()}
        stageAgents={["constructor"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /constructor/ }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认形象" }));
    expect(onChange).toHaveBeenCalledWith({ chars: {} });
  });

  test("只读契约：只允许行选择、恢复默认形象、关闭按钮", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <AgentLibrary
        prefs={{ chars: { main: "ops" } }}
        onChange={onChange}
        onClose={onClose}
        catalog={catalog()}
        stageAgents={[]}
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      const name = button.textContent ?? "";
      expect(name, "写操作按钮").not.toMatch(/保存|修改|删除|停止/);
    }
  });
});
