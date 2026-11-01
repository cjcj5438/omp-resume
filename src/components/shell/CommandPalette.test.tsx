/**
 * 命令面板键盘回归：↑/↓/Enter 走 document 监听（焦点在输入框，不冒泡到列表容器）。
 */
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

function renderPalette() {
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(
    <CommandPalette
      sessions={[]}
      meta={null}
      onNavigate={onNavigate}
      onOpenSession={() => {}}
      onNewSession={() => {}}
      onRescan={() => {}}
      onToggleTheme={() => {}}
      onCheckApp={() => {}}
      onCheckOmp={() => {}}
      onClose={onClose}
    />,
  );
  return { onNavigate, onClose };
}

it("↓ 后 Enter 执行第二项，↑ 回到首项，Enter 后关闭", () => {
  const { onNavigate, onClose } = renderPalette();
  // 「模型」命中两个页面：模型、模型测试（sessions 为空，无会话项）。
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索页面、会话或动作" }), {
    target: { value: "模型" },
  });
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(2);

  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(options[1]).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(document, { key: "Enter" });
  expect(onNavigate).toHaveBeenCalledTimes(1);
  expect(onNavigate).toHaveBeenCalledWith("bench");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("↑ 从首项循环到末项", () => {
  renderPalette();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索页面、会话或动作" }), {
    target: { value: "模型" },
  });
  const options = screen.getAllByRole("option");
  expect(options[0]).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(document, { key: "ArrowUp" });
  expect(options[1]).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(document, { key: "ArrowUp" });
  expect(options[0]).toHaveAttribute("aria-selected", "true");
});
