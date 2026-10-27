/** 记忆库维护：多选、删除确认（预览/门禁/错误码）、无效库清理、单库移除、备份恢复。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { MemoryBackup, MemoryBankStatus, MemoryDeletePreview, MemoryDeleteResult, MemoryDetail, MemoryGraph, MemoryOverview, MemoryPage } from "../types";
import { MemoryPanel } from "./MemoryPanel";
import { MemoryDeleteDialog } from "./MemoryDeleteDialog";
import { MemoryList } from "./MemoryList";
import { BANKS, TOTALS, backupOf, bankOf, itemOf as item, overviewOf, pageOf, statusOf } from "./memoryFixtures";

const ITEMS = [item({ id: "m1" }), item({ id: "m2" }), item({ id: "m3" })];
const previewOf = (ids: string[], over: Partial<MemoryDeletePreview> = {}): MemoryDeletePreview => ({
  requested: ids.length,
  deletable: { working: ids.length, episodic: 0 },
  unsupported: 0,
  notFound: 0,
  cascade: { facts: 0, embeddings: 0, annotations: 0, edges: 0, other: 0 },
  citedBySummaries: 0,
  ...over,
});

type Args = Record<string, unknown>;
interface Behavior {
  overview: MemoryOverview;
  loaded: string[];
  list: (args: Args) => MemoryPage | Promise<MemoryPage>;
  detail: (args: Args) => unknown;
  preview: (args: Args) => MemoryDeletePreview | Promise<MemoryDeletePreview>;
  deleteItems: (args: Args) => MemoryDeleteResult | Promise<MemoryDeleteResult>;
  status: (args: Args) => MemoryBankStatus | Promise<MemoryBankStatus>;
  backups: (args: Args) => MemoryBackup[] | Promise<MemoryBackup[]>;
  restore: (args: Args) => unknown;
  deleteBackup: (args: Args) => null | Promise<null>;
  deleteBank: (args: Args) => unknown;
  graph: (args: Args) => MemoryGraph;
}

/** 关系图夹具：两条记忆一条摘要边，够点选与 Esc 验证。 */
const GRAPH: MemoryGraph = {
  nodes: [
    { id: "m1", kind: "working", snippet: "片段 m1", createdAt: "2026-10-18T10:00:00.000Z", recallCount: 1, importance: null, degree: 1 },
    { id: "m2", kind: "episodic", snippet: "片段 m2", createdAt: "2026-10-18T09:00:00.000Z", recallCount: 0, importance: null, degree: 1 },
  ],
  edges: [{ source: "m2", target: "m1", kind: "summary" }],
  truncated: false,
  totalNodes: 2,
  totalEdges: 1,
  unlinkedCount: 0,
};

function renderPanel(over: Partial<Behavior> = {}) {
  const calls = {
    overview: 0, list: [] as Args[], preview: [] as Args[], deleteItems: [] as Args[], status: [] as Args[],
    detail: [] as Args[], backups: [] as Args[], restore: [] as Args[], deleteBackup: [] as Args[], deleteBank: [] as Args[],
  };
  const behavior: Behavior = {
    overview: overviewOf(),
    loaded: [],
    list: () => pageOf(ITEMS),
    detail: (args) => {
      const found = ITEMS.find((m) => m.id === args["id"]);
      if (!found) throw { code: "NOT_FOUND", message: "记忆不存在" };
      return { ...found, content: `正文 ${found.id}`, truncated: false, embedText: null, metadata: null, facts: [], summaryOf: [], relatedEdges: 0 };
    },
    preview: (args) => previewOf(args["ids"] as string[]),
    deleteItems: (args) => ({
      deleted: args["ids"] as string[],
      skipped: [],
      backup: backupOf({ id: "alpha@20250101T000000Z-before-delete", bank: "alpha" }),
    }),
    status: (args) => statusOf(args["bank"] as string),
    backups: () => [],
    restore: (args) => ({ bank: "alpha", restoredFrom: backupOf({ id: args["backupId"] as string, bank: "alpha" }), safetyBackup: null }),
    deleteBackup: () => null,
    deleteBank: (args) => backupOf({ id: `${args["bank"]}@x-bank-removed`, bank: args["bank"] as string, kind: "bank-removed" }),
    graph: () => GRAPH,
    ...over,
  };
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Args;
    switch (cmd) {
      case "memory_overview":
        calls.overview += 1;
        return structuredClone(behavior.overview);
      case "memory_list":
        calls.list.push(args);
        return behavior.list(args);
      case "memory_detail":
        calls.detail.push(args);
        return behavior.detail(args);
      case "memory_delete_preview":
        calls.preview.push(args);
        return behavior.preview(args);
      case "memory_delete_items":
        calls.deleteItems.push(args);
        return behavior.deleteItems(args);
      case "memory_bank_status":
        calls.status.push(args);
        return behavior.status(args);
      case "memory_backups":
        calls.backups.push(args);
        return behavior.backups(args);
      case "memory_restore":
        calls.restore.push(args);
        return behavior.restore(args);
      case "memory_delete_backup":
        calls.deleteBackup.push(args);
        return behavior.deleteBackup(args);
      case "memory_delete_bank":
        calls.deleteBank.push(args);
        return behavior.deleteBank(args);
      case "memory_graph":
        return behavior.graph(args);
      default:
        return null;
    }
  });
  const onToast = vi.fn();
  const onOpenSession = vi.fn();
  render(<MemoryPanel loadedSessionIds={new Set(behavior.loaded)} onOpenSession={onOpenSession} onToast={onToast} />);
  return { behavior, calls, onToast, onOpenSession };
}

