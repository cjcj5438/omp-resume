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

beforeEach(() => {
  clearMocks();
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
