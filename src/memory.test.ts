/** 记忆库 API 封装与 dev mock 语义：不可用状态、不可读库、通配符字面搜索、分页、截断、补零。 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { memoryBackups, memoryBankStatus, memoryDeleteBackup, memoryDeleteBank, memoryDeleteItems, memoryDeletePreview, memoryDetail, memoryGrowth, memoryList, memoryOverview, memoryRestore } from "./api";
import { installMockBackend } from "./dev/mockBackend";

async function mockWith(search: string) {
  window.history.replaceState({}, "", search);
  await installMockBackend();
}

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("memory API 封装", () => {
  it("四个命令按契约传 camelCase 参数并补齐默认值", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "memory_overview") {
        return { available: true, backend: "mnemopi", root: "/r", banks: [], totals: {} };
      }
      if (cmd === "memory_list") return { total: 0, items: [] };
      if (cmd === "memory_detail") return { id: "x" };
      return [];
    });
    await memoryOverview();
    await memoryList({ bank: "b" });
    await memoryDetail({ bank: "b", id: "x" });
    await memoryGrowth({ days: 30 });
    expect(calls).toEqual([
      ["memory_overview", {}],
      [
        "memory_list",
        {
          bank: "b",
          query: null,
          kind: "all",
          onlyNeverRecalled: false,
          onlyUnconsolidated: false,
          onlyMissingSource: false,
          sort: "newest",
          limit: 50,
          offset: 0,
        },
      ],
      ["memory_detail", { bank: "b", id: "x" }],
      ["memory_growth", { bank: null, days: 30 }],
    ]);
  });

  it("七个写命令按扁平 camelCase 传参", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "memory_backups") return [];
      if (cmd === "memory_delete_backup") return null;
      return {};
    });
    await memoryBankStatus({ bank: "b" });
    await memoryBackups({});
    await memoryBackups({ bank: "b" });
    await memoryDeletePreview({ bank: "b", ids: ["a", "a"] });
    await memoryDeleteItems({ bank: "b", ids: ["a"] });
    await memoryDeleteBank({ bank: "b" });
    await memoryRestore({ backupId: "b@20250101T000000Z-before-delete" });
    await memoryDeleteBackup({ backupId: "b@20250101T000000Z-before-delete" });
    expect(calls).toEqual([
      ["memory_bank_status", { bank: "b" }],
      ["memory_backups", { bank: null }],
      ["memory_backups", { bank: "b" }],
      ["memory_delete_preview", { bank: "b", ids: ["a", "a"] }],
      ["memory_delete_items", { bank: "b", ids: ["a"] }],
      ["memory_delete_bank", { bank: "b" }],
      ["memory_restore", { backupId: "b@20250101T000000Z-before-delete" }],
      ["memory_delete_backup", { backupId: "b@20250101T000000Z-before-delete" }],
    ]);
  });

  it("显式过滤条件原样透传", async () => {
    let seen: Record<string, unknown> | null = null;
    mockIPC((cmd, args) => {
      if (cmd === "memory_list") seen = args as Record<string, unknown>;
      return { total: 0, items: [] };
    });
    await memoryList({
      bank: "b",
      query: "缓存",
      kind: "episodic",
      onlyNeverRecalled: true,
      onlyUnconsolidated: true,
      onlyMissingSource: true,
      sort: "mostRecalled",
      limit: 200,
      offset: 50,
    });
    expect(seen).toEqual({
      bank: "b",
      query: "缓存",
      kind: "episodic",
      onlyNeverRecalled: true,
      onlyUnconsolidated: true,
      onlyMissingSource: true,
      sort: "mostRecalled",
      limit: 200,
      offset: 50,
    });
  });
});

describe("memory mock 数据", () => {
  it("默认可用，覆盖空库 / 目录已删 / 不可读", async () => {
    await mockWith("/?mock=1");
    const o = await memoryOverview();
    expect(o.available).toBe(true);
    expect(o.backend).toBe("mnemopi");
    expect(o.banks.length).toBeGreaterThanOrEqual(5);
    expect(o.banks.find((b) => b.bank === "empty-proj")?.working).toBe(0);
    expect(o.banks.find((b) => b.bank === "gone-proj")?.cwdExists).toBe(false);
    const locked = o.banks.find((b) => b.bank === "locked-proj");
    expect(locked?.readable).toBe(false);
    expect(locked?.error).toBeTruthy();
    expect(o.totals.working + o.totals.episodic).toBeGreaterThan(100);
  });

  it("?memory=off 返回 available:false 且不报错", async () => {
    await mockWith("/?mock=1&memory=off");
    const o = await memoryOverview();
    expect(o.available).toBe(false);
    expect(o.banks).toEqual([]);
    expect(o.totals.banks).toBe(0);
  });

  it("不可读库的列表与详情报 IO，未知库报 NOT_FOUND", async () => {
    await mockWith("/?mock=1");
    await expect(memoryList({ bank: "locked-proj" })).rejects.toMatchObject({ code: "IO" });
    await expect(memoryDetail({ bank: "locked-proj", id: "x" })).rejects.toMatchObject({ code: "IO" });
    await expect(memoryList({ bank: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("通配符按字面搜索，不会匹配全部", async () => {
    await mockWith("/?mock=1");
    const percent = await memoryList({ bank: "omp-resume", query: "%" });
    expect(percent.total).toBe(1);
    expect(percent.items[0].snippet).toContain("100%");
    const underscore = await memoryList({ bank: "omp-resume", query: "_" });
    expect(underscore.total).toBe(1);
    expect(underscore.items[0].snippet).toContain("snake_case");
  });

  it("分页与排序", async () => {
    await mockWith("/?mock=1");
    const first = await memoryList({ bank: "omp-resume", limit: 50 });
    expect(first.total).toBeGreaterThanOrEqual(120);
    expect(first.items.length).toBe(50);
    const rest = await memoryList({ bank: "omp-resume", limit: 200, offset: 100 });
    expect(rest.items.length).toBe(first.total - 100);
    const recalled = await memoryList({ bank: "omp-resume", sort: "mostRecalled", limit: 5 });
    const counts = recalled.items.map((m) => m.recallCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const newest = await memoryList({ bank: "omp-resume", limit: 5 });
    const times = newest.items.map((m) => Date.parse(m.createdAt ?? ""));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("30KB 条目未超上限；超过 200KB 的条目截断并标注", async () => {
    await mockWith("/?mock=1");
    const long = await memoryList({ bank: "omp-resume", query: "很长的合成记忆", limit: 5 });
    expect(long.items.length).toBe(1);
    const full = await memoryDetail({ bank: "omp-resume", id: long.items[0].id });
    expect(full.truncated).toBe(false);
    expect(full.content.length).toBe(30 * 1024);

    const capped = await memoryList({ bank: "omp-resume", query: "超过上限的合成记忆", limit: 5 });
    expect(capped.items.length).toBe(1);
    const cut = await memoryDetail({ bank: "omp-resume", id: capped.items[0].id });
    expect(cut.truncated).toBe(true);
    expect(cut.content.length).toBe(200 * 1024);
    expect(cut.contentChars).toBe(210 * 1024);
  });

  it("增长按本地日补零且支持单库范围", async () => {
    await mockWith("/?mock=1");
    const all = await memoryGrowth({ days: 30 });
    expect(all.length).toBe(30);
    expect(all.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))).toBe(true);
    expect(all.reduce((n, p) => n + p.working + p.episodic, 0)).toBeGreaterThan(0);
    const emptyRange = await memoryGrowth({ bank: "empty-proj", days: 7 });
    expect(emptyRange.length).toBe(7);
    expect(emptyRange.every((p) => p.working === 0 && p.episodic === 0)).toBe(true);
    const scoped = await memoryGrowth({ bank: "omp-resume", days: 365 });
    const allLong = await memoryGrowth({ days: 365 });
    expect(scoped.reduce((n, p) => n + p.working, 0)).toBeLessThan(allLong.reduce((n, p) => n + p.working, 0));
  });

  it("?fail=memory_list 生效", async () => {
    await mockWith("/?mock=1&fail=memory_list");
    await expect(memoryList({ bank: "omp-resume" })).rejects.toMatchObject({ code: "IO" });
  });
});

describe("memory mock 写操作（有状态）", () => {
  it("预览与删除数字一致，删除后总览/列表/增长同步减少", async () => {
    await mockWith("/?mock=1");
    const before = await memoryList({ bank: "notes-app", limit: 50 });
    expect(before.total).toBe(8);
    const ids = before.items.slice(0, 3).map((m) => m.id);
    const preview = await memoryDeletePreview({ bank: "notes-app", ids });
    expect(preview.requested).toBe(3);
    expect(preview.deletable.working + preview.deletable.episodic).toBe(3);
    expect(preview.notFound).toBe(0);
    const result = await memoryDeleteItems({ bank: "notes-app", ids });
    expect(result.deleted).toEqual(ids);
    expect(result.skipped).toEqual([]);
    expect(result.backup.kind).toBe("before-delete");
    expect(result.backup.working).toBe(4);
    const after = await memoryList({ bank: "notes-app", limit: 50 });
    expect(after.total).toBe(5);
    const overview = await memoryOverview();
    const notes = overview.banks.find((b) => b.bank === "notes-app");
    expect((notes?.working ?? 0) + (notes?.episodic ?? 0)).toBe(5);
    const growth = await memoryGrowth({ bank: "notes-app", days: 365 });
    expect(growth.reduce((n, p) => n + p.working + p.episodic, 0)).toBe(5);
  });

  it("全不可删时报 INVALID_INPUT 且不创建备份", async () => {
    await mockWith("/?mock=1");
    await expect(memoryDeleteItems({ bank: "notes-app", ids: ["mem-ghost-1", "mem-ghost-2"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await memoryBackups({ bank: "notes-app" })).toEqual([]);
  });

  it("ids 去重保序；不存在的 id 走 skipped；空与超限报 INVALID_INPUT", async () => {
    await mockWith("/?mock=1");
    const page = await memoryList({ bank: "notes-app", limit: 50 });
    const a = page.items[0].id;
    const b = page.items[1].id;
    const preview = await memoryDeletePreview({ bank: "notes-app", ids: [b, a, b, "mem-ghost-1"] });
    expect(preview.requested).toBe(3);
    expect(preview.notFound).toBe(1);
    const result = await memoryDeleteItems({ bank: "notes-app", ids: [b, a, b, "mem-ghost-1"] });
    expect(result.deleted).toEqual([b, a]);
    expect(result.skipped).toEqual([{ id: "mem-ghost-1", reason: "not_found" }]);
    await expect(memoryDeletePreview({ bank: "notes-app", ids: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(memoryDeleteItems({ bank: "notes-app", ids: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      memoryDeleteItems({ bank: "notes-app", ids: Array.from({ length: 501 }, (_, i) => `x-${i}`) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("删库后总览不再列出该库，恢复后条数回来且带安全备份", async () => {
    await mockWith("/?mock=1");
    const removed = await memoryDeleteBank({ bank: "notes-app" });
    expect(removed.kind).toBe("bank-removed");
    expect(await memoryOverview().then((o) => o.banks.some((b) => b.bank === "notes-app"))).toBe(false);
    await expect(memoryList({ bank: "notes-app" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const restored = await memoryRestore({ backupId: removed.id });
    expect(restored.bank).toBe("notes-app");
    expect(restored.safetyBackup).toBeNull();
    const overview = await memoryOverview();
    const notes = overview.banks.find((b) => b.bank === "notes-app");
    expect((notes?.working ?? 0) + (notes?.episodic ?? 0)).toBe(8);
  });

  it("恢复现存库会先建恢复前安全备份，恢复内容等于快照", async () => {
    await mockWith("/?mock=1");
    const page = await memoryList({ bank: "notes-app", limit: 50 });
    const first = await memoryDeleteItems({ bank: "notes-app", ids: [page.items[0].id] });
    expect((await memoryList({ bank: "notes-app", limit: 50 })).total).toBe(7);
    const restored = await memoryRestore({ backupId: first.backup.id });
    expect(restored.restoredFrom.id).toBe(first.backup.id);
    expect(restored.safetyBackup?.kind).toBe("before-restore");
    expect((await memoryList({ bank: "notes-app", limit: 50 })).total).toBe(8);
    const backups = await memoryBackups({ bank: "notes-app" });
    expect(backups.map((b) => b.kind)).toEqual(["before-restore", "before-delete"]);
  });

  it("删除前/恢复前备份只留最新 5 份，移除的库备份不剪", async () => {
    await mockWith("/?mock=1");
    const page = await memoryList({ bank: "notes-app", limit: 50 });
    for (const m of page.items.slice(0, 6)) {
      await memoryDeleteItems({ bank: "notes-app", ids: [m.id] });
    }
    const kept = await memoryBackups({ bank: "notes-app" });
    expect(kept.length).toBe(5);
    expect(new Set(kept.map((b) => b.id)).size).toBe(5);
    await memoryDeleteBank({ bank: "gone-proj" });
    await memoryDeleteBank({ bank: "home-lab" });
    const removed = await memoryBackups({});
    expect(removed.filter((b) => b.kind === "bank-removed").length).toBe(2);
  });

  it("备份列表 newest first 且支持按库过滤；永久删除后再次删报 NOT_FOUND", async () => {
    await mockWith("/?mock=1");
    const page = await memoryList({ bank: "notes-app", limit: 50 });
    const first = await memoryDeleteItems({ bank: "notes-app", ids: [page.items[0].id] });
    const gone = await memoryList({ bank: "gone-proj", limit: 50 });
    const second = await memoryDeleteItems({ bank: "gone-proj", ids: [gone.items[0].id] });
    const all = await memoryBackups({});
    expect(all.map((b) => b.id)).toEqual([second.backup.id, first.backup.id]);
    expect((await memoryBackups({ bank: "notes-app" })).map((b) => b.id)).toEqual([first.backup.id]);
    await memoryDeleteBackup({ backupId: first.backup.id });
    expect((await memoryBackups({ bank: "notes-app" })).length).toBe(0);
    await expect(memoryDeleteBackup({ backupId: first.backup.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(memoryRestore({ backupId: first.backup.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("backupId 形状非法报 OUTSIDE_ROOT", async () => {
    await mockWith("/?mock=1");
    await expect(memoryRestore({ backupId: "no-at-sign" })).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    await expect(memoryRestore({ backupId: "../x@20250101T000000Z-before-delete" })).rejects.toMatchObject({
      code: "OUTSIDE_ROOT",
    });
    await expect(memoryDeleteBackup({ backupId: "b@bad-dirname" })).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
  });

  it("?memoryInUse 报占用并阻塞写操作，?memoryProbe=fail 报探测失败", async () => {
    await mockWith("/?mock=1&memoryInUse=notes-app");
    const status = await memoryBankStatus({ bank: "notes-app" });
    expect(status.inUse).toBe(true);
    expect(status.holders).toEqual([{ pid: 4242, command: "omp" }]);
    const other = await memoryBankStatus({ bank: "gone-proj" });
    expect(other.inUse).toBe(false);
    const page = await memoryList({ bank: "notes-app", limit: 5 });
    await expect(memoryDeleteItems({ bank: "notes-app", ids: [page.items[0].id] })).rejects.toMatchObject({
      code: "IN_USE",
    });
    await expect(memoryDeleteBank({ bank: "notes-app" })).rejects.toMatchObject({ code: "IN_USE" });
    expect((await memoryList({ bank: "notes-app", limit: 50 })).total).toBe(8);
  });

  it("?memoryProbe=fail 时状态报 probeFailed 且写操作全部拒绝", async () => {
    await mockWith("/?mock=1&memoryProbe=fail");
    const status = await memoryBankStatus({ bank: "notes-app" });
    expect(status.probeFailed).toBe(true);
    expect(status.inUse).toBe(false);
    const page = await memoryList({ bank: "notes-app", limit: 5 });
    await expect(memoryDeleteItems({ bank: "notes-app", ids: [page.items[0].id] })).rejects.toMatchObject({
      code: "PROBE_FAILED",
    });
    await expect(memoryDeleteBank({ bank: "notes-app" })).rejects.toMatchObject({ code: "PROBE_FAILED" });
  });

  it("?fail 对写命令同样生效", async () => {
    await mockWith("/?mock=1&fail=memory_delete_items,memory_bank_status");
    const page = await memoryList({ bank: "notes-app", limit: 5 });
    await expect(memoryDeletePreview({ bank: "notes-app", ids: [page.items[0].id] })).resolves.toBeTruthy();
    await expect(memoryDeleteItems({ bank: "notes-app", ids: [page.items[0].id] })).rejects.toMatchObject({ code: "IO" });
    await expect(memoryBankStatus({ bank: "notes-app" })).rejects.toMatchObject({ code: "IO" });
  });
});