async function selectBank(name: string, firstSnippet = "片段 m1"): Promise<void> {
  await openBank(name);
  await screen.findByText(firstSnippet);
}
const selectMode = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "选择" }));
};
const selectRow = (snippet: string): void => {
  fireEvent.click(screen.getByLabelText(`选择：${snippet}`));
};
const headerStrip = (): HTMLElement => document.querySelector(".mem-bank-header") as HTMLElement;
const rowLabel = (): (string | null)[] => Array.from(document.querySelectorAll(".mem-bank-row"), (r) => r.getAttribute("aria-label"));
const openBank = (name: string): Promise<void> => screen.findByRole("button", { name }).then((b) => void fireEvent.click(b));
const deleteConfirm = (): HTMLElement => screen.getByRole("button", { name: /备份并删除 \d+ 条/ });

async function openDeleteDialog(): Promise<HTMLElement> {
  if (screen.queryAllByRole("checkbox").length === 0) selectMode();
  selectRow("片段 m1");
  fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
  return screen.findByRole("dialog", { name: "删除记忆（alpha）" });
}

beforeEach(() => {
  clearMocks();
});

describe("多选语义", () => {
  it("选择跨页保持；全选已加载/清除生效；切库退出并清空", async () => {
    const { calls } = renderPanel({
      list: (args) => (args["offset"] === 0 ? pageOf([item({ id: "m1" }), item({ id: "m2" })], 3) : pageOf([item({ id: "m3" })], 3)),
    });
    await selectBank("alpha");
    selectMode();
    selectRow("片段 m1");
    expect(screen.getByText("已选 1 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByText("片段 m3");
    expect(screen.getByText("已选 1 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全选当前已加载" }));
    expect(screen.getByText("已选 3 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(screen.getByText("已选 0 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "empty" }));
    await waitFor(() => expect(calls.list[calls.list.length - 1]?.bank).toBe("empty"));
    expect(screen.queryByText(/已选/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("按当前筛选分页收集全部 id，到 500 停并提示；收集期间复选框禁用", async () => {
    const pending = Promise.withResolvers<MemoryPage>();
    let collect = false;
    const { calls, onToast } = renderPanel({
      list: (args) => {
        if (!collect) return pageOf(ITEMS);
        const limit = args["limit"] as number;
        const offset = args["offset"] as number;
        if (limit === 200 && offset === 0) return pending.promise;
        const total = 1200;
        const n = Math.min(limit, Math.max(0, total - offset));
        return pageOf(Array.from({ length: n }, (_, i) => item({ id: `g${offset + i}`, snippet: `大 ${offset + i}` })), total);
      },
    });
    await selectBank("alpha");
    selectMode();
    collect = true;
    fireEvent.click(screen.getByRole("button", { name: "选中当前筛选的全部结果" }));
    await screen.findByRole("button", { name: /正在收集/ });
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
      expect(box).toHaveAttribute("title", "正在收集筛选项，请稍候");
    }
    pending.resolve(pageOf(Array.from({ length: 200 }, (_, i) => item({ id: `g${i}`, snippet: `大 ${i}` })), 1200));
    await waitFor(() => expect(screen.getByText("已选 500 条")).toBeInTheDocument(), { timeout: 8000 });
    const collected = calls.list.filter((c) => c["limit"] === 200);
    expect(collected.map((c) => c["offset"])).toEqual([0, 200, 400]);
    expect(collected[0]).toMatchObject({ bank: "alpha", kind: "all", sort: "newest" });
    expect(onToast).toHaveBeenCalledWith("共 1200 条，已选中前 500 条（一次最多删除 500 条）", "info");
  }, 20000);
});

describe("删除确认框", () => {
  it("显示预览数字与级联，按勾选顺序发送 ids，成功后刷新并清空", async () => {
    const { calls, onToast } = renderPanel({
      preview: (args) =>
        previewOf(args["ids"] as string[], {
          deletable: { working: 1, episodic: 0 },
          notFound: 2,
          unsupported: 1,
          cascade: { facts: 2, embeddings: 0, annotations: 0, edges: 1, other: 0 },
          citedBySummaries: 3,
        }),
    });
    await selectBank("alpha");
    selectMode();
    selectRow("片段 m2");
    selectRow("片段 m1");
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(await within(dialog).findByText(/将从「alpha」删除 1 条记忆/)).toBeInTheDocument();
    expect(within(dialog).getByText("2 条已不在库中，将跳过。")).toBeInTheDocument();
    expect(within(dialog).getByText("该库的情节摘要暂不支持删除：1 条，将跳过。")).toBeInTheDocument();
    expect(within(dialog).getByText(/有 3 条情节摘要引用了这些记忆/)).toBeInTheDocument();
    expect(within(dialog).getByText("同时清理：事实 2 条 · 关联边 1 条。")).toBeInTheDocument();
    expect(calls.preview).toEqual([{ bank: "alpha", ids: ["m2", "m1"] }]);
    expect(calls.deleteItems).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "备份并删除 1 条" }));
    await waitFor(() => expect(calls.deleteItems).toEqual([{ bank: "alpha", ids: ["m2", "m1"] }]));
    expect(onToast).toHaveBeenCalledWith("已删除 2 条，已备份", "info");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("已选 0 条")).toBeInTheDocument();
    await waitFor(() => expect(calls.overview).toBe(2));
  });

  it("取消不触发删除；全不可删时确认禁用并列出原因；空 ids 不请求", async () => {
    const { calls } = renderPanel({
      preview: (args) => previewOf(args["ids"] as string[], { deletable: { working: 0, episodic: 0 }, notFound: 1, unsupported: 2 }),
    });
    await selectBank("alpha");
    selectMode();
    expect(screen.getByRole("button", { name: "删除所选…" })).toBeDisabled();
    const dialog = await openDeleteDialog();
    expect(await within(dialog).findByText("所选记忆都无法删除（1 条已不在库中，2 条暂不支持）。")).toBeInTheDocument();
    expect(deleteConfirm()).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.deleteItems).toEqual([]);
    // 空 ids：只提示，不再发预览请求。
    const before = calls.preview.length;
    render(<MemoryDeleteDialog bank="alpha" displayName="alpha" ids={[]} onClose={() => {}} onToast={() => {}} onDone={() => {}} />);
    expect(screen.getByText("未选择任何记忆。")).toBeInTheDocument();
    expect(calls.preview.length).toBe(before);
  });

  it("门禁未就绪（加载中）时确认禁用且点击不发请求；占用/探测失败说明原因，重试后放行", async () => {
    const pending = Promise.withResolvers<MemoryBankStatus>();
    const { behavior, calls } = renderPanel({ status: () => pending.promise });
    await selectBank("alpha");
    await openDeleteDialog();
    await screen.findByText("正在确认可删除内容与占用状态…");
    expect(deleteConfirm()).toBeDisabled();
    fireEvent.click(deleteConfirm());
    expect(calls.deleteItems).toEqual([]);
    pending.resolve(statusOf("alpha", { inUse: true, holders: [{ pid: 4242, command: "omp" }] }));
    expect(await screen.findByText(/该库正被使用：omp \(pid 4242\)/)).toBeInTheDocument();
    expect(deleteConfirm()).toBeDisabled();
    behavior.status = () => statusOf("alpha");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(deleteConfirm()).toBeEnabled());

    // 探测失败：重新打开确认框（门禁通过时没有重试按钮）。
    behavior.status = () => statusOf("alpha", { probeFailed: true });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(await screen.findByText(/无法确认是否有 omp 会话在使用该库/)).toBeInTheDocument();
    expect(deleteConfirm()).toBeDisabled();
    expect(calls.deleteItems).toEqual([]);
  }, 15000);

  it("提交中只发一次请求", async () => {
    const gate = Promise.withResolvers<MemoryDeleteResult>();
    const { calls } = renderPanel({ deleteItems: () => gate.promise });
    await selectBank("alpha");
    const dialog = await openDeleteDialog();
    const confirm = within(dialog).getByRole("button", { name: "备份并删除 1 条" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await within(dialog).findByText("删除中…")).toBeInTheDocument();
    await act(async () => {
      gate.resolve({ deleted: ["m1"], skipped: [], backup: backupOf({ id: "alpha@b", bank: "alpha" }) });
    });
    expect(calls.deleteItems.length).toBe(1);
  });

  it.each([
    ["IN_USE", "先退出占用该库的 omp 会话"],
    ["PROBE_FAILED", "无法确认是否有 omp"],
    ["IO", "删除失败"],
    ["NOT_FOUND", "删除失败"],
  ])("写错误 %s 给出中文说明并保留原文", async (code, phrase) => {
    renderPanel({
      deleteItems: () => {
        throw { code, message: `后端:${code}` };
      },
    });
    await selectBank("alpha");
    const dialog = await openDeleteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "备份并删除 1 条" }));
    const note = await within(dialog).findByText(new RegExp(phrase));
    expect(note.textContent).toContain(`后端:${code}`);
    expect(within(dialog).getByRole("button", { name: "备份并删除 1 条" })).toBeEnabled();
  });

  it("详情里的删除这条走同一确认框；行上不放删除按钮", async () => {
    const { calls, onToast } = renderPanel();
    await selectBank("alpha");
    const row = screen.getByText("片段 m1").closest(".mem-item") as HTMLElement;
    expect(within(row).queryByRole("button", { name: /删除/ })).toBeNull();
    fireEvent.click(screen.getByText("片段 m1"));
    expect(await screen.findByText("复制全文")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除这条…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    fireEvent.click(within(dialog).getByRole("button", { name: "备份并删除 1 条" }));
    await waitFor(() => expect(calls.deleteItems).toEqual([{ bank: "alpha", ids: ["m1"] }]));
    expect(onToast).toHaveBeenCalledWith("已删除 1 条，已备份", "info");
    await waitFor(() => expect(calls.overview).toBe(2));
    await waitFor(() => expect(screen.queryByText("复制全文")).toBeNull());
  });

});

