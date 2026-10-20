/**
 * 记忆库维护测试：多选语义、删除确认（预览/门禁/错误码）、单条删除、
 * 移除库、备份与恢复。破坏性命令只能在明确确认后触发。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type {
  MemoryBackup,
  MemoryBankStatus,
  MemoryBankSummary,
  MemoryDeletePreview,
  MemoryDeleteResult,
  MemoryDeleteSkipped,
  MemoryDetail,
  MemoryItem,
  MemoryOverview,
  MemoryPage,
  MemoryRestoreResult,
  MemoryTotals,
} from "../types";
import { MemoryPanel } from "./MemoryPanel";
import { MemoryDeleteDialog } from "./MemoryDeleteDialog";
import { useMemorySelection } from "./MemorySelection";
import { memoryWriteErrorText } from "./useMemoryMaintenance";

function bank(over: Partial<MemoryBankSummary> & Pick<MemoryBankSummary, "bank" | "displayName">): MemoryBankSummary {
  return {
    cwd: `/Users/demo/my/${over.bank}`,
    cwdExists: true,
    working: 0,
    episodic: 0,
    facts: 0,
    bytes: 0,
    firstMemoryAt: null,
    lastMemoryAt: null,
    neverRecalled: 0,
    unconsolidated: 0,
    sourceSessions: 0,
    missingSourceSessions: 0,
    readable: true,
    error: null,
    ...over,
  };
}

const TOTALS: MemoryTotals = {
  banks: 5,
  working: 40,
  episodic: 60,
  facts: 7,
  bytes: 2048,
  neverRecalled: 10,
  unconsolidated: 5,
  missingSourceSessions: 2,
  sourceSessions: 10,
};

const BANKS: MemoryBankSummary[] = [
  bank({ bank: "alpha", displayName: "alpha", working: 30, episodic: 40, bytes: 1024 }),
  bank({ bank: "beta", displayName: "beta", working: 10, episodic: 20, bytes: 1024 }),
  bank({ bank: "empty", displayName: "empty", cwd: "/Users/demo/my/empty" }),
  bank({ bank: "gone", displayName: "gone", cwd: "/Users/demo/old", cwdExists: false, working: 3, bytes: 100 }),
  { ...bank({ bank: "locked", displayName: "locked" }), readable: false, error: "目录无读取权限" },
];

function item(over: Partial<MemoryItem> & Pick<MemoryItem, "id">): MemoryItem {
  return {
    kind: "working",
    snippet: `片段 ${over.id}`,
    contentChars: 20,
    createdAt: "2026-10-18T10:00:00.000Z",
    sourceSessionId: null,
    sourceSessionExists: null,
    recallCount: 0,
    lastRecalledAt: null,
    importance: null,
    veracity: null,
    memoryType: null,
    consolidated: false,
    superseded: false,
    ...over,
  };
}

function detailOf(m: MemoryItem): MemoryDetail {
  return { ...m, content: `正文 ${m.id}`, truncated: false, embedText: null, metadata: null, facts: [], summaryOf: [], relatedEdges: 0 };
}

function previewOf(ids: string[], over: Partial<MemoryDeletePreview> = {}): MemoryDeletePreview {
  return {
    requested: ids.length,
    deletable: { working: ids.length, episodic: 0 },
    unsupported: 0,
    notFound: 0,
    cascade: { facts: 0, embeddings: 0, annotations: 0, edges: 0, other: 0 },
    citedBySummaries: 0,
    ...over,
  };
}

function statusOf(bank: string, over: Partial<MemoryBankStatus> = {}): MemoryBankStatus {
  return { bank, inUse: false, probeFailed: false, holders: [], backups: [], ...over };
}

function backup(over: Partial<MemoryBackup> & Pick<MemoryBackup, "id" | "bank">): MemoryBackup {
  return {
    kind: "before-delete",
    createdAt: "2026-10-19T10:00:00.000Z",
    bytes: 1024,
    working: 2,
    episodic: 1,
    cwd: "/Users/demo/my/alpha",
    ...over,
  };
}

type Args = Record<string, unknown>;

interface Behavior {
  list: (args: Args) => MemoryPage | Promise<MemoryPage>;
  preview: (args: Args) => MemoryDeletePreview | Promise<MemoryDeletePreview>;
  deleteItems: (args: Args) => MemoryDeleteResult | Promise<MemoryDeleteResult>;
  status: (args: Args) => MemoryBankStatus | Promise<MemoryBankStatus>;
  backups: (args: Args) => MemoryBackup[] | Promise<MemoryBackup[]>;
  restore: (args: Args) => MemoryRestoreResult | Promise<MemoryRestoreResult>;
  deleteBackup: (args: Args) => null | Promise<null>;
  deleteBank: (args: Args) => MemoryBackup | Promise<MemoryBackup>;
  detail: (args: Args) => MemoryDetail | Promise<MemoryDetail>;
}

interface Calls {
  overview: number;
  list: Args[];
  preview: Args[];
  deleteItems: Args[];
  status: Args[];
  backups: Args[];
  restore: Args[];
  deleteBackup: Args[];
  deleteBank: Args[];
}

const ITEMS = [item({ id: "m1" }), item({ id: "m2" }), item({ id: "m3" })];

function installMaintenanceStub(over: Partial<Behavior> = {}): { behavior: Behavior; calls: Calls } {
  const calls: Calls = {
    overview: 0,
    list: [],
    preview: [],
    deleteItems: [],
    status: [],
    backups: [],
    restore: [],
    deleteBackup: [],
    deleteBank: [],
  };
  const behavior: Behavior = {
    list: () => ({ total: ITEMS.length, items: ITEMS }),
    preview: (args) => previewOf(args["ids"] as string[]),
    deleteItems: (args) => ({
      deleted: args["ids"] as string[],
      skipped: [] as MemoryDeleteSkipped[],
      backup: backup({ id: "alpha@20250101T000000Z-before-delete", bank: "alpha" }),
    }),
    status: (args) => statusOf(args["bank"] as string),
    backups: () => [],
    restore: (args) => ({
      bank: "alpha",
      restoredFrom: backup({ id: args["backupId"] as string, bank: "alpha" }),
      safetyBackup: backup({ id: "alpha@20250102T000000Z-before-restore", bank: "alpha", kind: "before-restore" }),
    }),
    deleteBackup: () => null,
    deleteBank: (args) => backup({ id: `${args["bank"]}@20250101T000000Z-bank-removed`, bank: args["bank"] as string, kind: "bank-removed" }),
    detail: (args) => {
      const found = ITEMS.find((m) => m.id === args["id"]);
      if (!found) throw { code: "NOT_FOUND", message: "记忆不存在" };
      return detailOf(found);
    },
    ...over,
  };
  const overview: MemoryOverview = {
    available: true,
    backend: "mnemopi",
    root: "/Users/demo/.omp/agent/memory",
    banks: BANKS,
    totals: TOTALS,
  };
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Args;
    switch (cmd) {
      case "memory_overview":
        calls.overview += 1;
        return structuredClone(overview);
      case "memory_growth":
        return [{ date: "2026-10-18", working: 1, episodic: 0 }];
      case "memory_list":
        calls.list.push(args);
        return behavior.list(args);
      case "memory_detail":
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
      default:
        return null;
    }
  });
  return { behavior, calls };
}

function renderMaintenance(over: Partial<Behavior> = {}) {
  const onToast = vi.fn();
  const { behavior, calls } = installMaintenanceStub(over);
  render(<MemoryPanel loadedSessionIds={new Set()} onOpenSession={() => {}} onToast={onToast} />);
  return { behavior, calls, onToast };
}

async function selectBank(name: string, firstSnippet = "片段 m1"): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name }));
  await screen.findByText(firstSnippet);
}

function bankRow(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest("tr") as HTMLElement;
}

/** 头条的「备份与恢复」按钮（行内同名按钮很多，按容器区分）。 */
function openBackupsFromHeader(): void {
  const head = document.querySelector(".mem-head") as HTMLElement;
  fireEvent.click(within(head).getByRole("button", { name: "备份与恢复" }));
}

