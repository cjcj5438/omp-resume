import { beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SessionUsage, UsageHealth, UsageRange, UsageStats } from "../types";
import { mockEmptyUsageHealth, mockEmptyUsageStats, mockSessionUsage, mockUsageHealth, mockUsageStats } from "../dev/usageMock";
import { UsageSummary } from "./UsageSummary";
import { StatsView } from "./StatsView";
import { Donut } from "./UsageDonut";
import { HealthBoard } from "./HealthBoard";

const links = { tab: "usage" as const, sessionTitle: () => null, onOpenSession: () => {}, onToast: () => {} };

beforeEach(() => clearMocks());

it("切换会话后，旧请求的迟到结果和新请求失败均不会展示旧花费", async () => {
  const first = Promise.withResolvers<SessionUsage>();
  const second = Promise.withResolvers<SessionUsage>();
  mockIPC((_cmd, args) => {
    if (args && typeof args === "object" && "path" in args && args.path === "/first") return first.promise;
    return second.promise;
  });
  const view = render(<UsageSummary path="/first" supported revision="1" />);
  view.rerender(<UsageSummary path="/second" supported revision="1" />);
  await act(async () => { first.resolve(mockSessionUsage); });
  expect(screen.queryByLabelText("会话用量与花费")).toBeNull();
  await act(async () => { second.reject({ code: "IO", message: "bad file" }); });
  expect(screen.queryByLabelText("会话用量与花费")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("花费页范围切换的迟到结果不覆盖当前统计；刷新失败可重试并转为空数据", async () => {
  const recent = Promise.withResolvers<UsageStats>();
  const all = Promise.withResolvers<UsageStats>();
  const calls: UsageRange[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "get_usage_stats") return mockUsageHealth("today");
    const range = (args as { range: UsageRange }).range;
    calls.push(range);
    if (calls.length === 1) return recent.promise;
    if (calls.length === 2) return all.promise;
    if (calls.length === 3) throw { code: "IO", message: "扫描失败" };
    return mockEmptyUsageStats(range);
  });
  render(<StatsView {...links} />);
  await waitFor(() => expect(calls).toEqual(["today"]));
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => expect(calls).toEqual(["today", "all"]));
  await act(async () => { all.resolve(mockUsageStats("all")); });
  expect(within(screen.getByLabelText("用量总计")).getByText("$192.60")).toBeTruthy();
  await act(async () => { recent.resolve(mockUsageStats("today")); });
  expect(within(screen.getByLabelText("用量总计")).getByText("$192.60")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新统计" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("扫描失败");
  expect(screen.queryByLabelText("用量总计")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("此范围内暂无用量数据")).toBeTruthy();
});

it("范围切走又快速切回：缓存命中不重复请求，迟到结果不覆盖且刷新可用", async () => {
  const today = mockUsageStats("today");
  const expected = `$${today.total.cost.total.toFixed(2)}`;
  const initial = Promise.withResolvers<UsageStats>();
  const pending = Promise.withResolvers<UsageStats>();
  const calls: UsageRange[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "get_usage_stats") return mockUsageHealth("today");
    if (!args || typeof args !== "object" || !("range" in args)) throw new Error("缺少 range 参数");
    // 测试桩：命令契约保证 range 为 UsageRange，收窄后断言为联合类型。
    const range = args.range as UsageRange;
    calls.push(range);
    if (calls.length === 1) return initial.promise;
    if (calls.length === 2) return pending.promise;
    return mockUsageStats(range);
  });
  render(<StatsView {...links} />);
  await waitFor(() => expect(calls).toEqual(["today"]));
  await act(async () => { initial.resolve(today); });
  expect(within(screen.getByLabelText("用量总计")).getByText(expected)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => expect(calls).toEqual(["today", "all"]));
  // all 尚未返回就切回今天：缓存命中，不应再发请求。
  fireEvent.click(screen.getByRole("button", { name: "今天" }));
  expect(calls).toEqual(["today", "all"]);
  await act(async () => { pending.resolve(mockUsageStats("all")); });
  // 迟到的 all 结果不覆盖今天的数据。
  expect(within(screen.getByLabelText("用量总计")).getByText(expected)).toBeTruthy();
  // 缓存命中必须复位 loading，否则刷新按钮永久禁用。
  const refresh = screen.getByRole("button", { name: "刷新统计" });
  expect(refresh).toBeEnabled();
  fireEvent.click(refresh);
  await waitFor(() => expect(calls).toEqual(["today", "all", "today"]));
});

