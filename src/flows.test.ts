/**
 * 删除计划与「从此节点继续」编排单测。
 */
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "./types";
import { planDelete, runContinueFromNode, type ContinueDeps } from "./flows";

function summary(path: string, inUse: boolean): SessionSummary {
  return {
    id: path,
    path,
    cwd: "/w/p",
    cwdExists: true,
    title: path,
    createdAt: "2026-10-14T00:00:00.000Z",
    modifiedAt: "2026-10-14T00:00:00.000Z",
    sizeBytes: 1,
    messageCount: 1,
    branchCount: 1,
    inUse,
    probeOk: true,
    fork: null,
    formatSupported: true,
    version: 3,
    badLines: 0,
    firstUserMessage: null,
  };
}

describe("planDelete", () => {
  it("跳过 inUse 会话，其余进入待删列表", () => {
    const byPath = new Map([
      ["/s/a.jsonl", summary("/s/a.jsonl", true)],
      ["/s/b.jsonl", summary("/s/b.jsonl", false)],
      ["/s/c.jsonl", summary("/s/c.jsonl", true)],
    ]);
    const plan = planDelete(byPath, ["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl"]);
    expect(plan.deletable).toEqual(["/s/b.jsonl"]);
    expect(plan.skippedInUse).toEqual(["/s/a.jsonl", "/s/c.jsonl"]);
  });

  it("全部在用时 deletable 为空（确认按钮应禁用）", () => {
    const byPath = new Map([
      ["/s/a.jsonl", summary("/s/a.jsonl", true)],
      ["/s/b.jsonl", summary("/s/b.jsonl", true)],
    ]);
    const plan = planDelete(byPath, ["/s/a.jsonl", "/s/b.jsonl"]);
    expect(plan.deletable).toEqual([]);
  });
});

describe("runContinueFromNode 编排", () => {
  const recordingDeps = (
    calls: string[],
    over: Partial<ContinueDeps> = {},
  ): ContinueDeps => ({
    appendBranchMarker: async (_p, nodeId) => {
      calls.push(`append:${nodeId}`);
      return "marker-1";
    },
    openInIterm: async () => {
      calls.push("open");
    },
    refresh: async () => {
      calls.push("refresh");
    },
    ...over,
  });

  it("顺序为 append → open → refresh", async () => {
    const calls: string[] = [];
    const out = await runContinueFromNode(recordingDeps(calls), "/s/a.jsonl", "n9");
    expect(calls).toEqual(["append:n9", "open", "refresh"]);
    expect(out.notice).toBeNull();
  });

  it("markerId 为 null：提示但不追加，仍打开 iTerm", async () => {
    const calls: string[] = [];
    const out = await runContinueFromNode(
      recordingDeps(calls, {
        appendBranchMarker: async () => {
          calls.push("append");
          return null;
        },
      }),
      "/s/a.jsonl",
      "n9",
    );
    expect(out.notice).toBe("该节点已是当前位置，未追加标记");
    expect(calls).toEqual(["append", "open", "refresh"]);
  });

  it("append 失败：绝不打开 iTerm，也不刷新", async () => {
    const calls: string[] = [];
    const deps = recordingDeps(calls, {
      appendBranchMarker: async () => {
        calls.push("append");
        throw { code: "IN_USE", message: "会话正被另一个 omp 使用" };
      },
    });
    await expect(runContinueFromNode(deps, "/s/a.jsonl", "n9")).rejects.toEqual({
      code: "IN_USE",
      message: "会话正被另一个 omp 使用",
    });
    expect(calls).toEqual(["append"]);
  });

  it("open 失败：错误说明标记已追加，不回滚", async () => {
    const calls: string[] = [];
    const deps = recordingDeps(calls, {
      openInIterm: async () => {
        calls.push("open");
        throw { code: "ITERM_FAILED", message: "AppleScript 拒绝" };
      },
    });
    await expect(runContinueFromNode(deps, "/s/a.jsonl", "n9")).rejects.toEqual({
      code: "ITERM_FAILED",
      message: "标记已追加，但打开 iTerm 失败：AppleScript 拒绝",
    });
    expect(calls).toEqual(["append:n9", "open"]);
  });
});
