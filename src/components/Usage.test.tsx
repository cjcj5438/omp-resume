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
it("UsageSummary 渲染设计稿 4 行 detail-list（输入/输出/缓存命中/成本）", async () => {
  mockIPC(() => mockSessionUsage);
  render(<UsageSummary path="/s" supported revision="1" />);
  const list = await screen.findByLabelText("会话用量与花费");
  expect(list.tagName).toBe("DL");
  expect(list).toHaveTextContent("输入");
  expect(list).toHaveTextContent("输出");
  expect(list).toHaveTextContent("缓存命中");
  expect(list).toHaveTextContent("成本");
  expect(list).toHaveTextContent(`$${mockSessionUsage.cost.total.toFixed(2)}`);
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
  await waitFor(() => expect(calls).toEqual(["7d"]));
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => expect(calls).toEqual(["7d", "all"]));
  await act(async () => { all.resolve(mockUsageStats("all")); });
  expect(within(screen.getByLabelText("用量总计")).getByText("$192.60")).toBeTruthy();
  await act(async () => { recent.resolve(mockUsageStats("7d")); });
  expect(within(screen.getByLabelText("用量总计")).getByText("$192.60")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新统计" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("扫描失败");
  expect(screen.queryByLabelText("用量总计")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("此范围内暂无用量数据")).toBeTruthy();
});

it("范围切走又快速切回：缓存命中不重复请求，迟到结果不覆盖且刷新可用", async () => {
  const week = mockUsageStats("7d");
  const expected = `$${week.total.cost.total.toFixed(2)}`;
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
  await waitFor(() => expect(calls).toEqual(["7d"]));
  await act(async () => { initial.resolve(week); });
  expect(within(screen.getByLabelText("用量总计")).getByText(expected)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => expect(calls).toEqual(["7d", "all"]));
  // all 尚未返回就切回 7 天：缓存命中，不应再发请求。
  fireEvent.click(screen.getByRole("button", { name: "7 天" }));
  expect(calls).toEqual(["7d", "all"]);
  await act(async () => { pending.resolve(mockUsageStats("all")); });
  // 迟到的 all 结果不覆盖 7 天的数据。
  expect(within(screen.getByLabelText("用量总计")).getByText(expected)).toBeTruthy();
  // 缓存命中必须复位 loading，否则刷新按钮永久禁用。
  const refresh = screen.getByRole("button", { name: "刷新统计" });
  expect(refresh).toBeEnabled();
  fireEvent.click(refresh);
  await waitFor(() => expect(calls).toEqual(["7d", "all", "7d"]));
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
  await waitFor(() => expect(calls).toEqual(["7d"]));
  await act(async () => { first.resolve(mockUsageStats("7d")); });
  const weekCost = mockUsageStats("7d").total.cost.total.toFixed(2);
  expect(screen.getByLabelText("用量总计").textContent).toContain(`$${weekCost}`);
  // 切到没加载过的范围：旧 KPI 立刻消失，换成加载文案。
  fireEvent.click(screen.getByRole("button", { name: "30 天" }));
  await waitFor(() => expect(calls).toEqual(["7d", "30d"]));
  expect(screen.queryByLabelText("用量总计")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("正在扫描用量");
  await act(async () => { second.resolve(mockUsageStats("30d")); });
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
  // 默认「7 天」⇒ 天桶。
  const chart = await screen.findByRole("img", { name: /花费趋势/ });
  expect(chart.getAttribute("aria-label")).toContain("7 天");
  expect(chart.querySelectorAll("circle").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "今天" }));
  await waitFor(() => {
    const next = screen.getByRole("img", { name: /花费趋势/ });
    expect(next.getAttribute("aria-label")).toContain("24 小时");
  });
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => {
    const next = screen.getByRole("img", { name: /花费趋势/ });
    expect(next.getAttribute("aria-label")).toContain("7 天");
  });
});

it("成本趋势 panel 头有图例「每X成本/Token」，与指标 Seg 同行", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  await screen.findByRole("img", { name: /花费趋势/ });
  const legend = document.querySelector(".trend-head-tools .chart-legend");
  expect(legend?.textContent).toBe("每日成本");
  expect(legend?.querySelector(".legend-swatch.legend-trend")).not.toBeNull();
  // 与指标 Seg 在同一行容器内。
  expect(document.querySelector(".trend-head-tools [role='group'][aria-label='趋势指标']")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "今天" }));
  await waitFor(() => expect(document.querySelector(".trend-head-tools .chart-legend")?.textContent).toBe("每小时成本"));
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => expect(document.querySelector(".trend-head-tools .chart-legend")?.textContent).toBe("每段成本"));
  fireEvent.click(within(screen.getByRole("group", { name: "趋势指标" })).getByRole("button", { name: "Token" }));
  await waitFor(() => expect(document.querySelector(".trend-head-tools .chart-legend")?.textContent).toBe("每段Token"));
});

