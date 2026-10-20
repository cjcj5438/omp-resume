/**
 * CheatSheetDialog 测试：复制成功/失败反馈、版本提示、组合用法与过滤。
 * 剪贴板用 navigator.clipboard 桩，不触碰系统剪贴板。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { OMP_VERSION } from "../ompCommands";
import { OMP_COMBOS } from "../ompCombos";
import { CheatSheetDialog } from "./CheatSheetDialog";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

function renderDialog(installedVersion: string | null = null) {
  render(<CheatSheetDialog installedVersion={installedVersion} onClose={() => {}} />);
}

beforeEach(() => {
  stubClipboard(vi.fn().mockResolvedValue(undefined));
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("版本提示", () => {
  it("已安装版本与基准不一致时提示，一致或未知时不提示", () => {
    const { unmount } = render(
      <CheatSheetDialog installedVersion="18.11.1" onClose={() => {}} />,
    );
    expect(
      screen.getByText(`你安装的是 18.11.1，速查基于 ${OMP_VERSION}，个别命令可能有差异`),
    ).toBeInTheDocument();
    unmount();

    renderDialog(OMP_VERSION);
    expect(screen.queryByText(/个别命令可能有差异/)).toBeNull();
    unmount();
  });
});

describe("复制", () => {
  it("复制命令名成功后按钮变为已复制并在 1.5 秒后还原", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderDialog();

    fireEvent.change(screen.getByLabelText("过滤命令"), { target: { value: "delete" } });
    const btn = screen.getByRole("button", { name: "复制 /delete" });
    fireEvent.click(btn);
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("/delete");
    expect(btn).toHaveTextContent("已复制 ✓");

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(btn).toHaveTextContent("复制");
  });

  it("有参数的命令提供含参数模板复制，写原文参数提示", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderDialog();

    fireEvent.change(screen.getByLabelText("过滤命令"), { target: { value: "compact" } });
    fireEvent.click(screen.getByRole("button", { name: "复制 /compact 的含参数模板" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("/compact [soft|remote|snapcompact] [focus]");
  });

  it("复制失败显示可见提示而不是已复制", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    renderDialog();

    fireEvent.change(screen.getByLabelText("过滤命令"), { target: { value: "delete" } });
    fireEvent.click(screen.getByRole("button", { name: "复制 /delete" }));
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("复制失败");
    expect(screen.getByRole("button", { name: "复制 /delete" })).toHaveTextContent("复制");
  });
});

describe("常用分组", () => {
  it("空查询时顶部显示常用分组，过滤时隐藏且不重复行", () => {
    renderDialog();
    const titles = [...document.querySelectorAll(".cheatsheet-group-title")].map((el) => el.textContent ?? "");
    expect(titles.length).toBeGreaterThan(1);
    expect(titles[0]).toMatch(/^常用/);
    // 置顶行与原分组行重复出现
    expect(screen.getAllByRole("button", { name: "复制 /compact" })).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("过滤命令"), { target: { value: "compact" } });
    expect(screen.queryByText(/^常用/, { selector: ".cheatsheet-group-title" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "复制 /compact" })).toHaveLength(1);
  });
});

describe("组合用法", () => {
  it("切换视图后按场景展示，复制全部按换行拼接各步", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderDialog();

    fireEvent.click(screen.getByRole("tab", { name: "组合用法" }));
    const combo = OMP_COMBOS[0];
    expect(screen.getByRole("heading", { name: combo.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `复制全部：${combo.title}` }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(combo.steps.map((s) => s.cmd).join("\n"));
  });

  it("过滤在组合视图下作用于场景标题与步骤", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "组合用法" }));
    fireEvent.change(screen.getByLabelText("过滤命令"), { target: { value: "/memory" } });
    expect(screen.getByRole("heading", { name: "记忆库维护" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "上下文快满了" })).toBeNull();

    fireEvent.change(screen.getByLabelText("过滤命令"), { target: { value: "不存在的场景xyz" } });
    expect(screen.getByText("没有匹配的场景")).toBeInTheDocument();
  });
});
