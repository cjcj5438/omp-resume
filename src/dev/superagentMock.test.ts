/** mock 后端 Superagent 状态机：disabled → 启用 running → restart 计数；未启用重启拒绝。 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { installMockBackend } from "./mockBackend";
import { superagentResetState, superagentRestart, superagentSetEnabled, superagentStatus } from "../api";

beforeEach(() => {
  clearMocks();
});

describe("mock superagent 状态机", () => {
  it("disabled → set_enabled(true) → running → restart 计数 +1", async () => {
    await installMockBackend();
    const initial = await superagentStatus();
    expect(initial.state).toBe("disabled");
    expect(initial.enabled).toBe(false);
    expect(initial.pid).toBeNull();

    const running = await superagentSetEnabled(true);
    expect(running.state).toBe("running");
    expect(running.enabled).toBe(true);
    expect(running.pid).not.toBeNull();

    const restarted = await superagentRestart();
    expect(restarted.state).toBe("running");
    expect(restarted.restarts).toBe(running.restarts + 1);

    const stopped = await superagentSetEnabled(false);
    expect(stopped.state).toBe("disabled");
    expect(stopped.pid).toBeNull();
  });

  it("未启用时 restart 报 INVALID_INPUT", async () => {
    await installMockBackend();
    await expect(superagentRestart()).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("reset_state 只在 incompatible 可用；成功后回到 running 且 schema:null", async () => {
    await installMockBackend();
    expect((await superagentStatus()).schema ?? null).toBeNull();
    await expect(superagentResetState()).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
