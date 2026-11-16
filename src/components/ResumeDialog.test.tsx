/** ResumeDialog 单测：idle/inUse 变体、探测失败禁用、focus 路由。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResumeDialog } from "./ResumeDialog";
import { FIXTURE_SESSIONS } from "../dev/fixtures";

beforeEach(() => {
  clearMocks();
});

describe("ResumeDialog", () => {
  it("idle 会话：确认调 open_in_iterm + toast + 刷新", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "check_session") return { inUse: false, probeOk: true };
      if (cmd === "open_in_iterm") return null;
      return null;
    });
    const s1 = FIXTURE_SESSIONS[0].summary;
    const onOpened = vi.fn();
    const onToast = vi.fn();
    const onClose = vi.fn();
    render(<ResumeDialog session={s1} onClose={onClose} onOpened={onOpened} onToast={onToast} />);
    const open = await screen.findByRole("button", { name: "打开标签页" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    await waitFor(() => expect(calls).toContain("open_in_iterm"));
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("inUse + iTerm2 占用：主按钮切标签页，不调 open_in_iterm", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "check_session") return { inUse: true, probeOk: true };
      if (cmd === "focus_iterm_tab") return null;
      return null;
    });
    const s1 = {
      ...FIXTURE_SESSIONS[0].summary,
      occupant: { pid: 100, app: "iTerm2", appVersion: "3.5" },
    };
    const onClose = vi.fn();
    render(<ResumeDialog session={s1} onClose={onClose} onOpened={() => {}} onToast={() => {}} />);
    const focus = await screen.findByRole("button", { name: "切到正在运行的标签页" });
    fireEvent.click(focus);
    await waitFor(() => expect(calls).toContain("focus_iterm_tab"));
    expect(calls).not.toContain("open_in_iterm");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("inUse + 非 iTerm 占用：只有「知道了」", async () => {
    mockIPC((cmd) => {
      if (cmd === "check_session") return { inUse: true, probeOk: true };
      return null;
    });
    const s2 = FIXTURE_SESSIONS[1].summary;
    render(<ResumeDialog session={s2} onClose={() => {}} onOpened={() => {}} onToast={() => {}} />);
    expect(await screen.findByRole("button", { name: "知道了" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开标签页" })).toBeNull();
    expect(screen.queryByRole("button", { name: "切到正在运行的标签页" })).toBeNull();
  });

  it("探测失败：warn 且不给打开标签页", async () => {
    mockIPC((cmd) => {
      if (cmd === "check_session") return { inUse: false, probeOk: false };
      return null;
    });
    const s1 = FIXTURE_SESSIONS[0].summary;
    render(<ResumeDialog session={s1} onClose={() => {}} onOpened={() => {}} onToast={() => {}} />);
    await screen.findByText(/占用探测失败/);
    expect(screen.getByRole("button", { name: "打开标签页" })).toBeDisabled();
  });

  it("确认中挂起不关闭；失败后留在框内可重试，重试成功只关闭并刷新一次", async () => {
    const { promise: gate, reject: rejectOpen } = Promise.withResolvers<unknown>();
    let opens = 0;
    mockIPC((cmd) => {
      if (cmd === "check_session") return { inUse: false, probeOk: true };
      if (cmd === "open_in_iterm") {
        opens += 1;
        return opens === 1 ? gate : null;
      }
      return null;
    });
    const s1 = FIXTURE_SESSIONS[0].summary;
    const onClose = vi.fn();
    const onOpened = vi.fn();
    const onToast = vi.fn();
    render(<ResumeDialog session={s1} onClose={onClose} onOpened={onOpened} onToast={onToast} />);
    const open = await screen.findByRole("button", { name: "打开标签页" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);

    // 挂起期间：按钮禁用，取消也禁用，框不关闭。
    await waitFor(() => expect(open).toBeDisabled());
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();

    // 后端确认失败：error toast、框保留、未刷新，按钮恢复可用。
    rejectOpen({ code: "ITERM_FAILED", message: "未检测到 omp 启动该会话" });
    await waitFor(() => expect(onToast).toHaveBeenCalledTimes(1));
    expect(onToast.mock.calls[0][1]).toBe("error");
    expect(String(onToast.mock.calls[0][0])).toContain("未检测到 omp 启动该会话");
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
    const retry = await screen.findByRole("button", { name: "打开标签页" });
    await waitFor(() => expect(retry).toBeEnabled());

    // 重试成功：只关闭一次、只刷新一次，toast 为 info。
    fireEvent.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledTimes(2);
    expect(onToast.mock.calls[1][1]).toBe("info");
    expect(opens).toBe(2);
  });
});