describe("单库移除与使用中徽标", () => {
  it("操作条显示规模与备份入口；移除需确认并做占用门禁，成功后刷新", async () => {
    const { behavior, calls, onToast } = renderPanel({
      status: () => statusOf("empty", { inUse: true, holders: [{ pid: 4242, command: "omp" }] }),
    });
    await screen.findByRole("button", { name: "alpha" });
    expect(document.querySelector(".mem-bank-header")).toBeNull();
    await selectBank("empty");
    const strip = headerStrip();
    expect(within(strip).getByText("工作 0 · 情节 0 · 事实 0")).toBeInTheDocument();
    expect(within(strip).getByText("使用中")).toBeInTheDocument();
    fireEvent.click(within(strip).getByRole("button", { name: "移除此库…" }));
    const dialog = await screen.findByRole("dialog", { name: "移除项目库（empty）" });
    expect(within(dialog).getByText(/会先备份并移到备份区/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "移除此库" })).toBeDisabled();
    expect(await within(dialog).findByText(/该库正被使用：omp \(pid 4242\)/)).toBeInTheDocument();
    behavior.status = () => statusOf("empty");
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "移除此库" })).toBeEnabled());
    const rmBtn = within(dialog).getByRole("button", { name: "移除此库" });
    fireEvent.click(rmBtn); fireEvent.click(rmBtn);
    await waitFor(() => expect(calls.deleteBank).toEqual([{ bank: "empty" }]));
    expect(onToast).toHaveBeenCalledWith("已移除 empty，可在「备份与恢复」中还原", "info");
    await waitFor(() => expect(calls.overview).toBe(2));
  });

});

