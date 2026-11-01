import { beforeEach, expect, it, vi } from "vitest";
import { installMockBackend } from "../dev/mockBackend";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CleanupView } from "./CleanupView";

beforeEach(() => {
  clearMocks();
});

const noop = () => {};

function renderView() {
  return render(
    <CleanupView canView={() => false} onView={noop} onDelete={noop} refreshToken={0} />,
  );
}

it("可清空输入，失焦恢复；有效值触发重扫", async () => {
  const seen: { olderThanDays: number; topN: number }[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "list_cleanup_candidates") throw `no handler for ${cmd}`;
    const a = args as { olderThanDays: number; topN: number };
    seen.push({ olderThanDays: a.olderThanDays, topN: a.topN });
    return [];
  });
  renderView();
  await screen.findByText(/没有符合清理规则的会话/);
  expect(seen).toEqual([{ olderThanDays: 30, topN: 10 }]);

  const daysInput = screen.getByRole("spinbutton", { name: "久未更新的天数" });
  // 可清空：days 的 min=1，空串非法 → 不触发扫描，失焦恢复已提交值。
  fireEvent.change(daysInput, { target: { value: "" } });
  expect(daysInput).toHaveValue(null);
  fireEvent.blur(daysInput);
  expect(daysInput).toHaveValue(30);
  await waitFor(() => expect(seen.length).toBe(1));

  // 有效值：提交并触发重扫。
  fireEvent.change(daysInput, { target: { value: "7" } });
  await waitFor(() => expect(seen).toEqual([{ olderThanDays: 30, topN: 10 }, { olderThanDays: 7, topN: 10 }]));

  // topN 的 min=0：空串按 0 提交（positiveInt 现行为），失焦显示 0。
  const topInput = screen.getByRole("spinbutton", { name: "体积前 N 名" });
  fireEvent.change(topInput, { target: { value: "" } });
  expect(topInput).toHaveValue(null);
  fireEvent.blur(topInput);
  expect(topInput).toHaveValue(0);
});

it("切换原因 KPI 后，已勾选但不可见的项被剪掉，删除只带可见项", async () => {
  const onDelete = vi.fn();
  await installMockBackend();
  render(
    <CleanupView canView={() => false} onView={noop} onDelete={onDelete} refreshToken={0} />,
  );
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "全选可勾选项" }));
  const meta = () => document.querySelector(".panel-meta")?.textContent ?? "";
  const before = meta();
  const group = screen.getByRole("group", { name: "按原因筛选" });
  const emptyCard = within(group).getByRole("button", {
    name: /空会话/,
  });
  fireEvent.click(emptyCard);
  expect(emptyCard).toHaveAttribute("aria-pressed", "true");
  const after = meta();
  expect(after).not.toBe(before);
  fireEvent.click(screen.getByRole("button", { name: /删除选中/ }));
  expect(onDelete).toHaveBeenCalledTimes(1);
  const targets = onDelete.mock.calls[0][0] as { path: string; source?: string; excluded?: number }[];
  expect(targets.length).toBeGreaterThan(0);
  // 发起方随批带上被排除数：targets 全标 cleanup 来源，excluded 为可见集不可勾选数。
  expect(targets.every((t) => t.source === "cleanup" && typeof t.excluded === "number")).toBe(true);
  const locked = document.querySelectorAll("tr.cleanup-locked").length;
  expect(targets[0].excluded).toBe(locked);
  // 再次点击同一卡片取消筛选。
  fireEvent.click(emptyCard);
  expect(emptyCard).toHaveAttribute("aria-pressed", "false");
});

it("行内删除只带该行；guard 行禁用；KPI foot 显示真实规则值", async () => {
  const onDelete = vi.fn();
  await installMockBackend();
  render(
    <CleanupView canView={() => false} onView={noop} onDelete={onDelete} refreshToken={0} />,
  );
  await screen.findByRole("table");
  // KPI foot 真实规则值（默认 days=30/topN=10）。
  const group = screen.getByRole("group", { name: "按原因筛选" });
  const foots = [...group.querySelectorAll(".kpi-foot")].map((el) => el.textContent);
  expect(foots).toEqual(["0 条有效消息", "cwd 已删除", "体积前 10 且 ≥5MiB", "超过 30 天未更新"]);
  // 行内删除：点第一行的删除键，只带一个目标。
  const delBtns = screen.getAllByRole("button", { name: /^删除 / });
  expect(delBtns.length).toBeGreaterThan(0);
  const enabled = delBtns.find((b) => b.hasAttribute("disabled") === false);
  expect(enabled).not.toBeUndefined();
  fireEvent.click(enabled!);
  expect(onDelete).toHaveBeenCalledTimes(1);
  const targets = onDelete.mock.calls[0][0] as { path: string }[];
  expect(targets).toHaveLength(1);
  // guard 行（占用中）的删除键禁用。
  const locked = document.querySelector("tr.cleanup-locked");
  if (locked !== null) {
    const lockedDel = within(locked as HTMLElement).getByRole("button", { name: /^删除 / });
    expect(lockedDel).toBeDisabled();
  }
});

it("原因过滤时工具条显示清除提示；panel-foot 有扫描说明", async () => {
  await installMockBackend();
  render(
    <CleanupView canView={() => false} onView={noop} onDelete={noop} refreshToken={0} />,
  );
  await screen.findByRole("table");
  expect(screen.queryByText("已按原因过滤")).toBeNull();
  const group = screen.getByRole("group", { name: "按原因筛选" });
  fireEvent.click(within(group).getByRole("button", { name: /空会话/ }));
  expect(screen.getByText("已按原因过滤")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清除" }));
  expect(screen.queryByText("已按原因过滤")).toBeNull();
  expect(screen.getByText("删除前会做一次占用探测；正在使用的会话会被排除。")).toBeInTheDocument();
  expect(screen.getByText(/扫描于 \d{2}:\d{2}/)).toBeInTheDocument();
});
