/**
 * 记忆库面板测试：健康卡口径、不可用状态、列表请求参数、防抖与过期响应、
 * 分页、来源跳转门禁、详情截断与展开、错误提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type {
  MemoryBankSummary,
  MemoryDetail,
  MemoryItem,
  MemoryOverview,
  MemoryPage,
  MemoryTotals,
} from "../types";
import { MemoryPanel } from "./MemoryPanel";

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
  banks: 4,
  working: 40,
  episodic: 60,
  facts: 7,
  bytes: 2048,
  neverRecalled: 51,
  unconsolidated: 30,
  missingSourceSessions: 2,
  sourceSessions: 10,
};

const BANKS: MemoryBankSummary[] = [
  bank({ bank: "alpha", displayName: "alpha", working: 30, episodic: 40, bytes: 1024, neverRecalled: 30, unconsolidated: 60 }),
  bank({ bank: "beta", displayName: "beta", cwd: "/Users/demo/my/beta", working: 10, episodic: 20, bytes: 1024 }),
  bank({ bank: "empty", displayName: "empty", cwd: null }),
  bank({ bank: "gone", displayName: "gone", cwd: "/Users/demo/old", cwdExists: false }),
  { ...bank({ bank: "locked", displayName: "locked" }), readable: false, error: "目录无读取权限" },
];

function overviewOf(over: Partial<MemoryOverview> = {}): MemoryOverview {
  return {
    available: true,
    backend: "mnemopi",
    root: "/Users/demo/.omp/agent/memory",
    banks: BANKS,
    totals: TOTALS,
    ...over,
  };
}

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

function page(items: MemoryItem[], total = items.length): MemoryPage {
  return { total, items };
}

interface Stub {
  listCalls: Record<string, unknown>[];
  growthCalls: Record<string, unknown>[];
  detailCalls: Record<string, unknown>[];
  list: (args: Record<string, unknown>) => MemoryPage | Promise<MemoryPage>;
  detail?: (args: Record<string, unknown>) => MemoryDetail | Promise<MemoryDetail>;
}

function installStub(overview: MemoryOverview, over: Partial<Stub> = {}): Stub {
  const stub: Stub = {
    listCalls: [],
    growthCalls: [],
    detailCalls: [],
    list: () => page([item({ id: "a" })]),
    ...over,
  };
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (cmd === "memory_overview") return structuredClone(overview);
    if (cmd === "memory_growth") {
      stub.growthCalls.push(args);
      return [{ date: "2026-10-18", working: 1, episodic: 0 }];
    }
    if (cmd === "memory_list") {
      stub.listCalls.push(args);
      return stub.list(args);
    }
    if (cmd === "memory_detail") {
      stub.detailCalls.push(args);
      if (!stub.detail) throw { code: "NOT_FOUND", message: "无详情桩" };
      return stub.detail(args);
    }
    return null;
  });
  return stub;
}

function renderPanel(opts: {
  overview?: MemoryOverview;
  loaded?: string[];
  list?: Stub["list"];
  detail?: Stub["detail"];
} = {}) {
  const onToast = vi.fn();
  const onOpenSession = vi.fn();
  const stub = installStub(opts.overview ?? overviewOf(), { list: opts.list, detail: opts.detail });
  render(
    <MemoryPanel
      loadedSessionIds={new Set(opts.loaded ?? [])}
      onOpenSession={onOpenSession}
      onToast={onToast}
    />,
  );
  return { stub, onToast, onOpenSession };
}

beforeEach(() => {
  clearMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("总览与健康卡", () => {
  it("百分比按条数计算，超过一半用警示底色", async () => {
    renderPanel();
    const cards = await screen.findByLabelText("记忆库健康状况");
    const cardOf = (label: string) =>
      (within(cards).getByText(label).closest(".mem-card") as HTMLElement).textContent ?? "";
    expect(cardOf("记忆总数")).toContain("100");
    expect(cardOf("记忆总数")).toContain("工作 40 · 情节 60");
    expect(cardOf("从未被召回")).toContain("51%");
    expect(cardOf("尚未合并")).toContain("占工作记忆 75%");
    expect(cardOf("来源会话已不在")).toContain("2/10");
    expect(cardOf("磁盘占用")).toContain("2.0 KB");
    const never = within(cards).getByText("从未被召回").closest(".mem-card");
    const uncons = within(cards).getByText("尚未合并").closest(".mem-card");
    expect(never).toHaveClass("mem-card-warn");
    expect(uncons).toHaveClass("mem-card-warn");
  });

  it("总数为 0 时百分比显示破折号而不是 NaN", async () => {
    renderPanel({
      overview: overviewOf({
        banks: [bank({ bank: "alpha", displayName: "alpha" })],
        totals: {
          banks: 1,
          working: 0,
          episodic: 0,
          facts: 0,
          bytes: 0,
          neverRecalled: 0,
          unconsolidated: 0,
          missingSourceSessions: 0,
          sourceSessions: 0,
        },
      }),
    });
    const cards = await screen.findByLabelText("记忆库健康状况");
    expect(within(cards).getByText("占 —")).toBeInTheDocument();
    expect(within(cards).getByText("占工作记忆 —")).toBeInTheDocument();
    expect(within(cards).queryByText(/NaN/)).toBeNull();
    expect(within(cards).getByText("0 B")).toBeInTheDocument();
  });

  it("不可用时给出平和说明而非报错", async () => {
    const { onToast } = renderPanel({ overview: overviewOf({ available: false, backend: null, banks: [], totals: TOTALS }) });
    expect(await screen.findByText("未找到本地记忆库")).toBeInTheDocument();
    expect(screen.getByText(/本页只展示本地 Mnemopi 记忆库/)).toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalled();
  });
});

describe("项目库与列表请求", () => {
  it("点击项目库按默认参数请求该库", async () => {
    const { stub } = renderPanel({ overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }) });
    fireEvent.click(await screen.findByRole("button", { name: "beta" }));
    await waitFor(() => expect(stub.listCalls.length).toBeGreaterThan(0));
    expect(stub.listCalls[stub.listCalls.length - 1]).toEqual({
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

  it("唯一有数据的库会被预选并加载", async () => {
    const { stub } = renderPanel({
      overview: overviewOf({
        banks: [bank({ bank: "solo", displayName: "solo", working: 3 }), bank({ bank: "empty", displayName: "empty" })],
      }),
    });
    await waitFor(() => expect(stub.listCalls[0]?.bank).toBe("solo"));
  });

  it("过滤条件组合成正确参数", async () => {
    const { stub } = renderPanel({ overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }) });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() => expect(stub.listCalls.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "从未召回" }));
    fireEvent.click(screen.getByRole("button", { name: "未合并" }));
    fireEvent.click(screen.getByRole("button", { name: "来源已不在" }));
    fireEvent.change(screen.getByLabelText("记忆类型"), { target: { value: "working" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "mostRecalled" } });
    await waitFor(() => expect(stub.listCalls[stub.listCalls.length - 1]).toMatchObject({
      bank: "alpha",
      kind: "working",
      onlyNeverRecalled: true,
      onlyUnconsolidated: true,
      onlyMissingSource: true,
      sort: "mostRecalled",
      offset: 0,
    }));
  });

  it("搜索在 200ms 后才发请求，并带上查询词", async () => {
    vi.useFakeTimers();
    const { stub } = renderPanel({ overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = stub.listCalls.length;
    fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "缓存" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(stub.listCalls.length).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(stub.listCalls[stub.listCalls.length - 1]).toMatchObject({ query: "缓存" });
  });

  it("慢的旧响应不会覆盖新结果", async () => {
    const slow = Promise.withResolvers<MemoryPage>();
    const fast = Promise.withResolvers<MemoryPage>();
    let listCount = 0;
    const { stub } = renderPanel({
      overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }),
      list: () => {
        listCount += 1;
        if (listCount === 1) return page([item({ id: "init", snippet: "初始结果" })]);
        if (listCount === 2) return slow.promise;
        return fast.promise;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    await screen.findByText("初始结果");
    fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "a" } });
    await waitFor(() => expect(stub.listCalls.length).toBe(2));
    fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "ab" } });
    await waitFor(() => expect(stub.listCalls.length).toBe(3));
    await act(async () => {
      fast.resolve(page([item({ id: "fast", snippet: "新结果" })]));
    });
    expect(await screen.findByText("新结果")).toBeInTheDocument();
    await act(async () => {
      slow.resolve(page([item({ id: "slow", snippet: "过期结果" })]));
    });
    expect(screen.queryByText("过期结果")).toBeNull();
    expect(screen.getByText("新结果")).toBeInTheDocument();
  });

  it("加载更多以已显示条数为 offset 追加", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => item({ id: `p${i}`, snippet: `第 ${i} 条` }));
    const secondPage = Array.from({ length: 10 }, (_, i) => item({ id: `q${i}`, snippet: `补充 ${i} 条` }));
    const { stub } = renderPanel({
      overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }),
      list: (args) => (args["offset"] === 0 ? page(firstPage, 60) : page(secondPage, 60)),
    });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    expect(await screen.findByText(/已显示 50 \/ 共 60 条/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("补充 0 条")).toBeInTheDocument();
    expect(screen.getByText("第 0 条")).toBeInTheDocument();
    expect(stub.listCalls[stub.listCalls.length - 1]).toMatchObject({ offset: 50, limit: 50 });
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("列表请求失败时 toast 并在行内提示", async () => {
    const { onToast } = renderPanel({
      overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }),
      list: () => {
        throw { code: "IO", message: "模拟读取失败" };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("加载记忆列表失败：模拟读取失败", "error"));
    expect(await screen.findByText("加载失败：模拟读取失败")).toBeInTheDocument();
    expect(screen.getByText(/记忆后端：mnemopi/)).toBeInTheDocument();
  });
});

describe("来源会话与详情", () => {
  const items = [
    item({ id: "loaded", snippet: "来源已加载", sourceSessionId: "s1", sourceSessionExists: true }),
    item({ id: "notloaded", snippet: "来源未加载", sourceSessionId: "s2", sourceSessionExists: true }),
    item({ id: "gone", snippet: "来源已删除", sourceSessionId: "s3", sourceSessionExists: false }),
    item({ id: "nosource", snippet: "没有来源" }),
  ];

  it("仅当来源会话已加载时可跳转，且回调收到会话 id", async () => {
    const { onOpenSession } = renderPanel({
      overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }),
      loaded: ["s1"],
      list: () => page(items),
    });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    await screen.findByText("来源已加载");
    const rowOfSnippet = (text: string) => screen.getByText(text).closest(".mem-item") as HTMLElement;
    const jumpIn = (text: string) => within(rowOfSnippet(text)).getByRole("button", { name: "查看来源会话" });

    expect(jumpIn("来源已加载")).toBeEnabled();
    expect(jumpIn("来源未加载")).toBeDisabled();
    expect(jumpIn("来源未加载")).toHaveAttribute("title", "来源会话未加载到当前列表");
    expect(jumpIn("来源已删除")).toBeDisabled();
    expect(jumpIn("来源已删除")).toHaveAttribute("title", "来源会话已不在（可能已被删除）");
    expect(jumpIn("没有来源")).toBeDisabled();
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
      metadata: { lane: "working" },
      facts: [{ subject: "用户", predicate: "偏好", object: "中文提交信息", key: "pref:commit-lang" }],
      summaryOf: ["mem-1"],
      relatedEdges: 3,
    };
    const { stub } = renderPanel({
      overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }),
      list: () => page([detail]),
      detail: () => detail,
    });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    fireEvent.click(await screen.findByText("超长条目"));
    expect(await screen.findByText(/内容过长，仅显示前 8000 字符（全文 30720 字符）/)).toBeInTheDocument();
    expect(stub.detailCalls[0]).toEqual({ bank: "alpha", id: "big" });
    expect(screen.getByText("用户 · 偏好 · 中文提交信息")).toBeInTheDocument();
    expect(screen.getByText("mem-1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    const content = document.querySelector(".mem-content") as HTMLElement;
    expect(content).toHaveClass("mem-content-collapsed");
    fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
    expect(content).not.toHaveClass("mem-content-collapsed");
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("翻页不会丢弃已打开的详情请求", async () => {
    const pending = Promise.withResolvers<MemoryDetail>();
    const firstPage = Array.from({ length: 50 }, (_, i) => item({ id: `p${i}`, snippet: `第 ${i} 条` }));
    const { stub } = renderPanel({
      overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }),
      list: (args) =>
        args["offset"] === 0 ? page(firstPage, 60) : page([item({ id: "more", snippet: "更多一条" })], 60),
      detail: () => pending.promise,
    });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    await screen.findByText("第 0 条");
    fireEvent.click(screen.getByText("第 0 条"));
    await waitFor(() => expect(stub.detailCalls.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByText("更多一条");
    await act(async () => {
      pending.resolve({
        ...item({ id: "p0", snippet: "第 0 条" }),
        content: "详情正文",
        truncated: false,
        embedText: null,
        metadata: null,
        facts: [],
        summaryOf: [],
        relatedEdges: 0,
      });
    });
    expect(await screen.findByText("详情正文")).toBeInTheDocument();
  });

  it("详情加载失败 toast 且不影响列表", async () => {
    const { onToast } = renderPanel({
      overview: overviewOf({ banks: [BANKS[0], BANKS[1]] }),
      list: () => page([item({ id: "x", snippet: "详情会失败" })]),
      detail: () => {
        throw { code: "IO", message: "读不出来" };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    fireEvent.click(await screen.findByText("详情会失败"));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("加载记忆详情失败：读不出来", "error"));
    expect(await screen.findByText("详情加载失败：读不出来")).toBeInTheDocument();
    expect(screen.getByText("详情会失败")).toBeInTheDocument();
  });
});
