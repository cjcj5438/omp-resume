import { beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  deleteMcpServer,
  getMcpServer,
  listMcp,
  normalizeError,
  saveMcpServer,
  setMcpEnabled,
} from "./api";
import { installMockBackend } from "./dev/mockBackend";

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("MCP 错误码归一化", () => {
  it.each(["INVALID_INPUT", "CONFLICT"])("透传 %s", (code) => {
    expect(normalizeError({ code, message: "中文" })).toEqual({ code, message: "中文" });
  });

  it.each(["INVALID_INPUT", "CONFLICT"])("封装透出 %s", async (code) => {
    mockIPC(() => {
      throw { code, message: "中文错误" };
    });
    await expect(listMcp()).rejects.toEqual({ code, message: "中文错误" });
  });
});

describe("MCP 命令封装", () => {
  it("五个 wrapper 传递 camelCase 参数", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "mcp_list") return { files: [], servers: [] };
      if (cmd === "mcp_get_server") return { config: {}, revision: "r" };
      return { revision: "r2" };
    });
    await listMcp({});
    await getMcpServer({ scope: "user", name: "a" });
    await saveMcpServer({ scope: "user", name: "a", config: {}, expectedRevision: "r" });
    await setMcpEnabled({ scope: "project", project: "/p", name: "a", enabled: false, expectedRevision: "r" });
    await deleteMcpServer({ scope: "user", name: "a", expectedRevision: "r" });
    expect(calls).toEqual([
      ["mcp_list", { project: null }],
      ["mcp_get_server", { scope: "user", project: null, name: "a" }],
      [
        "mcp_save_server",
        { scope: "user", project: null, name: "a", config: {}, expectedRevision: "r", originalName: null },
      ],
      [
        "mcp_set_enabled",
        { scope: "project", project: "/p", name: "a", enabled: false, expectedRevision: "r" },
      ],
      ["mcp_delete_server", { scope: "user", project: null, name: "a", expectedRevision: "r" }],
    ]);
  });
});

describe("MCP 有状态 mock", () => {
  const project = "/Users/chenjing/my/omp-resume";

  it("覆盖 project 同名、disabledServers 与强制启用，列表不泄露 secret 值", async () => {
    await installMockBackend();
    const list = await listMcp({ project });
    expect(list.files.map((file) => file.scope)).toEqual(["user", "project"]);
    const byKey = new Map(list.servers.map((server) => [`${server.scope}:${server.name}`, server]));
    expect(byKey.get("user:shared")).toMatchObject({ shadowedBy: "project", effective: false });
    expect(byKey.get("project:shared")).toMatchObject({ shadowedBy: null, effective: true });
    expect(byKey.get("user:blocked")).toMatchObject({ shadowedBy: "disabledServers", effective: false });
    expect(byKey.get("user:forced")).toMatchObject({ enabled: false, effective: true, shadowedBy: null });
    expect(byKey.get("user:filesystem")).toMatchObject({
      transport: "stdio",
      argCount: 2,
      envKeys: ["DEMO_TOKEN"],
      hasAuth: false,
    });
    expect(byKey.get("user:blocked")).toMatchObject({ headerKeys: ["Authorization"], hasAuth: true });
    expect(list.files[1]).toMatchObject({ disabledServers: [], enabledServers: [] });
    const serialized = JSON.stringify(list);
    for (const secret of ["mock-env-secret", "mock-header-secret", "mock-oauth-secret", "mock-private-argument", "••••"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("get 返回真实配置；原样回存成功；掩码被拒且文件不变", async () => {
    await installMockBackend();
    const raw = await getMcpServer({ scope: "user", name: "filesystem" });
    expect(raw.config).toMatchObject({ env: { DEMO_TOKEN: "mock-env-secret" } });
    const saved = await saveMcpServer({
      scope: "user",
      name: "filesystem",
      config: raw.config,
      expectedRevision: raw.revision,
    });
    expect(saved.revision).toBe(raw.revision);
    await expect(
      saveMcpServer({
        scope: "user",
        name: "filesystem",
        config: { command: "npx", env: { DEMO_TOKEN: "••••" } },
        expectedRevision: saved.revision,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const after = await getMcpServer({ scope: "user", name: "filesystem" });
    expect(after.config).toMatchObject({ env: { DEMO_TOKEN: "mock-env-secret" } });
    expect(after.revision).toBe(raw.revision);
  });

  it("过期 revision 冲突；开关双向；重命名与删除保留覆盖列表", async () => {
    await installMockBackend();
    const first = await listMcp({ project });
    const stale = first.files[0].revision;
    await setMcpEnabled({ scope: "user", name: "filesystem", enabled: false, expectedRevision: stale });
    await expect(
      setMcpEnabled({ scope: "user", name: "filesystem", enabled: true, expectedRevision: stale }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const disabled = await listMcp({ project });
    expect(disabled.servers.find((server) => server.scope === "user" && server.name === "filesystem")).toMatchObject({
      enabled: false,
      effective: false,
      shadowedBy: "disabled",
    });
    const current = disabled.files[0].revision;
    await setMcpEnabled({ scope: "user", name: "filesystem", enabled: true, expectedRevision: current });
    const enabled = await getMcpServer({ scope: "user", name: "filesystem" });
    expect(enabled.config !== null && typeof enabled.config === "object" && "enabled" in enabled.config).toBe(false);
    await saveMcpServer({
      scope: "user",
      name: "renamed",
      config: { command: "node" },
      expectedRevision: enabled.revision,
      originalName: "filesystem",
    });
    const renamed = await listMcp({});
    expect(renamed.servers.some((server) => server.name === "filesystem")).toBe(false);
    expect(renamed.servers.some((server) => server.name === "renamed")).toBe(true);
    await deleteMcpServer({ scope: "user", name: "renamed", expectedRevision: renamed.files[0].revision });
    const deleted = await listMcp({});
    expect(deleted.servers.some((server) => server.name === "renamed")).toBe(false);
    expect(deleted.files[0]).toMatchObject({ disabledServers: ["blocked"], enabledServers: ["blocked", "forced"] });
  });

  it("项目路径校验与 ?fail=<cmd>", async () => {
    await installMockBackend();
    await expect(listMcp({ project: "relative" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(listMcp({ project: "/Users/chenjing" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(getMcpServer({ scope: "project", name: "x" })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    clearMocks();
    window.history.replaceState({}, "", "/?mock&fail=mcp_list");
    await installMockBackend();
    await expect(listMcp({})).rejects.toEqual({ code: "IO", message: "mock 强制失败：mcp_list" });
  });
});
