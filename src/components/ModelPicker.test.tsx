import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { setModelHidden } from "../hiddenModels";
import type { ModelInfo } from "../types";
import { ModelPicker } from "./ModelPicker";

function model(id: string): ModelInfo {
  return {
    selector: `p/${id}`,
    provider: "p",
    id,
    name: id.toUpperCase(),
    thinkingLevels: [],
    contextWindow: null,
    maxTokens: null,
    reasoning: false,
    input: ["text"],
    costInput: null,
    costOutput: null,
    costCacheRead: null,
    costCacheWrite: null,
  };
}

describe("ModelPicker 隐藏模型", () => {
  it("隐藏的模型不进下拉列表，但已隐藏的当前值保留", () => {
    const [a, b, c] = [model("a"), model("b"), model("c")];
    setModelHidden(a.selector, true);
    setModelHidden(b.selector, true);
    render(
      <ModelPicker
        models={[a, b, c]}
        value={a.selector}
        onChange={vi.fn()}
        unsetLabel="未设置"
        allowUnset={false}
        disabled={false}
        label="默认模型"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "默认模型" }));
    const list = screen.getByRole("listbox", { name: "默认模型" });
    expect(within(list).getByText("p/a")).toBeInTheDocument();
    expect(within(list).getByText("p/c")).toBeInTheDocument();
    expect(within(list).queryByText("p/b")).toBeNull();
  });
});
