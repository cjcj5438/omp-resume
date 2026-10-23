import { beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CleanupView } from "./CleanupView";

beforeEach(() => {
  clearMocks();
});

const noop = () => {};

function renderView() {
  return render(
    <CleanupView onBack={noop} canView={() => false} onView={noop} onDelete={noop} refreshToken={0} />,
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
