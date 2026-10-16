/**
 * SkillsPanel 测试：只读列表、隐藏徽章、说明文案、更新重载与失败恢复。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installMockBackend } from "../dev/mockBackend";
import { SkillsPanel } from "./SkillsPanel";
import { useOmpOp, type ToastFn } from "./useOmpOp";

function Host({ onToast }: { onToast: ToastFn }) {
  const op = useOmpOp();
  return <SkillsPanel op={op} onToast={onToast} refreshToken={0} />;
}

const NOTE =
  "仅更新通过 omp skill 从 registry 安装的技能；~/.agents/skills 下的技能由其他工具管理，不受影响。";

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("SkillsPanel（有状态 mock）", () => {
  it("渲染行、来源徽章、描述 tooltip 与说明文案", async () => {
    await installMockBackend();
    render(<Host onToast={vi.fn()} />);
    await screen.findByText("registry-example");

    const desc = screen.getByText("由 registry 管理的示例技能");
    expect(desc.closest("td")).toHaveAttribute("title", "由 registry 管理的示例技能");
    expect(screen.getByText("registry")).toBeInTheDocument();
    expect(screen.getByText("agents-example")).toBeInTheDocument();
    expect(screen.getByText("agents:user")).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("更新后流式完成并重载，按钮先禁用后恢复", async () => {
    window.history.replaceState({}, "", "/?latency=100");
    await installMockBackend();
    const onToast = vi.fn();
    render(<Host onToast={onToast} />);
    await screen.findByText("registry-example");

    const button = screen.getByRole("button", { name: "更新 registry skills" });
    fireEvent.click(button);
    expect(button).toBeDisabled();

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("registry skills 已更新", "info"),
    );
    expect(
      await screen.findByText("由 registry 管理的示例技能（已更新）"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新 registry skills" })).toBeEnabled();
  });

  it("更新失败后 toast 报错且按钮恢复可用", async () => {
    window.history.replaceState({}, "", "/?fail=omp_skills_update");
    await installMockBackend();
    const onToast = vi.fn();
    render(<Host onToast={onToast} />);
    await screen.findByText("registry-example");

    fireEvent.click(screen.getByRole("button", { name: "更新 registry skills" }));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("mock 强制失败：omp_skills_update", "error"),
    );
    expect(screen.getByRole("button", { name: "更新 registry skills" })).toBeEnabled();
  });
});

describe("SkillsPanel（定制 mock）", () => {
  it("隐藏技能展示隐藏徽章", async () => {
    mockIPC((cmd) => {
      if (cmd === "omp_skills_list")
        return {
          skills: [
            {
              name: "hidden-one",
              description: "隐藏的技能",
              filePath: "/mock/hidden/SKILL.md",
              baseDir: "/mock/hidden",
              source: "registry",
              hide: true,
            },
          ],
          warnings: [],
        };
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    render(<Host onToast={vi.fn()} />);
    await screen.findByText("hidden-one");
    expect(screen.getByText("隐藏")).toBeInTheDocument();
  });

  it("OMP_NOT_FOUND 显示空状态而非 toast", async () => {
    mockIPC((cmd) => {
      if (cmd === "omp_skills_list")
        throw { code: "OMP_NOT_FOUND", message: "找不到 omp" };
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    const onToast = vi.fn();
    render(<Host onToast={onToast} />);
    expect(
      await screen.findByText("未找到 omp，请先安装 omp 后再管理技能。"),
    ).toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalled();
  });

  it("列表失败显示内联横幅，重试后加载", async () => {
    let calls = 0;
    mockIPC((cmd) => {
      if (cmd === "omp_skills_list") {
        calls += 1;
        if (calls === 1) throw { code: "IO", message: "读失败" };
        return { skills: [], warnings: [] };
      }
      throw { code: "UNKNOWN", message: `未知命令：${cmd}` };
    });
    render(<Host onToast={vi.fn()} />);
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("读失败")).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂无技能")).toBeInTheDocument();
  });
});
