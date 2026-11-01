/** SessionList 别名/标签行内展示与标签过滤条单测。 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionList } from "./SessionList";
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
    <SessionList
      groups={list.groups}
      listError={null}
      onRetry={noop}
      onNewSessionIn={noop}
      checked={new Set()}
      onToggleCheck={noop}
      onToggleChecks={noop}
      onClearChecks={noop}
      multiMode={false}
      selectedPath={null}
      onOpenSession={noop}
      onOpenMeta={noop}
      onBulkResume={noop}
      collapsed={new Set<string>()}
      onCollapsedChange={noop}
      pins={{ projects: [], sessions: [] }}
      onTogglePin={noop}
      meta={meta}
      tagCounts={meta ? tagCounts : []}
      activeTags={activeTags}
      onToggleTag={onToggleTag}
      onToast={noop}
      onOpenIterm={noop}
      onRequestDelete={noop}
      onMetaSnapshot={noop}
    />,
  );
  return { onToggleTag };
}

describe("SessionList 别名行内展示", () => {
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
    const badges = [...document.querySelectorAll(".session-row .badge-tag")].map((el) => el.textContent);
    expect(badges).toEqual(["bug", "a", "b", "+2"]);
  });

  it("无别名时行内只显示原标题", () => {
    renderSidebar({ revision: 0, sessions: {} });
    const s1 = FIXTURE_SESSIONS[0].summary;
    expect(screen.getByText(s1.title)).toBeInTheDocument();
    expect(document.querySelector(".row-title-orig")).toBeNull();
  });
});
describe("SessionList 行内模型与 tokens（S9）", () => {
  function metaOf(title: string): HTMLElement | null {
    for (const row of document.querySelectorAll(".session-row")) {
      if (row.querySelector(".sr-title strong")?.textContent === title)
        return row.querySelector(".sr-meta");
    }
    return null;
  }

  it("不同会话渲染各自的模型与 tokens 值", () => {
    renderSidebar({ revision: 0, sessions: {} });
    const s1 = FIXTURE_SESSIONS[0].summary;
    const s2 = FIXTURE_SESSIONS[1].summary;
    const m1 = metaOf(s1.title)?.textContent ?? "";
    const m2 = metaOf(s2.title)?.textContent ?? "";
    // 夹具保证两行值不同：断言渲染的是行值而非全局值。
    expect(s1.tokens).not.toBe(s2.tokens);
    expect(m1).toContain(s1.model!);
    expect(m2).toContain(s2.model!);
    expect(m1).not.toBe(m2);
  });

  it("tokens/model 为 null 时显示「—」；非空 tokens 带主会话口径 title", () => {
    renderSidebar({ revision: 0, sessions: {} });
    const s6 = FIXTURE_SESSIONS[5].summary;
    expect(s6.model).toBeNull();
    expect(s6.tokens).toBeNull();
    const m6 = metaOf(s6.title)?.textContent ?? "";
    expect(m6).toContain("—");
    const s1 = FIXTURE_SESSIONS[0].summary;
    const row = [...document.querySelectorAll(".session-row")].find(
      (el) => el.querySelector(".sr-title strong")?.textContent === s1.title,
    )!;
    const tok = row.querySelector(".sr-meta .mono")!;
    expect(tok.getAttribute("title")).toBe("主会话 token（不含子代理）");
  });
});
describe("SessionList 标签过滤条", () => {
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
