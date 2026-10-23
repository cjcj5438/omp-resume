import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Boom({ value }: { value: unknown }): never {
  throw value;
}

it("子树抛错时显示页面出错和重新加载按钮", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reload = vi.fn();
  const orig = window.location;
  Object.defineProperty(window, "location", { value: { ...orig, reload }, configurable: true, writable: true });
  try {
    render(
      <ErrorBoundary>
        <Boom value={new Error("炸了")} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("页面出错：炸了");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(window, "location", { value: orig, configurable: true, writable: true });
  }
});

it("子树抛出非 Error 值时显示其字符串形式", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <ErrorBoundary>
      <Boom value="字符串炸弹" />
    </ErrorBoundary>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("页面出错：字符串炸弹");
});
