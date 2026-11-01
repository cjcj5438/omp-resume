/** SessionList：组内置顶、批量勾选三态与选择条。 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SessionList } from "./SessionList";
import { FIXTURE_SESSIONS, buildListResult } from "../dev/fixtures";
import type { ProjectGroup } from "../types";

const noop = () => {};
const list = buildListResult(FIXTURE_SESSIONS);
const omp = list.groups.find((g) => g.cwd.endsWith("/omp-resume"))!;
const obsidian = list.groups.find((g) => g.cwd.endsWith("/notes-app"))!;
const [s1] = omp.sessions;
const [s4] = obsidian.sessions;

function renderSidebar(over: {
  groups?: ProjectGroup[];
  pinnedIds?: string[];
  checked?: Set<string>;
  onToggleChecks?: (paths: string[], on: boolean) => void;
  onClearChecks?: () => void;
  onTogglePin?: (kind: string, key: string) => void;
  collapsed?: Set<string>;
  onCollapsedChange?: (next: Set<string>) => void;
  multiMode?: boolean;
}) {
  const onToggleChecks = over.onToggleChecks ?? vi.fn();
  const onClearChecks = over.onClearChecks ?? vi.fn();
  const view = render(
    <SessionList
      groups={over.groups ?? list.groups}
      listError={null}
      onRetry={noop}
      checked={over.checked ?? new Set()}
      onToggleCheck={noop}
      onToggleChecks={onToggleChecks}
      onClearChecks={onClearChecks}
      multiMode={over.multiMode ?? false}
      selectedPath={null}
      onOpenSession={noop}
      onOpenMeta={noop}
      onBulkResume={noop}
      collapsed={over.collapsed ?? new Set<string>()}
      onCollapsedChange={over.onCollapsedChange ?? noop}
      pins={{ projects: [], sessions: over.pinnedIds ?? [] }}
      onTogglePin={over.onTogglePin ?? noop}
      onNewSessionIn={noop}
      meta={null}
      tagCounts={[]}
      activeTags={[]}
      onToggleTag={noop}
      onToast={noop}
      onOpenIterm={noop}
      onRequestDelete={noop}
      onMetaSnapshot={noop}
    />,
  );
  return { onToggleChecks, onClearChecks, view };
}

function rowTitlesIn(group: HTMLElement): string[] {
  return Array.from(group.querySelectorAll(".sr-title strong"), (el) => el.textContent ?? "");
}

function groupByName(name: string): HTMLElement {
  for (const section of document.querySelectorAll(".project-block")) {
    if (section.querySelector(".p-name")?.textContent === name && section instanceof HTMLElement)
      return section;
  }
  throw new Error(`未找到项目组：${name}`);
}

describe("SessionList 组内置顶", () => {
  it("置顶会话组内上浮，标题前有 pin 图标；点击行动作取消置顶", () => {
    const onTogglePin = vi.fn();
    renderSidebar({ pinnedIds: [s1.id, s4.id], onTogglePin });

    const group = groupByName("omp-resume");
    expect(rowTitlesIn(group)[0]).toBe(s1.title);
    expect(group.querySelectorAll(".sr-title .pin")).toHaveLength(1);

    const toggle = within(group).getByRole("button", { name: `取消置顶 ${s1.title}` });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("is-on");
    fireEvent.click(toggle);
    expect(onTogglePin).toHaveBeenCalledWith("session", s1.id);
  });

  it("无置顶会话时无 pin 图标", () => {
    renderSidebar({});
    expect(document.querySelector(".sr-title .pin")).toBeNull();
  });
});

describe("SessionList 批量勾选", () => {
  it("组头三态：部分勾选为 mixed，点击勾选该组全部可见会话", () => {
    const { onToggleChecks } = renderSidebar({ checked: new Set([s1.path]) });

    const groupBox = (name: string) =>
      within(groupByName(name)).getByRole("checkbox", {
        name: `选择项目 ${name} 的全部会话`,
      });
    const ompBox = groupBox("omp-resume");
    expect(ompBox).toHaveAttribute("aria-checked", "mixed");
    expect(ompBox).toHaveAttribute("data-state", "some");
    expect(groupBox("notes-app")).toHaveAttribute("aria-checked", "false");

    fireEvent.click(ompBox);
    expect(onToggleChecks).toHaveBeenCalledWith(omp.sessions.map((s) => s.path), true);
  });

  it("全选组头包含已折叠组的全部可见会话", () => {
    const { onToggleChecks } = renderSidebar({ collapsed: new Set([obsidian.cwd]) });
    const collapsed = groupByName("notes-app");
    expect(collapsed.querySelector(".group-rows")).toBeNull();

    fireEvent.click(
      within(collapsed).getByRole("checkbox", { name: "选择项目 notes-app 的全部会话" }),
    );
    expect(onToggleChecks).toHaveBeenCalledWith(obsidian.sessions.map((s) => s.path), true);
  });

  it("已选时出现选择条：全选当前列表与清除", () => {
    const { onToggleChecks, onClearChecks } = renderSidebar({ checked: new Set([s1.path]) });

    expect(document.querySelector(".selection-bar")?.textContent).toContain("已选择 1 个会话");
    fireEvent.click(screen.getByRole("button", { name: "全选当前列表" }));
    expect(onToggleChecks).toHaveBeenCalledWith(
      list.groups.flatMap((g) => g.sessions.map((s) => s.path)),
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(onClearChecks).toHaveBeenCalledTimes(1);
  });

  it("当前列表全部已选时不再提供“全选当前列表”", () => {
    const all = new Set(list.groups.flatMap((g) => g.sessions.map((s) => s.path)));
    renderSidebar({ checked: all });
    expect(screen.queryByRole("button", { name: "全选当前列表" })).toBeNull();
    expect(document.querySelector(".selection-bar")?.textContent).toContain(`已选择 ${all.size} 个会话`);
  });
});

describe("SessionList 选择态（S1：开关已并入 SessionsPage toolbar，状态经 props 传入）", () => {
  it("列表内不再渲染多选开关", () => {
    renderSidebar({});
    expect(screen.queryByRole("button", { name: "多选" })).toBeNull();
  });

  it("默认关闭：无选择条、侧栏不在选择态", () => {
    renderSidebar({});
    expect(document.querySelector(".session-list")).not.toHaveClass("is-selecting");
    expect(document.querySelector(".selection-bar")).toBeNull();
  });

  it("multiMode 打开后进入选择态：0 选中也显示选择条，可一键全选当前列表", () => {
    const { onToggleChecks } = renderSidebar({ multiMode: true });

    expect(document.querySelector(".session-list")).toHaveClass("is-selecting");
    expect(document.querySelector(".selection-bar")).toBeInTheDocument();
    // 0 选中时不提供无意义的「清除选择」。
    expect(screen.queryByRole("button", { name: "清除选择" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全选当前列表" }));
    expect(onToggleChecks).toHaveBeenCalledWith(
      list.groups.flatMap((g) => g.sessions.map((s) => s.path)),
      true,
    );
  });

  it("有勾选时自动进入选择态", () => {
    renderSidebar({ checked: new Set([s1.path]) });
    // 未开开关：已有勾选即视为选择态。
    expect(document.querySelector(".session-list")).toHaveClass("is-selecting");
  });

  it("空列表下不渲染空选择条", () => {
    renderSidebar({ groups: [], multiMode: true });
    expect(document.querySelector(".selection-bar")).toBeNull();
  });

  it("勾选项被过滤掉时选择条仍在，可清除选择", () => {
    const { onClearChecks } = renderSidebar({
      groups: [],
      checked: new Set([s1.path]),
    });
    expect(document.querySelector(".selection-bar")).toBeInTheDocument();
    // 没有可见会话，不提供无从执行的全选。
    expect(screen.queryByRole("button", { name: "全选当前列表" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(onClearChecks).toHaveBeenCalledTimes(1);
  });
});