it("切换范围立刻清掉旧范围数据并显示加载文案", async () => {
  const first = Promise.withResolvers<UsageStats>();
  const second = Promise.withResolvers<UsageStats>();
  const calls: UsageRange[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "get_usage_stats") return mockUsageHealth("today");
    const range = (args as { range: UsageRange }).range;
    calls.push(range);
    return calls.length === 1 ? first.promise : second.promise;
  });
  render(<StatsView {...links} />);
  await waitFor(() => expect(calls).toEqual(["today"]));
  await act(async () => { first.resolve(mockUsageStats("today")); });
  const todayCost = mockUsageStats("today").total.cost.total.toFixed(2);
  expect(screen.getByLabelText("用量总计").textContent).toContain(`$${todayCost}`);
  // 切到没加载过的范围：旧 KPI 立刻消失，换成加载文案。
  fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
  await waitFor(() => expect(calls).toEqual(["today", "7d"]));
  expect(screen.queryByLabelText("用量总计")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("正在扫描用量");
  await act(async () => { second.resolve(mockUsageStats("7d")); });
  expect(await screen.findByLabelText("用量总计")).toBeTruthy();
});

it("趋势全零时给一句说明而不是空坐标系", async () => {
  const stats = mockUsageStats("30d");
  const zeroed: UsageStats = { ...stats, trend: { ...stats.trend, points: stats.trend.points.map((p) => ({ ...p, cost: 0, tokens: { ...p.tokens, total: 0 } })) } };
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? zeroed : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  expect(await screen.findByText("花费在该范围内为 0")).toBeTruthy();
  expect(screen.queryByRole("img", { name: /花费趋势/ })).toBeNull();
  fireEvent.click(within(screen.getByRole("group", { name: "趋势指标" })).getByRole("button", { name: "Token" }));
  expect(await screen.findByText("Token在该范围内为 0")).toBeTruthy();
});

it("花费趋势按范围切换小时/天分桶，all 不补零", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  // 默认「今天」⇒ 小时桶。
  const chart = await screen.findByRole("img", { name: /花费趋势/ });
  expect(chart.getAttribute("aria-label")).toContain("24 小时");
  expect(chart.querySelectorAll("rect.chart-bar").length).toBe(24);
  expect(chart.querySelectorAll("rect.chart-hit").length).toBe(24);
  expect(chart.querySelector("rect.chart-hit")?.getAttribute("data-tip")).toContain("花费");
  expect(chart.querySelector("rect.chart-bar title")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
  await waitFor(() => {
    const next = screen.getByRole("img", { name: /花费趋势/ });
    expect(next.getAttribute("aria-label")).toContain("7 天");
    expect(next.querySelectorAll("rect.chart-bar").length).toBe(7);
    expect(next.querySelectorAll("rect.chart-hit").length).toBe(7);
  });
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => {
    const next = screen.getByRole("img", { name: /花费趋势/ });
    expect(next.querySelectorAll("rect.chart-bar").length).toBe(7);
  });
});

