/** SessionsPage 多选开关（S1）：toolbar 行尾持有 multiMode，驱动 SessionList 选择态。 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionsPage } from "./SessionsPage";
import { FIXTURE_SESSIONS, buildListResult } from "../dev/fixtures";

const noop = () => {};
const list = buildListResult(FIXTURE_SESSIONS);
const visibleCount = list.groups.flatMap((g) => g.sessions).length;

function renderPage(over: { checked?: Set<string> } = {}) {
  const onClearChecks = vi.fn();
  render(
    <SessionsPage
      groups={list.groups}
      statusFilter="all"
      onStatusFilter={noop}
      visibleCount={visibleCount}
      runningCount={0}
      totalCount={visibleCount}
      hiddenEmpty={0}
      query=""
      onQuery={noop}
      loading={false}
      listError={null}
      onRetry={noop}
      onRescan={noop}
      onNewSession={noop}
      checked={over.checked ?? new Set()}
      onToggleCheck={noop}
      onToggleChecks={noop}
      onClearChecks={onClearChecks}
      selectedPath={null}
      onOpenSession={noop}
      onOpenMeta={noop}
      onBulkResume={noop}
      collapsed={new Set<string>()}
      onCollapsedChange={noop}
      pins={{ projects: [], sessions: [] }}
      onTogglePin={noop}
      onNewSessionIn={noop}
      meta={null}
      tagCounts={[]}
      activeTags={[]}
      onToggleTag={noop}
      onClearFilters={noop}
      onToast={noop}
      onOpenIterm={noop}
      onRequestDelete={noop}
      onMetaSnapshot={noop}
    />,
  );
  return { onClearChecks };
}

describe("SessionsPage 多选开关（S1）", () => {
  it("开关在 toolbar 行内（排序计数之后），列表内无独立行", () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: "多选" });
    expect(toggle.closest(".sessions-toolbar")).not.toBeNull();
    expect(document.querySelector(".page-select-toggle")).toBeNull();
  });

  it("打开后列表进入选择态：0 选中也显示选择条", () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: "多选" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".selection-bar")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "多选" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".session-list")).toHaveClass("is-selecting");
    expect(document.querySelector(".selection-bar")).toBeInTheDocument();
  });

  it("有勾选时开关自动保持开启；关闭开关则清空全部勾选", () => {
    const s1 = list.groups[0].sessions[0];
    const { onClearChecks } = renderPage({ checked: new Set([s1.path]) });
    expect(screen.getByRole("button", { name: "多选" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "多选" }));
    expect(onClearChecks).toHaveBeenCalledTimes(1);
  });
});
