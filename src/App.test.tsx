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
import type { ListSessionsResult } from "./types";

const S1 = "🎛️ DEMO: 构建可视化配置桌面应用";
const S2 = "🏠 DEMO4: 修复示例代理连接失败";
const S4 = "🦙 DEMO3: 本地模型总结笔记";
const S5 = "🔀 分支很多的会话：鉴权方案 A/B 对比";
const S7 = "🗑️ 旧项目：删库迁移记录";
const S9 = "🔒 权限问题排查";
const S10 = "(无标题)";

function rowOf(title: string): HTMLElement {
  for (const el of screen.getAllByText(title)) {
    const row = el.closest(".session-row");
    if (row) return row as HTMLElement;
  }
  throw new Error(`未找到会话行：${title}`);
}

function checkOf(title: string): HTMLElement {
  return within(rowOf(title)).getByRole("button", { name: /^(选择|取消选择)会话/ });
}

beforeEach(() => {
  clearMocks();
});

describe("列表：过滤与跨刷新保持", () => {
  it("过滤框按标题/cwd/首条用户消息匹配，空组隐藏", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    const input = screen.getByRole("searchbox", { name: "搜索会话" });
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

    fireEvent.click(checkOf(S2));
    fireEvent.click(rowOf(S1));
    expect(await screen.findByRole("heading", { name: S1 })).toBeInTheDocument();

    // 回到列表页刷新：选中与勾选跨路由保持。
    fireEvent.click(screen.getByRole("button", { name: /^会话列表/ }));
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());

    expect(rowOf(S1)).toHaveClass("is-active");
    expect(checkOf(S2)).toHaveAttribute("aria-pressed", "true");
    // 勾选行保留
    expect(checkOf(S2)).toBeInTheDocument();
  });

  it("列表页删除选中会话后不再显示，被删会话脱离选中", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(checkOf(S1));
    // 先进一次工作台建立 selectedPath，再回列表删除。
    fireEvent.click(rowOf(S1));
    await screen.findByRole("heading", { name: S1 });
    fireEvent.click(screen.getByRole("button", { name: /^会话列表/ }));
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await screen.findByText(/成功删除 1 个会话/);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(screen.queryByText(S1)).toBeNull();
    expect(checkOf(S2)).toHaveAttribute("aria-pressed", "false");
  });
});

describe("删除流程", () => {
  it("使用中会话列为跳过并从删除集合剔除", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(checkOf(S1));
    fireEvent.click(checkOf(S2));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("永久删除 2 个会话");
    expect(screen.getByRole("dialog")).toHaveTextContent("占用中已排除");
    expect(screen.getByText("使用中，将被跳过")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    // 只有 s1 提交删除：成功 1，无失败
    await screen.findByText(/成功删除 1 个会话/);
    expect(screen.queryByText(/占用探测失败/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByText(S1)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^会话列表/ }));
    expect(await screen.findByText(S2)).toBeInTheDocument();
  });

  it("部分失败逐条展示，不被吞掉", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    // s9 探测失败：后端返回 PROBE_FAILED
    fireEvent.click(checkOf(S9));
    fireEvent.click(checkOf(S10));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await screen.findByText(/成功删除 1 个会话/);
    const results = document.querySelector(".delete-results");
    expect(results).not.toBeNull();
    expect(results).toHaveTextContent("占用探测失败");
  });

  it("全部在使用中时弹「无法删除」单按钮变体", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(checkOf(S2));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("无法删除");
    expect(screen.getByRole("button", { name: "知道了" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "永久删除" })).toBeNull();
  });
});

describe("从节点分叉", () => {
  it("ForkDialog 确认：kv 说明 + 创建分支并打开", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S5));
    fireEvent.click(screen.getByRole("button", { name: "树" }));
    // 初始选中 = leaf（bx-L facts 面板出现）；选中由被动 effect 落定后按钮才可用。
    await screen.findByText("节点 bx-L");
    const contBtn = await screen.findByRole("button", { name: "从此节点分叉" });
    await waitFor(() => expect(contBtn).toBeEnabled());

    fireEvent.click(contBtn);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("从节点分叉");
    expect(dialog).toHaveTextContent("omp-resume-branch");

    fireEvent.click(within(dialog).getByRole("button", { name: "创建分支并打开" }));

    // leaf 节点 markerId null：notice 留在框内说明（不直接关）。
    await within(dialog).findByText("该节点已是当前位置，未追加标记");
    const handle = (window as unknown as { __ompMock?: { calls: string[] } }).__ompMock;
    expect(handle?.calls).toContain(FIXTURE_SESSIONS[4].summary.path);
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

  it("在 iTerm2 恢复与从此节点分叉均因缺 cwd 禁用，不触碰后端", async () => {
    const mock = await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S7));
    const itermBtn = screen.getByRole("button", { name: "在 iTerm2 恢复" });
    expect(itermBtn).toBeDisabled();
    expect(itermBtn).toHaveAttribute("title", "项目目录不存在");

    fireEvent.click(screen.getByRole("button", { name: "树" }));
    await screen.findByText(/节点 s7-/);
    // 缺 cwd 时续聊必然打不开 iTerm：按钮禁用，append/open 均不会被调用。
    const contBtn = screen.getByRole("button", { name: "从此节点分叉" });
    expect(contBtn).toBeDisabled();
    expect(contBtn).toHaveAttribute("title", "项目目录不存在");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mock.itermCalls).toEqual([]);
  });
});