it("看板默认今天；KPI 展示中断注记与缓存未上报；切换标签页各自记住范围且不重复请求", async () => {
  const calls: string[] = [];
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    calls.push(`${cmd}:${range}`);
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  const view = render(<StatsView {...links} />);
  await screen.findByLabelText("用量总计");
  expect(calls).toEqual(["get_usage_stats:today"]);
  view.rerender(<StatsView {...links} tab="health" />);
  expect(await screen.findByLabelText("关键指标")).toBeTruthy();
  expect(calls).toEqual(["get_usage_stats:today", "get_usage_health:today"]);
  const kpis = screen.getByLabelText("关键指标");
  expect(within(kpis).getByText("132")).toBeTruthy();
  expect(within(kpis).getByText("另有 2 次用户中断")).toBeTruthy();
  expect(within(kpis).getByText("62.0%")).toBeTruthy();
  expect(within(screen.getByLabelText("按模型缓存命中")).getByText("—")).toBeTruthy();
  const healthPanel = screen.getByRole("tabpanel", { name: "运行健康" });
  fireEvent.click(within(healthPanel).getByRole("button", { name: "近 7 天" }));
  await waitFor(() => expect(calls).toContain("get_usage_health:7d"));
  view.rerender(<StatsView {...links} tab="usage" />);
  view.rerender(<StatsView {...links} tab="health" />);
  expect(calls.filter((c) => c === "get_usage_health:7d")).toHaveLength(1);
  expect(within(screen.getByLabelText("关键指标")).getByText("940")).toBeTruthy();
});

it("活跃度卡片：热力图铺开 + 紧贴汇总（活跃天数 / 合计 / 最高单日 / 连续）", async () => {
  const stats = mockUsageStats("30d");
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? stats : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const card = await screen.findByLabelText("活跃度");
  // 卡片独占一行（不在 health-grid 里），图例随网格走（右下对齐）。
  expect(card.closest(".health-grid")).toBeNull();
  const heat = within(card).getByRole("group", { name: /活跃度热力图/ });
  expect(heat.querySelectorAll(".heat-cell").length).toBe(182);
  expect(within(card).getByText("活跃天数")).toBeTruthy();
  expect(within(card).getByText("合计花费")).toBeTruthy();
  expect(within(card).getByText("连续活跃天数")).toBeTruthy();
  expect(card.textContent).toContain("最高单日");
  // 图例不在卡片头：与网格同组，位于网格下方右对齐。
  expect(within(card).getByText("少").closest(".card-head")).toBeNull();
  const wrap = heat.parentElement;
  expect(wrap?.className).toContain("heat-wrap");
  expect(wrap?.querySelector(".heat-foot .heat-legend")).toBeTruthy();
});

it("看板空数据给出克制空态，命中率显示“—”而非 0%", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockEmptyUsageStats(range) : mockEmptyUsageHealth(range);
  });
  render(<StatsView {...links} tab="health" />);
  expect((await screen.findAllByText("此范围内暂无请求")).length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText("此范围内还没有错误").length).toBeGreaterThanOrEqual(2);
  const cache = screen.getByLabelText("按模型缓存命中");
  expect(within(cache).getByText("此范围内暂无模型缓存数据")).toBeTruthy();
  const kpis = screen.getByLabelText("关键指标");
  expect(within(kpis).getByText("—")).toBeTruthy();
});

it("上游不报缓存时 KPI 显示“—”并说明原因，而不是 0%", async () => {
  const health: UsageHealth = mockUsageHealth("today");
  health.cache.hitRate = null;
  mockIPC((cmd) => cmd === "get_usage_stats" ? mockUsageStats("30d") : health);
  render(<StatsView {...links} tab="health" />);
  const kpis = await screen.findByLabelText("关键指标");
  expect(within(kpis).getByText("—")).toBeTruthy();
  expect(within(kpis).getByText("该上游未返回缓存数据")).toBeTruthy();
  expect(within(kpis).queryByText("0.0%")).toBeNull();
});