describe("无效库批量清理", () => {
  const openCleanup = async (): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByRole("button", { name: "清理无效库…" }));
    return screen.findByRole("dialog", { name: "清理无效库" });
  };

  it("默认全选可移除库；使用中与不可读禁用；失败继续并逐条汇总，成功后刷新", async () => {
    let failGone = true;
    const { calls, onToast } = renderPanel({
      status: (args) =>
        statusOf(args["bank"] as string, args["bank"] === "empty" ? { inUse: true, holders: [{ pid: 4242, command: "omp" }] } : {}),
      deleteBank: (args) => {
        if (args["bank"] === "gone" && failGone) throw { code: "IN_USE", message: "库正被 omp 会话使用：omp (pid 4242)" };
        return backupOf({ id: `x@y-${args["bank"]}`, bank: args["bank"] as string, kind: "bank-removed" });
      },
    });
    const dialog = await openCleanup();
    expect(within(dialog).getByText(/会先备份并移到备份区/)).toBeInTheDocument();
    expect(await within(dialog).findAllByText(/使用中，先退出占用它的 omp 会话/)).not.toHaveLength(0);
    expect(within(dialog).getByRole("checkbox", { name: /empty/ })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: /gone/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /locked/ })).toBeDisabled();
    expect(await within(dialog).findByText(/将移除 1 个库、共 3 条记忆/)).toBeInTheDocument();
    const runBtn = within(dialog).getByRole("button", { name: "备份并移除 1 个库" });
    fireEvent.click(runBtn); fireEvent.click(runBtn);
    await waitFor(() => expect(calls.deleteBank).toEqual([{ bank: "gone" }]));
    expect(await within(dialog).findByText(/gone：无法移除/)).toBeInTheDocument();
    expect(dialog.querySelectorAll(".mem-step-fail")).toHaveLength(1);
    expect(onToast).toHaveBeenCalledWith("已移除 0 个无效库，1 个失败", "error");
    expect(await within(dialog).findByRole("button", { name: "完成" })).toBeInTheDocument();
    await waitFor(() => expect(calls.overview).toBe(2));
    // 再跑一次：失败消失，结果页汇总成功并提示可还原。
    failGone = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
    const again = await openCleanup();
    await within(again).findByRole("checkbox", { name: /gone/ });
    fireEvent.click(within(again).getByRole("button", { name: "备份并移除 1 个库" }));
    expect(await within(again).findByText(/gone：已移除（已备份）/)).toBeInTheDocument();
    expect(onToast).toHaveBeenCalledWith("已移除 1 个无效库，均已备份", "info");
  });

  it("没有无效库时清理入口与「只看无效库」都禁用", async () => {
    renderPanel({ overview: overviewOf({ banks: [bankOf({ bank: "alpha", working: 3 })] }) });
    await screen.findByRole("button", { name: "alpha" });
    expect(screen.getByRole("button", { name: "只看无效库（0）" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清理无效库…" })).toBeDisabled();
  });
});

describe("备份与恢复", () => {
  const two = [
    backupOf({ id: "alpha@20250102T000000Z-before-delete", bank: "alpha" }),
    backupOf({ id: "gone@20250101T000000Z-bank-removed", bank: "gone", kind: "bank-removed", working: 3, episodic: 0, cwd: "/Users/demo/old" }),
  ];
  const openBackups = async (): Promise<HTMLElement> => {
    const head = document.querySelector(".mem-head") as HTMLElement;
    fireEvent.click(within(head).getByRole("button", { name: "备份与恢复" }));
    return screen.findByRole("dialog", { name: "备份与恢复" });
  };

  it("列表按时间倒序显示类型与数量、留存说明；操作条可预选范围", async () => {
    const { calls, behavior } = renderPanel({ backups: () => [] });
    await screen.findByRole("button", { name: "alpha" });
    const empty = await openBackups();
    expect(await within(empty).findByText("还没有备份。删除记忆或移除库时会自动创建。")).toBeInTheDocument();
    expect(within(empty).getByText(/每个库自动保留最近 5 份/)).toBeInTheDocument();
    fireEvent.click(within(empty).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    behavior.backups = () => two;
    const dialog = await openBackups();
    const rows = await within(dialog).findAllByRole("listitem");
    expect(within(rows[0]).getByText("删除前")).toBeInTheDocument();
    expect(within(rows[1]).getByText("移除的库")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/工作 2 · 情节 1/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await selectBank("empty");
    fireEvent.click(within(headerStrip()).getByRole("button", { name: "备份与恢复" }));
    const reopened = await screen.findByRole("dialog", { name: "备份与恢复" });
    expect(within(reopened).getByLabelText("备份项目库范围")).toHaveValue("empty");
    expect(calls.backups[calls.backups.length - 1]).toEqual({ bank: "empty" });
  });

  it("恢复现存库：安全备份说明 + 占用门禁，成功后刷新", async () => {
    const { calls, onToast } = renderPanel({ backups: () => two });
    await screen.findByRole("button", { name: "alpha" });
    const dialog = await openBackups();
    fireEvent.click(within((await within(dialog).findAllByRole("listitem"))[0]).getByRole("button", { name: "恢复…" }));
    await within(dialog).findByText(/恢复前会自动为当前内容创建安全备份/);
    expect(calls.status).toEqual([{ bank: "alpha" }]);
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(calls.restore).toEqual([{ backupId: "alpha@20250102T000000Z-before-delete" }]));
    expect(onToast).toHaveBeenCalledWith("已恢复 alpha", "info");
    expect(await within(dialog).findByText("共 2 份")).toBeInTheDocument();
    await waitFor(() => expect(calls.overview).toBe(2));
  });

  it("已移除库恢复跳过门禁；旧门禁状态不残留；恢复失败不刷新；永久删除需二次确认", async () => {
    const vanished = backupOf({ id: "vanished@20250101T000000Z-bank-removed", bank: "vanished", kind: "bank-removed", cwd: "/tmp/v" });
    const { behavior, calls } = renderPanel({
      backups: () => [two[0], vanished],
      status: () => statusOf("alpha", { inUse: true, holders: [{ pid: 7, command: "omp" }] }),
    });
    behavior.restore = () => {
      throw { code: "IO", message: "校验失败" };
    };
    await screen.findByRole("button", { name: "alpha" });
    const dialog = await openBackups();
    const itemAt = async (i: number): Promise<HTMLElement> => (await within(dialog).findAllByRole("listitem"))[i];
    // 现存库 alpha：占用中，恢复被禁用。
    fireEvent.click(within(await itemAt(0)).getByRole("button", { name: "恢复…" }));
    await within(dialog).findByText(/该库正被使用：omp \(pid 7\)/);
    expect(within(dialog).getByRole("button", { name: "恢复" })).toBeDisabled();
    // 已移除库：跳过门禁，旧持有者不残留；恢复失败留在确认页且不刷新。
    fireEvent.click(within(dialog).getByRole("button", { name: "返回" }));
    fireEvent.click(within(await itemAt(1)).getByRole("button", { name: "恢复…" }));
    expect(await within(dialog).findByText(/该库当前已被移除/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/该库正被使用/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复" }));
    expect(await within(dialog).findByText("恢复失败：校验失败")).toBeInTheDocument();
    expect(calls.overview).toBe(1);
    expect(calls.status).toEqual([{ bank: "alpha" }]);
    // 永久删除备份：返回不触发，确认后才发命令。
    fireEvent.click(within(dialog).getByRole("button", { name: "返回" }));
    fireEvent.click(within(await itemAt(0)).getByRole("button", { name: "永久删除备份…" }));
    const confirm = await screen.findByRole("dialog", { name: "永久删除备份" });
    expect(calls.deleteBackup).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "返回" }));
    fireEvent.click(within(await itemAt(0)).getByRole("button", { name: "永久删除备份…" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "永久删除备份" })).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(calls.deleteBackup).toEqual([{ backupId: "alpha@20250102T000000Z-before-delete" }]));
  });
});

