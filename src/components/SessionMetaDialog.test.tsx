/** SessionMetaDialog 单测：逗号标签解析、保存同步、冲突重载、损坏禁用（由 SessionMetaEditor 测试移植）。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionMetaDialog, parseTags } from "./SessionMetaDialog";
import { installMockBackend } from "../dev/mockBackend";
import type { MetaSnapshot } from "../types";

const noopToast = () => {};
const noopClose = () => {};

function mockHandle() {
  return (window as unknown as { __ompMock: { bumpMeta: () => void } }).__ompMock;
}

beforeEach(() => {
  clearMocks();
});

describe("parseTags", () => {
  it("中英文逗号拆分、去空、去重（大小写不敏感保留首个）", () => {
    expect(parseTags("Rust, 布局，rust,, ，Go")).toEqual(["Rust", "布局", "Go"]);
    expect(parseTags("  ")).toEqual([]);
  });
});

describe("SessionMetaDialog", () => {
  it("保存成功同步快照并关闭", async () => {
    await installMockBackend();
    const onSnapshot = vi.fn<(snap: MetaSnapshot) => void>();
    const onClose = vi.fn();
    render(
      <SessionMetaDialog
        sessionId="s1"
        sessionTitle="会话 s1"
        entry={null}
        revision={0}
        loadError={null}
        onSnapshot={onSnapshot}
        onClose={onClose}
        onToast={noopToast}
      />,
    );
    fireEvent.change(screen.getByLabelText("别名"), { target: { value: "我的别名" } });
    fireEvent.change(screen.getByLabelText("标签"), { target: { value: "bug, 高优" } });
    fireEvent.click(screen.getByRole("button", { name: "保存到 meta.json" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    const snap = onSnapshot.mock.calls[0][0];
    expect(snap.revision).toBe(1);
    expect(snap.sessions["s1"].alias).toBe("我的别名");
    expect(snap.sessions["s1"].tags).toEqual(["bug", "高优"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("CONFLICT 时提示已被外部修改并重载，用户可重试", async () => {
    await installMockBackend();
    const onSnapshot = vi.fn<(snap: MetaSnapshot) => void>();
    const onToast = vi.fn<(text: string, kind: "info" | "error") => void>();
    render(
      <SessionMetaDialog
        sessionId="s1"
        sessionTitle="会话 s1"
        entry={null}
        revision={0}
        loadError={null}
        onSnapshot={onSnapshot}
        onClose={noopClose}
        onToast={onToast}
      />,
    );
    fireEvent.change(screen.getByLabelText("别名"), { target: { value: "a" } });
    // 模拟外部修改顶掉 revision。
    mockHandle().bumpMeta();
    fireEvent.click(screen.getByRole("button", { name: "保存到 meta.json" }));
    await screen.findByText(/已被外部修改/);
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    expect(onSnapshot.mock.calls[0][0].revision).toBe(1);
  });

  it("META_CORRUPT 时显示错误并禁用保存", async () => {
    await installMockBackend();
    render(
      <SessionMetaDialog
        sessionId="s1"
        sessionTitle="会话 s1"
        entry={null}
        revision={0}
        loadError={{ code: "META_CORRUPT", message: "备注文件已损坏" }}
        onSnapshot={() => {}}
        onClose={noopClose}
        onToast={noopToast}
      />,
    );
    expect(screen.getByText(/备注文件已损坏/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("别名"), { target: { value: "a" } });
    expect(screen.getByRole("button", { name: "保存到 meta.json" })).toBeDisabled();
  });

  it("标签超长/超数/别名超长时本地校验拦截，不发请求", async () => {
    await installMockBackend();
    const onSnapshot = vi.fn<(snap: MetaSnapshot) => void>();
    render(
      <SessionMetaDialog
        sessionId="s1"
        sessionTitle="会话 s1"
        entry={null}
        revision={0}
        loadError={null}
        onSnapshot={onSnapshot}
        onClose={noopClose}
        onToast={noopToast}
      />,
    );
    fireEvent.change(screen.getByLabelText("标签"), { target: { value: "x".repeat(25) } });
    fireEvent.click(screen.getByRole("button", { name: "保存到 meta.json" }));
    await screen.findByText(/单个标签最多/);
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});