it("错误类型与兜底去向按契约中文映射展示", async () => {
  const health: UsageHealth = mockUsageHealth("30d");
  mockIPC((cmd) => cmd === "get_usage_stats" ? mockUsageStats("30d") : health);
  render(<StatsView {...links} tab="health" />);
  const kinds = await screen.findByLabelText("错误类型分布");
  expect(within(kinds).getByText("触发限流")).toBeTruthy();
  expect(within(kinds).getByText("响应超时")).toBeTruthy();
  const fallbacks = screen.getByLabelText("兜底去向");
  expect(within(fallbacks).getByText("anthropic / claude-haiku-4-5")).toBeTruthy();
  expect(fallbacks.textContent).toContain("未知来源 →");
  expect(fallbacks.textContent).toContain("anthropic / claude-sonnet-4-5 →");
  expect(within(screen.getByLabelText("最近错误")).getAllByText("触发限流").length).toBeGreaterThan(0);
});

it("最近错误/兜底出现同毫秒重复条目时全部渲染且无 key 冲突警告", () => {
  const base = mockUsageHealth("today");
  const health: UsageHealth = {
    ...base,
    errors: {
      ...base.errors,
      total: 2,
      recent: [
        { time: 1789824000000, provider: "p1", model: "m1", kind: "quota", message: "额度用尽" },
        { time: 1789824000000, provider: "p1", model: "m1", kind: "quota", message: "额度用尽" },
      ],
    },
    fallbacks: {
      ...base.fallbacks,
      total: 2,
      recent: [
        { time: 1789824000000, from: null, to: { provider: "p2", model: "m2" } },
        { time: 1789824000000, from: null, to: { provider: "p2", model: "m2" } },
      ],
    },
  };
  const logged: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  try {
    render(<HealthBoard data={health} />);
    expect(screen.getByLabelText("最近错误").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByLabelText("最近兜底切换").querySelectorAll("li")).toHaveLength(2);
    expect(logged.join("\n")).not.toContain("same key");
  } finally {
    spy.mockRestore();
  }
});

it("总览仪表盘：6 KPI / 双环形 / 模型速度 / 热力图 182 格", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats("30d") : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const grid = await screen.findByLabelText("用量总计");
  const labels = [...grid.querySelectorAll(".kpi-label")].map((el) => el.textContent);
  expect(labels).toEqual(["会话", "累计 Token", "费用", "缓存命中", "工具调用", "活跃时长"]);
  const tokenDonut = screen.getByLabelText("Token 构成").querySelector("svg");
  expect(tokenDonut?.getAttribute("aria-label")).toContain("输入");
  const timeDonut = screen.getByLabelText("耗时构成");
  expect(timeDonut.querySelector("svg")?.getAttribute("aria-label")).toContain("模型等待");
  expect(timeDonut.textContent).toContain("输出速度 142.6 tok/s");
  const models = screen.getByLabelText("按模型");
  expect(models.textContent).toContain("速度");
  expect(models.textContent).toContain("首字延迟");
  expect(models.textContent).toContain("118.4 tok/s");
  expect(models.textContent).toContain("7.4s");
  const heat = screen.getByRole("group", { name: /活跃度热力图/ });
  expect(heat.querySelectorAll(".heat-cell").length).toBe(182);
});

it("指标切换：Token / 花费切换趋势图且柱数不变", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const chart = await screen.findByRole("img", { name: /花费趋势/ });
  const bars = chart.querySelectorAll("rect.chart-bar").length;
  fireEvent.click(within(screen.getByRole("group", { name: "趋势指标" })).getByRole("button", { name: "Token" }));
  await waitFor(() => {
    const next = screen.getByRole("img", { name: /Token 趋势/ });
    expect(next.getAttribute("aria-label")).toMatch(/^Token 趋势/);
    expect(next.querySelectorAll("rect.chart-bar").length).toBe(bars);
  });
  fireEvent.click(within(screen.getByRole("group", { name: "趋势指标" })).getByRole("button", { name: "花费" }));
  await waitFor(() => {
    expect(screen.getByRole("img", { name: /花费趋势/ }).querySelectorAll("rect.chart-bar").length).toBe(bars);
  });
});

