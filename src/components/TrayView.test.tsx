/**
 * 菜单栏页测试：开关写回的参数形状与返回值采用；命令失败时 toast + 重载。
 */
import { beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrayPanel } from "./TrayPanel";
import { TrayView } from "./TrayView";
import { __resetPresetsStore } from "../modelPresets";
import type { SessionSummary, TrayPreview, TraySettings } from "../types";

vi.mock("@tauri-apps/api/event", async (orig) => ({
  ...(await orig<object>()),
  listen: vi.fn(async () => () => {}),
}));

const SETTINGS: TraySettings = {
  notifyOnWaiting: true,
  notifyOnStuck: true,
  notifyOnFinish: false,
  badgeStyle: "count",
  titleWidth: "standard",
  showCost: true,
  showProject: false,
  showIdle: true,
  compactRows: false,
  clickAction: "panel",
  showSearch: true,
  showDockIcon: false,
};

const PREVIEW: TrayPreview = {
  ready: true,
  trayTitle: "1·0",
  costUsd: 1.2,
  requestCount: 7,
  rows: [{ sessionId: "s1", status: "working", title: "标题", project: null, subagents: 0, elapsedSecs: 120, enabled: true, disabledReason: null }],
  overflow: [],
  recent: [],
  projects: [],
  modes: null,
  badgeSamples: [{ state: "working", title: "2·0" }],
};

function session(): SessionSummary {
  return {
    id: "s1",
    path: "/tmp/s1.jsonl",
    title: "标题",
    cwd: "/tmp/proj",
    cwdExists: true,
    createdAt: "2026-10-01T00:00:00Z",
    modifiedAt: "2026-10-02T00:00:00Z",
    sizeBytes: 0,
    messageCount: 0,
    branchCount: 0,
    inUse: true,
    probeOk: true,
    occupant: null,
    fork: null,
    formatSupported: true,
    version: 1,
    badLines: 0,
    firstUserMessage: null,
    model: null,
    tokens: null,
  };
}

beforeEach(() => {
  clearMocks();
  __resetPresetsStore();
});

it("关闭「显示今日花费」后，set_tray_settings 收到补丁且界面采用返回值", async () => {
  const seen: unknown[] = [];
  let current = { ...SETTINGS };
  mockIPC((cmd, args) => {
    if (cmd === "get_tray_settings") return structuredClone(current);
    if (cmd === "set_tray_settings") {
      const a = args as { patch: Partial<TraySettings> };
      seen.push(a.patch);
      current = { ...current, ...a.patch };
      return structuredClone(current);
    }
    if (cmd === "get_tray_preview") {
      return { ...structuredClone(PREVIEW), costUsd: current.showCost ? PREVIEW.costUsd : null, requestCount: current.showCost ? PREVIEW.requestCount : null };
    }
    throw `no handler for ${cmd}`;
  });
  render(<TrayView sessions={[session()]} onOpenSession={() => {}} onToast={() => {}} />);

  const sw = await screen.findByRole("switch", { name: "显示今日花费" });
  expect(sw).toHaveAttribute("aria-checked", "true");
  fireEvent.click(sw);

  await waitFor(() => expect(seen).toEqual([{ showCost: false }]));
  // 界面采用返回值：开关翻转，预览里的花费行消失。
  expect(await screen.findByRole("switch", { name: "显示今日花费" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await waitFor(() => expect(screen.queryByText("今日花费 $1.20")).toBeNull());
});

it("命令失败时出现错误 toast，并重调 get_tray_settings", async () => {
  const onToast = vi.fn();
  let getCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "get_tray_settings") {
      getCalls += 1;
      return structuredClone(SETTINGS);
    }
    if (cmd === "set_tray_settings") throw { code: "INVALID_INPUT", message: "patch 必须为对象" };
    if (cmd === "get_tray_preview") return structuredClone(PREVIEW);
    throw `no handler for ${cmd}`;
  });
  render(<TrayView sessions={[session()]} onOpenSession={() => {}} onToast={onToast} />);

  fireEvent.click(await screen.findByRole("switch", { name: "显示今日花费" }));

  await waitFor(() => expect(onToast).toHaveBeenCalledWith("patch 必须为对象", "error"));
  // reload 回到真实状态：get 重调，开关保持原值。
  await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(2));
  expect(screen.getByRole("switch", { name: "显示今日花费" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

it("模型模式卡：出现模式控件并能切换", async () => {
  const onToast = vi.fn();
  const current = {
    modelRoles: { default: "acme/big" },
    agentModelOverrides: {},
    defaultThinkingLevel: "high",
  };
  const presets = [
    { name: "A", modelRoles: { default: "acme/big" }, defaultThinkingLevel: "high", agentModelOverrides: null, invalidReason: null },
    { name: "B", modelRoles: { default: "acme/small" }, defaultThinkingLevel: "high", agentModelOverrides: null, invalidReason: null },
  ];
  let active = "A";
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "get_tray_settings") return structuredClone(SETTINGS);
    if (cmd === "get_tray_preview") return structuredClone(PREVIEW);
    if (cmd === "list_model_presets") {
      return { presets: structuredClone(presets), active, current: structuredClone(current), rawPresets: {} };
    }
    if (cmd === "switch_model_preset") {
      active = "B";
      return { presets: structuredClone(presets), active, current: structuredClone(current), rawPresets: {} };
    }
    throw `no handler for ${cmd}`;
  });
  render(<TrayView sessions={[session()]} onOpenSession={() => {}} onToast={onToast} />);

  const button = await screen.findByRole("button", { name: "模型模式" });
  expect(button.textContent).toBe("模式：A");
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^B/ }));
  await waitFor(() => expect(onToast).toHaveBeenCalledWith("已切换到模式「B」", "info"));
  expect(calls).toContain("switch_model_preset");
});
it("托盘搜索有内容时显示清除键，点击清空并聚焦输入框", () => {
  const actions = {
    onFocusSession: () => {},
    onResumeRecent: () => {},
    onNewSession: () => {},
    onOpenMain: () => {},
    onOpenSettings: () => {},
    onSwitchMode: () => {},
    onQuit: () => {},
  };
  render(
    <TrayPanel
      preview={PREVIEW}
      settings={SETTINGS}
      mode="preview"
      actions={actions}
      appVersion={null}
      ompVersion={null}
      switchingMode={null}
    />,
  );
  const input = screen.getByLabelText("搜索会话或项目") as HTMLInputElement;
  expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  fireEvent.change(input, { target: { value: "标题" } });
  const clear = screen.getByRole("button", { name: "清除搜索" });
  fireEvent.click(clear);
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
});