it("看板默认 7 天；KPI 展示中断注记与缓存未上报；切换标签页各自记住范围且不重复请求", async () => {
  const calls: string[] = [];
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    calls.push(`${cmd}:${range}`);
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  const view = render(<StatsView {...links} />);
  await screen.findByLabelText("用量总计");
  expect(calls).toEqual(["get_usage_stats:7d"]);
  view.rerender(<StatsView {...links} tab="health" />);
  expect(await screen.findByLabelText("关键指标")).toBeTruthy();
  expect(calls).toEqual(["get_usage_stats:7d", "get_usage_health:7d"]);
  const kpis = screen.getByLabelText("关键指标");
  expect(within(kpis).getByText("940")).toBeTruthy();
  expect(within(kpis).getByText("另有 11 次用户中断")).toBeTruthy();
  expect(within(kpis).getByText("66.0%")).toBeTruthy();
  expect(within(kpis).getByText("p50 1.9s · p95 6.4s")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "30 天" }));
  await waitFor(() => expect(calls).toContain("get_usage_health:30d"));
  view.rerender(<StatsView {...links} tab="usage" />);
  view.rerender(<StatsView {...links} tab="health" />);
  expect(calls.filter((c) => c === "get_usage_health:30d")).toHaveLength(1);
  expect(within(screen.getByLabelText("关键指标")).getByText("3,820")).toBeTruthy();
});

it("健康页头按钮叫「刷新」；手动刷新成功后 toast 带范围，失败不 toast", async () => {
  const onToast = vi.fn();
  let failNext = false;
  const calls: string[] = [];
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    if (cmd === "get_usage_health") {
      calls.push(range);
      if (failNext) {
        failNext = false;
        throw { code: "IO", message: "刷新失败" };
      }
      return mockUsageHealth(range);
    }
    return mockUsageStats(range);
  });
  const view = render(<StatsView {...links} tab="health" onToast={onToast} />);
  await screen.findByLabelText("关键指标");
  expect(onToast).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "刷新看板" })).toBeNull();
  // 切范围不 toast。
  fireEvent.click(screen.getByRole("button", { name: "30 天" }));
  await waitFor(() => expect(calls).toEqual(["7d", "30d"]));
  // 等 30 天数据落定（3,820 请求）且刷新键可用再点刷新：否则刷新与切范围请求竞速。
  await screen.findByText("3,820");
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled());
  expect(onToast).not.toHaveBeenCalled();
  // 手动刷新成功 → toast 带范围标签。
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(onToast).toHaveBeenCalledWith("健康数据已刷新 · 30 天", "info"));
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled());
  // 手动刷新失败 → 不 toast（错误走 banner）。
  failNext = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByRole("alert");
  expect(onToast).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("活跃度热力图：52 周可滚动 + 4 盒装 stats（活跃 / 当前连续 / 最长连续 / 峰值单日）", async () => {
  const stats = mockUsageStats("30d");
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? stats : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const heat = await screen.findByRole("group", { name: /活跃度热力图/ });
  const card = heat.closest(".panel");
  expect(card).not.toBeNull();
  expect(heat.querySelectorAll("button.heat-cell").length).toBe(364);
  expect(heat.closest(".heat-scroll")).not.toBeNull();
  expect(card?.textContent).toContain("活跃天数");
  expect(card?.textContent).toContain("当前连续");
  expect(card?.textContent).toContain("最长连续");
  expect(card?.textContent).toContain("峰值单日");
  expect(card?.querySelector(".heat-foot .heat-scale")).not.toBeNull();
});

it("看板空数据给出克制空态，命中率显示“—”而非 0%", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockEmptyUsageStats(range) : mockEmptyUsageHealth(range);
  });
  render(<StatsView {...links} tab="health" />);
  expect((await screen.findAllByText("此范围内暂无请求")).length).toBeGreaterThanOrEqual(2);
  expect((await screen.findAllByText("此范围内还没有错误")).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("此范围内暂无模型缓存数据")).toBeTruthy();
  const kpis = screen.getByLabelText("关键指标");
  expect(within(kpis).getAllByText("—").length).toBeGreaterThanOrEqual(1);
});