describe("总览与健康卡", () => {
  it("百分比按条数计算，超过一半用警示底色", async () => {
    renderPanel();
    const cards = await screen.findByLabelText("记忆库健康状况");
    const cardOf = (label: string): HTMLElement => within(cards).getByText(label).closest(".mem-card") as HTMLElement;
    expect(cardOf("记忆总数").textContent).toContain("工作 40 · 情节 60");
    expect(cardOf("从未被召回").textContent).toContain("占 51%");
    expect(cardOf("尚未合并").textContent).toContain("占工作记忆 75%");
    expect(cards.textContent).toContain("2.0 KB");
    expect(cardOf("从未被召回")).toHaveClass("mem-card-warn");
    expect(cardOf("尚未合并")).toHaveClass("mem-card-warn");
  });

  it("总数为 0 时占比显示破折号而不是 NaN；不可用时给出平和说明", async () => {
    renderPanel({
      overview: overviewOf({
        banks: [bankOf({ bank: "alpha" })],
        totals: { ...TOTALS, working: 0, episodic: 0, neverRecalled: 0, unconsolidated: 0, bytes: 0, facts: 0 },
      }),
    });
    const cards = await screen.findByLabelText("记忆库健康状况");
    expect(within(cards).getByText(/^占 —/)).toBeInTheDocument();
    expect(within(cards).getByText(/^占工作记忆 —/)).toBeInTheDocument();
    expect(within(cards).queryByText(/NaN/)).toBeNull();

    clearMocks();
    const second = renderPanel({ overview: overviewOf({ available: false, backend: null, banks: [] }) });
    expect(await screen.findByText("未找到本地记忆库")).toBeInTheDocument();
    expect(second.onToast).not.toHaveBeenCalled();
  });
});

