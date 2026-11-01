/**
 * McpPanel 测试：行与状态 chips、无 secret 渲染、编辑/掩码/冲突/删除/readError/非法 JSON。
 * 有状态场景走 installMockBackend；readError 与调用计数用直连 mockIPC 桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getMcpServer, listMcp, saveMcpServer } from "../api";
import { installMockBackend } from "../dev/mockBackend";
import { McpPanel } from "./McpPanel";

const PROJECTS = [{ cwd: "/Users/demo/my/omp-resume", name: "omp-resume" }];

function renderPanel(onToast = vi.fn()) {
  render(<McpPanel projects={PROJECTS} onToast={onToast} />);
  return { onToast };
}

function rowOf(scope: string, name: string): HTMLElement {
  return screen.getByTestId(`mcp-row-${scope}-${name}`);
}

beforeEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
});

describe("行与状态", () => {
  it("用户级四种 chips：生效 / disabledServers / 强制启用，且不渲染 secret 值", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");

    expect(within(rowOf("user", "filesystem")).getByText("生效")).toBeInTheDocument();
    expect(within(rowOf("user", "filesystem")).getByText("stdio")).toBeInTheDocument();
    expect(within(rowOf("user", "filesystem")).getByText("npx")).toBeInTheDocument();
    // mcp-P1-5：首词 + 参数计数（不渲染完整 argv，避免泄露凭据；完整命令见编辑框）。
    expect(within(rowOf("user", "filesystem")).getByText("· 2 个参数")).toBeInTheDocument();
    expect(
      within(rowOf("user", "blocked")).getByText("未生效：被 disabledServers 禁用"),
    ).toBeInTheDocument();
    // forced 自身 enabled:false，但用户 enabledServers 强制启用 → 生效。
    expect(within(rowOf("user", "forced")).getByText("生效")).toBeInTheDocument();
    expect(
      within(rowOf("user", "forced")).getByRole("button", { name: "启用 forced" }),
    ).toBeInTheDocument();

    for (const secret of ["mock-env-secret", "mock-header-secret", "mock-oauth-secret", "mock-private-argument"]) {
      expect(screen.queryByText(secret)).toBeNull();
    }
    expect(document.body.textContent).not.toContain("••••");
  });

  it("选中项目级后显示项目行，用户级同名条目进只读区并标被覆盖", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");

    fireEvent.click(screen.getByRole("button", { name: "项目级" }));
    fireEvent.change(screen.getByRole("combobox", { name: "项目" }), {
      target: { value: PROJECTS[0].cwd },
    });
    await screen.findByTestId("mcp-row-project-shared");
    expect(within(rowOf("project", "shared")).getByText("生效")).toBeInTheDocument();
    expect(within(rowOf("project", "shared")).getByText("http")).toBeInTheDocument();
    // 只读区：同名用户条目提示被项目级覆盖。
    expect(within(rowOf("user", "shared")).getByText("被覆盖")).toBeInTheDocument();
  });
});

describe("编辑与保存", () => {
  it("编辑预填真实值；无改动保存成功并提示重载", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");

    fireEvent.click(within(rowOf("user", "filesystem")).getByRole("button", { name: "编辑 filesystem" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });
    const box = within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement;
    expect(box.value).toContain("mock-env-secret");

    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onToast).toHaveBeenCalledWith("MCP 配置已保存 · revision 已校验", "info");
    expect(screen.getByText(/已运行的 omp 会话需执行 \/mcp reload/)).toBeInTheDocument();
  });

  it("掩码粘贴被后端拒绝，对话框内展示原文案且 revision 不变", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");
    const before = (await listMcp({})).files[0].revision;

    fireEvent.click(within(rowOf("user", "filesystem")).getByRole("button", { name: "编辑 filesystem" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });
    const box = within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: box.value.replace("mock-env-secret", "••••") } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await within(dialog).findByText(/env\.DEMO_TOKEN.*掩码占位符/);
    expect(screen.getByRole("dialog", { name: "编辑 MCP 服务器" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect((await listMcp({})).files[0].revision).toBe(before);
    expect(await getMcpServer({ scope: "user", name: "filesystem" })).toMatchObject({
      config: { env: { DEMO_TOKEN: "mock-env-secret" } },
    });
  });

  it("外部并发修改导致 CONFLICT：横幅提示，对话框与输入保留", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");
    const stale = (await listMcp({})).files[0].revision;

    fireEvent.click(within(rowOf("user", "filesystem")).getByRole("button", { name: "编辑 filesystem" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });
    // 对话框打开后，外部先改一次文件，使对话框的 revision 过期。
    await saveMcpServer({
      scope: "user",
      name: "filesystem",
      config: { command: "external-writer" },
      expectedRevision: stale,
    });
    const box = within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: box.value.replace("npx", "typed-command") } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await within(dialog).findByText(/已被外部修改/);
    const banner = within(dialog).getByText(/已被外部修改/).textContent ?? "";
    expect(banner).toContain("列表已刷新，但编辑框仍是你的版本");
    expect(banner).toContain("再次点击保存将以你的内容覆盖该条目");
    expect(screen.getByRole("dialog", { name: "编辑 MCP 服务器" })).toBeInTheDocument();
    expect((within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement).value).toContain(
      "typed-command",
    );
  });

  it("CONFLICT 后重试保存成功：输入生效且外部新增的无关条目保留", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");
    const stale = (await listMcp({})).files[0].revision;

    fireEvent.click(within(rowOf("user", "filesystem")).getByRole("button", { name: "编辑 filesystem" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });
    const box = within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: box.value.replace("npx", "typed-command") } });
    // 外部先新增一条无关服务器，使对话框的 revision 过期。
    await saveMcpServer({
      scope: "user",
      name: "external-peer",
      config: { command: "peer" },
      expectedRevision: stale,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await within(dialog).findByText(/已被外部修改/);
    expect((within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement).value).toContain(
      "typed-command",
    );
    // 冲突刷新后外部条目已出现在列表中。
    expect(await screen.findByTestId("mcp-row-user-external-peer")).toBeInTheDocument();

    // 核对后的第二次保存是显式确认：成功且不丢外部条目。
    const retry = screen.getByRole("dialog", { name: "编辑 MCP 服务器" });
    fireEvent.click(within(retry).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onToast).toHaveBeenCalledWith("MCP 配置已保存 · revision 已校验", "info");
    expect(await getMcpServer({ scope: "user", name: "filesystem" })).toMatchObject({
      config: { command: "typed-command" },
    });
    expect(
      (await listMcp({})).servers.some((s) => s.scope === "user" && s.name === "external-peer"),
    ).toBe(true);
  });

  it("新增模式 CONFLICT 后重试：absent 刷新为新 revision 后保存成功", async () => {
    await installMockBackend();
    render(<McpPanel projects={[{ cwd: "/tmp/fresh-proj", name: "fresh-proj" }]} onToast={vi.fn()} />);
    await screen.findByTestId("mcp-row-user-filesystem");
    // 切到尚无配置文件的新项目。
    fireEvent.click(screen.getByRole("button", { name: "项目级" }));
    fireEvent.change(screen.getByRole("combobox", { name: "项目" }), {
      target: { value: "/tmp/fresh-proj" },
    });
    await screen.findByText("该范围还没有 MCP 配置文件，新增第一条服务器即可创建。");

    // 新增经页头「添加服务器」按钮。
    fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 MCP 服务器" });
    fireEvent.change(within(dialog).getByLabelText("服务器名称"), {
      target: { value: "mine" },
    });
    const box = within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: JSON.stringify({ command: "typed-add" }) } });
    // 外部先创建了该文件（revision 由 absent 变为 sha）。
    await saveMcpServer({
      scope: "project",
      project: "/tmp/fresh-proj",
      name: "external-first",
      config: { command: "peer" },
      expectedRevision: "absent",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));

    await within(dialog).findByText(/已被外部修改/);
    const retry = screen.getByRole("dialog", { name: "添加 MCP 服务器" });
    fireEvent.click(within(retry).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const names = (await listMcp({ project: "/tmp/fresh-proj" })).servers
      .filter((s) => s.scope === "project")
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["external-first", "mine"]);
    expect(
      await getMcpServer({ scope: "project", project: "/tmp/fresh-proj", name: "mine" }),
    ).toMatchObject({ config: { command: "typed-add" } });
  });

  it("非法 JSON 不调用后端", async () => {
    let saves = 0;
    mockIPC((cmd) => {
      if (cmd === "mcp_list") {
        return {
          files: [
            {
              scope: "user",
              path: "/Users/demo/.omp/agent/mcp.json",
              exists: true,
              readError: null,
              revision: "r1",
              disabledServers: [],
              enabledServers: [],
            },
          ],
          servers: [
            {
              scope: "user",
              name: "solo",
              transport: "stdio",
              command: "node",
              argCount: 0,
              url: null,
              enabled: true,
              effective: true,
              shadowedBy: null,
              envKeys: [],
              headerKeys: [],
              hasAuth: false,
            },
          ],
        };
      }
      if (cmd === "mcp_get_server") return { config: { command: "node" }, revision: "r1" };
      if (cmd === "mcp_save_server") {
        saves += 1;
        return { revision: "r2" };
      }
      throw `no handler for ${cmd}`;
    });
    renderPanel();
    await screen.findByTestId("mcp-row-user-solo");

    fireEvent.click(screen.getByRole("button", { name: "编辑 solo" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });
    fireEvent.change(within(dialog).getByLabelText("服务器配置 JSON"), { target: { value: "{oops" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await within(dialog).findByText(/JSON 格式不正确/);
    expect(saves).toBe(0);
  });

  it("传输选「自动推断」保存：type 字段被删除，保存成功", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");

    fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 MCP 服务器" });
    fireEvent.change(within(dialog).getByLabelText("服务器名称"), { target: { value: "auto-type" } });
    const box = within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: JSON.stringify({ command: "node", args: ["m.js"] }) } });
    // 模板默认 stdio；切一次非空再切回自动推断，断言 type 键消失。
    fireEvent.change(within(dialog).getByLabelText("传输"), { target: { value: "stdio" } });
    expect(JSON.parse(box.value)).toHaveProperty("type", "stdio");
    fireEvent.change(within(dialog).getByLabelText("传输"), { target: { value: "" } });
    const parsed = JSON.parse(box.value) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("type");

    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onToast).toHaveBeenCalledWith("已添加 MCP 服务器 · auto-type", "info");
    const saved = await getMcpServer({ scope: "user", name: "auto-type" });
    expect(saved.config).not.toHaveProperty("type");
    expect(saved.config).toMatchObject({ command: "node" });
  });
});

describe("开关与删除", () => {
  it("禁用/启用切换状态 chip", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");

    fireEvent.click(within(rowOf("user", "filesystem")).getByRole("button", { name: "禁用 filesystem" }));
    await waitFor(() =>
      expect(within(rowOf("user", "filesystem")).getByText("未生效：已禁用")).toBeInTheDocument(),
    );
    fireEvent.click(within(rowOf("user", "filesystem")).getByRole("button", { name: "启用 filesystem" }));
    await waitFor(() =>
      expect(within(rowOf("user", "filesystem")).getByText("生效")).toBeInTheDocument(),
    );
  });

  it("删除需要确认；取消保留，确认移除", async () => {
    await installMockBackend();
    const { onToast } = renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");

    fireEvent.click(within(rowOf("user", "filesystem")).getByRole("button", { name: "删除 filesystem" }));
    const dialog = await screen.findByRole("dialog", { name: "删除 MCP 服务器" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("mcp-row-user-filesystem")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除 filesystem" }));
    const confirm = await screen.findByRole("dialog", { name: "删除 MCP 服务器" });
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByTestId("mcp-row-user-filesystem")).toBeNull());
    expect(onToast).toHaveBeenCalledWith("已删除 filesystem", "info");
  });
});

describe("只读与失败", () => {
  it("readError 横幅展示并禁用该范围变更", async () => {
    mockIPC((cmd) => {
      if (cmd === "mcp_list") {
        return {
          files: [
            {
              scope: "user",
              path: "/Users/demo/.omp/agent/mcp.json",
              exists: true,
              readError: "配置文件不是合法 JSON，请先手动修复",
              revision: "deadbeef",
              disabledServers: [],
              enabledServers: [],
            },
          ],
          servers: [],
        };
      }
      throw `no handler for ${cmd}`;
    });
    renderPanel();
    await screen.findByText(/请先手动修复该 JSON 文件/);
    expect(screen.getByText(/配置文件不是合法 JSON/)).toBeInTheDocument();
    // 新增经页头「添加服务器」按钮：targetBlocked 时 add 不开对话框。
    fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("加载失败展示横幅并可重试", async () => {
    let calls = 0;
    mockIPC((cmd) => {
      if (cmd !== "mcp_list") throw `no handler for ${cmd}`;
      calls += 1;
      if (calls === 1) throw { code: "IO", message: "读失败" };
      return {
        files: [
          {
            scope: "user",
            path: "/Users/demo/.omp/agent/mcp.json",
            exists: false,
            readError: null,
            revision: "absent",
            disabledServers: [],
            enabledServers: [],
          },
        ],
        servers: [],
      };
    });
    renderPanel();
    await screen.findByText("读失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(/还没有 MCP 配置文件/);
  });
});

describe("输入防篡改（WKWebView）", () => {
  it("服务器名称输入关闭自动大写/纠错/拼写检查", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");
    fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 MCP 服务器" });
    const input = within(dialog).getByLabelText("服务器名称") as HTMLInputElement;
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    const box = within(dialog).getByLabelText("服务器配置 JSON") as HTMLTextAreaElement;
    expect(box.getAttribute("autocapitalize")).toBe("off");
    expect(box.getAttribute("autocorrect")).toBe("off");
    expect(box.getAttribute("spellcheck")).toBe("false");
  });
});

describe("disabledServers 行", () => {
  const HINT = "该名称在 disabledServers 中被禁用；本应用不修改 disabledServers，请手动编辑 mcp.json 后刷新";

  it("开关按钮禁用并展示提示，编辑/删除保持可用", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-blocked");
    const row = rowOf("user", "blocked");
    expect(within(row).getByText("未生效：被 disabledServers 禁用")).toBeInTheDocument();
    const toggle = within(row).getByRole("button", { name: /^(启用|禁用) blocked$/ });
    expect(toggle).toBeDisabled();
    expect(toggle.getAttribute("title")).toBe(HINT);
    expect(within(row).getByRole("button", { name: "编辑 blocked" })).toBeEnabled();
    expect(within(row).getByRole("button", { name: "删除 blocked" })).toBeEnabled();
  });

  it("普通行的开关仍可用", async () => {
    await installMockBackend();
    renderPanel();
    await screen.findByTestId("mcp-row-user-filesystem");
    const row = rowOf("user", "filesystem");
    expect(within(row).getByRole("button", { name: "禁用 filesystem" })).toBeEnabled();
    fireEvent.click(within(row).getByRole("button", { name: "禁用 filesystem" }));
    await waitFor(() =>
      expect(within(rowOf("user", "filesystem")).getByText("未生效：已禁用")).toBeInTheDocument(),
    );
  });
});

describe("冲突后重载失败", () => {
  it("展示真实加载错误而非 UNREADABLE 文案", async () => {
    let lists = 0;
    mockIPC((cmd) => {
      if (cmd === "mcp_list") {
        lists += 1;
        if (lists > 1) throw { code: "IO", message: "项目目录不存在" };
        return {
          files: [
            {
              scope: "user",
              path: "/Users/demo/.omp/agent/mcp.json",
              exists: true,
              readError: null,
              revision: "r1",
              disabledServers: [],
              enabledServers: [],
            },
          ],
          servers: [
            {
              scope: "user",
              name: "solo",
              transport: "stdio",
              command: "node",
              argCount: 0,
              url: null,
              enabled: true,
              effective: true,
              shadowedBy: null,
              envKeys: [],
              headerKeys: [],
              hasAuth: false,
            },
          ],
        };
      }
      if (cmd === "mcp_get_server") return { config: { command: "node" }, revision: "r1" };
      if (cmd === "mcp_save_server") throw { code: "CONFLICT", message: "文件已被外部修改" };
      throw `no handler for ${cmd}`;
    });
    renderPanel();
    await screen.findByTestId("mcp-row-user-solo");
    fireEvent.click(screen.getByRole("button", { name: "编辑 solo" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await within(dialog).findByText(/已被外部修改/);
    expect(within(dialog).getByText("项目目录不存在")).toBeInTheDocument();
    expect(within(dialog).queryByText(/配置文件无法读取/)).toBeNull();
  });
});

describe("双击竞态", () => {
  function soloList(revision: string) {
    return {
      files: [
        {
          scope: "user",
          path: "/Users/demo/.omp/agent/mcp.json",
          exists: true,
          readError: null,
          revision,
          disabledServers: [],
          enabledServers: [],
        },
      ],
      servers: [
        {
          scope: "user",
          name: "solo",
          transport: "stdio",
          command: "node",
          argCount: 0,
          url: null,
          enabled: true,
          effective: true,
          shadowedBy: null,
          envKeys: [],
          headerKeys: [],
          hasAuth: false,
        },
      ],
    };
  }

  it("双击保存只发一次请求且不出现幽灵冲突横幅", async () => {
    let saves = 0;
    mockIPC((cmd) => {
      if (cmd === "mcp_list") return soloList("r1");
      if (cmd === "mcp_get_server") return { config: { command: "node" }, revision: "r1" };
      if (cmd === "mcp_save_server") {
        saves += 1;
        if (saves > 1) throw { code: "CONFLICT", message: "文件已被外部修改" };
        return { revision: "r2" };
      }
      throw `no handler for ${cmd}`;
    });
    const { onToast } = renderPanel();
    await screen.findByTestId("mcp-row-user-solo");
    fireEvent.click(screen.getByRole("button", { name: "编辑 solo" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });
    const save = within(dialog).getByRole("button", { name: "保存" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saves).toBe(1);
    expect(onToast).toHaveBeenCalledWith("MCP 配置已保存 · revision 已校验", "info");
    expect(screen.queryByText(/已被外部修改/)).toBeNull();
  });

  it("双击禁用只发一次请求", async () => {
    let toggles = 0;
    mockIPC((cmd) => {
      if (cmd === "mcp_list") return soloList("r1");
      if (cmd === "mcp_set_enabled") {
        toggles += 1;
        return { revision: "r2" };
      }
      throw `no handler for ${cmd}`;
    });
    renderPanel();
    await screen.findByTestId("mcp-row-user-solo");
    const toggle = screen.getByRole("button", { name: "禁用 solo" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggles).toBe(1));
    // 等待重载完成，避免跨测试泄漏。
    await waitFor(() => expect(screen.getByRole("button", { name: "禁用 solo" })).toBeEnabled());
  });
});

describe("握手测试", () => {
  it("首屏渲染与列表刷新不触发握手（只在点击时执行）", async () => {
    let handshakes = 0;
    mockIPC((cmd) => {
      if (cmd === "mcp_handshake") {
        handshakes += 1;
        return { ok: true, tools: 3, ms: 10, error: null };
      }
      if (cmd === "mcp_list") {
        return {
          files: [{ scope: "user", path: "/Users/demo/.omp/agent/mcp.json", exists: true, readError: null, revision: "r1", modifiedAt: null, disabledServers: [], enabledServers: [] }],
          servers: [{ scope: "user", name: "solo", transport: "stdio", command: "node", argCount: 0, url: null, enabled: true, effective: true, shadowedBy: null, envKeys: [], headerKeys: [], hasAuth: false }],
        };
      }
      throw `no handler for ${cmd}`;
    });
    renderPanel();
    await screen.findByTestId("mcp-row-user-solo");
    expect(handshakes).toBe(0);
    expect(screen.getByText("rev r1")).toBeInTheDocument();
  });

  it("点击测试后 toast 工具数，工具列更新", async () => {
    mockIPC((cmd) => {
      if (cmd === "mcp_handshake") return { ok: true, tools: 7, ms: 120, error: null };
      if (cmd === "mcp_list") {
        return {
          files: [{ scope: "user", path: "/Users/demo/.omp/agent/mcp.json", exists: true, readError: null, revision: "r1", modifiedAt: null, disabledServers: [], enabledServers: [] }],
          servers: [{ scope: "user", name: "solo", transport: "stdio", command: "node", argCount: 0, url: null, enabled: true, effective: true, shadowedBy: null, envKeys: [], headerKeys: [], hasAuth: false }],
        };
      }
      throw `no handler for ${cmd}`;
    });
    const onToast = vi.fn();
    render(<McpPanel projects={PROJECTS} onToast={onToast} />);
    await screen.findByTestId("mcp-row-user-solo");
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("solo 握手成功 · 7 个工具", "info"));
    expect(within(screen.getByTestId("mcp-row-user-solo")).getByText("7")).toBeInTheDocument();
  });

  it("握手失败 toast 错误，工具列保持 —", async () => {
    mockIPC((cmd) => {
      if (cmd === "mcp_handshake") return { ok: false, tools: null, ms: 50, error: "无法连接到服务器" };
      if (cmd === "mcp_list") {
        return {
          files: [{ scope: "user", path: "/Users/demo/.omp/agent/mcp.json", exists: true, readError: null, revision: "r1", modifiedAt: null, disabledServers: [], enabledServers: [] }],
          servers: [{ scope: "user", name: "solo", transport: "stdio", command: "node", argCount: 0, url: null, enabled: true, effective: true, shadowedBy: null, envKeys: [], headerKeys: [], hasAuth: false }],
        };
      }
      throw `no handler for ${cmd}`;
    });
    const onToast = vi.fn();
    render(<McpPanel projects={PROJECTS} onToast={onToast} />);
    await screen.findByTestId("mcp-row-user-solo");
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("solo 握手失败：无法连接到服务器", "error"));
  });
});
