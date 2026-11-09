import { beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen } from "@testing-library/react";
import type { SessionUsage } from "../types";
import { mockSessionUsage } from "../dev/usageMock";
import { UsageSummary } from "./UsageSummary";

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