beforeEach(() => {
  clearMocks();
});

describe("多选语义", () => {
  it("选择模式跨页保持，切库或改筛选后清空", async () => {
    const { calls } = renderMaintenance({
      list: (args) => {
        const offset = args["offset"] as number;
        return offset === 0
          ? { total: 3, items: [item({ id: "m1" }), item({ id: "m2" })] }
          : { total: 3, items: [item({ id: "m3" })] };
      },
    });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    expect(screen.getByText("已选 1 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByText("片段 m3");
    expect(screen.getByText("已选 1 条")).toBeInTheDocument();
    // 切库：退出选择模式并清空。
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    await waitFor(() => expect(calls.list[calls.list.length - 1]?.bank).toBe("beta"));
    expect(screen.queryByText(/已选/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // 改筛选：清空选择但保留模式。
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await screen.findByText("片段 m1");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "未合并" }));
    await waitFor(() => expect(screen.getByText("已选 0 条")).toBeInTheDocument());
  });

  it("全选当前已加载只选中已加载项，清除可重置", async () => {
    renderMaintenance({
      list: (args) => {
        const offset = args["offset"] as number;
        return offset === 0
          ? { total: 3, items: [item({ id: "m1" }), item({ id: "m2" })] }
          : { total: 3, items: [item({ id: "m3" })] };
      },
    });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "全选当前已加载" }));
    expect(screen.getByText("已选 2 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByText("片段 m3");
    expect(screen.getByText("已选 2 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(screen.getByText("已选 0 条")).toBeInTheDocument();
  });

  it("选中当前筛选的全部结果按筛选分页收集 id", async () => {
    const { calls } = renderMaintenance({
      list: (args) => {
        const limit = args["limit"] as number;
        const offset = args["offset"] as number;
        const total = 450;
        const n = Math.min(limit, Math.max(0, total - offset));
        return {
          total,
          items: Array.from({ length: n }, (_, i) => item({ id: `f${offset + i}`, snippet: `条目 ${offset + i}` })),
        };
      },
    });
    await selectBank("alpha", "条目 0");
    fireEvent.click(screen.getByRole("button", { name: "从未召回" }));
    await waitFor(() =>
      expect(calls.list[calls.list.length - 1]).toMatchObject({ onlyNeverRecalled: true, limit: 50 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "选中当前筛选的全部结果" }));
    await waitFor(() => expect(screen.getByText("已选 450 条")).toBeInTheDocument());
    const collected = calls.list.filter((c) => c["limit"] === 200);
    expect(collected.map((c) => c["offset"])).toEqual([0, 200, 400]);
    for (const c of collected) {
      expect(c).toMatchObject({ bank: "alpha", kind: "all", onlyNeverRecalled: true, sort: "newest" });
    }
  }, 20000);

  it("收集到 500 即停并提示，不再翻页", async () => {
    const { calls, onToast } = renderMaintenance({
      list: (args) => {
        const limit = args["limit"] as number;
        const offset = args["offset"] as number;
        const total = 1200;
        if (limit === 50 && offset === 50) {
          return { total, items: [item({ id: "g999", snippet: "大 999" })] };
        }
        const n = Math.min(limit, Math.max(0, total - offset));
        return {
          total,
          items: Array.from({ length: n }, (_, i) => item({ id: `g${offset + i}`, snippet: `大 ${offset + i}` })),
        };
      },
    });
    await selectBank("alpha", "大 0");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "选中当前筛选的全部结果" }));
    await waitFor(() => expect(screen.getByText("已选 500 条")).toBeInTheDocument());
    expect(calls.list.filter((c) => c["limit"] === 200).map((c) => c["offset"])).toEqual([0, 200, 400]);
    expect(onToast).toHaveBeenCalledWith("筛选结果共 1200 条，已选中前 500 条（一次最多删除 500 条）", "info");
    expect(screen.getByText("已达上限 500 条，一次最多删除 500 条")).toBeInTheDocument();
    // 加载更多拿到界外行：未选中的复选框被禁用并说明原因。
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByText("大 999");
    const boxes = screen.getAllByRole("checkbox");
    const unchecked = boxes.filter((b) => !(b as HTMLInputElement).checked);
    expect(unchecked.length).toBeGreaterThan(0);
    expect(unchecked[0]).toBeDisabled();
    expect(unchecked[0]).toHaveAttribute("title", "一次最多删除 500 条");
  }, 20000);
  it("收集期间行复选框与选择操作禁用并说明原因，完成后恢复", async () => {
    let release!: (page: MemoryPage) => void;
    const pending = new Promise<MemoryPage>((resolve) => {
      release = resolve;
    });
    renderMaintenance({
      list: (args) => (args["limit"] === 200 ? pending : { total: ITEMS.length, items: ITEMS }),
    });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "选中当前筛选的全部结果" }));
    await screen.findByRole("button", { name: /正在收集/ });
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBe(3);
    for (const box of boxes) {
      expect(box).toBeDisabled();
      expect(box).toHaveAttribute("title", "正在收集筛选项，请稍候");
    }
    expect(screen.getByRole("button", { name: "清除" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清除" })).toHaveAttribute("title", "正在收集筛选项，请稍候");
    release({ total: ITEMS.length, items: ITEMS });
    await waitFor(() => expect(screen.getByText("已选 3 条")).toBeInTheDocument());
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeEnabled();
    }
  });

  it("快捷筛选建议只开筛选，不自动选中", async () => {
    const { calls } = renderMaintenance();
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "从未召回且来源已不在" }));
    expect(screen.getByRole("button", { name: "从未召回" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "来源已不在" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(calls.list[calls.list.length - 1]).toMatchObject({ onlyNeverRecalled: true, onlyMissingSource: true }),
    );
    expect(screen.getByText("已选 0 条")).toBeInTheDocument();
  });

  it("选择上限在 hook 层生效且可清空", () => {
    const { result } = renderHook(() =>
      useMemorySelection(
        "alpha",
        { query: null, kind: "all", onlyNeverRecalled: false, onlyUnconsolidated: false, onlyMissingSource: false, sort: "newest" },
        () => {},
      ),
    );
    act(() => {
      for (let i = 0; i < 501; i += 1) result.current.toggleCheck(`x${i}`, true);
    });
    expect(result.current.checked.size).toBe(500);
    expect(result.current.atCap).toBe(true);
    act(() => result.current.reset());
    expect(result.current.checked.size).toBe(0);
    act(() => result.current.selectLoaded(Array.from({ length: 600 }, (_, i) => `y${i}`)));
    expect(result.current.checked.size).toBe(500);
  });
});

