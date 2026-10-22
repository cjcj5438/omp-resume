/**
 * App 集成测试（mockIPC + DEV 夹具）：
 * 列表过滤、选择/勾选跨刷新保持、删除流程、从节点继续 UI、focus 刷新节流。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import { FIXTURE_SESSIONS, buildListResult } from "./dev/fixtures";
import { installMockBackend } from "./dev/mockBackend";

const S1 = "🎛️ DEMO: 构建可视化配置桌面应用";
const S2 = "🏠 DEMO4: 修复示例代理连接失败";
const S4 = "🦙 DEMO3: 本地模型总结笔记";
const S5 = "🔀 分支很多的会话：鉴权方案 A/B 对比";
const S7 = "🗑️ 旧项目：删库迁移记录";
const S9 = "🔒 权限问题排查";
const S10 = "(无标题)";

function rowOf(title: string): HTMLElement {
  for (const el of screen.getAllByText(title)) {
    const row = el.closest(".row");
    if (row) return row as HTMLElement;
  }
  throw new Error(`未找到会话行：${title}`);
}

function checkOf(title: string): HTMLElement {
  return within(rowOf(title)).getByRole("checkbox");
}

beforeEach(() => {
  clearMocks();
});

describe("列表：过滤与跨刷新保持", () => {
  it("过滤框按标题/cwd/首条用户消息匹配，空组隐藏", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    const input = screen.getByRole("searchbox", { name: "过滤会话" });
    fireEvent.change(input, { target: { value: "demo3" } });
    expect(rowOf(S4)).toBeInTheDocument();
    expect(screen.queryByText(S1)).toBeNull();

    fireEvent.change(input, { target: { value: "notes" } });
    expect(rowOf(S4)).toBeInTheDocument();
    expect(rowOf(S5)).toBeInTheDocument();
    expect(screen.queryByText(S1)).toBeNull();

    // 首条用户消息命中
    fireEvent.change(input, { target: { value: "删库前先备份" } });
    expect(rowOf(S7)).toBeInTheDocument();
    expect(screen.queryByText(S4)).toBeNull();
  });

  it("刷新后选中行与勾选保持，消失的会话被清理", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S1));
    fireEvent.click(checkOf(S2));
    expect(await screen.findByRole("heading", { name: S1 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled());

    expect(rowOf(S1)).toHaveClass("row-selected");
    expect(checkOf(S2)).toBeChecked();
    expect(screen.getByRole("heading", { name: S1 })).toBeInTheDocument();
    // 勾选行保留
    expect(checkOf(S2)).toBeInTheDocument();
  });

  it("选中的会话消失后详情面板提示已不存在", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S1));
    fireEvent.click(checkOf(S1));
    fireEvent.click(screen.getByRole("button", { name: /删除所选 \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await screen.findByText(/成功删除 1 个会话/);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(screen.queryByText(S1)).toBeNull();
    expect(screen.getByText("该会话已不存在")).toBeInTheDocument();
    expect(checkOf(S2)).not.toBeChecked();
  });
});

describe("删除流程", () => {
  it("使用中会话列为跳过并从删除集合剔除", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(checkOf(S1));
    fireEvent.click(checkOf(S2));
    fireEvent.click(screen.getByRole("button", { name: /删除所选 \(2\)/ }));

    expect(screen.getByRole("dialog")).toHaveTextContent(`永久删除 2 个会话？`);
    expect(screen.getByText("使用中，将被跳过")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    // 只有 s1 提交删除：成功 1，无失败
    await screen.findByText(/成功删除 1 个会话/);
    expect(screen.queryByText(/占用探测失败/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByText(S1)).toBeNull());
    expect(rowOf(S2)).toBeInTheDocument();
  });

  it("部分失败逐条展示，不被吞掉", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    // s9 探测失败：后端返回 PROBE_FAILED
    fireEvent.click(checkOf(S9));
    fireEvent.click(checkOf(S10));
    fireEvent.click(screen.getByRole("button", { name: /删除所选 \(2\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await screen.findByText(/成功删除 1 个会话/);
    const results = document.querySelector(".delete-results");
    expect(results).not.toBeNull();
    expect(results).toHaveTextContent("占用探测失败");
  });

  it("全部在使用中时确认按钮禁用", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(checkOf(S2));
    fireEvent.click(screen.getByRole("button", { name: /删除所选 \(1\)/ }));

    const confirm = screen.getByRole("button", { name: "永久删除" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("title", "所有选中会话都在使用中");
  });
});

describe("从节点继续", () => {
  it("选中 leaf 节点：未追加标记提示 + 仍在 iTerm 打开 + 刷新", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S5));
    fireEvent.click(screen.getByRole("tab", { name: "树" }));
    // 初始选中 = leaf（bx-L「当前位置」）；选中由被动 effect 落定后按钮才可用。
    await screen.findByText("当前位置");
    const contBtn = await screen.findByRole("button", { name: "从此节点继续" });
    await waitFor(() => expect(contBtn).toBeEnabled());

    fireEvent.click(contBtn);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("从此节点继续？");
    expect(dialog).toHaveTextContent("omp-resume-branch");

    fireEvent.click(within(dialog).getByRole("button", { name: "追加标记并在 iTerm 打开" }));

    await screen.findByText("该节点已是当前位置，未追加标记");
    const handle = (window as unknown as { __ompMock?: { calls: string[] } }).__ompMock;
    expect(handle?.calls).toContain(FIXTURE_SESSIONS[4].summary.path);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
  });
});

describe("focus 刷新节流", () => {
  it("800ms 内的重复 focus 不叠加加载", async () => {
    const counts = { list: 0 };
    mockIPC(async (cmd: string) => {
      if (cmd === "list_sessions") {
        counts.list += 1;
        return buildListResult(FIXTURE_SESSIONS);
      }
      if (cmd === "get_conversation")
        return { path: "x", leafId: null, targetId: "", items: [] };
      if (cmd === "get_tree")
        return { path: "x", leafId: null, rootIds: [], activePathIds: [], nodes: [] };
      return null;
    });
    render(<App />);
    await screen.findByText(S1);
    expect(counts.list).toBe(1);

    // 距挂载不足 800ms：跳过
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(counts.list).toBe(1));

    await new Promise((r) => setTimeout(r, 850));
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(counts.list).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(counts.list).toBe(2);
  });
});

describe("缺 cwd 会话", () => {
  it("行与详情头展示目录不存在徽章，正常会话没有", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    expect(within(rowOf(S7)).getByText("目录不存在")).toBeInTheDocument();
    expect(within(rowOf(S1)).queryByText("目录不存在")).toBeNull();
  });

  it("在 iTerm 继续与从此节点继续均因缺 cwd 禁用，不触碰后端", async () => {
    const mock = await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S7));
    const itermBtn = screen.getByRole("button", { name: "在 iTerm 继续" });
    expect(itermBtn).toBeDisabled();
    expect(itermBtn).toHaveAttribute("title", "项目目录不存在");

    fireEvent.click(screen.getByRole("tab", { name: "树" }));
    await screen.findByText("当前位置");
    // 缺 cwd 时续聊必然打不开 iTerm：按钮禁用，append/open 均不会被调用。
    const contBtn = screen.getByRole("button", { name: "从此节点继续" });
    expect(contBtn).toBeDisabled();
    expect(contBtn).toHaveAttribute("title", "项目目录不存在");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mock.itermCalls).toEqual([]);
  });
});

describe("视图返回栈", () => {
  it("统计 → 管理 → 返回：逐级退回，而不是直接跳回会话页", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "统计" }));
    await screen.findByRole("heading", { name: "用量统计" });
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await screen.findByRole("heading", { name: "管理" });

    // 第一次返回 → 统计（上一级），不是会话页。
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(await screen.findByRole("heading", { name: "用量统计" })).toBeInTheDocument();
    // 再返回 → 会话页。
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "用量统计" })).toBeNull());
  });

  it("Esc 从子视图退回上一级；对话框打开时不抢 Esc", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    await screen.findByRole("heading", { name: "清理" });

    // 速查对话框打开时 Esc 先关它，视图不动。
    fireEvent.click(screen.getByRole("button", { name: "速查" }));
    const dialog = await screen.findByRole("dialog", { name: "命令速查" });
    // Esc 由对话框自己处理（它在容器上监听，焦点在内时生效）。
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令速查" })).toBeNull());
    expect(screen.getByRole("heading", { name: "清理" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "清理" })).toBeNull());
  });

  it("提示词历史页也有返回", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: "提示词历史" }));
    expect(await screen.findByRole("heading", { name: "提示词历史" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "提示词历史" })).toBeNull());
  });
});

describe("命令速查", () => {
  it("点击速查打开对话框，过滤缩小行，关闭按钮关闭", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "速查" }));
    const dialog = await screen.findByRole("dialog", { name: "命令速查" });
    // 默认是「入门路径」；命令表在「全部命令」页。
    fireEvent.click(within(dialog).getByRole("tab", { name: "全部命令" }));
    expect(within(dialog).getByText(/共 \d+ 条斜杠命令（内置 \d+ \+ 扩展 \d+）/)).toBeInTheDocument();

    const filter = within(dialog).getByRole("searchbox", { name: "过滤命令" });
    fireEvent.change(filter, { target: { value: "compact" } });
    // 每行都有一个「复制 /<命令名>」按钮：过滤后只剩 compact 那一行。
    expect(within(dialog).getAllByRole("button", { name: "复制 /compact" })).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: "复制 /shake" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "命令速查" })).toBeNull();
  });
});

const PINS_KEY = "omp-resume:pins:v1";

function idOf(title: string): string {
  const found = FIXTURE_SESSIONS.find((f) => f.summary.title === title);
  if (!found) throw new Error(`夹具缺少会话：${title}`);
  return found.summary.id;
}

function storedPins(): { projects: string[]; sessions: string[] } {
  return JSON.parse(localStorage.getItem(PINS_KEY) ?? "{}") as {
    projects: string[];
    sessions: string[];
  };
}

function groupOf(title: string): HTMLElement {
  const section = rowOf(title).closest(".group");
  if (!(section instanceof HTMLElement)) throw new Error(`未找到分组：${title}`);
  return section;
}

function rowTitlesIn(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll(".row-title"), (el) => el.textContent ?? "");
}

function groupNames(): string[] {
  return Array.from(document.querySelectorAll(".group-name"), (el) => el.textContent ?? "");
}

function groupByName(name: string): HTMLElement {
  for (const section of document.querySelectorAll(".group:not(.pinned-group)")) {
    const el = section.querySelector(".group-name");
    if (el?.textContent === name && section instanceof HTMLElement) return section;
  }
  throw new Error(`未找到项目组：${name}`);
}

function pinnedSection(): HTMLElement {
  const el = document.querySelector(".pinned-group");
  if (!(el instanceof HTMLElement)) throw new Error("未找到置顶区");
  return el;
}

describe("置顶", () => {
  it("置顶项目排到最前，重新挂载后顺序保持", async () => {
    await installMockBackend();
    const first = render(<App />);
    await screen.findByText(S1);
    const names = groupNames();
    const target = names[names.length - 1];

    fireEvent.click(screen.getByRole("button", { name: `置顶项目 ${target}` }));
    expect(groupNames()[0]).toBe(target);

    first.unmount();
    render(<App />);
    await screen.findByText(S1);
    expect(groupNames()[0]).toBe(target);
    expect(storedPins().projects).toHaveLength(1);
  });

  it("置顶会话跨项目聚合进置顶区，并从原组移出、不重复出现", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const namesBefore = groupNames();

    fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${S4}` }));
    fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${S1}` }));

    const pinned = pinnedSection();
    // 按修改时间新→旧：S1（3 分钟前）在 S4（30 小时前）之前。
    expect(rowTitlesIn(pinned)).toEqual([S1, S4]);
    // 置顶行脱离项目上下文：显示所属项目名。
    expect(Array.from(pinned.querySelectorAll(".row-project"), (el) => el.textContent)).toEqual([
      "omp-resume",
      "notes-app",
    ]);
    // 原组仍存在但不再包含这两个会话；全列表各出现一次。
    expect(groupNames()).toEqual(namesBefore);
    expect(screen.getAllByText(S1)).toHaveLength(1);
    expect(screen.getAllByText(S4)).toHaveLength(1);
    for (const section of document.querySelectorAll(".group:not(.pinned-group)")) {
      expect(rowTitlesIn(section as HTMLElement)).not.toContain(S1);
      expect(rowTitlesIn(section as HTMLElement)).not.toContain(S4);
    }
  });

  it("项目的会话全部置顶后组头保留并提示，新会话入口不丢", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const project = groupOf(S1);
    const name = project.querySelector(".group-name")?.textContent ?? "";
    const titles = rowTitlesIn(project);

    for (const t of titles) {
      fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${t}` }));
    }

    const emptied = groupByName(name);
    expect(rowTitlesIn(emptied)).toEqual([]);
    expect(within(emptied).getByText("该项目的会话均已置顶")).toBeInTheDocument();
    expect(within(emptied).getByRole("button", { name: `置顶项目 ${name}` })).toBeInTheDocument();
    expect(within(emptied).getByRole("button", { name: `在 ${name} 新会话` })).toBeInTheDocument();
    expect(rowTitlesIn(pinnedSection())).toHaveLength(titles.length);
  });

  it("过滤同时作用于置顶区：无匹配时整区隐藏", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const project = groupOf(S1);
    const target = rowTitlesIn(project).find((t) => t !== S1) ?? S1;
    fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${target}` }));

    const filter = screen.getByRole("searchbox", { name: "过滤会话" });
    fireEvent.change(filter, { target: { value: "notes" } });
    expect(document.querySelector(".pinned-group")).toBeNull();

    fireEvent.change(filter, { target: { value: "omp-resume" } });
    expect(rowTitlesIn(pinnedSection())).toEqual([target]);
  });

  it("详情工具栏的置顶与列表同步", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S1));
    fireEvent.click(screen.getByRole("button", { name: "置顶" }));

    expect(storedPins().sessions).toEqual([idOf(S1)]);
    expect(screen.getByRole("button", { name: `取消置顶会话 ${S1}` })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const detailToggle = screen.getByRole("button", { name: "已置顶" });
    expect(detailToggle).toHaveAttribute("aria-pressed", "true");
    expect(detailToggle).toHaveClass("btn-accent");
    fireEvent.click(detailToggle);
    expect(storedPins().sessions).toEqual([]);
    expect(screen.getByRole("button", { name: "置顶" })).toHaveAttribute("aria-pressed", "false");
  });

  it("删除成功的会话清理其置顶，其余置顶保留", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${S1}` }));
    fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${S2}` }));
    fireEvent.click(checkOf(S1));
    fireEvent.click(screen.getByRole("button", { name: /删除所选 \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await screen.findByText(/成功删除 1 个会话/);
    expect(storedPins().sessions).toEqual([idOf(S2)]);
  });

  it("删除失败的会话保留置顶", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    // s9 探测失败：后端返回 PROBE_FAILED，删除不成功。
    fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${S9}` }));
    fireEvent.click(checkOf(S9));
    fireEvent.click(screen.getByRole("button", { name: /删除所选 \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() =>
      expect(document.querySelector(".delete-results")).toHaveTextContent("占用探测失败"),
    );
    expect(storedPins().sessions).toEqual([idOf(S9)]);
  });
});

describe("批量选择", () => {
  function groupBox(name: string): HTMLElement {
    return within(groupByName(name)).getByRole("checkbox", {
      name: `选择项目 ${name} 的全部会话`,
    });
  }

  it("组头全选勾选该组全部会话，选择条计数与清除同步", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const project = groupOf(S1);
    const name = project.querySelector(".group-name")?.textContent ?? "";
    const paths = Array.from(project.querySelectorAll(".row"), (row) =>
      row.querySelector("input[type=checkbox]"),
    ).filter((el): el is HTMLInputElement => el != null);

    fireEvent.click(groupBox(name));
    expect(paths.every((box) => box.checked)).toBe(true);
    expect(screen.getByText(`已选 ${paths.length} 项`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /删除所选 \(\d+\)/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(screen.queryByText(/已选 \d+ 项/)).toBeNull();
    expect(paths.some((box) => box.checked)).toBe(false);
  });

  it("取消组头勾选清空该组；过滤后只勾选可见会话", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const project = groupOf(S1);
    const name = project.querySelector(".group-name")?.textContent ?? "";

    fireEvent.click(groupBox(name));
    fireEvent.click(groupBox(name));
    expect(screen.queryByText(/已选 \d+ 项/)).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "过滤会话" }), {
      target: { value: "DEMO4" },
    });
    fireEvent.click(groupBox(name));
    const checkedRows = document.querySelectorAll(".row input[type=checkbox]:checked");
    expect(checkedRows).toHaveLength(1);
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
  });

  it("置顶区全选只含置顶会话，原组不再重复", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: `置顶会话 ${S4}` }));

    fireEvent.click(
      within(pinnedSection()).getByRole("checkbox", { name: "选择全部置顶会话" }),
    );
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全选当前列表" }));
    const rows = document.querySelectorAll(".row");
    expect(screen.getByText(`已选 ${rows.length} 项`)).toBeInTheDocument();
  });
});

describe("omp 版本与更新", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("侧栏显示本机 omp 版本并提供检查按钮", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    expect(await screen.findByText("omp 18.11.1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查 omp 更新" })).toBeEnabled();
  });

  it("有新版时对话框提示可更新，一键更新后显示已更新", async () => {
    window.history.replaceState(null, "", "/?omp=new");
    await installMockBackend();
    render(<App />);
    await screen.findByText("omp 18.11.1");

    fireEvent.click(screen.getByRole("button", { name: "检查 omp 更新" }));
    const dialog = await screen.findByRole("dialog", { name: "omp 版本更新" });
    expect(within(dialog).getByText("可更新到 18.12.0")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "更新 omp" }));
    expect(await within(dialog).findByText(/已更新到 18\.12\.0/)).toBeInTheDocument();
  });

  it("已是最新版本时对话框显示最新状态", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText("omp 18.11.1");

    fireEvent.click(screen.getByRole("button", { name: "检查 omp 更新" }));
    const dialog = await screen.findByRole("dialog", { name: "omp 版本更新" });
    expect(within(dialog).getByText("已是最新版本")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "更新 omp" })).toBeNull();
  });

  it("检查失败时弹出错误提示且不打开对话框", async () => {
    window.history.replaceState(null, "", "/?fail=omp_update_check");
    await installMockBackend();
    render(<App />);
    await screen.findByText("omp 18.11.1");

    fireEvent.click(screen.getByRole("button", { name: "检查 omp 更新" }));
    expect(await screen.findByText("mock 强制失败：omp_update_check")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("记忆库跳转来源会话", () => {
  it("在管理页点击查看来源会话会离开管理视图并选中该会话", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    fireEvent.click(await screen.findByRole("tab", { name: "记忆库" }));
    fireEvent.click(await screen.findByRole("button", { name: "omp-resume" }));

    const jumps = await screen.findAllByRole("button", { name: "查看来源会话" });
    const enabled = jumps.find((b) => (b as HTMLButtonElement).disabled === false);
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled as HTMLButtonElement);

    expect(screen.queryByRole("heading", { name: "管理" })).toBeNull();
    expect(document.querySelector(".detail-head")).not.toBeNull();
  });
});