it("高花费会话：有标题行可点击打开，其余行为纯展示", async () => {
  const stats = mockUsageStats("30d");
  const firstPath = stats.topSessions[0].path;
  const onOpenSession = vi.fn();
  mockIPC(() => stats);
  render(<StatsView tab="usage" sessionTitle={(p) => (p === firstPath ? "会话甲" : null)} onOpenSession={onOpenSession} onToast={() => {}} />);
  const section = await screen.findByLabelText("高花费会话");
  expect(section.querySelectorAll("button.top-row").length).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: /会话甲/ }));
  expect(onOpenSession).toHaveBeenCalledTimes(1);
  expect(onOpenSession).toHaveBeenCalledWith(firstPath);
});

it("空统计：暂无用量数据且不渲染活跃度", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockEmptyUsageStats(range) : mockEmptyUsageHealth(range);
  });
  render(<StatsView {...links} />);
  expect(await screen.findByText("此范围内暂无用量数据")).toBeTruthy();
  expect(screen.queryByLabelText("活跃度")).toBeNull();
});

it("Donut 零和降级：显示暂无数据", () => {
  render(<Donut label="x" slices={[]} center="0" centerSub="y" />);
  expect(screen.getByText("暂无数据")).toBeTruthy();
});

it("热力指标切换 Token 后格子等级按 Token 重算；点击格子显示选中日与涨跌", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const card = await screen.findByLabelText("活跃度");
  const heat = within(card).getByRole("group", { name: /活跃度热力图/ });
  const cells = Array.from(heat.querySelectorAll("button.heat-cell"));
  expect(cells.length).toBe(182);
  const withUsage = cells.find((c) => (c.getAttribute("aria-label") ?? "").includes("花费"));
  expect(withUsage).not.toBeUndefined();
  const heatSeg = within(card).getByRole("group", { name: "热力指标" });
  fireEvent.click(within(heatSeg).getByRole("button", { name: "Token" }));
  const cellsAfter = Array.from(heat.querySelectorAll("button.heat-cell"));
  expect(cellsAfter.length).toBe(182);
  // 同一格子的取值文案从花费切到 Token。
  const key0 = withUsage!.getAttribute("aria-label")?.split(" ")[0];
  const same = cellsAfter.find((c) => c.getAttribute("aria-label")?.startsWith(key0 ?? "???"));
  expect(same?.getAttribute("aria-label")).toContain("Token");
  expect(card.textContent).toContain("按日Token");

  // 点击一个格子：选中日块显示该日期与涨跌。
  const target = cells[cells.length - 1];
  const key = target.getAttribute("aria-label")?.split(" ")[0] ?? "";
  fireEvent.click(target);
  const day = await screen.findByLabelText("选中日");
  expect(day.textContent).toContain(key);
  expect(day.textContent).toContain("较前 7 天日均");
  expect(target.getAttribute("aria-pressed")).toBe("true");
});

it("复制摘要：数据就绪前禁用，就绪后启用", async () => {
  const onToast = vi.fn();
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} onToast={onToast} />);
  const btn = screen.getByRole("button", { name: "复制摘要" });
  expect(btn).toBeDisabled();
  await screen.findByLabelText("用量总计");
  await waitFor(() => expect(btn).toBeEnabled());
});

it("健康页错误类型筛选：选一类后标题显示 N/M 条，无此类显示空态", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} tab="health" />);
  const card = await screen.findByLabelText("最近错误");
  const seg = within(card).getByRole("group", { name: "错误类型筛选" });
  const kinds = within(seg).getAllByRole("button").map((b) => b.textContent);
  expect(kinds[0]).toContain("全部");
  expect(kinds.length).toBeGreaterThan(1);
  // 选第一个具体类型：标题显示 N/M 条。
  const first = within(seg).getAllByRole("button")[1];
  fireEvent.click(first);
  expect(card.textContent).toMatch(/\d+\/\d+ 条/);
});