describe("删除确认框", () => {
  it("按勾选顺序发送 ids，成功后刷新并清空选择", async () => {
    const { calls, onToast } = renderMaintenance();
    await selectBank("alpha");
    expect(calls.overview).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m2"));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(within(dialog).getByText(/将从「alpha」删除 2 条记忆/)).toBeInTheDocument();
    expect(calls.preview).toEqual([{ bank: "alpha", ids: ["m2", "m1"] }]);
    expect(calls.deleteItems).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "备份并删除 2 条" }));
    await waitFor(() => expect(calls.deleteItems).toEqual([{ bank: "alpha", ids: ["m2", "m1"] }]));
    expect(onToast).toHaveBeenCalledWith("已删除 2 条，已备份", "info");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("已选 0 条")).toBeInTheDocument();
    expect(calls.overview).toBe(2);
  });

  it("取消不触发删除；删除所选在 0 选中时禁用", async () => {
    const { calls } = renderMaintenance();
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    expect(screen.getByRole("button", { name: "删除所选…" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(calls.preview.length).toBe(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.deleteItems).toEqual([]);
  });

  it("跳过项、引用提示与级联数量如实展示", async () => {
    renderMaintenance({
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
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(within(dialog).getByText("2 条已不在库中，将跳过。")).toBeInTheDocument();
    expect(within(dialog).getByText("该库的情节摘要暂不支持删除：1 条，将跳过。")).toBeInTheDocument();
    expect(within(dialog).getByText(/有 3 条情节摘要引用了这些记忆/)).toBeInTheDocument();
    expect(within(dialog).getByText("同时清理：事实 2 条 · 关联边 1 条。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "备份并删除 1 条" })).toBeEnabled();
  });

  it("全不可删时确认禁用并列出原因条数", async () => {
    const { calls } = renderMaintenance({
      preview: (args) =>
        previewOf(args["ids"] as string[], {
          deletable: { working: 0, episodic: 0 },
          notFound: 1,
          unsupported: 2,
        }),
    });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(
      within(dialog).getByText("所选记忆都无法删除（1 条已不在库中，2 条暂不支持）。"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "备份并删除 0 条" })).toBeDisabled();
    expect(calls.deleteItems).toEqual([]);
  });

  it("空 ids 直接提示且不调用预览", () => {
    const { calls } = installMaintenanceStub();
    render(<MemoryDeleteDialog bank="alpha" displayName="alpha" ids={[]} onClose={() => {}} onToast={() => {}} onDone={() => {}} />);
    expect(screen.getByText("未选择任何记忆。")).toBeInTheDocument();
    expect(calls.preview).toEqual([]);
    expect(calls.status).toEqual([]);
  });

  it("占用中禁用确认并点名持有者，重试后可继续", async () => {
    const { behavior } = renderMaintenance({
      status: () => statusOf("alpha", { inUse: true, holders: [{ pid: 4242, command: "omp" }] }),
    });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(within(dialog).getByText(/该库正被使用：omp \(pid 4242\)/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "备份并删除 1 条" });
    expect(confirm).toBeDisabled();
    behavior.status = () => statusOf("alpha");
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "备份并删除 1 条" })).toBeEnabled());
  });

  it("探测失败禁用确认，重试后可继续", async () => {
    const { behavior } = renderMaintenance({
      status: () => statusOf("alpha", { probeFailed: true }),
    });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    expect(within(dialog).getByText(/无法确认是否有 omp 会话在使用该库/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "备份并删除 1 条" })).toBeDisabled();
    behavior.status = () => statusOf("alpha");
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "备份并删除 1 条" })).toBeEnabled());
  });

  it("提交中禁用按钮且只发一次请求", async () => {
    const gate = Promise.withResolvers<MemoryDeleteResult>();
    const { calls } = renderMaintenance({ deleteItems: () => gate.promise });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    const confirm = within(dialog).getByRole("button", { name: "备份并删除 1 条" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await within(dialog).findByText("删除中…")).toBeInTheDocument();
    await act(async () => {
      gate.resolve({ deleted: ["m1"], skipped: [], backup: backup({ id: "alpha@b", bank: "alpha" }) });
    });
    expect(calls.deleteItems.length).toBe(1);
  });

  it.each([
    ["IN_USE", "先退出占用该库的 omp 会话"],
    ["PROBE_FAILED", "无法确认是否有 omp"],
    ["IO", "删除失败"],
    ["INVALID_INPUT", "删除失败"],
    ["OUTSIDE_ROOT", "删除失败"],
    ["NOT_FOUND", "删除失败"],
  ])("删除失败 %s 给出中文说明并保留原文", async (code, phrase) => {
    renderMaintenance({
      deleteItems: () => {
        throw { code, message: `后端:${code}` };
      },
    });
    await selectBank("alpha");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByLabelText("选择：片段 m1"));
    fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除记忆（alpha）" });
    fireEvent.click(within(dialog).getByRole("button", { name: "备份并删除 1 条" }));
    const note = await within(dialog).findByText(new RegExp(phrase));
    expect(note.textContent).toContain(`后端:${code}`);
    expect(within(dialog).getByRole("button", { name: "备份并删除 1 条" })).toBeEnabled();
  });

  it("详情里的删除这条走同一确认框，成功后收起详情并刷新", async () => {
    const { calls, onToast } = renderMaintenance();
    await selectBank("alpha");
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

  it("行上不放删除按钮，保持紧凑", async () => {
    renderMaintenance();
    await selectBank("alpha");
    const row = screen.getByText("片段 m1").closest(".mem-item") as HTMLElement;
    expect(within(row).queryByRole("button", { name: /删除/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    expect(within(row).queryByRole("button", { name: /删除/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: "复制片段" })).toBeNull();
  });

  it("写错误文案按动作区分动词", () => {
    expect(memoryWriteErrorText({ code: "IN_USE", message: "omp (pid 1)" }, "remove")).toContain("无法移除");
    expect(memoryWriteErrorText({ code: "IO", message: "坏盘" }, "restore")).toBe("恢复失败：坏盘");
    expect(memoryWriteErrorText({ code: "NOT_FOUND", message: "没了" }, "backup-delete")).toBe("删除备份失败：没了");
  });
});

describe("库级操作", () => {
  it("空库建议清理且可移除，成功后刷新", async () => {
    const { calls, onToast } = renderMaintenance();
    await screen.findByRole("button", { name: "alpha" });
    const emptyRow = bankRow("empty");
    expect(within(emptyRow).getByText("建议清理")).toBeInTheDocument();
    expect(within(bankRow("alpha")).queryByText("建议清理")).toBeNull();
    expect(within(bankRow("gone")).getByText("建议清理")).toBeInTheDocument();
    expect(within(bankRow("locked")).queryByRole("button", { name: "移除此库…" })).toBeNull();
    fireEvent.click(within(emptyRow).getByRole("button", { name: "移除此库…" }));
    const dialog = await screen.findByRole("dialog", { name: "移除项目库（empty）" });
    expect(within(dialog).getByText(/工作 0 · 情节 0/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "移除此库" }));
    await waitFor(() => expect(calls.deleteBank).toEqual([{ bank: "empty" }]));
    expect(onToast).toHaveBeenCalledWith("已移除 empty，可在「备份与恢复」中还原", "info");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.overview).toBe(2);
  });

  it("移除被占用时禁用，重试后可继续", async () => {
    const { behavior, calls } = renderMaintenance({
      status: () => statusOf("empty", { inUse: true, holders: [{ pid: 4242, command: "omp" }] }),
    });
    await screen.findByRole("button", { name: "alpha" });
    fireEvent.click(within(bankRow("empty")).getByRole("button", { name: "移除此库…" }));
    const dialog = await screen.findByRole("dialog", { name: "移除项目库（empty）" });
    expect(within(dialog).getByRole("button", { name: "移除此库" })).toBeDisabled();
    behavior.status = () => statusOf("empty");
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "移除此库" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "移除此库" }));
    await waitFor(() => expect(calls.deleteBank).toEqual([{ bank: "empty" }]));
  });

  it("使用中徽标只在选中行时懒查，不随总览加载", async () => {
    const { calls } = renderMaintenance({
      status: () => statusOf("alpha", { inUse: true, holders: [{ pid: 4242, command: "omp" }] }),
    });
    await screen.findByRole("button", { name: "alpha" });
    await screen.findByText("片段 m1").catch(() => null);
    expect(calls.status).toEqual([]);
    expect(screen.queryByText("使用中")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await screen.findByText("片段 m1");
    expect(await screen.findByText("使用中")).toBeInTheDocument();
    expect(calls.status).toEqual([{ bank: "alpha" }]);
  });
});