describe("项目库图表", () => {
  it("按记忆数降序排列；无效库带徽章；只看无效库可过滤", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "alpha" });
    expect(rowLabel()).toEqual(["alpha", "beta", "gone", "empty", "locked"]);
    expect(within(screen.getByRole("button", { name: "gone" })).getByText("目录已不存在")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "empty" })).getByText("空库")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "locked" })).getByText("不可读")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "只看无效库（3）" }));
    expect(rowLabel()).toEqual(["gone", "empty", "locked"]);
    expect(screen.getByRole("button", { name: "清理无效库…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "只看无效库（3）" }));
    expect(rowLabel().length).toBe(BANKS.length);
    fireEvent.click(screen.getByRole("button", { name: "gone" }));
    expect(screen.getByRole("button", { name: "gone" })).toHaveAttribute("aria-pressed", "true");
  });

  it("点选项目库按默认参数请求该库记忆", async () => {
    const { calls } = renderPanel();
    await openBank("beta");
    await waitFor(() => expect(calls.list.length).toBeGreaterThan(0));
    expect(calls.list[calls.list.length - 1]).toEqual({
      bank: "beta",
      query: null,
      kind: "all",
      onlyNeverRecalled: false,
      onlyUnconsolidated: false,
      onlyMissingSource: false,
      sort: "newest",
      limit: 50,
      offset: 0,
    });
  });

  it("行悬浮用 data-tip 显示多行摘要，无效库显示错误且无原生 title", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "alpha" });
    const tipOf = (name: string): string | null =>
      document.querySelector(`.mem-bank-row[aria-label="${name}"]`)?.getAttribute("data-tip") ?? null;
    expect(tipOf("alpha")).toContain("工作");
    expect(tipOf("alpha")).toContain("未召回");
    expect(tipOf("locked")).toContain("目录无读取权限");
    expect(document.querySelector(".mem-bank-row[title]")).toBeNull();
  });

  it("不可读库被选中时不发列表请求并说明原因", async () => {
    const { calls } = renderPanel();
    await openBank("locked");
    expect(await screen.findByText(/该库不可读：目录无读取权限/)).toBeInTheDocument();
    expect(calls.list).toEqual([]);
  });

  it("选中库在右侧抽屉里展开：不占列表流、可切换库、Esc 与关闭按钮都能收起", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "alpha" });
    // 未选中：无抽屉，左列给出提示。
    expect(document.querySelector(".drawer")).toBeNull();
    expect(screen.getByText(/点上面的项目库，在右侧查看其中的记忆/)).toBeInTheDocument();

    await selectBank("alpha");
    const drawer = await screen.findByRole("complementary", { name: "项目库 alpha" });
    expect(drawer).toHaveClass("drawer", "drawer-inline");
    expect(drawer.querySelector(".drawer-title")?.textContent).toContain("alpha");
    // 抽屉在左列之外（兄弟节点），不是列表末尾的一段。
    expect(drawer.closest(".mem-main")).toBeNull();
    expect(screen.queryByText(/点上面的项目库/)).toBeNull();

    // 抽屉开着时点另一个库：只换内容，不关抽屉。
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    const swapped = await screen.findByRole("complementary", { name: "项目库 beta" });
    expect(swapped.querySelector(".drawer-title")?.textContent).toContain("beta");
    expect(document.querySelectorAll(".drawer")).toHaveLength(1);

    // 关闭按钮收起；再开一次，Esc 也能收起。
    fireEvent.click(within(swapped).getByRole("button", { name: "关闭项目库 beta" }));
    expect(document.querySelector(".drawer")).toBeNull();
    await selectBank("alpha");
    await screen.findByRole("complementary", { name: "项目库 alpha" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".drawer")).toBeNull();
  });

  it("抽屉里的模态框先关自己：Esc 只关闭确认框，抽屉保留", async () => {
    renderPanel();
    await selectBank("empty");
    const drawer = await screen.findByRole("complementary", { name: "项目库 empty" });
    fireEvent.click(within(drawer).getByRole("button", { name: "移除此库…" }));
    const dialog = await screen.findByRole("dialog", { name: "移除项目库（empty）" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("complementary", { name: "项目库 empty" })).toBeInTheDocument();
  });
});

