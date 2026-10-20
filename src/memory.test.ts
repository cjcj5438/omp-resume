/** dev memory mock 语义：数据集、不可读、通配符、分页排序、截断、补零、写操作往返与门禁。 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import {
  memoryBackups,
  memoryBankStatus,
  memoryDeleteBackup,
  memoryDeleteBank,
  memoryDeleteItems,
  memoryDeletePreview,
  memoryDetail,
  memoryList,
  memoryOverview,
  memoryRestore,
} from "./api";
import { installMockBackend } from "./dev/mockBackend";
import { BULK_IN_USE_BANK } from "./dev/memoryMock";

async function mockWith(search: string): Promise<void> {
  window.history.replaceState({}, "", search);
  await installMockBackend();
}

const idsOf = async (bank: string, limit = 50): Promise<string[]> => (await memoryList({ bank, limit })).items.map((m) => m.id);

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("数据集", () => {
  it("默认覆盖空库 / 目录已删 / 不可读；?memory=off 平和降级；?memoryBanks=37 生成批量库", async () => {
    await mockWith("/?mock=1");
    const o = await memoryOverview();
    const byBank = new Map(o.banks.map((b) => [b.bank, b]));
    expect(byBank.get("empty-proj")?.working).toBe(0);
    expect(byBank.get("gone-proj")?.cwdExists).toBe(false);
    expect(byBank.get("locked-proj")?.readable).toBe(false);
    expect(o.totals.working + o.totals.episodic).toBeGreaterThan(100);

    await mockWith("/?mock=1&memory=off");
    const off = await memoryOverview();
    expect(off).toMatchObject({ available: false, banks: [] });
    expect(off.totals.banks).toBe(0);

    await mockWith("/?mock=1&memoryBanks=37");
    const many = await memoryOverview();
    expect(many.banks.length).toBe(42);
    const bulk = many.banks.filter((b) => b.bank.startsWith("bulk-"));
    expect(bulk.length).toBe(37);
    const sizes = bulk.map((b) => b.working + b.episodic);
    expect(Math.max(...sizes)).toBeGreaterThan(100);
    expect(sizes).toContain(0);
    expect(bulk.filter((b) => b.cwdExists === false).length).toBe(3);
    expect(bulk.filter((b) => !b.readable).length).toBe(1);
    const status = await memoryBankStatus({ bank: BULK_IN_USE_BANK });
    expect(status.inUse).toBe(true);
    await expect(memoryDeleteBank({ bank: BULK_IN_USE_BANK })).rejects.toMatchObject({ code: "IN_USE" });
  });

  it("不可读库报 IO，未知库报 NOT_FOUND，?fail 生效", async () => {
    await mockWith("/?mock=1");
    await expect(memoryList({ bank: "locked-proj" })).rejects.toMatchObject({ code: "IO" });
    await expect(memoryDetail({ bank: "locked-proj", id: "x" })).rejects.toMatchObject({ code: "IO" });
    await expect(memoryList({ bank: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await mockWith("/?mock=1&fail=memory_list");
    await expect(memoryList({ bank: "omp-resume" })).rejects.toMatchObject({ code: "IO" });
  });

  it("搜索按字面匹配通配符，分页与排序遵守契约", async () => {
    await mockWith("/?mock=1");
    expect((await memoryList({ bank: "omp-resume", query: "%", limit: 200 })).total).toBe(1);
    expect((await memoryList({ bank: "omp-resume", query: "_", limit: 200 })).total).toBe(1);
    const first = await memoryList({ bank: "omp-resume", limit: 5 });
    const second = await memoryList({ bank: "omp-resume", limit: 5, offset: 5 });
    expect(first.items).toHaveLength(5);
    expect(first.items.some((m) => second.items.some((n) => n.id === m.id))).toBe(false);
    const byRecalls = await memoryList({ bank: "omp-resume", sort: "mostRecalled", limit: 200 });
    const counts = byRecalls.items.map((m) => m.recallCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const oldest = await memoryList({ bank: "omp-resume", sort: "oldest", limit: 200 });
    const times = oldest.items.map((m) => Date.parse(m.createdAt ?? ""));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("超过 200KB 的条目截断并标注", async () => {
    await mockWith("/?mock=1");
    const items = (await memoryList({ bank: "omp-resume", limit: 200 })).items;
    const long = items.find((m) => m.contentChars > 200 * 1024);
    expect(long).toBeDefined();
    const detail = await memoryDetail({ bank: "omp-resume", id: long?.id ?? "" });
    expect(detail.truncated).toBe(true);
    expect(detail.content.length).toBe(200 * 1024);

  });
});

describe("写操作（有状态）", () => {
  it("预览与删除数字一致，删除后总览/列表/增长同步减少", async () => {
    await mockWith("/?mock=1");
    const ids = (await idsOf("notes-app")).slice(0, 3);
    const preview = await memoryDeletePreview({ bank: "notes-app", ids });
    expect(preview).toMatchObject({ requested: 3, notFound: 0 });
    expect(preview.deletable.working + preview.deletable.episodic).toBe(3);
    const result = await memoryDeleteItems({ bank: "notes-app", ids });
    expect(result.deleted).toEqual(ids);
    expect(result.backup.kind).toBe("before-delete");
    expect((await memoryList({ bank: "notes-app" })).total).toBe(5);
    const notes = (await memoryOverview()).banks.find((b) => b.bank === "notes-app");
    expect((notes?.working ?? 0) + (notes?.episodic ?? 0)).toBe(5);
  });

  it("ids 去重保序、跳过不存在的 id；空/超限/全不可删报 INVALID_INPUT 且不建备份", async () => {
    await mockWith("/?mock=1");
    const [a, b] = await idsOf("notes-app");
    const result = await memoryDeleteItems({ bank: "notes-app", ids: [b, a, b, "mem-ghost"] });
    expect(result.deleted).toEqual([b, a]);
    expect(result.skipped).toEqual([{ id: "mem-ghost", reason: "not_found" }]);
    await expect(memoryDeletePreview({ bank: "notes-app", ids: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      memoryDeleteItems({ bank: "notes-app", ids: Array.from({ length: 501 }, (_, i) => `x-${i}`) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(memoryDeleteItems({ bank: "notes-app", ids: ["mem-ghost"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await memoryBackups({ bank: "notes-app" })).toHaveLength(1);
  });

  it("删库后总览不再列出、列表报 NOT_FOUND，恢复后条数回来；现存库恢复带安全备份", async () => {
    await mockWith("/?mock=1");
    const removed = await memoryDeleteBank({ bank: "notes-app" });
    expect(removed.kind).toBe("bank-removed");
    expect((await memoryOverview()).banks.some((b) => b.bank === "notes-app")).toBe(false);
    await expect(memoryList({ bank: "notes-app" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const restored = await memoryRestore({ backupId: removed.id });
    expect(restored).toMatchObject({ bank: "notes-app", safetyBackup: null });
    expect((await memoryList({ bank: "notes-app" })).total).toBe(8);

    const first = await memoryDeleteItems({ bank: "notes-app", ids: [(await idsOf("notes-app"))[0]] });
    const back = await memoryRestore({ backupId: first.backup.id });
    expect(back.safetyBackup?.kind).toBe("before-restore");
    expect((await memoryList({ bank: "notes-app" })).total).toBe(8);
    expect(new Set((await memoryBackups({ bank: "notes-app" })).map((b) => b.kind))).toEqual(
      new Set(["before-restore", "bank-removed", "before-delete"]),
    );
  });

  it("删除前备份只留最新 5 份；备份列表 newest first、可过滤、永久删除后报 NOT_FOUND", async () => {
    await mockWith("/?mock=1");
    for (const id of (await idsOf("notes-app")).slice(0, 6)) {
      await memoryDeleteItems({ bank: "notes-app", ids: [id] });
    }
    expect(await memoryBackups({ bank: "notes-app" })).toHaveLength(5);
    const goneIds = await idsOf("gone-proj");
    await memoryDeleteItems({ bank: "gone-proj", ids: [goneIds[1]] });
    const all = await memoryBackups({});
    const times = all.map((b) => Date.parse(b.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect((await memoryBackups({ bank: "notes-app" })).every((b) => b.bank === "notes-app")).toBe(true);
    const newest = all[0];
    await memoryDeleteBackup({ backupId: newest.id });
    await expect(memoryDeleteBackup({ backupId: newest.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("占用/探测失败阻塞所有写操作", async () => {
    await mockWith("/?mock=1&memoryInUse=notes-app");
    expect((await memoryBankStatus({ bank: "notes-app" })).holders).toEqual([{ pid: 4242, command: "omp" }]);
    expect((await memoryBankStatus({ bank: "gone-proj" })).inUse).toBe(false);
    const ids = await idsOf("notes-app", 5);
    await expect(memoryDeleteItems({ bank: "notes-app", ids: [ids[0]] })).rejects.toMatchObject({ code: "IN_USE" });
    await expect(memoryDeleteBank({ bank: "notes-app" })).rejects.toMatchObject({ code: "IN_USE" });

    await mockWith("/?mock=1&memoryProbe=fail");
    expect((await memoryBankStatus({ bank: "notes-app" })).probeFailed).toBe(true);
    await expect(memoryDeleteBank({ bank: "notes-app" })).rejects.toMatchObject({ code: "PROBE_FAILED" });
  });
});
