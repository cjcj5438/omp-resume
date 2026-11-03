import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Conversation, SuperagentResponse, SuperagentSessionItem } from "../../types";
import { SuperagentSessionsView } from "./SuperagentSessionsView";

const requestMock = vi.fn<() => Promise<SuperagentResponse>>();
const convMock = vi.fn<(req: { path: string }) => Promise<Conversation>>();

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    superagentRequest: () => requestMock(),
    getConversation: (req: { path: string }) => convMock(req),
  };
});

type RowState = SuperagentSessionItem["state"];

function item(id: string, state: RowState, extra: Partial<SuperagentSessionItem> = {}): SuperagentSessionItem {
  return {
    id, role: "worker", ticketId: "t1", title: `标题-${id}`,
    sessionFile: `/mock/superagent/sessions/${id}/x.jsonl`, state, ...extra,
  };
}

function listBody(items: SuperagentSessionItem[]): SuperagentResponse {
  return { status: 200, body: JSON.stringify({ items }) };
}

function conv(): Conversation {
  return {
    path: "/mock/x.jsonl", targetId: "a", leafId: "a", branchPointId: null,
    items: [{ kind: "user", id: "a", timestamp: null, text: "你好" }],
  };
}

beforeEach(() => {
  requestMock.mockReset();
  convMock.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("SuperagentSessionsView", () => {
  it("五行状态映射到 pill 文案与角色 Badge", async () => {
    const states: [string, RowState][] = [
      ["w-run", "running"], ["w-settle", "settling"], ["w-start", "starting"], ["w-idle", "idle"], ["w-absent", "absent"],
    ];
    requestMock.mockResolvedValue(listBody([
      item("main", "idle", { role: "orchestrator", ticketId: null, title: "主会话标题" }),
      ...states.map(([id, state]) => item(id, state)),
    ]));
    convMock.mockResolvedValue(conv());
    render(<SuperagentSessionsView target={null} />);
    const list = await screen.findByRole("list");
    expect(within(list).getByText("主会话标题")).toBeInTheDocument();
    // 主会话 accent Badge，worker 灰 Badge。
    expect(within(list).getByText("主会话")).toHaveClass("badge-accent");
    expect(within(list).getByText("运行中")).toBeInTheDocument();
    expect(within(list).getByText("收尾中")).toBeInTheDocument();
    expect(within(list).getByText("启动中")).toBeInTheDocument();
    expect(within(list).getAllByText("空闲").length).toBeGreaterThanOrEqual(1);
    expect(within(list).getByText("未运行")).toBeInTheDocument();
    expect(within(list).getAllByText("worker").length).toBe(5);
  });

  it("选中行调用 getConversation(sessionFile) 并渲染对话", async () => {
    requestMock.mockResolvedValue(listBody([item("main", "idle"), item("worker-1", "running")]));
    convMock.mockResolvedValue(conv());
    render(<SuperagentSessionsView target={null} />);
    const list = await screen.findByRole("list");
    const row = within(list).getByText("标题-worker-1").closest("button");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(convMock).toHaveBeenCalledWith({ path: "/mock/superagent/sessions/worker-1/x.jsonl" });
    expect(await screen.findByText("你好")).toBeInTheDocument();
  });

  it("target.seq 变化选中目标（同 id 重复点也生效）", async () => {
    requestMock.mockResolvedValue(listBody([item("main", "idle"), item("worker-9", "running")]));
    convMock.mockResolvedValue(conv());
    const { rerender } = render(<SuperagentSessionsView target={{ id: "main", seq: 0 }} />);
    const list = await screen.findByRole("list");
    expect(within(list).getByText("标题-main")).toBeInTheDocument();
    rerender(<SuperagentSessionsView target={{ id: "worker-9", seq: 1 }} />);
    const selected = within(list).getByText("标题-worker-9").closest("button");
    expect(selected?.getAttribute("aria-pressed")).toBe("true");
    rerender(<SuperagentSessionsView target={{ id: "worker-9", seq: 2 }} />);
    const again = within(list).getByText("标题-worker-9").closest("button");
    expect(again?.getAttribute("aria-pressed")).toBe("true");
  });

  it("sessionFile 为 null 显示无记录空态，不调 getConversation", async () => {
    requestMock.mockResolvedValue(listBody([
      item("main", "idle", { sessionFile: null }),
    ]));
    render(<SuperagentSessionsView target={null} />);
    expect(await screen.findByText("该会话还没有记录")).toBeInTheDocument();
    expect(convMock).not.toHaveBeenCalled();
  });

  it("形状错误的行被丢掉，好行照常显示", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ items: [item("good", "idle"), { id: 42, role: "nope" }, null, "x"] }),
    });
    convMock.mockResolvedValue(conv());
    render(<SuperagentSessionsView target={null} />);
    const list = await screen.findByRole("list");
    expect(within(list).getByText("标题-good")).toBeInTheDocument();
    expect(screen.queryByText("42")).toBeNull();
  });

  it("请求失败显示 ErrorBanner", async () => {
    requestMock.mockRejectedValue({ code: "SUPERAGENT_UNAVAILABLE", message: "守护进程未运行" });
    render(<SuperagentSessionsView target={null} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("守护进程未运行");
  });
});