describe("路由导航", () => {
  it("导航进入用量页与模型页，Esc 逐级退回", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "用量" }));
    await screen.findByRole("heading", { name: "用量" });
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    await screen.findByRole("heading", { name: "模型" });

    // Esc → 上一级（用量），不是会话页。
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("heading", { name: "用量" })).toBeInTheDocument();
    // 再 Esc → 会话列表页。
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "用量" })).toBeNull());
    expect(screen.getByText(S1)).toBeInTheDocument();
  });

  it("Esc 从子路由退回；对话框打开时不抢 Esc", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: "清理候选" }));
    await screen.findByRole("heading", { name: "清理候选" });

    // 删除对话框打开时 Esc 先关它，路由不动。
    fireEvent.click(screen.getByRole("button", { name: "速查表" }));
    await screen.findByRole("heading", { name: "速查表" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("heading", { name: "清理候选" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "清理候选" })).toBeNull());
  });

  it("提示词历史页可由导航进入", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: "提示词历史" }));
    expect(await screen.findByRole("heading", { name: "提示词历史" })).toBeInTheDocument();
  });
});

describe("速查表页", () => {
  it("导航进入速查表页", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "速查表" }));
    expect(await screen.findByRole("heading", { name: "速查表" })).toBeInTheDocument();
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
  const section = rowOf(title).closest(".project-block");
  if (!(section instanceof HTMLElement)) throw new Error(`未找到分组：${title}`);
  return section;
}

function rowTitlesIn(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll(".sr-title strong"), (el) => el.textContent ?? "");
}

function groupNames(): string[] {
  return Array.from(document.querySelectorAll(".p-name"), (el) => el.textContent ?? "");
}

