/**
 * ManageView 测试：页签切换、App 视图进出、全部更新的顺序/中断/对话框。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
import App from "../App";
import { installMockBackend } from "../dev/mockBackend";
import { ManageView } from "./ManageView";

const S1 = "🎛️ DEMO: 构建可视化配置桌面应用";

function rowOf(title: string): HTMLElement {
  for (const el of screen.getAllByText(title)) {
    const row = el.closest(".row");
    if (row) return row as HTMLElement;
  }
  throw new Error(`未找到会话行：${title}`);
}

function renderManageView() {
  const onToast = vi.fn();
  const onBack = vi.fn();
  const onCheckOmp = vi.fn();
  const onOpenSession = vi.fn();
  render(
    <ManageView
      projects={[{ cwd: "/tmp/a", name: "a" }]}
      onToast={onToast}
      onBack={onBack}
      onCheckOmp={onCheckOmp}
      loadedSessionIds={new Set()}
      onOpenSession={onOpenSession}
    />,
  );
  return { onToast, onBack, onCheckOmp, onOpenSession };
}

const UPDATE_CMDS = [
  "omp_marketplace_update",
  "omp_plugin_upgrade",
  "omp_skills_update",
  "omp_update_check",
];

/** 记录调用顺序的 omp 桩：流式命令逐行回日志，升级报已是最新。 */
function stubOmpCalls(
  calls: string[],
  fail?: { cmd: string; error: { code: string; message: string } },
) {
  mockIPC((cmd, payload) => {
    calls.push(cmd);
    if (fail && cmd === fail.cmd) throw fail.error;
    if (cmd === "omp_plugins_list")
      return { plugins: [], npm: [], marketplaces: [], warnings: [] };
    if (cmd === "omp_skills_list") return { skills: [], warnings: [] };
    if (cmd === "omp_update_check")
      return {
        current: "18.11.1",
        latest: null,
        upToDate: true,
        raw: "✔ Already up to date\n",
      };
    const onLine =
      typeof payload === "object" && payload !== null && "onLine" in payload
        ? payload.onLine
        : null;
    if (onLine instanceof Channel) onLine.onmessage(`line:${cmd}`);
    if (cmd === "omp_marketplace_update") return { output: "✔ Updated marketplace\n" };
    if (cmd === "omp_plugin_upgrade")
      return { output: "All marketplace plugins are up to date.\n", changes: [] };
    if (cmd === "omp_skills_update") return { output: "✔ Updated\n" };
    throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
  });
}

function summaryLines(): string[] {
  const summary = screen.getByRole("list", { name: "全部更新结果" });
  return within(summary)
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");
}

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("ManageView 页签", () => {
  it("默认模型页，可切 Agent / 插件 / Skills / MCP，返回会话回调", async () => {
    await installMockBackend();
    const { onBack } = renderManageView();

    expect(screen.getByRole("tablist", { name: "管理视图" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "模型", selected: true })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "模型库" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "测试" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "角色分配" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Agent" }));
    expect(screen.getByRole("tab", { name: "Agent", selected: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    await screen.findByText("已安装插件");

    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(await screen.findByText(/仅更新通过 omp skill/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(await screen.findByRole("combobox", { name: "配置范围" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("App 管理视图进出", () => {
  it("管理按钮进入，返回会话退出，管理中点行回到会话并选中", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    expect(await screen.findByRole("tablist", { name: "管理视图" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.queryByRole("tablist", { name: "管理视图" })).toBeNull();
    expect(screen.getByText("从左侧选择一个会话查看详情")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByRole("tablist", { name: "管理视图" });
    fireEvent.click(rowOf(S1));
    expect(screen.queryByRole("tablist", { name: "管理视图" })).toBeNull();
    expect(screen.getByRole("heading", { name: S1 })).toBeInTheDocument();
  });
});

describe("全部更新", () => {
  it("按顺序执行四步并给出每步小结，不开更新对话框", async () => {
    const calls: string[] = [];
    stubOmpCalls(calls);
    const { onToast, onCheckOmp } = renderManageView();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    await screen.findByText("尚未安装插件");

    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));
    expect(await screen.findByRole("list", { name: "全部更新结果" })).toBeInTheDocument();
    expect(summaryLines()).toEqual([
      "✔ 更新 marketplace 目录：完成",
      "✔ 升级插件：全部已是最新",
      "✔ 更新 registry skills：完成",
      "✔ 检查 omp 更新：omp 已是最新",
    ]);
    expect(calls.filter((c) => UPDATE_CMDS.includes(c))).toEqual(UPDATE_CMDS);
    expect(onToast).toHaveBeenCalledWith("全部更新完成", "info");
    expect(onCheckOmp).not.toHaveBeenCalled();
    // 流式日志保留在操作日志中。
    const log = document.querySelector('pre[aria-label="操作日志"]');
    expect(log?.textContent).toContain("line:omp_marketplace_update");
  });

  it("首个失败即停，点名失败步骤，后续不再执行", async () => {
    const calls: string[] = [];
    stubOmpCalls(calls, {
      cmd: "omp_plugin_upgrade",
      error: { code: "OMP_FAILED", message: "升级炸了" },
    });
    const { onToast, onCheckOmp } = renderManageView();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    await screen.findByText("尚未安装插件");

    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));
    expect(await screen.findByRole("list", { name: "全部更新结果" })).toBeInTheDocument();
    expect(summaryLines()).toEqual([
      "✔ 更新 marketplace 目录：完成",
      "✘ 升级插件：升级炸了",
    ]);
    expect(calls).not.toContain("omp_skills_update");
    expect(calls).not.toContain("omp_update_check");
    expect(onToast).toHaveBeenCalledWith("全部更新在「升级插件」失败：升级炸了", "error");
    expect(onCheckOmp).not.toHaveBeenCalled();
  });

  it("有新版时打开 omp 更新对话框", async () => {
    window.history.replaceState({}, "", "/?omp=new");
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByRole("tablist", { name: "管理视图" });
    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));
    const dialog = await screen.findByRole("dialog", { name: "omp 版本更新" });
    expect(within(dialog).getByText("可更新到 18.12.0")).toBeInTheDocument();
  });

  it("omp 已是最新时只记一行，不开对话框", async () => {
    await installMockBackend();
    const { onToast, onCheckOmp } = renderManageView();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    await screen.findByText("已安装插件");

    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));
    expect(await screen.findByRole("list", { name: "全部更新结果" })).toBeInTheDocument();
    expect(summaryLines()).toContain("✔ 检查 omp 更新：omp 已是最新");
    expect(onCheckOmp).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("全部更新完成", "info");
  });

  it("运行时禁用全部更新与 MCP 操作，页签保持可切换", async () => {
    window.history.replaceState({}, "", "/?latency=100");
    await installMockBackend();
    renderManageView();
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    await screen.findByText("已安装插件");

    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    await screen.findByRole("combobox", { name: "配置范围" });
    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));

    expect(screen.getByRole("button", { name: "全部更新" })).toBeDisabled();
    const fieldset = document.querySelector("fieldset.manage-fieldset");
    expect(fieldset).not.toBeNull();
    expect(fieldset).toHaveAttribute("disabled");
    expect(screen.getByRole("tab", { name: "插件" })).toBeEnabled();

    expect(
      await screen.findByRole("list", { name: "全部更新结果" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部更新" })).toBeEnabled();
    expect(document.querySelector("fieldset.manage-fieldset")).not.toHaveAttribute(
      "disabled",
    );
  });
});
