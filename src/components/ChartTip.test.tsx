import { expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChartTip } from "./ChartTip";

function setup(tip = "第一行\n第二行") {
  render(
    <>
      <div data-tip={tip} data-testid="host">
        <span data-testid="inner">子元素</span>
      </div>
      <ChartTip />
    </>,
  );
}

it("悬停子元素解析到祖先 data-tip：多行展示，首行加粗；移出隐藏", () => {
  setup();
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerOver(screen.getByTestId("inner"), { clientX: 100, clientY: 100 });
  const tip = screen.getByRole("tooltip");
  expect(tip.querySelector("strong")).toHaveTextContent("第一行");
  expect(tip.textContent).toBe("第一行第二行");
  fireEvent.pointerOut(screen.getByTestId("inner"));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("Escape 与聚焦行为：聚焦显示、Escape 隐藏", () => {
  setup();
  fireEvent.focusIn(screen.getByTestId("inner"));
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
