/** Sidebar 别名/标签行内展示与标签过滤条单测。 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { FIXTURE_SESSIONS } from "../dev/fixtures";
import { buildListResult } from "../dev/fixtures";
import type { MetaSnapshot } from "../types";

const noop = () => {};

function renderSidebar(meta: MetaSnapshot | null, activeTags: string[] = []) {
  const list = buildListResult(FIXTURE_SESSIONS);
  const tagCounts = [
    { tag: "bug", count: 2 },
    { tag: "高优", count: 1 },
  ];
  const onToggleTag = vi.fn<(tag: string) => void>();
  render(
    <Sidebar
      groups={list.groups}
      pinnedSessions={[]}
      totalCount={10}
      hiddenEmpty={0}
      query=""
      onQuery={noop}
      loading={false}
      listError={null}
      onRetry={noop}
      onRefresh={noop}
      onOpenCheatSheet={noop}
      manageActive={false}
      onToggleManage={noop}
      statsActive={false}
      onToggleStats={noop}
      cleanupActive={false}
      onToggleCleanup={noop}
      onNewSession={noop}
      onNewSessionIn={noop}
      historyActive={false}
      onToggleHistory={noop}
      checked={new Set()}
      onToggleCheck={noop}
      onToggleChecks={noop}
      onClearChecks={noop}
      selectedPath={null}
      onSelect={noop}
      pins={{ projects: [], sessions: [] }}
      onTogglePin={noop}
      ompVersion={null}
      ompChecking={false}
      onCheckOmp={noop}
      meta={meta}
      tagCounts={meta ? tagCounts : []}
      activeTags={activeTags}
      onToggleTag={onToggleTag}
    />,
  );
  return { onToggleTag };
}

describe("Sidebar 别名行内展示", () => {
  it("有别名时别名作主标题、原标题小号灰字附后", () => {
    const s1 = FIXTURE_SESSIONS[0].summary;
    const meta: MetaSnapshot = {
      revision: 1,
      sessions: {
        [s1.id]: { alias: "我的别名", tags: ["bug", "a", "b", "c", "d"], note: null, updatedAt: "t" },
      },
    };
    renderSidebar(meta);
    // 别名为主标题。
    expect(screen.getByText("我的别名")).toBeInTheDocument();
    // 原标题仍在行内、小号灰字（可区分两者）。
    const orig = document.querySelector(".row-title-orig");
    expect(orig?.textContent).toBe(s1.title);
    // 至多 3 个标签徽章 + 溢出计数（限定在会话行内，不含过滤条）。
    const badges = [...document.querySelectorAll(".row .badge-tag")].map((el) => el.textContent);
    expect(badges).toEqual(["bug", "a", "b", "+2"]);
  });

  it("无别名时行内只显示原标题", () => {
    renderSidebar({ revision: 0, sessions: {} });
    const s1 = FIXTURE_SESSIONS[0].summary;
    expect(screen.getByText(s1.title)).toBeInTheDocument();
    expect(document.querySelector(".row-title-orig")).toBeNull();
  });
});
describe("Sidebar 标签过滤条", () => {
  it("列出标签及计数，点击切换", () => {
    const meta: MetaSnapshot = { revision: 0, sessions: {} };
    const { onToggleTag } = renderSidebar(meta, ["bug"]);
    const bar = screen.getByRole("group", { name: "按标签过滤" });
    expect(bar.textContent).toContain("bug");
    expect(bar.textContent).toContain("2");
    const chip = screen.getByRole("button", { name: /bug/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /高优/ }));
    expect(onToggleTag).toHaveBeenCalledWith("高优");
  });

  it("无标签时不渲染过滤条", () => {
    renderSidebar(null);
    expect(screen.queryByRole("group", { name: "按标签过滤" })).toBeNull();
  });
});
