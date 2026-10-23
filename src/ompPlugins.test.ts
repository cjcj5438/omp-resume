import { beforeEach, describe, expect, it, vi } from "vitest";
import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  addOmpMarketplace, installOmpPlugin,
  removeOmpMarketplace, setOmpPluginEnabled, uninstallOmpPlugin, updateOmpMarketplaces,
  updateOmpSkills, upgradeOmpPlugins,
} from "./api";
import type { OmpOpResult } from "./types";

beforeEach(() => {
  clearMocks();
});

const mutations: {
  command: string;
  args: Record<string, unknown>;
  call: (onLine: (line: string) => void) => Promise<OmpOpResult>;
}[] = [
  { command: "omp_plugin_install", args: { id: "hello@m" }, call: (line) => installOmpPlugin("hello@m", line) },
  { command: "omp_plugin_uninstall", args: { id: "hello@m" }, call: (line) => uninstallOmpPlugin("hello@m", line) },
  { command: "omp_plugin_set_enabled", args: { id: "hello@m", enabled: false }, call: (line) => setOmpPluginEnabled("hello@m", false, line) },
  { command: "omp_plugin_upgrade", args: { id: null }, call: (line) => upgradeOmpPlugins(null, line) },
  { command: "omp_marketplace_update", args: { name: null }, call: (line) => updateOmpMarketplaces(null, line) },
  { command: "omp_marketplace_add", args: { source: "/tmp/mkt" }, call: (line) => addOmpMarketplace("/tmp/mkt", line) },
  { command: "omp_marketplace_remove", args: { name: "m" }, call: (line) => removeOmpMarketplace("m", line) },
  { command: "omp_skills_update", args: {}, call: updateOmpSkills },
];

describe("插件/技能 API", () => {
  it.each(mutations)("$command 传递 camelCase 参数并流式接收日志", async ({ command, args, call }) => {
    mockIPC((cmd, payload) => {
      expect(cmd).toBe(command);
      if (!payload || typeof payload !== "object" || !("onLine" in payload) || !(payload.onLine instanceof Channel)) {
        throw new Error("缺少 onLine Channel");
      }
      expect(payload).toMatchObject(args);
      payload.onLine.onmessage("first");
      payload.onLine.onmessage("second");
      return { output: "first\nsecond\n", changes: [] };
    });
    const onLine = vi.fn();
    expect((await call(onLine)).output).toBe("first\nsecond\n");
    expect(onLine.mock.calls).toEqual([["first"], ["second"]]);
  });

  it.each(["BUSY", "TIMEOUT", "OMP_FAILED", "INVALID_INPUT"])("保留 %s 错误码", async (code) => {
    mockIPC(() => { throw { code, message: "中文错误与输出尾部" }; });
    await expect(updateOmpSkills(vi.fn())).rejects.toEqual({ code, message: "中文错误与输出尾部" });
  });
});
