import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { getConfig, normalizeError } from "./api";

describe("normalizeError", () => {
  it("透传后端 AppError", () => {
    expect(normalizeError({ code: "IN_USE", message: "占用" })).toEqual({
      code: "IN_USE",
      message: "占用",
    });
  });

  it("未知 code 降级为 UNKNOWN", () => {
    expect(normalizeError({ code: "NOPE", message: "x" }).code).toBe("UNKNOWN");
  });

  it("字符串与 Error 对象归一化", () => {
    expect(normalizeError("boom")).toEqual({ code: "UNKNOWN", message: "boom" });
    expect(normalizeError(new Error("bad"))).toEqual({
      code: "UNKNOWN",
      message: "bad",
    });
  });
});

describe("命令封装", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("getConfig 透传返回值", async () => {
    const dirs = { sessionsDir: "/s", ownersDir: "/o" };
    mockIPC((cmd) => {
      if (cmd === "get_config") return dirs;
    });
    await expect(getConfig()).resolves.toEqual(dirs);
  });

  it("后端错误归一化为 AppError", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_config") throw { code: "IO", message: "读失败" };
    });
    await expect(getConfig()).rejects.toEqual({ code: "IO", message: "读失败" });
  });

  it("未 mock 的命令按字符串错误归一化", async () => {
    const spy = vi.fn();
    mockIPC((cmd) => {
      spy(cmd);
      throw `no handler for ${cmd}`;
    });
    await expect(getConfig()).rejects.toEqual({
      code: "UNKNOWN",
      message: "no handler for get_config",
    });
    expect(spy).toHaveBeenCalledWith("get_config");
  });
});