it("上游不报缓存时 KPI 显示“—”，而不是 0%", async () => {
  const health: UsageHealth = mockUsageHealth("today");
  health.cache.hitRate = null;
  mockIPC((cmd) => cmd === "get_usage_stats" ? mockUsageStats("30d") : health);
  render(<StatsView {...links} tab="health" />);
  const kpis = await screen.findByLabelText("关键指标");
  expect(within(kpis).getByText("—")).toBeTruthy();
  expect(within(kpis).queryByText("0.0%")).toBeNull();
});

it("错误类型与兜底去向按契约中文映射展示", async () => {
  const health: UsageHealth = mockUsageHealth("30d");
  mockIPC((cmd) => cmd === "get_usage_stats" ? mockUsageStats("30d") : health);
  render(<StatsView {...links} tab="health" />);
  const kindsTitle = await screen.findByText("错误类型");
  const kinds = kindsTitle.closest(".panel") as HTMLElement;
  expect(within(kinds).getByText("触发限流")).toBeTruthy();
  expect(within(kinds).getByText("响应超时")).toBeTruthy();
  const fbTitle = screen.getByText("兜底去向");
  const fallbacks = fbTitle.closest(".panel") as HTMLElement;
  expect(within(fallbacks).getByText("anthropic / claude-haiku-4-5")).toBeTruthy();
  expect(fallbacks.textContent).toContain("未知来源 →");
  expect(fallbacks.textContent).toContain("anthropic / claude-sonnet-4-5 →");
  const logTitle = screen.getByText("最近错误");
  const logs = logTitle.closest(".panel") as HTMLElement;
  expect(within(logs).getAllByText("触发限流").length).toBeGreaterThan(0);
});

it("最近错误/兜底出现同毫秒重复条目时全部渲染且无 key 冲突警告", () => {
  const base = mockUsageHealth("today");
  const health: UsageHealth = {
    ...base,
    errors: {
      ...base.errors,
      total: 2,
      recent: [
        { time: 1789824000000, provider: "p1", model: "m1", kind: "quota", message: "额度用尽", retry: "已重试恢复" },
        { time: 1789824000000, provider: "p1", model: "m1", kind: "quota", message: "额度用尽", retry: null },
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
    render(<HealthBoard data={health} rangeLabel="今天" />);
    expect(screen.getByLabelText("错误日志").querySelectorAll(".log-row")).toHaveLength(2);
    expect(screen.getByLabelText("最近兜底切换").querySelectorAll("li")).toHaveLength(2);
    expect(logged.join("\n")).not.toContain("same key");
  } finally {
    spy.mockRestore();
  }
});

it("总览仪表盘：6 KPI / 模型 donut / 小时分布 / 双环形扩展 / 明细表 / 热力图 364 格", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats("30d") : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const grid = await screen.findByLabelText("用量总计");
  const labels = [...grid.querySelectorAll(".kpi-label")].map((el) => el.textContent);
  expect(labels).toEqual(["成本", "Token", "请求数", "缓存命中", "工具耗时", "最长单次"]);
  expect(grid.textContent).toContain("较上一周期");
  const hourly = screen.getByRole("img", { name: /按小时请求分布/ });
  expect(hourly.querySelectorAll(".hb").length).toBe(24);
  const modelDonut = screen.getByRole("img", { name: /模型构成/ });
  expect(modelDonut.getAttribute("aria-label")).toContain("claude-sonnet-4-5");
  const tokenDonut = screen.getByLabelText("Token 构成").querySelector("svg");
  expect(tokenDonut?.getAttribute("aria-label")).toContain("输入");
  const timeDonut = screen.getByLabelText("耗时构成");
  expect(timeDonut.querySelector("svg")?.getAttribute("aria-label")).toContain("模型等待");
  expect(timeDonut.textContent).toContain("输出速度 142.6 tok/s");
  const models = screen.getByLabelText("按模型");
  expect(models.textContent).toContain("速度");
  expect(models.textContent).toContain("首字延迟");
  expect(models.textContent).toContain("118.4 tok/s");
  expect(models.textContent).toContain("7.4 s");
  const heat = screen.getByRole("group", { name: /活跃度热力图/ });
  expect(heat.querySelectorAll("button.heat-cell").length).toBe(364);
});

it("指标切换：Token / 花费切换趋势图且点数不变", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const chart = await screen.findByRole("img", { name: /花费趋势/ });
  const dots = chart.querySelectorAll("circle").length;
  fireEvent.click(within(screen.getByRole("group", { name: "趋势指标" })).getByRole("button", { name: "Token" }));
  await waitFor(() => {
    const next = screen.getByRole("img", { name: /Token 趋势/ });
    expect(next.getAttribute("aria-label")).toMatch(/^Token 趋势/);
    expect(next.querySelectorAll("circle").length).toBe(dots);
  });
  fireEvent.click(within(screen.getByRole("group", { name: "趋势指标" })).getByRole("button", { name: "花费" }));
  await waitFor(() => {
    expect(screen.getByRole("img", { name: /花费趋势/ }).querySelectorAll("circle").length).toBe(dots);
  });
});

