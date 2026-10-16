/** SessionMetaEditor 单测：脏态保存、标签增删、冲突重载、损坏禁用。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionMetaEditor } from "./SessionMetaEditor";
import { installMockBackend } from "../dev/mockBackend";
import type { MetaSnapshot } from "../types";

const noopToast = () => {};

function mockHandle() {
  return (window as unknown as { __ompMock: { bumpMeta: () => void } }).__ompMock;
}

beforeEach(() => {
  clearMocks();
});

describe("SessionMetaEditor", () => {
  it("未修改时保存/还原禁用；修改后保存成功同步快照", async () => {
    await installMockBackend();
    const onSnapshot = vi.fn<(snap: MetaSnapshot) => void>();
    render(
      <SessionMetaEditor
        sessionId="s1"
        entry={null}
        revision={0}
        loadError={null}
        onSnapshot={onSnapshot}
        onToast={noopToast}
      />,
    );
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "还原" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "会话别名" }), {
      target: { value: "我的别名" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    const snap = onSnapshot.mock.calls[0][0];
    expect(snap.revision).toBe(1);
    expect(snap.sessions["s1"].alias).toBe("我的别名");
  });

  it("标签回车添加、点 × 删除；重复标签忽略", async () => {
    await installMockBackend();
    const onSnapshot = vi.fn<(snap: MetaSnapshot) => void>();
    render(
      <SessionMetaEditor
        sessionId="s1"
        entry={null}
        revision={0}
        loadError={null}
        onSnapshot={onSnapshot}
        onToast={noopToast}
      />,
    );
    const input = screen.getByRole("textbox", { name: "添加标签" });
    fireEvent.change(input, { target: { value: "bug" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "BUG" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "删除标签 BUG" })).toBeNull();
    expect(screen.getByRole("button", { name: "删除标签 bug" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除标签 bug" }));
    expect(screen.queryByRole("button", { name: "删除标签 bug" })).toBeNull();
    // 删回原样 → 不再是脏态。
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("CONFLICT 时提示已被外部修改并重载，用户可重试", async () => {
    await installMockBackend();
    const onSnapshot = vi.fn<(snap: MetaSnapshot) => void>();
    const onToast = vi.fn<(text: string, kind: "info" | "error") => void>();
    render(
      <SessionMetaEditor
        sessionId="s1"
        entry={null}
        revision={0}
        loadError={null}
        onSnapshot={onSnapshot}
        onToast={onToast}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "会话别名" }), {
      target: { value: "a" },
    });
    // 模拟外部修改顶掉 revision。
    mockHandle().bumpMeta();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/已被外部修改/);
    // 冲突后自动重载了一次快照。
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    expect(onSnapshot.mock.calls[0][0].revision).toBe(1);
  });

  it("META_CORRUPT 时显示错误并禁用保存", async () => {
    await installMockBackend();
    render(
      <SessionMetaEditor
        sessionId="s1"
        entry={null}
        revision={0}
        loadError={{ code: "META_CORRUPT", message: "备注文件已损坏" }}
        onSnapshot={() => {}}
        onToast={noopToast}
      />,
    );
    expect(screen.getByText(/备注文件已损坏/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "会话别名" }), {
      target: { value: "a" },
    });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });
});
