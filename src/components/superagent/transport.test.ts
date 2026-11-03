/** transport：SUPERAGENT_UNAVAILABLE → TransportUnavailable，其余错误透传。 */
import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { TransportUnavailable } from "omp-superagent/panel";
import { invokeTransport } from "./transport";

afterEach(() => clearMocks());

describe("invokeTransport", () => {
  it("守护进程不可用时抛 TransportUnavailable（面板显示离线态）", async () => {
    mockIPC((cmd) => {
      if (cmd === "superagent_request") throw { code: "SUPERAGENT_UNAVAILABLE", message: "守护进程未运行" };
      throw `未知命令：${cmd}`;
    });
    const err = await invokeTransport("GET", "state").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportUnavailable);
    expect((err as Error).message).toBe("守护进程未运行");
  });

  it("成功时返回 status + text", async () => {
    mockIPC((cmd) => {
      if (cmd === "superagent_request") return { status: 200, body: '{"ok":true}' };
      throw `未知命令：${cmd}`;
    });
    await expect(invokeTransport("GET", "state")).resolves.toEqual({
      status: 200,
      text: '{"ok":true}',
    });
  });

  it("其他错误码原样透传 AppError", async () => {
    mockIPC((cmd) => {
      if (cmd === "superagent_request") throw { code: "INVALID_INPUT", message: "path 非法" };
      throw `未知命令：${cmd}`;
    });
    const err = await invokeTransport("GET", "../x").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TransportUnavailable);
    expect(err).toEqual({ code: "INVALID_INPUT", message: "path 非法" });
  });
});