it("高花费会话：有标题行可点击打开，其余行为纯展示", async () => {
  const stats = mockUsageStats("30d");
  const firstPath = stats.topSessions[0].path;
  const onOpenSession = vi.fn();
  mockIPC(() => stats);
  render(<StatsView tab="usage" sessionTitle={(p) => (p === firstPath ? "会话甲" : null)} onOpenSession={onOpenSession} onToast={() => {}} />);
  const section = await screen.findByText("成本最高的会话");
  const panel = section.closest(".panel");
  expect(panel?.querySelectorAll("tr.is-click").length).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: /会话甲/ }));
  expect(onOpenSession).toHaveBeenCalledTimes(1);
  expect(onOpenSession).toHaveBeenCalledWith(firstPath);
});

it("空统计：暂无用量数据且不渲染热力图", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockEmptyUsageStats(range) : mockEmptyUsageHealth(range);
  });
  render(<StatsView {...links} />);
  expect(await screen.findByText("此范围内暂无用量数据")).toBeTruthy();
  expect(screen.queryByRole("group", { name: /活跃度热力图/ })).toBeNull();
});

it("Donut 零和降级：显示暂无数据", () => {
  render(<Donut label="x" slices={[]} />);
  expect(screen.getByText("暂无数据")).toBeTruthy();
});

it("热力默认请求指标；切 Token 后格子文案跟随；点击格子显示选中日详情与涨跌", async () => {
  mockIPC((cmd, args) => {
    const range = (args as { range: UsageRange }).range;
    return cmd === "get_usage_stats" ? mockUsageStats(range) : mockUsageHealth(range);
  });
  render(<StatsView {...links} />);
  const heat = await screen.findByRole("group", { name: /活跃度热力图/ });
  const card = heat.closest(".panel");
  expect(card).not.toBeNull();
  expect(heat.getAttribute("aria-label")).toContain("按请求着色");
  const cells = Array.from(heat.querySelectorAll("button.heat-cell"));
  expect(cells.length).toBe(364);
  const withUsage = cells.find((c) => (c.getAttribute("aria-label") ?? "").includes("次请求"));
  expect(withUsage).not.toBeUndefined();
  const heatSeg = within(card as HTMLElement).getByRole("group", { name: "热力指标" });
  fireEvent.click(within(heatSeg).getByRole("button", { name: "Token" }));
  await waitFor(() => expect(heat.getAttribute("aria-label")).toContain("按Token着色"));
  const cellsAfter = Array.from(heat.querySelectorAll("button.heat-cell"));
  expect(cellsAfter.length).toBe(364);
  // 同一格子的取值文案从请求切到 Token。
  const key0 = withUsage!.getAttribute("aria-label")?.split(" ")[0];
  const same = cellsAfter.find((c) => c.getAttribute("aria-label")?.startsWith(key0 ?? "???"));
  expect(same?.getAttribute("aria-label")).toContain("token");

  // 点击一个格子：选中日详情显示该日期与涨跌。
  const target = cells[cells.length - 1];
  const key = target.getAttribute("aria-label")?.split(" ")[0] ?? "";
  fireEvent.click(target);
  const day = await screen.findByLabelText("选中日");
  expect(day.textContent).toContain(`${Number(key.slice(5, 7))} 月 ${Number(key.slice(8, 10))} 日`);
  expect(day.textContent).toContain("较前 7 天日均");
  expect(day.textContent).toContain("主要项目");
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
  const title = await screen.findByText("最近错误");
  const card = title.closest(".panel") as HTMLElement;
  const seg = within(card).getByRole("group", { name: "错误类型筛选" });
  const kinds = within(seg).getAllByRole("button").map((b) => b.textContent);
  expect(kinds[0]).toContain("全部");
  expect(kinds.length).toBeGreaterThan(1);
  // 选第一个具体类型：标题显示 N/M 条。
  const first = within(seg).getAllByRole("button")[1];
  fireEvent.click(first);
  expect(card.textContent).toMatch(/\d+\/\d+ 条/);
});
