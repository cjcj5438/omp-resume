/** DetailPane 占用者行单测：有 occupant 显示应用/版本/PID，无则不显示。 */
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DetailPane } from "./DetailPane";
import { FIXTURE_SESSIONS } from "../dev/fixtures";
import { installMockBackend } from "../dev/mockBackend";

const noop = () => {};
const noContinue = async () => ({ notice: null });

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
        checkedCount={0}
        refreshKey={0}
        onOpenIterm={noop}
        onDelete={noop}
        onContinue={noContinue}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        metaRevision={0}
        metaError={null}
        onMetaSnapshot={noop}
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
        checkedCount={0}
        refreshKey={0}
        onOpenIterm={noop}
        onDelete={noop}
        onContinue={noContinue}
        onToast={noop}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        metaRevision={0}
        metaError={null}
        onMetaSnapshot={noop}
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
        checkedCount={0}
        refreshKey={0}
        onOpenIterm={noop}
        onDelete={noop}
        onContinue={noContinue}
        onToast={onToast}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        metaRevision={0}
        metaError={null}
        onMetaSnapshot={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制会话 ID" }));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("已复制会话 ID", "info"));
    expect(writeText).toHaveBeenCalledWith(s1.id);
  });

  it("剪贴板写入被拒绝时提示手动复制", async () => {
    await installMockBackend();
    stubClipboard(() => Promise.reject(new Error("denied")));
    const onToast = vi.fn<(text: string, kind: "info" | "error") => void>();
    render(
      <DetailPane
        session={FIXTURE_SESSIONS[0].summary}
        gone={false}
        checkedCount={0}
        refreshKey={0}
        onOpenIterm={noop}
        onDelete={noop}
        onContinue={noContinue}
        onToast={onToast}
        pinned={false}
        onTogglePin={noop}
        metaEntry={null}
        metaRevision={0}
        metaError={null}
        onMetaSnapshot={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制会话 ID" }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("复制失败，请手动选择复制", "error"),
    );
  });
});
