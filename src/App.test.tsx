/**
 * App 集成测试（mockIPC + DEV 夹具）：
 * 列表过滤、选择/勾选跨刷新保持、删除流程、从节点继续 UI、focus 刷新节流。
 */
import { beforeEach, describe, expect, it } from "vitest";
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

    fireEvent.change(input, { target: { value: "obsidian" } });
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
    // 初始选中 = leaf（bx-L「当前位置」）
    await screen.findByText("当前位置");

    fireEvent.click(screen.getByRole("button", { name: "从此节点继续" }));
    const dialog = screen.getByRole("dialog");
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
