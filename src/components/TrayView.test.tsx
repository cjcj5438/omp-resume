/**
 * 菜单栏页测试：开关写回的参数形状与返回值采用；命令失败时 toast + 重载。
 */
import { beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrayView } from "./TrayView";
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
  clickAction: "menu",
  showDockIcon: false,
};

const PREVIEW: TrayPreview = {
  ready: true,
  header: "omp 会话 · 占用 1 · 工作中 1 · 等待输入 0",
  trayTitle: "1·0",
  costText: "今日花费 $1.20",
  rows: [{ sessionId: "s1", status: "working", text: "标题 · 工作中 · 2分", enabled: true }],
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
  };
}

beforeEach(() => {
  clearMocks();
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
      return { ...structuredClone(PREVIEW), costText: current.showCost ? PREVIEW.costText : null };
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
