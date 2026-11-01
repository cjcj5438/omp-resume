/**
 * 外观与行为页测试：主题切换写 dataset；启动检查更新偏好落 localStorage。
 */
import { beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsView } from "./SettingsView";
import { useAppearance } from "../useAppearance";
import { APP_PREFS_STORAGE_KEY, loadAppPrefs, saveAppPrefs } from "../appPrefs";
import type { TrayPreview, TraySettings } from "../types";

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
  header: "没有运行中的 omp 会话",
  trayTitle: null,
  costText: "今日花费 $1.20",
  rows: [],
  overflow: [],
  recent: [],
  projects: [],
  modes: null,
  badgeSamples: [],
};

/** 与 App 相同的外观接线：useAppearance 状态下发给 SettingsView。 */
function Harness({ checkUpdateOnLaunch = true }: { checkUpdateOnLaunch?: boolean }) {
  const appearance = useAppearance();
  const prefs = { sidebarCollapsed: false, checkUpdateOnLaunch };
  return (
    <SettingsView
      appearance={appearance.appearance}
      onSetMode={appearance.setMode}
      onSetAccent={appearance.setAccent}
      prefs={prefs}
      onPrefs={(p) => saveAppPrefs(p)}
      appVersion="0.5.0"
      appChecking={false}
      ompVersion={null}
      ompChecking={false}
      onCheckApp={() => {}}
      onCheckOmp={() => {}}
      onNavigate={() => {}}
      onToast={() => {}}
    />
  );
}

beforeEach(() => {
  clearMocks();
  mockIPC((cmd) => {
    if (cmd === "get_tray_settings") return structuredClone(SETTINGS);
    if (cmd === "get_tray_preview") return structuredClone(PREVIEW);
    if (cmd === "get_app_paths") {
      return {
        sessionsDir: "/tmp/sessions",
        ownersDir: "/tmp/owners",
        historyDb: "/tmp/history.db",
        memoryDir: "/tmp/memory",
        dataDir: null,
        ompBin: null,
      };
    }
    throw `no handler for ${cmd}`;
  });
});

it("点浅色后 documentElement.dataset.theme 为 light", async () => {
  render(<Harness />);
  fireEvent.click(await screen.findByRole("radio", { name: "浅色" }));
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("关掉启动检查更新后，localStorage 对应值为 false", async () => {
  saveAppPrefs({ sidebarCollapsed: false, checkUpdateOnLaunch: true });
  render(<Harness />);
  fireEvent.click(await screen.findByRole("switch", { name: "启动时自动检查应用更新" }));
  expect(loadAppPrefs().checkUpdateOnLaunch).toBe(false);
  // 写入的 JSON 与 key 与 App 侧一致。
  expect(JSON.parse(localStorage.getItem(APP_PREFS_STORAGE_KEY) ?? "{}")).toMatchObject({
    checkUpdateOnLaunch: false,
  });
});

it("路径值为 null 时显示「未找到」", async () => {
  render(<Harness />);
  // dataDir 与 ompBin 为 null。
  expect(await screen.findAllByText("未找到")).toHaveLength(2);
});
