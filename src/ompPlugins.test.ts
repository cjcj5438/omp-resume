import { beforeEach, describe, expect, it, vi } from "vitest";
import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  addOmpMarketplace, discoverOmpPlugins, installOmpPlugin, listOmpPlugins, listOmpSkills,
  removeOmpMarketplace, setOmpPluginEnabled, uninstallOmpPlugin, updateOmpMarketplaces,
  updateOmpSkills, upgradeOmpPlugins,
} from "./api";
import { installMockBackend, streamedOutput } from "./dev/mockBackend";
import type { OmpOpResult } from "./types";

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
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

  it("三个只读 wrapper 不传 Channel", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "omp_plugins_list") return { plugins: [], npm: [], marketplaces: [], warnings: [] };
      if (cmd === "omp_skills_list") return { skills: [], warnings: [] };
      return [];
    });
    await listOmpPlugins();
    await discoverOmpPlugins("m");
    await listOmpSkills();
    expect(calls).toEqual([
      ["omp_plugins_list", {}],
      ["omp_plugin_discover", { marketplace: "m" }],
      ["omp_skills_list", {}],
    ]);
  });

  it("有状态 mock 覆盖安装、开关、升级、删除及技能来源隔离", async () => {
    await installMockBackend();
    expect((await listOmpPlugins()).plugins).toHaveLength(2);
    await addOmpMarketplace("/tmp/new-mkt", vi.fn());
    const discovered = await discoverOmpPlugins("new-mkt");
    expect(discovered[0]?.name).toBe("hello-plugin");
    const id = "hello-plugin@new-mkt";
    const onLine = vi.fn();
    await installOmpPlugin(id, onLine);
    await setOmpPluginEnabled(id, false, onLine);
    expect((await listOmpPlugins()).plugins.find((plugin) => plugin.id === id)?.enabled).toBe(false);
    await setOmpPluginEnabled(id, true, onLine);
    await updateOmpMarketplaces("new-mkt", onLine);
    const upgraded = await upgradeOmpPlugins(id, onLine);
    expect(upgraded.changes).toEqual([{ id, scope: "user", from: "1.0.0", to: "2.0.0" }]);
    expect((await upgradeOmpPlugins(id, onLine)).changes).toEqual([]);
    expect(onLine).toHaveBeenCalled();
    await uninstallOmpPlugin(id, onLine);
    await removeOmpMarketplace("new-mkt", onLine);
    const result = await listOmpPlugins();
    expect(result.plugins.some((plugin) => plugin.id === id)).toBe(false);
    expect(result.marketplaces.some((marketplace) => marketplace.name === "new-mkt")).toBe(false);
    const before = await listOmpSkills();
    await updateOmpSkills(onLine);
    const after = await listOmpSkills();
    expect(after.skills.find((skill) => skill.source === "agents:user")).toEqual(before.skills.find((skill) => skill.source === "agents:user"));
    expect(after.skills.find((skill) => skill.source === "registry")?.description).toContain("已更新");
  });

  it("mock 支持 ?fail=<cmd>", async () => {
    window.history.replaceState({}, "", "/?mock&fail=omp_skills_update");
    await installMockBackend();
    await expect(updateOmpSkills(vi.fn())).rejects.toEqual({ code: "IO", message: "mock 强制失败：omp_skills_update" });
  });

  it("未知 marketplace/插件报 OMP_FAILED（与真后端一致）", async () => {
    await installMockBackend();
    await expect(discoverOmpPlugins("no-such-mkt")).rejects.toEqual({
      code: "OMP_FAILED",
      message: "marketplace 不存在",
    });
    await expect(setOmpPluginEnabled("nope@probe-mkt", false, vi.fn())).rejects.toEqual({
      code: "OMP_FAILED",
      message: "插件不存在",
    });
    await expect(removeOmpMarketplace("no-such-mkt", vi.fn())).rejects.toEqual({
      code: "OMP_FAILED",
      message: "marketplace 不存在",
    });
  });

  it("空输出投递零行而非一行空字符串", async () => {
    await installMockBackend();
    const onEmpty = vi.fn();
    const emptyChannel = new Channel<string>();
    emptyChannel.onmessage = onEmpty;
    expect(streamedOutput({ onLine: emptyChannel }, "").output).toBe("");
    expect(onEmpty).not.toHaveBeenCalled();
    const onLines = vi.fn();
    const channel = new Channel<string>();
    channel.onmessage = onLines;
    expect(streamedOutput({ onLine: channel }, "a\nb\n").output).toBe("a\nb\n");
    expect(onLines.mock.calls).toEqual([["a"], ["b"]]);
  });
});