describe("记忆列表与详情", () => {
  it("过滤条件组合成正确参数", async () => {
    const { calls } = renderPanel();
    await openBank("alpha");
    await waitFor(() => expect(calls.list.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "从未召回" }));
    fireEvent.click(screen.getByRole("button", { name: "未合并" }));
    fireEvent.change(screen.getByLabelText("记忆类型"), { target: { value: "working" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "mostRecalled" } });
    await waitFor(() =>
      expect(calls.list[calls.list.length - 1]).toMatchObject({
        kind: "working",
        onlyNeverRecalled: true,
        onlyUnconsolidated: true,
        sort: "mostRecalled",
        offset: 0,
      }),
    );
  });

  it("搜索防抖合并连续输入，慢的旧响应不覆盖新结果", async () => {
    const slow = Promise.withResolvers<MemoryPage>();
    const fast = Promise.withResolvers<MemoryPage>();
    let n = 0;
    const { calls } = renderPanel({
      list: () => {
        n += 1;
        return n === 1 ? pageOf([item({ id: "init", snippet: "初始结果" })]) : n === 2 ? slow.promise : fast.promise;
      },
    });
    await openBank("alpha");
    await screen.findByText("初始结果");
    const before = calls.list.length;
    fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "缓" } });
    fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "缓存" } });
    await waitFor(() => expect(calls.list.length).toBe(before + 1));
    expect(calls.list[calls.list.length - 1]).toMatchObject({ query: "缓存" });
    fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "缓存命中" } });
    await waitFor(() => expect(calls.list.length).toBe(before + 2));
    await act(async () => {
      fast.resolve(pageOf([item({ id: "fast", snippet: "新结果" })]));
    });
    expect(await screen.findByText("新结果")).toBeInTheDocument();
    await act(async () => {
      slow.resolve(pageOf([item({ id: "slow", snippet: "过期结果" })]));
    });
    expect(screen.queryByText("过期结果")).toBeNull();
  });

  it("加载更多以已显示条数为 offset 追加", async () => {
    const first = Array.from({ length: 50 }, (_, i) => item({ id: `p${i}`, snippet: `第 ${i} 条` }));
    const { calls } = renderPanel({
      list: (args) =>
        args["offset"] === 0 ? pageOf(first, 60) : pageOf(Array.from({ length: 10 }, (_, i) => item({ id: `q${i}`, snippet: `补充 ${i}` })), 60),
    });
    await openBank("alpha");
    await screen.findByText(/已显示 50 \/ 共 60 条/);
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("补充 0")).toBeInTheDocument();
    expect(calls.list[calls.list.length - 1]).toMatchObject({ offset: 50, limit: 50 });
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("来源会话仅在已加载时可跳转，三态各有说明", async () => {
    const items = [
      item({ id: "loaded", snippet: "来源已加载", sourceSessionId: "s1", sourceSessionExists: true }),
      item({ id: "notloaded", snippet: "来源未加载", sourceSessionId: "s2", sourceSessionExists: true }),
      item({ id: "gone", snippet: "来源已删除", sourceSessionId: "s3", sourceSessionExists: false }),
      item({ id: "nosource", snippet: "没有来源" }),
    ];
    const { onOpenSession } = renderPanel({ loaded: ["s1"], list: () => pageOf(items) });
    await openBank("alpha");
    await screen.findByText("来源已加载");
    const jumpIn = (text: string): HTMLElement =>
      within(screen.getByText(text).closest(".mem-item") as HTMLElement).getByRole("button", { name: "查看来源会话" });
    expect(jumpIn("来源已加载")).toBeEnabled();
    expect(jumpIn("来源未加载")).toHaveAttribute("title", "来源会话未加载到当前列表");
    expect(jumpIn("来源已删除")).toHaveAttribute("title", "来源会话已不在（可能已被删除）");
    expect(jumpIn("没有来源")).toHaveAttribute("title", "该记忆未记录来源会话");
    fireEvent.click(jumpIn("来源已加载"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("详情标注截断，正文默认折叠且可展开", async () => {
    const detail: MemoryDetail = {
      ...item({ id: "big", snippet: "超长条目", contentChars: 30720 }),
      content: "x".repeat(8000),
      truncated: true,
      embedText: null,
      metadata: null,
      facts: [{ subject: "用户", predicate: "偏好", object: "中文提交信息", key: "pref:commit-lang" }],
      summaryOf: ["mem-1"],
      relatedEdges: 3,
    };
    const { calls } = renderPanel({ list: () => pageOf([detail]), detail: () => detail });
    await openBank("alpha");
    fireEvent.click(await screen.findByText("超长条目"));
    expect(await screen.findByText(/内容过长，仅显示前 8000 字符（全文 30720 字符）/)).toBeInTheDocument();
    expect(calls.detail[0]).toEqual({ bank: "alpha", id: "big" });
    expect(screen.getByText("用户 · 偏好 · 中文提交信息")).toBeInTheDocument();
    const content = document.querySelector(".mem-content") as HTMLElement;
    expect(content).toHaveClass("mem-content-collapsed");
    fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
    expect(content).not.toHaveClass("mem-content-collapsed");
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("列表失败时 toast 并在行内提示，仍保留总览", async () => {
    const { onToast } = renderPanel({
      list: () => {
        throw { code: "IO", message: "模拟读取失败" };
      },
    });
    await openBank("alpha");
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("加载记忆列表失败：模拟读取失败", "error"));
    expect(await screen.findByText("加载失败：模拟读取失败")).toBeInTheDocument();
    expect(screen.getByText(/记忆后端：mnemopi/)).toBeInTheDocument();
  });
});

describe("关系图在抽屉内的 Esc 处理", () => {
  it("选中节点时 Esc 只清选中，抽屉保留；再按一次才关抽屉", async () => {
    renderPanel();
    await selectBank("alpha");
    const drawer = await screen.findByRole("complementary", { name: "项目库 alpha" });
    fireEvent.click(within(drawer).getByRole("button", { name: "关系图" }));
    const svg = await waitFor(() => {
      const el = document.querySelector<SVGSVGElement>(".mem-graph-canvas");
      if (el === null) throw new Error("关系图未挂载");
      return el;
    });

    // 点节点选中（拖拽未发生 ⇒ 视为点选）。节点坐标由布局 effect 写入，
    // svg 挂载与节点出现之间有一帧，必须等 circle 真正渲染。
    const node = await waitFor(() => {
      const circle = svg.querySelector("circle");
      if (circle === null) throw new Error("节点尚未就绪");
      return circle.closest("g") as SVGGElement;
    });
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 0, clientY: 0 });
    const card = await screen.findByRole("complementary", { name: "选中记忆" });
    expect(card).toBeInTheDocument();
    expect(within(card).getByText("重要度")).toBeInTheDocument();

    // 第一下 Esc：清选中，抽屉还在（离开局面的方式不能是「关抽屉」）。
    fireEvent.keyDown(svg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "选中记忆" })).toBeNull());
    expect(screen.getByRole("complementary", { name: "项目库 alpha" })).toBeInTheDocument();

    // 无选中时 Esc 冒泡到抽屉：关闭。
    fireEvent.keyDown(svg, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".drawer")).toBeNull());
  });
});

