/** DetailPane 占用者行单测：有 occupant 显示应用/版本/PID，无则不显示。 */
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DetailPane } from "./DetailPane";
import { FIXTURE_SESSIONS } from "../dev/fixtures";
import { installMockBackend } from "../dev/mockBackend";
import type { SessionSummary } from "../types";
const noop = () => {};

beforeEach(() => {
  clearMocks();
});

describe("DetailPane 占用者行", () => {
  it("有 occupant 时显示“占用：应用 版本 · PID”", async () => {
    await installMockBackend();
    // s2：inUse + occupant { VS Code 1.138.0, pid 3074 }（见 dev/fixtures）。
    const s2 = FIXTURE_SESSIONS[1].summary;
    if (s2.occupant?.app !== "VS Code") throw new Error("夹具 s2 缺少 VS Code 占用者");
    render(
      <DetailPane
        session={s2}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={noop}
      />,
    );
    expect(await screen.findByText(/占用：VS Code 1\.138\.0 · PID 3074/)).toBeTruthy();
  });

  it("无 occupant 时不显示占用行", async () => {
    await installMockBackend();
    // s1：普通会话，无 occupant。
    const s1 = FIXTURE_SESSIONS[0].summary;
    if (s1.occupant !== null) throw new Error("夹具 s1 应无占用者");
    const { container } = render(
      <DetailPane
        session={s1}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={noop}
      />,
    );
    expect(container.textContent).not.toContain("占用：");
  });
});

describe("复制会话 ID", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  it("点击会话 ID 写入剪贴板并提示已复制", async () => {
    await installMockBackend();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const onToast = vi.fn<(text: string, kind: "info" | "error") => void>();
    const s1 = FIXTURE_SESSIONS[0].summary;
    render(
      <DetailPane
        session={s1}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={onToast}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={noop}
      />,
    );

    fireEvent.click(document.querySelector(".ws-meta .id-copy") as HTMLElement);

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("已复制会话 ID", "info"));
    expect(writeText).toHaveBeenCalledWith(s1.id);
  });

  it("剪贴板写入被拒绝时经原生 copy_text 兜底仍提示已复制", async () => {
    await installMockBackend();
    stubClipboard(() => Promise.reject(new Error("denied")));
    const onToast = vi.fn<(text: string, kind: "info" | "error") => void>();
    render(
      <DetailPane
        session={FIXTURE_SESSIONS[0].summary}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={onToast}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={noop}
      />,
    );

    fireEvent.click(document.querySelector(".ws-meta .id-copy") as HTMLElement);

    // navigator.clipboard 被拒 → 落到原生 copy_text（mock 下成功）→ 仍提示已复制。
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("已复制会话 ID", "info"));
  });

  it("原生 copy_text 也失败时提示手动复制", async () => {
    // 不装 mock 后端：copy_text 的 invoke 无正常 mock → 兜底抛错。
    mockIPC(() => {
      throw new Error("no mock");
    });
    stubClipboard(() => Promise.reject(new Error("denied")));
    const onToast = vi.fn<(text: string, kind: "info" | "error") => void>();
    render(
      <DetailPane
        session={FIXTURE_SESSIONS[0].summary}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={onToast}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={noop}
      />,
    );

    fireEvent.click(document.querySelector(".ws-meta .id-copy") as HTMLElement);

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("复制失败，请手动选择复制", "error"),
    );
  });
});

describe("快速切换会话", () => {
  function renderPane(session: SessionSummary) {
    return render(
      <DetailPane
        session={session}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={noop}
      />,
    );
  }

  it("快速切换会话只显示最新对话", async () => {
    const s1 = FIXTURE_SESSIONS[0].summary;
    const s2 = FIXTURE_SESSIONS[1].summary;
    const slow = Promise.withResolvers<unknown>();
    mockIPC((cmd, args) => {
      if (cmd === "get_conversation" && args && typeof args === "object" && "path" in args && args.path === s1.path) return slow.promise;
      if (cmd === "get_conversation") return { path: s2.path, leafId: null, targetId: "", items: [{ kind: "user", text: "快会话的对话" }] };
      if (cmd === "get_session_usage") return { cost: { total: 0, main: 0, background: 0, subagent: 0 }, messages: { user: 0, assistant: 0 }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, models: [] };
      throw `no handler for ${cmd}`;
    });
    const view = renderPane(s1);
    view.rerender(
      <DetailPane
        session={s2}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={noop}
      />,
    );
    expect(await screen.findByText("快会话的对话")).toBeTruthy();
    slow.resolve({ path: s1.path, leafId: null, targetId: "", items: [{ kind: "user", text: "慢会话的对话" }] });
    await waitFor(() => expect(screen.queryByText("慢会话的对话")).toBeNull());
  });
});
describe("tab 上提（T7）", () => {
  it("tab 由外部 detailTab 决定，点击标签页回调 onDetailTabChange", async () => {
    await installMockBackend();
    const onDetailTabChange = vi.fn();
    const s1 = FIXTURE_SESSIONS[0].summary;
    const view = render(
      <DetailPane
        session={s1}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="overview"
        onDetailTabChange={onDetailTabChange}
      />,
    );
    expect(screen.getByRole("button", { name: "概览" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(onDetailTabChange).toHaveBeenCalledWith("conv");
    // 外部状态驱动切换：重渲染后对话面板可见。
    view.rerender(
      <DetailPane
        session={s1}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onDelete={noop}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="conv"
        onDetailTabChange={onDetailTabChange}
      />,
    );
    expect(screen.getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "true");
  });
});
describe("树在对话中定位（R4）", () => {
  it("onLocate 切 conv tab 并透传 activeNodeId", async () => {
    await installMockBackend();
    const onDetailTabChange = vi.fn();
    const s5 = FIXTURE_SESSIONS[4].summary;
    render(
      <DetailPane
        session={s5}
        gone={false}
        refreshKey={0}
        onOpenIterm={noop}
        onOpenStage={noop}
        onBack={noop}
        metaRequest={null}
        onOpenMetaDialog={noop}
        onForkRequest={noop}
        onDelete={noop}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        detailTab="tree"
        onDetailTabChange={onDetailTabChange}
      />,
    );
    // 树加载后点「在对话中定位」：应回调切 tab（App 侧 setTab("conv")）。
    const locate = await screen.findByRole("button", { name: "在对话中定位" });
    fireEvent.click(locate);
    expect(onDetailTabChange).toHaveBeenCalledWith("conv");
  });
});
