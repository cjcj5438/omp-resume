import { beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SessionUsage, UsageStats } from "../types";
import { mockSessionUsage, mockUsageStats } from "../dev/usageMock";
import { UsageSummary } from "./UsageSummary";
import { StatsView } from "./StatsView";

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

it("范围切换的迟到结果不覆盖当前统计；刷新失败支持重试并能转为空数据", async () => {
  const recent = Promise.withResolvers<UsageStats>();
  const all = Promise.withResolvers<UsageStats>();
  let calls = 0;
  mockIPC(() => {
    calls += 1;
    if (calls === 1) return recent.promise;
    if (calls === 2) return all.promise;
    if (calls === 3) throw { code: "IO", message: "扫描失败" };
    return { total: { ...mockSessionUsage, cost: { main: 0, background: 0, subagent: 0, total: 0 } }, byProject: [], byModel: [], byDay: [] };
  });
  render(<StatsView onBack={() => {}} />);
  await waitFor(() => expect(calls).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  await waitFor(() => expect(calls).toBe(2));
  await act(async () => { all.resolve(mockUsageStats(null)); });
  expect(within(screen.getByLabelText("用量总计")).getByText("$25.68")).toBeTruthy();
  await act(async () => { recent.resolve(mockUsageStats(30)); });
  expect(within(screen.getByLabelText("用量总计")).getByText("$25.68")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新统计" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("扫描失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("此范围内暂无用量数据")).toBeTruthy();
});
