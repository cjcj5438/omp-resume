/** 批量恢复规划单测：跳过口径、超限、格式不支持仍可打开。 */
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "./types";
import { MAX_BULK_RESUME, planBulkResume } from "./bulkResume";

function s(over: Partial<SessionSummary> & { path: string }): SessionSummary {
  return {
    id: over.path,
    cwd: "/w/p",
    cwdExists: true,
    title: "t",
    createdAt: "2026-10-14T00:00:00.000Z",
    modifiedAt: "2026-10-14T00:00:00.000Z",
    sizeBytes: 1,
    messageCount: 1,
    branchCount: 1,
    inUse: false,
    probeOk: true,
    occupant: null,
    fork: null,
    formatSupported: true,
    version: 3,
    badLines: 0,
    firstUserMessage: null,
    ...over,
  };
}

describe("planBulkResume", () => {
  it("使用中和目录不存在被跳过并注明原因", () => {
    const plan = planBulkResume([
      s({ path: "/p/ok.jsonl" }),
      s({ path: "/p/busy.jsonl", inUse: true }),
      s({ path: "/p/gone.jsonl", cwdExists: false }),
    ]);
    expect(plan.open.map((x) => x.path)).toEqual(["/p/ok.jsonl"]);
    expect(plan.skipped.map((x) => [x.s.path, x.reason])).toEqual([
      ["/p/busy.jsonl", "使用中"],
      ["/p/gone.jsonl", "目录不存在"],
    ]);
    expect(plan.overLimit).toEqual([]);
  });

  it("第 11 个起进入 overLimit，保持输入顺序", () => {
    const targets = Array.from({ length: MAX_BULK_RESUME + 3 }, (_, i) => s({ path: `/p/${i}.jsonl` }));
    const plan = planBulkResume(targets);
    expect(plan.open).toHaveLength(MAX_BULK_RESUME);
    expect(plan.open.map((x) => x.path)).toEqual(targets.slice(0, MAX_BULK_RESUME).map((x) => x.path));
    expect(plan.overLimit.map((x) => x.path)).toEqual([`/p/${MAX_BULK_RESUME}.jsonl`, `/p/${MAX_BULK_RESUME + 1}.jsonl`, `/p/${MAX_BULK_RESUME + 2}.jsonl`]);
    expect(plan.skipped).toEqual([]);
  });

  it("格式不支持仍可打开", () => {
    const plan = planBulkResume([s({ path: "/p/old.jsonl", formatSupported: false })]);
    expect(plan.open.map((x) => x.path)).toEqual(["/p/old.jsonl"]);
    expect(plan.skipped).toEqual([]);
  });
});
