/** NewSessionDialog 单测：模型下拉、留空用上次目录、提交调 new_session_in_iterm。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewSessionDialog } from "./NewSessionDialog";

beforeEach(() => {
  clearMocks();
  localStorage.clear();
});

describe("NewSessionDialog", () => {
  it("模型下拉首项为默认；提交带 model 参数", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_models") return [{ selector: "5438/deepseek", provider: "p", id: "deepseek" }];
      if (cmd === "new_session_in_iterm") return null;
      return null;
    });
    const onClose = vi.fn();
    render(<NewSessionDialog initialCwd="/Users/demo/my/omp-resume" onClose={onClose} onToast={() => {}} />);
    const select = (await screen.findByLabelText("模型")) as HTMLSelectElement;
    expect(select.options[0].text).toBe("默认（不指定）");
    fireEvent.change(select, { target: { value: "5438/deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "在 iTerm2 启动" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const call = calls.find((c) => c.cmd === "new_session_in_iterm");
    expect(call?.args).toMatchObject({ cwd: "/Users/demo/my/omp-resume", model: "5438/deepseek" });
  });

  it("留空用上次目录；无上次目录时报错不提交", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "list_models") return [];
      return null;
    });
    const onToast = vi.fn();
    localStorage.setItem("omp-resume:new-session-dir", "/Users/demo/last");
    const view = render(<NewSessionDialog initialCwd={null} onClose={() => {}} onToast={onToast} />);
    // 回填上次目录。
    expect((screen.getByLabelText("工作目录") as HTMLInputElement).value).toBe("/Users/demo/last");
    view.unmount();

    localStorage.clear();
    render(<NewSessionDialog initialCwd={null} onClose={() => {}} onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "在 iTerm2 启动" }));
    expect(onToast).toHaveBeenCalledWith("请填写工作目录，或点「选择…」挑选", "error");
    expect(calls).not.toContain("new_session_in_iterm");
  });

  it("模型列表加载失败时仅默认项可提交", async () => {
    mockIPC((cmd) => {
      if (cmd === "list_models") throw { code: "IO", message: "boom" };
      return null;
    });
    render(<NewSessionDialog initialCwd="/tmp/x" onClose={() => {}} onToast={() => {}} />);
    await screen.findByText("模型列表加载失败，仅可用默认模型提交。");
    const select = screen.getByLabelText("模型") as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
  });
});
