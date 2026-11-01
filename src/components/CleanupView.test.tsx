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
  // 全选可勾选项，再切到「空会话」：计数下降，删除只带可见项。
  fireEvent.click(screen.getByRole("button", { name: "全选可勾选项" }));
  const before = screen.getByRole("status").textContent ?? "";
  const group = screen.getByRole("group", { name: "按原因筛选" });
  const emptyCard = within(group).getByRole("button", {
    name: /空会话/,
  });
  fireEvent.click(emptyCard);
  expect(emptyCard).toHaveAttribute("aria-pressed", "true");
  const after = screen.getByRole("status").textContent ?? "";
  expect(after).not.toBe(before);
  fireEvent.click(screen.getByRole("button", { name: "删除所选…" }));
  expect(onDelete).toHaveBeenCalledTimes(1);
  const targets = onDelete.mock.calls[0][0] as { path: string }[];
  expect(targets.length).toBeGreaterThan(0);
  // 再次点击同一卡片取消筛选。
  fireEvent.click(emptyCard);
  expect(emptyCard).toHaveAttribute("aria-pressed", "false");
});
