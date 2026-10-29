/**
 * 自动更新测试（mock updater/process IPC）：
 * 有更新→弹窗展示版本→下载安装→提供重启；无更新→无弹窗；检查失败→静默。
 * 手动检查（侧栏按钮 / 托盘事件）：已是最新→提示；失败→报错提示；有更新→弹窗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import App from "./App";
import { installMockBackend } from "./dev/mockBackend";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/app", async (orig) => ({
  ...(await orig<object>()),
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
}));
// 必须展开原模块：@tauri-apps/api/window 内部也 import event 模块。
let trayHandler: (() => void) | null = null;
vi.mock("@tauri-apps/api/event", async (orig) => ({
  ...(await orig<object>()),
  listen: vi.fn(async (_event: string, handler: () => void) => {
    trayHandler = handler;
    return () => {};
  }),
}));

const mockCheck = vi.mocked(check);
const mockRelaunch = vi.mocked(relaunch);

function fakeUpdate(): Update {
  return {
    version: "0.2.0",
    currentVersion: "0.1.0",
    date: "2026-10-01T00:00:00Z",
    body: "修复了一些问题",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Update;
}

beforeEach(() => {
  clearMocks();
  vi.clearAllMocks();
  trayHandler = null;
  // 生产行为：允许启动检查联网（默认 DEV 下会跳过）。
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("自动更新", () => {
  it("有更新→弹窗展示版本→下载并安装→可重启", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);
    await installMockBackend();
    render(<App />);

    // 弹窗出现并展示新版本号。
    await screen.findByText("发现新版本 0.2.0");

    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);

    // 安装成功后提供重启。
    await screen.findByRole("button", { name: "立即重启" });
    fireEvent.click(screen.getByRole("button", { name: "立即重启" }));
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("无更新→不弹窗，列表正常", async () => {
    mockCheck.mockResolvedValue(null);
    await installMockBackend();
    render(<App />);

    await screen.findByRole("searchbox", { name: "过滤会话" });
    expect(screen.queryByText(/发现新版本/)).toBeNull();
  });

  it("检查失败→静默，列表照常渲染", async () => {
    mockCheck.mockRejectedValue(new Error("offline"));
    await installMockBackend();
    render(<App />);

    await screen.findByRole("searchbox", { name: "过滤会话" });
    expect(screen.queryByText(/发现新版本/)).toBeNull();
    // 无错误 toast，无异常冒泡。
    expect(screen.queryByText(/offline/)).toBeNull();
  });
});

describe("手动检查更新", () => {
  it("侧栏按钮：已是最新→提示当前版本", async () => {
    mockCheck.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await installMockBackend();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "检查应用更新" }));
    expect(await screen.findByText("已是最新版本 0.1.0")).toBeInTheDocument();
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  it("侧栏按钮：检查失败→报错提示", async () => {
    mockCheck.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
    await installMockBackend();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "检查应用更新" }));
    expect(await screen.findByText("检查更新失败：offline")).toBeInTheDocument();
  });

  it("托盘事件：有新版本→弹窗", async () => {
    mockCheck.mockResolvedValueOnce(null).mockResolvedValueOnce(fakeUpdate());
    await installMockBackend();
    render(<App />);

    await screen.findByRole("button", { name: "检查应用更新" });
    await vi.waitFor(() => expect(trayHandler).not.toBeNull());
    trayHandler?.();
    expect(await screen.findByText("发现新版本 0.2.0")).toBeInTheDocument();
  });
});