describe("备份与恢复", () => {
  const two = [
    backup({ id: "alpha@20250102T000000Z-before-delete", bank: "alpha", createdAt: "2026-10-19T10:00:00.000Z" }),
    backup({ id: "gone@20250101T000000Z-bank-removed", bank: "gone", kind: "bank-removed", working: 3, episodic: 0, cwd: "/Users/demo/old" }),
  ];

  it("空状态与留存说明", async () => {
    renderMaintenance({ backups: () => [] });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    expect(within(dialog).getByText("还没有备份。删除记忆或移除库时会自动创建。")).toBeInTheDocument();
    expect(within(dialog).getByText(/每个库自动保留最近 5 份/)).toBeInTheDocument();
  });

  it("列表按时间倒序展示类型与数量，库按钮可预选范围", async () => {
    const { calls } = renderMaintenance({ backups: () => two });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    const rows = within(dialog).getAllByRole("row");
    expect(within(rows[1]).getByText("删除前")).toBeInTheDocument();
    expect(within(rows[2]).getByText("移除的库")).toBeInTheDocument();
    expect(within(rows[1]).getByText("工作 2 · 情节 1")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(bankRow("beta")).getByRole("button", { name: "备份与恢复" }));
    const reopened = await screen.findByRole("dialog", { name: "备份与恢复" });
    expect(within(reopened).getByLabelText("备份项目库范围")).toHaveValue("beta");
    expect(calls.backups[calls.backups.length - 1]).toEqual({ bank: "beta" });
  });

  it("恢复现存库：确认说明安全备份，成功后刷新", async () => {
    const { calls, onToast } = renderMaintenance({ backups: () => two });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    const firstRow = within(dialog).getAllByRole("row")[1];
    fireEvent.click(within(firstRow).getByRole("button", { name: "恢复…" }));
    expect(await within(dialog).findByText(/恢复前会自动为当前内容创建安全备份/)).toBeInTheDocument();
    expect(calls.status).toEqual([{ bank: "alpha" }]);
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(calls.restore).toEqual([{ backupId: "alpha@20250102T000000Z-before-delete" }]),
    );
    expect(onToast).toHaveBeenCalledWith("已恢复 alpha；已为当前内容保留安全备份", "info");
    expect(await within(dialog).findByText("共 2 份")).toBeInTheDocument();
    expect(calls.overview).toBe(2);
  });

  it("恢复已移除的库不查占用门禁且无安全备份后缀", async () => {
    const vanished = backup({ id: "vanished@20250101T000000Z-bank-removed", bank: "vanished", cwd: "/tmp/v" });
    const { behavior, calls, onToast } = renderMaintenance({ backups: () => [vanished] });
    behavior.restore = () => ({ bank: "vanished", restoredFrom: vanished, safetyBackup: null });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    expect(within(dialog).getByText("vanished")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复…" }));
    expect(await within(dialog).findByText(/该库当前已被移除/)).toBeInTheDocument();
    expect(calls.status).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(calls.restore).toEqual([{ backupId: vanished.id }]));
    expect(onToast).toHaveBeenCalledWith("已恢复 vanished", "info");
  });

  it("先看过被占用的现存库恢复页，再看已移除库的恢复页：旧门禁状态不残留", async () => {
    const vanished = backup({ id: "vanished@20250101T000000Z-bank-removed", bank: "vanished", kind: "bank-removed", cwd: "/tmp/v" });
    const { calls } = renderMaintenance({
      backups: () => [two[0], vanished],
      status: () => statusOf("alpha", { inUse: true, holders: [{ pid: 4242, command: "omp" }] }),
    });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    const rowOf = (text: string) =>
      within(dialog).getAllByRole("row").find((r) => within(r).queryByText(text) !== null) as HTMLElement;
    // 现存库 alpha：占用中，恢复被禁用。
    fireEvent.click(within(rowOf("alpha")).getByRole("button", { name: "恢复…" }));
    await within(dialog).findByText(/该库正被使用：omp \(pid 4242\)/);
    expect(within(dialog).getByRole("button", { name: "恢复" })).toBeDisabled();
    // 返回再看已移除的库：不该再显示 alpha 的持有者，且恢复可用。
    fireEvent.click(within(dialog).getByRole("button", { name: "返回" }));
    fireEvent.click(within(rowOf("vanished")).getByRole("button", { name: "恢复…" }));
    expect(await within(dialog).findByText(/该库当前已被移除/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/该库正被使用/)).toBeNull();
    expect(within(dialog).queryByText("正在确认占用状态…")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "恢复" })).toBeEnabled();
    expect(calls.status).toEqual([{ bank: "alpha" }]);
  });

  it("恢复失败留在确认页且不刷新", async () => {
    const { calls } = renderMaintenance({
      backups: () => two,
      restore: () => {
        throw { code: "IO", message: "校验失败" };
      },
    });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    fireEvent.click(within(within(dialog).getAllByRole("row")[1]).getByRole("button", { name: "恢复…" }));
    await within(dialog).findByText(/恢复前会自动为当前内容创建安全备份/);
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复" }));
    expect(await within(dialog).findByText("恢复失败：校验失败")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(calls.overview).toBe(1);
  });

  it("恢复被占用时禁用，重试后可继续", async () => {
    const { behavior } = renderMaintenance({
      backups: () => two,
      status: () => statusOf("alpha", { inUse: true, holders: [{ pid: 7, command: "omp" }] }),
    });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    fireEvent.click(within(within(dialog).getAllByRole("row")[1]).getByRole("button", { name: "恢复…" }));
    await within(dialog).findByText(/该库正被使用/);
    expect(within(dialog).getByRole("button", { name: "恢复" })).toBeDisabled();
    behavior.status = () => statusOf("alpha");
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "恢复" })).toBeEnabled());
  });

  it("永久删除备份需要二次确认，取消不触发", async () => {
    const { calls, onToast } = renderMaintenance({ backups: () => two });
    await screen.findByRole("button", { name: "alpha" });
    openBackupsFromHeader();
    const dialog = await screen.findByRole("dialog", { name: "备份与恢复" });
    fireEvent.click(within(within(dialog).getAllByRole("row")[1]).getByRole("button", { name: "永久删除备份…" }));
    const confirm = await screen.findByRole("dialog", { name: "永久删除备份" });
    expect(calls.deleteBackup).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "返回" }));
    expect(await screen.findByRole("dialog", { name: "备份与恢复" })).toBeInTheDocument();
    expect(calls.deleteBackup).toEqual([]);
    fireEvent.click(within(within(dialog).getAllByRole("row")[1]).getByRole("button", { name: "永久删除备份…" }));
    const confirm2 = await screen.findByRole("dialog", { name: "永久删除备份" });
    fireEvent.click(within(confirm2).getByRole("button", { name: "永久删除" }));
    await waitFor(() =>
      expect(calls.deleteBackup).toEqual([{ backupId: "alpha@20250102T000000Z-before-delete" }]),
    );
    expect(onToast).toHaveBeenCalledWith("已永久删除备份", "info");
  });
});
