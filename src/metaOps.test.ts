/** metaOps 单测：整条替换保留其它字段、revision 串行推进、冲突中止。 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { MetaBatchError, applyTag, writeAlias } from "./metaOps";
import { normalizeError } from "./api";
import type { MetaSnapshot } from "./types";

interface MetaCall {
  sessionId: string;
  meta: { alias: string | null; tags: string[]; note: string | null } | null;
  expectedRevision: number;
}

/** 记录 set_session_meta 调用，并按 revision 递增返回新快照。 */
function installMeta(revision = 3): {
  calls: MetaCall[];
  /** 第 n 次（0 起算）写请求返回 CONFLICT。 */
  failOn: (n: number) => void;
} {
  const calls: MetaCall[] = [];
  let current: MetaSnapshot = {
    revision,
    sessions: {
      a: { alias: "旧名", tags: ["bug"], note: "备注 A", updatedAt: "t" },
      b: { alias: null, tags: [], note: "备注 B", updatedAt: "t" },
    },
  };
  let failAt: number | null = null;
  mockIPC((cmd, args) => {
    if (cmd !== "set_session_meta") throw new Error(`未预期的命令：${cmd}`);
    const a = args as unknown as {
      sessionId: string;
      meta: MetaCall["meta"];
      expectedRevision: number;
    };
    if (failAt !== null && calls.length === failAt) {
      throw { code: "CONFLICT", message: "备注已被外部修改" };
    }
    if (a.expectedRevision !== current.revision) {
      throw { code: "CONFLICT", message: "备注已被外部修改" };
    }
    calls.push({ sessionId: a.sessionId, meta: a.meta, expectedRevision: a.expectedRevision });
    current = {
      revision: current.revision + 1,
      sessions: {
        ...current.sessions,
        [a.sessionId]: {
          alias: a.meta?.alias ?? null,
          tags: a.meta?.tags ?? [],
          note: a.meta?.note ?? null,
          updatedAt: "t2",
        },
      },
    };
    return current;
  });
  return {
    calls,
    failOn: (n: number) => {
      failAt = n;
    },
  };
}

const base: MetaSnapshot = {
  revision: 3,
  sessions: {
    a: { alias: "旧名", tags: ["bug"], note: "备注 A", updatedAt: "t" },
    b: { alias: null, tags: [], note: "备注 B", updatedAt: "t" },
  },
};

beforeEach(() => clearMocks());

describe("writeAlias", () => {
  it("只改别名，标签与备注按原值回传", async () => {
    const spy = installMeta();
    const next = await writeAlias(base, "a", "新名");
    expect(spy.calls).toEqual([
      {
        sessionId: "a",
        meta: { alias: "新名", tags: ["bug"], note: "备注 A" },
        expectedRevision: 3,
      },
    ]);
    expect(next.revision).toBe(4);
    expect(next.sessions.a.alias).toBe("新名");
  });

  it("空字符串清除别名", async () => {
    const spy = installMeta();
    await writeAlias(base, "a", "   ");
    expect(spy.calls[0].meta?.alias).toBeNull();
  });
});

describe("applyTag", () => {
  it("串行写入时 expectedRevision 逐次递增，其它字段保持原值", async () => {
    const spy = installMeta();
    const result = await applyTag(base, ["a", "b"], "高优", true);
    expect(spy.calls.map((c) => c.expectedRevision)).toEqual([3, 4]);
    expect(spy.calls[0].meta).toEqual({ alias: "旧名", tags: ["bug", "高优"], note: "备注 A" });
    expect(spy.calls[1].meta).toEqual({ alias: null, tags: ["高优"], note: "备注 B" });
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.snapshot.revision).toBe(5);
  });

  it("已存在的标签（大小写不敏感）跳过，不发起写入", async () => {
    const spy = installMeta();
    const result = await applyTag(base, ["a"], "BUG", true);
    expect(spy.calls).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
  });

  it("已满 10 个标签的会话跳过加标签", async () => {
    const full: MetaSnapshot = {
      revision: 0,
      sessions: {
        a: {
          alias: null,
          tags: Array.from({ length: 10 }, (_, i) => `t${i}`),
          note: null,
          updatedAt: "t",
        },
      },
    };
    const spy = installMeta(0);
    const result = await applyTag(full, ["a"], "新标签", true);
    expect(spy.calls).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("移除标签会保留其它标签与备注", async () => {
    const spy = installMeta();
    await applyTag(base, ["a"], "Bug", false);
    expect(spy.calls[0].meta).toEqual({ alias: "旧名", tags: [], note: "备注 A" });
  });

  it("第二次写返回 CONFLICT 时抛 MetaBatchError，updated 为 1", async () => {
    const spy = installMeta();
    // 第一次写成功，第二次冲突。
    spy.failOn(1);
    const err = await applyTag(base, ["a", "b"], "高优", true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaBatchError);
    const batch = err as MetaBatchError;
    expect(batch.updated).toBe(1);
    expect(normalizeError(batch.cause).code).toBe("CONFLICT");
    // 快照是最后一次**成功**写入的结果。
    expect(batch.snapshot.sessions.a.tags).toContain("高优");
  });
});
