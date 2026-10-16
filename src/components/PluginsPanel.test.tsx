/**
 * PluginsPanel 测试（有状态 mock 后端 + mockIPC 定制）：
 * 列表渲染、启用/禁用往返、卸载确认、浏览安装、添加校验、
 * 升级汇总、忙时禁用与失败恢复。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installMockBackend } from "../dev/mockBackend";
import { PluginsPanel } from "./PluginsPanel";
import { useOmpOp, type ToastFn } from "./useOmpOp";

function Host({ onToast, show = true }: { onToast: ToastFn; show?: boolean }) {
  const op = useOmpOp();
  return (
    <>
      <div data-testid="op-state">{op.running ?? "idle"}</div>
      {show ? <PluginsPanel op={op} onToast={onToast} refreshToken={0} /> : null}
    </>
  );
}

function renderPanel() {
  const onToast = vi.fn();
  const result = render(<Host onToast={onToast} />);
  return { onToast, ...result };
}

/** 在已安装表中按名称 + 来源定位行。 */
function pluginRow(name: string, marketplace: string): HTMLElement {
  for (const cell of screen.getAllByText(name)) {
    const row = cell.closest("tr");
    if (row && within(row).queryByText(marketplace)) return row as HTMLElement;
  }
  throw new Error(`未找到插件行：${name}@${marketplace}`);
}

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("PluginsPanel（有状态 mock）", () => {
  it("渲染已安装行、状态徽章、时间与 npm 只读列表", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByRole("button", { name: "禁用 hello-plugin@probe-mkt" });

    const hello = pluginRow("hello-plugin", "probe-mkt");
    expect(within(hello).getByText("启用")).toBeInTheDocument();
    expect(within(hello).getByText("1.0.0")).toBeInTheDocument();
    expect(within(hello).getByText(/安装 /)).toBeInTheDocument();
    const formatter = pluginRow("formatter", "community");
    expect(within(formatter).getByText("已禁用")).toBeInTheDocument();

    expect(screen.getByText("npm 插件（只读）")).toBeInTheDocument();
    expect(screen.getByText("omp-enforce-uv")).toBeInTheDocument();
    expect(screen.getByText("0.3.0")).toBeInTheDocument();
    expect(screen.getByText("Marketplace")).toBeInTheDocument();
  });

  it("禁用再启用往返，徽章同步更新", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByRole("button", { name: "禁用 hello-plugin@probe-mkt" });

    fireEvent.click(screen.getByRole("button", { name: "禁用 hello-plugin@probe-mkt" }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("已禁用 hello-plugin@probe-mkt", "info"),
    );
    expect(
      await screen.findByRole("button", { name: "启用 hello-plugin@probe-mkt" }),
    ).toBeInTheDocument();
    expect(
      within(pluginRow("hello-plugin", "probe-mkt")).getByText("已禁用"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "启用 hello-plugin@probe-mkt" }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("已启用 hello-plugin@probe-mkt", "info"),
    );
    expect(
      within(pluginRow("hello-plugin", "probe-mkt")).getByText("启用"),
    ).toBeInTheDocument();
  });

  it("卸载需确认：取消无事，确认删除行", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByRole("button", { name: "卸载 hello-plugin@probe-mkt" });

    fireEvent.click(screen.getByRole("button", { name: "卸载 hello-plugin@probe-mkt" }));
    const dialog = await screen.findByRole("dialog", {
      name: "卸载插件 hello-plugin@probe-mkt？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "卸载 hello-plugin@probe-mkt" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "卸载 hello-plugin@probe-mkt" }));
    const dialog2 = await screen.findByRole("dialog", {
      name: "卸载插件 hello-plugin@probe-mkt？",
    });
    fireEvent.click(within(dialog2).getByRole("button", { name: "卸载" }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("已卸载 hello-plugin@probe-mkt", "info"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "卸载 hello-plugin@probe-mkt" }),
      ).toBeNull(),
    );
  });

  it("浏览 marketplace 并安装：加入已安装列表，按钮变为已安装", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByRole("button", { name: "浏览 probe-mkt" });

    fireEvent.click(screen.getByRole("button", { name: "浏览 probe-mkt" }));
    expect(
      await screen.findByRole("button", { name: "安装 formatter@probe-mkt" }),
    ).toBeInTheDocument();
    // 已安装的条目直接展示为禁用态的已安装。
    expect(
      screen.getByRole("button", { name: "已安装 hello-plugin@probe-mkt" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "安装 formatter@probe-mkt" }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("已安装 formatter@probe-mkt", "info"),
    );
    expect(
      await screen.findByRole("button", { name: "已安装 formatter@probe-mkt" }),
    ).toBeDisabled();
    expect(pluginRow("formatter", "probe-mkt")).toBeInTheDocument();
  });

  it("添加 marketplace 成功后出现在列表", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByRole("button", { name: "浏览 probe-mkt" });

    fireEvent.change(screen.getByRole("textbox", { name: "marketplace 来源" }), {
      target: { value: "/tmp/new-mkt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("已添加 marketplace：/tmp/new-mkt", "info"),
    );
    expect(await screen.findByRole("button", { name: "浏览 new-mkt" })).toBeInTheDocument();
  });

  it("升级全部展示 changes 汇总；再次升级报已是最新", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByRole("button", { name: "升级全部插件" });

    fireEvent.click(screen.getByRole("button", { name: "升级全部插件" }));
    expect(
      await screen.findByText("hello-plugin@probe-mkt 1.0.0 → 1.1.0"),
    ).toBeInTheDocument();
    expect(screen.getByText("formatter@community 1.0.0 → 1.1.0")).toBeInTheDocument();
    expect(onToast).toHaveBeenCalledWith("已升级 2 个插件", "info");
    // 原始输出始终可查看。
    fireEvent.click(screen.getByRole("button", { name: "查看原始输出" }));
    expect(screen.getByText(/1\.0\.0 -> 1\.1\.0/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "升级全部插件" }));
    expect(await screen.findByText("全部已是最新")).toBeInTheDocument();
    expect(onToast).toHaveBeenCalledWith("全部已是最新", "info");
  });

  it("操作运行时所有变更按钮禁用，完成后恢复", async () => {
    window.history.replaceState({}, "", "/?latency=200");
    await installMockBackend();
    renderPanel();
    await screen.findByRole("button", { name: "禁用 hello-plugin@probe-mkt" });

    fireEvent.click(screen.getByRole("button", { name: "禁用 hello-plugin@probe-mkt" }));
    expect(screen.getByRole("button", { name: "禁用 hello-plugin@probe-mkt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "升级全部插件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新 marketplace 目录" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "卸载 hello-plugin@probe-mkt" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "升级 formatter@community" })).toBeDisabled();
    // 浏览是只读操作，保持可用。
    expect(screen.getByRole("button", { name: "浏览 probe-mkt" })).toBeEnabled();

    expect(
      await screen.findByRole("button", { name: "启用 hello-plugin@probe-mkt" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "升级全部插件" })).toBeEnabled();
    expect(screen.getByTestId("op-state")).toHaveTextContent("idle");
  });

  it("操作失败后不卡死：toast 报错且按钮恢复可用", async () => {
    window.history.replaceState({}, "", "/?fail=omp_plugin_set_enabled");
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByRole("button", { name: "禁用 hello-plugin@probe-mkt" });

    fireEvent.click(screen.getByRole("button", { name: "禁用 hello-plugin@probe-mkt" }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        "mock 强制失败：omp_plugin_set_enabled",
        "error",
      ),
    );
    expect(screen.getByRole("button", { name: "禁用 hello-plugin@probe-mkt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "升级全部插件" })).toBeEnabled();
    expect(screen.getByTestId("op-state")).toHaveTextContent("idle");
    expect(
      within(pluginRow("hello-plugin", "probe-mkt")).getByText("启用"),
    ).toBeInTheDocument();
  });

  it("操作中卸载面板不崩：完成后面板可重新挂载", async () => {
    window.history.replaceState({}, "", "/?latency=100");
    await installMockBackend();
    const onToast = vi.fn();
    const { rerender } = render(<Host onToast={onToast} show />);
    await screen.findByRole("button", { name: "禁用 hello-plugin@probe-mkt" });

    fireEvent.click(screen.getByRole("button", { name: "禁用 hello-plugin@probe-mkt" }));
    expect(screen.getByTestId("op-state")).toHaveTextContent("禁用 hello-plugin@probe-mkt");
    rerender(<Host onToast={onToast} show={false} />);
    await waitFor(() => expect(screen.getByTestId("op-state")).toHaveTextContent("idle"));
    expect(onToast).not.toHaveBeenCalled();

    rerender(<Host onToast={onToast} show />);
    // 后端操作实际完成了：重挂载后插件已是禁用态。
    expect(
      await screen.findByRole("button", { name: "启用 hello-plugin@probe-mkt" }),
    ).toBeInTheDocument();
  });
});

describe("PluginsPanel（定制 mock）", () => {
  it("添加非法来源时内联展示后端 INVALID_INPUT 原文", async () => {
    mockIPC((cmd) => {
      if (cmd === "omp_plugins_list")
        return { plugins: [], npm: [], marketplaces: [], warnings: [] };
      if (cmd === "omp_marketplace_add")
        throw { code: "INVALID_INPUT", message: "来源不能以 - 开头" };
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    const { onToast } = renderPanel();
    await screen.findByText("尚未安装插件");

    fireEvent.change(screen.getByRole("textbox", { name: "marketplace 来源" }), {
      target: { value: "-bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByText("来源不能以 - 开头")).toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalled();
  });

  it("OMP_NOT_FOUND 显示空状态而非 toast", async () => {
    mockIPC((cmd) => {
      if (cmd === "omp_plugins_list")
        throw { code: "OMP_NOT_FOUND", message: "找不到 omp" };
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    const { onToast } = renderPanel();
    expect(
      await screen.findByText("未找到 omp，请先安装 omp 后再管理插件。"),
    ).toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalled();
  });

  it("列表失败显示内联横幅，重试后展示警告横幅", async () => {
    let calls = 0;
    mockIPC((cmd) => {
      if (cmd === "omp_plugins_list") {
        calls += 1;
        if (calls === 1) throw { code: "IO", message: "读失败" };
        return { plugins: [], npm: [], marketplaces: [], warnings: ["测试警告"] };
      }
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    renderPanel();
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("读失败")).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("尚未安装插件")).toBeInTheDocument();
    expect(screen.getByText("测试警告")).toBeInTheDocument();
  });
});

describe("PluginsPanel（回归）", () => {
  it("marketplace 来源输入关闭自动大写/纠错/拼写检查", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByRole("button", { name: "浏览 probe-mkt" });
    const input = screen.getByRole("textbox", { name: "marketplace 来源" }) as HTMLInputElement;
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });

  it("浏览后移除该 marketplace 则浏览面板清空", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByRole("button", { name: "浏览 probe-mkt" });
    fireEvent.click(screen.getByRole("button", { name: "浏览 probe-mkt" }));
    expect(
      await screen.findByRole("button", { name: "安装 formatter@probe-mkt" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".manage-browse")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移除 probe-mkt" }));
    const dialog = await screen.findByRole("dialog", { name: "移除 marketplace probe-mkt？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(document.querySelector(".manage-browse")).toBeNull());
    expect(screen.queryByRole("button", { name: "浏览 probe-mkt" })).toBeNull();
    // 其他 marketplace 仍可浏览。
    expect(screen.getByRole("button", { name: "浏览 community" })).toBeInTheDocument();
  });

  it("浏览并发只采纳最新响应（乱序到达时旧结果被丢弃）", async () => {
    const first = Promise.withResolvers<{ name: string; version: string; description: string }[]>();
    const second = Promise.withResolvers<{ name: string; version: string; description: string }[]>();
    mockIPC((cmd, args) => {
      if (cmd === "omp_plugins_list") {
        return {
          plugins: [],
          npm: [],
          marketplaces: [
            { name: "aaa", source: "s1" },
            { name: "bbb", source: "s2" },
          ],
          warnings: [],
        };
      }
      if (cmd === "omp_plugin_discover") {
        const payload = args as { marketplace?: string };
        if (payload.marketplace === "aaa") return first.promise;
        if (payload.marketplace === "bbb") return second.promise;
      }
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    renderPanel();
    await screen.findByRole("button", { name: "浏览 aaa" });
    fireEvent.click(screen.getByRole("button", { name: "浏览 aaa" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览 bbb" }));
    second.resolve([{ name: "new-item", version: "2.0.0", description: "新" }]);
    expect(await screen.findByText("new-item")).toBeInTheDocument();
    await act(async () => {
      first.resolve([{ name: "stale-item", version: "1.0.0", description: "旧" }]);
      await first.promise;
    });
    expect(screen.getByText("new-item")).toBeInTheDocument();
    expect(screen.queryByText("stale-item")).toBeNull();
  });
});