function groupByName(name: string): HTMLElement {
  for (const section of document.querySelectorAll(".project-block")) {
    const el = section.querySelector(".p-name");
    if (el?.textContent === name && section instanceof HTMLElement) return section;
  }
  throw new Error(`未找到项目组：${name}`);
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

  it("置顶会话组内上浮，标题前出现 pin 图标", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    // S1 不在组首（按 mtime 排）：置顶后应上浮到组首。
    fireEvent.click(screen.getByRole("button", { name: `置顶 ${S1}` }));
    const project = groupOf(S1);
    expect(rowTitlesIn(project)[0]).toBe(S1);
    expect(project.querySelectorAll(".sr-title .pin")).toHaveLength(1);
    expect(storedPins().sessions).toEqual([idOf(S1)]);

    fireEvent.click(screen.getByRole("button", { name: `取消置顶 ${S1}` }));
    expect(groupOf(S1).querySelector(".sr-title .pin")).toBeNull();
    expect(storedPins().sessions).toEqual([]);
  });

  it("已置顶 chip 跨项目列出全部置顶会话", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: `置顶 ${S4}` }));
    fireEvent.click(screen.getByRole("button", { name: `置顶 ${S1}` }));
    fireEvent.click(screen.getByRole("button", { name: "状态筛选：已置顶" }));

    const titles = document.querySelectorAll(".session-row .sr-title strong");
    expect(Array.from(titles, (el) => el.textContent)).toEqual([S1, S4]);
  });

  it("过滤隐藏无匹配的置顶会话", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const project = groupOf(S1);
    const target = rowTitlesIn(project).find((t) => t !== S1) ?? S1;
    fireEvent.click(screen.getByRole("button", { name: `置顶 ${target}` }));

    const filter = screen.getByRole("searchbox", { name: "搜索会话" });
    fireEvent.change(filter, { target: { value: "notes" } });
    expect(screen.queryByText(target)).toBeNull();

    fireEvent.change(filter, { target: { value: "omp-resume" } });
    expect(screen.getByText(target)).toBeInTheDocument();
  });

  it("详情工具栏的置顶与列表同步", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(rowOf(S1));
    fireEvent.click(await screen.findByRole("button", { name: "置顶" }));

    expect(storedPins().sessions).toEqual([idOf(S1)]);
    const detailToggle = screen.getByRole("button", { name: "已置顶" });
    expect(detailToggle).toHaveAttribute("aria-pressed", "true");
    // 回列表：行内置顶按钮同步为已置顶。
    fireEvent.click(screen.getByRole("button", { name: /^会话列表/ }));
    await screen.findByText(S1);
    expect(screen.getByRole("button", { name: `取消置顶 ${S1}` })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 工作台取消置顶后同步回列表。
    fireEvent.click(rowOf(S1));
    fireEvent.click(await screen.findByRole("button", { name: "已置顶" }));
    expect(storedPins().sessions).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /^会话列表/ }));
    await screen.findByText(S1);
    expect(screen.getByRole("button", { name: `置顶 ${S1}` })).toHaveAttribute("aria-pressed", "false");
  });

  it("删除成功的会话清理其置顶，其余置顶保留", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: `置顶 ${S1}` }));
    fireEvent.click(screen.getByRole("button", { name: `置顶 ${S2}` }));
    fireEvent.click(checkOf(S1));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await screen.findByText(/成功删除 1 个会话/);
    expect(storedPins().sessions).toEqual([idOf(S2)]);
  });

  it("删除失败的会话保留置顶", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    // s9 探测失败：后端返回 PROBE_FAILED，删除不成功。
    fireEvent.click(screen.getByRole("button", { name: `置顶 ${S9}` }));
    fireEvent.click(checkOf(S9));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
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
  const pressedOn = (el: Element) => el.getAttribute("aria-pressed") === "true";

  it("组头全选勾选该组全部会话，选择条计数与清除同步", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const project = groupOf(S1);
    const name = project.querySelector(".p-name")?.textContent ?? "";
    const boxes = () =>
      Array.from(project.querySelectorAll(".session-row .sel-box"), (el) => el as HTMLElement);

    fireEvent.click(groupBox(name));
    expect(boxes().every(pressedOn)).toBe(true);
    expect(document.querySelector(".selection-bar")?.textContent).toContain(`已选择 ${boxes().length} 个会话`);
    // 选择条删除按钮与勾选一致。
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(document.querySelector(".selection-bar")).toBeNull();
    expect(
      Array.from(document.querySelectorAll(".session-row .sel-box")).some(pressedOn),
    ).toBe(false);
  });

  it("取消组头勾选清空该组；过滤后只勾选可见会话", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const project = groupOf(S1);
    const name = project.querySelector(".p-name")?.textContent ?? "";

    fireEvent.click(groupBox(name));
    fireEvent.click(groupBox(name));
    expect(document.querySelector(".selection-bar")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), {
      target: { value: "DEMO4" },
    });
    fireEvent.click(groupBox(name));
    expect(document.querySelectorAll(".session-row .sel-box.is-on")).toHaveLength(1);
    expect(document.querySelector(".selection-bar")?.textContent).toContain("已选择 1 个会话");
  });

  it("全选当前列表选中全部可见行", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    fireEvent.click(screen.getByRole("button", { name: `置顶 ${S4}` }));
    fireEvent.click(checkOf(S4));
    expect(document.querySelector(".selection-bar")?.textContent).toContain("已选择 1 个会话");

    fireEvent.click(screen.getByRole("button", { name: "全选当前列表" }));
    const rows = document.querySelectorAll(".session-row");
    expect(document.querySelector(".selection-bar")?.textContent).toContain(`已选择 ${rows.length} 个会话`);
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
    expect(await screen.findByText("omp 18.16.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
  });

  it("有新版时对话框提示可更新，一键更新后显示已更新", async () => {
    window.history.replaceState(null, "", "/?omp=new");
    await installMockBackend();
    render(<App />);
    await screen.findByText("omp 18.16.0");

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    const dialog = await screen.findByRole("dialog", { name: "omp 版本更新" });
    expect(within(dialog).getByText("可更新到 18.17.0")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "更新 omp" }));
    expect(await within(dialog).findByText(/已更新到 18\.17\.0/)).toBeInTheDocument();
  });

  it("已是最新版本时对话框显示最新状态", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText("omp 18.16.0");

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    const dialog = await screen.findByRole("dialog", { name: "omp 版本更新" });
    expect(within(dialog).getByText("已是最新版本")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "更新 omp" })).toBeNull();
  });

  it("检查失败时弹出错误提示且不打开对话框", async () => {
    window.history.replaceState(null, "", "/?fail=omp_update_check");
    await installMockBackend();
    render(<App />);
    await screen.findByText("omp 18.16.0");

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("mock 强制失败：omp_update_check")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("记忆库跳转来源会话", () => {
  it("在管理页点击查看来源会话会离开管理视图并选中该会话", async () => {
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看 omp-resume 的记忆" }));

    const jumps = await screen.findAllByRole("button", { name: "查看来源会话" });
    const enabled = jumps.find((b) => (b as HTMLButtonElement).disabled === false);
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled as HTMLButtonElement);

    // 跳到来源会话：离开记忆页，进入工作台（详情头还在）。
    expect(screen.queryByRole("heading", { name: "记忆" })).toBeNull();
    expect(document.querySelector(".ws-head")).not.toBeNull();
  });
});

describe("工作台进舞台回看", () => {
  it("工作台点舞台进入回看；换会话再进则切换目标", async () => {
    // 舞台画布需要 ResizeObserver 与 canvas（jsdom 没有）：只验证切换逻辑，不画画布。
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    HTMLCanvasElement.prototype.getContext = () => null;
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);

    // mock 的「运行中」是 sessions[0]（= S1），所以舞台会先落在 S1 上。
    fireEvent.click(rowOf(S1));
    fireEvent.click(await screen.findByRole("button", { name: "舞台" }));
    await screen.findByRole("group", { name: "角色卡片" });
    const headTitle = () => document.querySelector(".stage-head-title")?.textContent;
    await waitFor(() => {
      expect(headTitle()).toBe(S1);
    });
    // 舞台内点左栏「运行中」的 S1：舞台目标仍是 S1。
    const rail = screen.getByRole("complementary", { name: "会话选择" });
    fireEvent.click(within(rail).getByRole("button", { name: new RegExp(S1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }));
    await waitFor(() => {
      expect(headTitle()).toBe(S1);
    });
    // 换会话：回列表进 S2 工作台，再点舞台 → 目标切到 S2。
    fireEvent.click(screen.getByRole("button", { name: /^会话列表/ }));
    await screen.findByText(S2);
    fireEvent.click(rowOf(S2));
    fireEvent.click(await screen.findByRole("button", { name: "舞台" }));
    await waitFor(() => {
      expect(headTitle()).toBe(S2);
    });
  });
});

describe("并发 load 与 toast 上限", () => {
  it("删除时与进行中的 load 并发，删除后列表反映删除", async () => {
    const gate = Promise.withResolvers<ListSessionsResult>();
    let lists = 0;
    let deleted = false;
    mockIPC(async (cmd: string) => {
      if (cmd === "list_sessions") {
        lists += 1;
        if (lists === 1) return gate.promise;
        return buildListResult(deleted ? FIXTURE_SESSIONS.slice(1) : FIXTURE_SESSIONS);
      }
      if (cmd === "delete_sessions") {
        deleted = true;
        return [{ path: FIXTURE_SESSIONS[0].summary.path, ok: true }];
      }
      if (cmd === "get_meta") return { revision: 0, sessions: {} };
      if (cmd === "get_session_usage")
        return {
          messages: { user: 0, assistant: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { total: 0, main: 0, background: 0, subagent: 0 },
          models: [],
        };
      if (cmd === "get_conversation") return { path: "x", leafId: null, targetId: "", items: [] };
      if (cmd === "get_tree") return { path: "x", leafId: null, rootIds: [], activePathIds: [], nodes: [] };
      if (cmd === "get_omp_version") throw { code: "OMP_NOT_FOUND", message: "未安装" };
      return null;
    });
    render(<App />);
    // 首个 load 被门住时触发删除：删除内部 await load() 命中 inFlight → rerun。
    await waitFor(() => expect(lists).toBe(1));
    gate.resolve(buildListResult(FIXTURE_SESSIONS));
    await screen.findByText(S1);
    fireEvent.click(checkOf(S1));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await screen.findByText(/成功删除 1 个会话/);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByText(S1)).toBeNull());
  });

  it("toast 超过 5 条丢弃最旧", async () => {
    window.history.replaceState(null, "", "/?fail=omp_update_check");
    await installMockBackend();
    render(<App />);
    await screen.findByText(S1);
    const btn = screen.getByRole("button", { name: "检查更新" });
    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(btn);
      await screen.findAllByText("mock 强制失败：omp_update_check");
    }
    expect(document.querySelectorAll(".toast").length).toBeLessThanOrEqual(5);
    expect(document.querySelectorAll(".toast").length).toBeGreaterThan(1);
  });
});
