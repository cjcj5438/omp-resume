/** openOmpChangelog：Tauri 打包走 openUrl；仅非 Tauri 环境回退 window.open。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OMP_CHANGELOG_URL, openOmpChangelog } from "./format";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const mocked = vi.mocked(openUrl);

beforeEach(() => {
  mocked.mockReset();
  vi.restoreAllMocks();
});

describe("openOmpChangelog", () => {
  it("openUrl 成功时不回退 window.open", async () => {
    mocked.mockResolvedValue(undefined);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openOmpChangelog();
    expect(mocked).toHaveBeenCalledExactlyOnceWith(OMP_CHANGELOG_URL);
    expect(open).not.toHaveBeenCalled();
  });

  it("非 Tauri 环境 openUrl 失败时回退 window.open", async () => {
    mocked.mockRejectedValue(new Error("invoke 失败"));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openOmpChangelog();
    expect(open).toHaveBeenCalledExactlyOnceWith(OMP_CHANGELOG_URL, "_blank", "noopener");
  });

  it("Tauri 打包环境 openUrl 失败时不回退 window.open 且不抛错", async () => {
    mocked.mockRejectedValue(new Error("无默认浏览器"));
    // Tauri 在启动脚本里定义 window.isTauri = true（core.js isTauri() 读它）。
    const w = window as unknown as Record<string, unknown>;
    Object.defineProperty(w, "isTauri", { value: true, configurable: true });
    try {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      await openOmpChangelog();
      expect(open).not.toHaveBeenCalled();
    } finally {
      delete w["isTauri"];
    }
  });
});