describe("关系图定位卡", () => {
  it("删除定位记忆后清除定位并刷新，不再展示已删卡片", async () => {
    const focusItem = item({ id: "m1" });
    const calls = { deleteItems: [] as Args[] };
    mockIPC((cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Args;
      switch (cmd) {
        case "memory_list":
          return pageOf([item({ id: "m2" }), item({ id: "m3" })]);
        case "memory_detail":
          if (args["id"] !== "m1") throw { code: "NOT_FOUND", message: "记忆不存在" };
          return { ...focusItem, content: "正文 m1", truncated: false, embedText: null, metadata: null, facts: [], summaryOf: [], relatedEdges: 0 };
        case "memory_delete_preview":
          return previewOf(args["ids"] as string[]);
        case "memory_bank_status":
          return statusOf("alpha");
        case "memory_delete_items":
          calls.deleteItems.push(args);
          return { deleted: args["ids"] as string[], skipped: [], backup: backupOf({ id: "alpha@20250101T000000Z-before-delete", bank: "alpha" }) };
        default:
          return null;
      }
    });
    const onClearFocus = vi.fn();
    const onRefresh = vi.fn();
    render(
      <MemoryList bank="alpha" displayName="alpha" loadedSessionIds={new Set()} onOpenSession={() => {}} onToast={() => {}} onRefresh={onRefresh} focusId="m1" onClearFocus={onClearFocus} />,
    );
    const focusList = await screen.findByRole("list", { name: "定位的记忆" });
    fireEvent.click(within(focusList).getByRole("button", { name: "删除这条…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "备份并删除 1 条" }));
    await waitFor(() => expect(calls.deleteItems).toEqual([{ bank: "alpha", ids: ["m1"] }]));
    await waitFor(() => expect(onClearFocus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });
});
