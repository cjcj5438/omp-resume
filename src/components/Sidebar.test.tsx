/** Sidebar：置顶区聚合、批量勾选三态与选择条、更新日志外链。 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { FIXTURE_SESSIONS, buildListResult } from "../dev/fixtures";
import { OMP_CHANGELOG_URL } from "../format";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ProjectGroup, SessionSummary } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const noop = () => {};
const list = buildListResult(FIXTURE_SESSIONS);
const omp = list.groups.find((g) => g.cwd.endsWith("/omp-resume"))!;
const obsidian = list.groups.find((g) => g.cwd.endsWith("/notes-app"))!;
const [s1] = omp.sessions;
const [s4] = obsidian.sessions;

function renderSidebar(over: {
  groups?: ProjectGroup[];
  pinnedSessions?: SessionSummary[];
  checked?: Set<string>;
  onToggleChecks?: (paths: string[], on: boolean) => void;
  onClearChecks?: () => void;
  onTogglePin?: (kind: string, key: string) => void;
  ompVersion?: string | null;
  statsActive?: boolean;
}) {
  const onToggleChecks = over.onToggleChecks ?? vi.fn();
  const onClearChecks = over.onClearChecks ?? vi.fn();
  const view = render(
    <Sidebar
      groups={over.groups ?? list.groups}
      pinnedSessions={over.pinnedSessions ?? []}
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
      statsActive={over.statsActive ?? false}
      onToggleStats={noop}
      stageActive={false}
      onToggleStage={noop}
      cleanupActive={false}
      onToggleCleanup={noop}
      checked={over.checked ?? new Set()}
      onToggleCheck={noop}
      onToggleChecks={onToggleChecks}
      onClearChecks={onClearChecks}
      selectedPath={null}
      onSelect={noop}
      pins={{ projects: [], sessions: over.pinnedSessions?.map((s) => s.id) ?? [] }}
      onTogglePin={over.onTogglePin ?? noop}
      ompVersion={over.ompVersion === undefined ? null : over.ompVersion}
      ompChecking={false}
      onCheckOmp={noop}
      onNewSession={noop}
      onNewSessionIn={noop}
      historyActive={false}
      onToggleHistory={noop}
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

function pinnedSection(): HTMLElement {
  const el = document.querySelector(".pinned-group");
  if (!(el instanceof HTMLElement)) throw new Error("未找到置顶区");
  return el;
}

function groupByName(name: string): HTMLElement {
  for (const section of document.querySelectorAll(".group:not(.pinned-group)")) {
    if (section.querySelector(".group-name")?.textContent === name && section instanceof HTMLElement)
      return section;
  }
  throw new Error(`未找到项目组：${name}`);
}

function rowTitles(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll(".row-title"), (el) => el.textContent ?? "");
}

describe("Sidebar 置顶区", () => {
  it("置顶行带醒目样式与所属项目名，点击置顶按钮取消置顶", () => {
    const onTogglePin = vi.fn();
    renderSidebar({ pinnedSessions: [s1, s4], onTogglePin });

    const pinned = pinnedSection();
    expect(rowTitles(pinned)).toEqual([s1.title, s4.title]);
    expect(pinned.querySelectorAll(".row-pinned")).toHaveLength(2);
    expect(Array.from(pinned.querySelectorAll(".row-project"), (el) => el.textContent)).toEqual([
      "omp-resume",
      "notes-app",
    ]);
    expect(within(pinned).getByText("置顶")).toBeInTheDocument();
    expect(pinned.querySelector(".pinned-count")?.textContent).toBe("2");

    const toggle = within(pinned).getByRole("button", { name: `取消置顶会话 ${s1.title}` });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("pin-toggle-on");
    fireEvent.click(toggle);
    expect(onTogglePin).toHaveBeenCalledWith("session", s1.id);
  });

  it("无置顶会话时不渲染置顶区", () => {
    renderSidebar({});
    expect(document.querySelector(".pinned-group")).toBeNull();
  });

  it("组内会话全部置顶时组头保留、显示占位说明，入口不丢", () => {
    renderSidebar({ groups: [{ ...obsidian, sessions: [] }], pinnedSessions: obsidian.sessions });

    const group = groupByName("notes-app");
    expect(rowTitles(group)).toEqual([]);
    expect(within(group).getByText("该项目的会话均已置顶")).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "在 notes-app 新会话" })).toBeEnabled();
    expect(within(group).getByRole("button", { name: "置顶项目 notes-app" })).toBeInTheDocument();
    expect(within(group).queryByText("目录不存在")).toBeNull();
    // 空组不提供三态勾选（无可选项）。
    expect(within(group).queryByRole("checkbox")).toBeNull();
  });
});

describe("Sidebar 批量勾选", () => {
  it("组头三态：部分勾选为 indeterminate，点击勾选该组全部可见会话", () => {
    const { onToggleChecks } = renderSidebar({ checked: new Set([s1.path]) });

    const groupBox = (name: string) =>
      within(groupByName(name)).getByRole<HTMLInputElement>("checkbox", {
        name: `选择项目 ${name} 的全部会话`,
      });
    const ompBox = groupBox("omp-resume");
    expect(ompBox.indeterminate).toBe(true);
    expect(ompBox).not.toBeChecked();
    expect(groupBox("notes-app").indeterminate).toBe(false);

    fireEvent.click(ompBox);
    expect(onToggleChecks).toHaveBeenCalledWith(omp.sessions.map((s) => s.path), true);
  });

  it("全选组头包含已折叠组的全部可见会话", () => {
    const { onToggleChecks } = renderSidebar({});
    fireEvent.click(within(groupByName("notes-app")).getByRole("button", { name: /^notes-app/ }));
    const collapsed = groupByName("notes-app");
    expect(collapsed.querySelector(".group-rows")).toBeNull();

    fireEvent.click(
      within(collapsed).getByRole("checkbox", { name: "选择项目 notes-app 的全部会话" }),
    );
    expect(onToggleChecks).toHaveBeenCalledWith(obsidian.sessions.map((s) => s.path), true);
  });

  it("已选时出现选择条：全选当前列表与清除", () => {
    const { onToggleChecks, onClearChecks } = renderSidebar({ checked: new Set([s1.path]) });

    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
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
    expect(screen.getByText(`已选 ${all.size} 项`)).toBeInTheDocument();
  });

  it("置顶会话已移出原组：全选当前列表不重复计入", () => {
    // App 传入的分组已剔除置顶会话，这里模拟同样形状。
    const groups = list.groups.map((g) =>
      g === omp ? { ...g, sessions: g.sessions.filter((s) => s.path !== s1.path) } : g,
    );
    const { onToggleChecks } = renderSidebar({
      groups,
      pinnedSessions: [s1],
      checked: new Set([s4.path]),
    });

    fireEvent.click(screen.getByRole("button", { name: "全选当前列表" }));
    const [paths] = vi.mocked(onToggleChecks).mock.calls[0];
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain(s1.path);
    expect(paths).toContain(s4.path);
    expect(paths).toHaveLength(list.groups.flatMap((g) => g.sessions).length);
  });

  it("置顶区头部可整区勾选", () => {
    const { onToggleChecks } = renderSidebar({ pinnedSessions: [s1, s4] });
    fireEvent.click(within(pinnedSection()).getByRole("checkbox", { name: "选择全部置顶会话" }));
    expect(onToggleChecks).toHaveBeenCalledWith([s1.path, s4.path], true);
  });
});

describe("Sidebar omp 更新日志", () => {
  it("版本行提供更新日志入口并打开官方地址", () => {
    const mocked = vi.mocked(openUrl);
    mocked.mockClear();
    renderSidebar({ ompVersion: "18.11.1" });

    fireEvent.click(screen.getByRole("button", { name: "更新日志" }));
    expect(mocked).toHaveBeenCalledExactlyOnceWith(OMP_CHANGELOG_URL);
  });
});

describe("Sidebar 顶部", () => {
  it("视图切换条同组：舞台/统计/清理/提示词历史/管理为 aria-pressed 开关，速查为普通动作", () => {
    renderSidebar({ statsActive: true });
    const nav = screen.getByRole("group", { name: "视图切换" });

    expect(Array.from(nav.querySelectorAll("button"), (b) => b.textContent)).toEqual([
      "舞台",
      "统计",
      "清理",
      "提示词历史",
      "管理",
      "速查",
    ]);
    expect(within(nav).getByRole("button", { name: "统计" })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["舞台", "清理", "提示词历史", "管理"]) {
      expect(within(nav).getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    // 速查是打开对话框的动作，不是视图开关。
    expect(within(nav).getByRole("button", { name: "速查" })).not.toHaveAttribute("aria-pressed");
  });

  it("图标化控件仍可被屏幕阅读器识别（刷新 / 外观）", () => {
    renderSidebar({ ompVersion: "18.11.1" });
    expect(screen.getByRole("button", { name: "刷新" })).toHaveAttribute("title", "刷新");
    expect(screen.getByRole("button", { name: "外观" })).toHaveAttribute("title", "切换主题与强调色");
  });
});

describe("Sidebar 多选开关", () => {
  function multiToggle(): HTMLElement {
    const btn = screen.getByRole("button", { name: "多选" });
    expect(btn).toHaveAttribute("title", "多选");
    return btn;
  }

  it("默认关闭：无选择条、侧栏不在选择态", () => {
    renderSidebar({});
    expect(multiToggle()).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".sidebar")).not.toHaveClass("is-selecting");
    expect(document.querySelector(".select-bar")).toBeNull();
  });

  it("打开后进入选择态：0 选中也显示选择条，可一键全选当前列表", () => {
    const { onToggleChecks } = renderSidebar({});
    fireEvent.click(multiToggle());

    expect(multiToggle()).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".sidebar")).toHaveClass("is-selecting");
    expect(screen.getByText("已选 0 项")).toBeInTheDocument();
    // 0 选中时不提供无意义的「清除选择」。
    expect(screen.queryByRole("button", { name: "清除选择" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全选当前列表" }));
    expect(onToggleChecks).toHaveBeenCalledWith(
      list.groups.flatMap((g) => g.sessions.map((s) => s.path)),
      true,
    );
  });

  it("有勾选时开关自动保持开启；关闭开关则清空全部勾选", () => {
    const { onClearChecks } = renderSidebar({ checked: new Set([s1.path]) });
    // 未点开关：已有勾选即视为选择态。
    expect(multiToggle()).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".sidebar")).toHaveClass("is-selecting");

    fireEvent.click(multiToggle());
    expect(onClearChecks).toHaveBeenCalledTimes(1);
  });

  it("空列表下不渲染空选择条", () => {
    renderSidebar({ groups: [], pinnedSessions: [] });
    fireEvent.click(multiToggle());
    expect(document.querySelector(".select-bar")).toBeNull();
  });

  it("勾选项被过滤掉时选择条仍在，可清除选择", () => {
    const { onClearChecks } = renderSidebar({
      groups: [],
      pinnedSessions: [],
      checked: new Set([s1.path]),
    });
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
    // 没有可见会话，不提供无从执行的全选。
    expect(screen.queryByRole("button", { name: "全选当前列表" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(onClearChecks).toHaveBeenCalledTimes(1);
  });
});
