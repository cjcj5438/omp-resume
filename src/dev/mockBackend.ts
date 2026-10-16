/**
 * DEV-ONLY mock 后端：通过 `mockIPC` 实现全部命令，有状态。
 * 仅在 DEV + `?mock` 时由 main.tsx 动态 import，生产包不包含。
 *
 * 已知与真后端的分歧：
 * - user scope 的 `project` 参数在 mock 中不校验（真后端按 CONTRACT §4.30 返回 INVALID_INPUT）。
 * - mock 的 revision 是规范 JSON 的 SHA（真后端是原始文件 bytes 的 SHA），且永不为 "unreadable"。
 * - `list_cleanup_candidates` 的 `bytes` 直接用夹具的 `sizeBytes`（真后端会额外递归统计
 *   sibling 附件目录与 `.bak`）；夹具里把几个会话的 `sizeBytes` 调大以覆盖 `large` 原因。
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { Channel } from "@tauri-apps/api/core";
import type { AppError, CleanupCandidate, CleanupReason, MarketplaceSummary, OmpOpResult, PluginSummary, PluginUpgradeChange, SkillSummary } from "../types";
import type { McpFileInfo, McpListResult, McpScope, McpServer, McpTransport } from "../types";
import type { PromptHistoryEntry } from "../types";
import {
  FIXTURE_SESSIONS,
  buildListResult,
  conversationForPath,
  generateLargeConversation,
  type FixtureSession,
} from "./fixtures";
import { mockSessionUsage, mockUsageStats } from "./usageMock";

interface FailAs {
  code: string;
  message: string;
}

function err(code: string, message: string): FailAs {
  return { code, message };
}

/** mockIPC 保留 Channel 对象，直接投递与生产一致的逐行文本。空输出投递零行。 */
export function streamedOutput(args: Record<string, unknown>, output: string): OmpOpResult {
  const channel = args["onLine"];
  if (channel instanceof Channel) {
    const trimmed = output.trimEnd();
    if (trimmed !== "") {
      for (const line of trimmed.split("\n")) channel.onmessage(line);
    }
  }
  return { output };
}

function randomHex8(existing: Set<string>): string {
  let id = "";
  do {
    id = Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  } while (existing.has(id));
  return id;
}

type McpObject = Record<string, unknown>;
interface McpMockFile {
  scope: McpScope;
  path: string;
  document: McpObject | null;
  revision: string;
}

function mcpObject(value: unknown): value is McpObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mcpName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length > 100 || !/^[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*$/.test(name)) {
    throw err("INVALID_INPUT", "服务器名称须为 1–100 个字母、数字或 _ - . :，名称段之间仅允许单个空格");
  }
}

function mcpTransport(config: McpObject): McpTransport {
  if (config["type"] !== undefined) {
    const type = config["type"];
    return type === "stdio" || type === "http" || type === "sse" ? type : "unknown";
  }
  if (Object.hasOwn(config, "command")) return "stdio";
  return Object.hasOwn(config, "url") ? "http" : "unknown";
}

function mcpConfig(config: unknown): asserts config is McpObject {
  if (!mcpObject(config)) throw err("INVALID_INPUT", "服务器配置必须是 JSON 对象");
  if (Object.hasOwn(config, "command") && Object.hasOwn(config, "url")) throw err("INVALID_INPUT", "command 与 url 不能同时设置");
  const type = mcpTransport(config);
  if (Object.hasOwn(config, "type") && type === "unknown") throw err("INVALID_INPUT", "type 仅支持 stdio、http 或 sse");
  const key = type === "http" || type === "sse" ? "url" : "command";
  const required = config[key];
  if (typeof required !== "string" || !required.trim()) throw err("INVALID_INPUT", `${key} 必须是非空字符串`);
  if (Object.hasOwn(config, "args") && (!Array.isArray(config["args"]) || !config["args"].every((arg: unknown) => typeof arg === "string"))) throw err("INVALID_INPUT", "args 必须是字符串数组");
  for (const field of ["env", "headers"]) {
    if (!Object.hasOwn(config, field)) continue;
    const values = config[field];
    if (!mcpObject(values)) throw err("INVALID_INPUT", `${field} 必须是字符串值对象`);
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== "string") throw err("INVALID_INPUT", `${field}.${name} 必须是字符串`);
      if (/^•+$/.test(value)) throw err("INVALID_INPUT", `${field}.${name} 不能是掩码占位符，请填写真实值`);
    }
  }
  if (Object.hasOwn(config, "enabled") && typeof config["enabled"] !== "boolean") throw err("INVALID_INPUT", "enabled 必须是布尔值");
  if (Object.hasOwn(config, "timeout") && (typeof config["timeout"] !== "number" || !Number.isFinite(config["timeout"]) || config["timeout"] < 0)) throw err("INVALID_INPUT", "timeout 必须是非负数");
}

function createMcpMock() {
  const home = "/Users/chenjing";
  const schema = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
  const userDocument: McpObject = {
    $schema: schema,
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "mock-private-argument"], env: { DEMO_TOKEN: "mock-env-secret" } },
      shared: { command: "node", args: ["mock-shared.js"] },
      blocked: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "mock-header-secret" }, oauth: { clientSecret: "mock-oauth-secret" } },
      forced: { type: "sse", url: "https://example.test/sse", enabled: false },
    },
    disabledServers: ["blocked"],
    enabledServers: ["blocked", "forced"],
    customField: { preserve: true },
  };
  const projects = new Map<string, Promise<McpMockFile>>();
  let user: Promise<McpMockFile> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const serverMap = (document: McpObject | null): McpObject => mcpObject(document?.["mcpServers"]) ? document["mcpServers"] : {};

  async function hash(document: McpObject | null): Promise<string> {
    if (document === null) return "absent";
    const bytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function projectPath(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value !== "string" || !value.startsWith("/")) throw err("INVALID_INPUT", "项目路径必须是绝对路径");
    // 浏览器 mock 无文件系统；仅模拟 cwd 规范化与 HOME 排除，真实存在性由 Rust 校验。
    const parts: string[] = [];
    for (const part of value.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    const path = `/${parts.join("/")}`;
    if (path === home) throw err("INVALID_INPUT", "HOME 目录不能作为 MCP 项目目录");
    return path;
  }

  function userFile(): Promise<McpMockFile> {
    if (!user) {
      const document = structuredClone(userDocument);
      user = hash(document).then((revision) => ({ scope: "user", path: `${home}/.omp/agent/mcp.json`, document, revision }));
    }
    return user;
  }

  function projectFile(project: string): Promise<McpMockFile> {
    let file = projects.get(project);
    if (!file) {
      const document = project === "/Users/chenjing/my/omp-resume"
        ? { $schema: schema, mcpServers: { shared: { type: "http", url: "https://example.test/project-mcp" } } }
        : null;
      file = hash(document).then((revision) => ({ scope: "project", path: `${project}/.omp/mcp.json`, document, revision }));
      projects.set(project, file);
    }
    return file;
  }

  async function selected(args: McpObject): Promise<McpMockFile> {
    const project = projectPath(args["project"]);
    if (args["scope"] === "user") return userFile();
    if (args["scope"] !== "project" || project === null) throw err("INVALID_INPUT", "项目级 MCP 配置需要项目路径");
    return projectFile(project);
  }

  async function list(projectValue: unknown): Promise<McpListResult> {
    const project = projectPath(projectValue);
    const files = [await userFile()];
    if (project !== null) files.push(await projectFile(project));
    const disabledValue = files[0].document?.["disabledServers"];
    const allowedValue = files[0].document?.["enabledServers"];
    const disabled = Array.isArray(disabledValue) ? disabledValue.filter((value): value is string => typeof value === "string") : [];
    const allowed = Array.isArray(allowedValue) ? allowedValue.filter((value): value is string => typeof value === "string") : [];
    const projectServers = serverMap(files[1]?.document ?? null);
    const servers: McpServer[] = [];
    for (const file of files) {
      for (const [name, raw] of Object.entries(serverMap(file.document))) {
        const config = mcpObject(raw) ? raw : {};
        const enabled = config["enabled"] !== false;
        let shadowedBy: McpServer["shadowedBy"] = null;
        if (disabled.includes(name)) shadowedBy = "disabledServers";
        else if (file.scope === "user" && Object.hasOwn(projectServers, name)) shadowedBy = "project";
        else if (!enabled && !allowed.includes(name)) shadowedBy = "disabled";
        servers.push({
          scope: file.scope, name, transport: mcpTransport(config),
          command: typeof config["command"] === "string" ? config["command"] : null,
          argCount: Array.isArray(config["args"]) ? config["args"].length : 0,
          url: typeof config["url"] === "string" ? config["url"] : null,
          enabled, effective: shadowedBy === null, shadowedBy,
          envKeys: mcpObject(config["env"]) ? Object.keys(config["env"]) : [],
          headerKeys: mcpObject(config["headers"]) ? Object.keys(config["headers"]) : [],
          hasAuth: config["auth"] != null || config["oauth"] != null,
        });
      }
    }
    return {
      files: files.map((file): McpFileInfo => ({
        scope: file.scope, path: file.path, exists: file.document !== null, readError: null, revision: file.revision,
        disabledServers: file.scope === "user" ? [...disabled] : [],
        enabledServers: file.scope === "user" ? [...allowed] : [],
      })),
      servers,
    };
  }

  return async (cmd: string, args: McpObject): Promise<unknown> => {
    if (cmd === "mcp_list") return list(args["project"]);
    if (cmd === "mcp_get_server") {
      mcpName(args["name"]);
      const file = await selected(args);
      const servers = serverMap(file.document);
      if (!Object.hasOwn(servers, args["name"])) throw err("NOT_FOUND", "MCP 服务器不存在");
      return { config: structuredClone(servers[args["name"]]), revision: file.revision };
    }
    const operation = pending.then(async () => {
      if (args["expectedRevision"] === "unreadable") throw err("IO", "配置文件无法读取，请先修复读取权限并刷新");
      mcpName(args["name"]);
      if (cmd === "mcp_save_server") mcpConfig(args["config"]);
      const file = await selected(args);
      if (file.revision === "unreadable") throw err("IO", "配置文件无法读取");
      if (file.revision !== args["expectedRevision"]) throw err("CONFLICT", "文件已被外部修改，请刷新后重试");
      const document = structuredClone(file.document ?? { $schema: schema, mcpServers: {} });
      if (!Object.hasOwn(document, "mcpServers")) document["mcpServers"] = {};
      const servers = serverMap(document);
      const name = args["name"];
      if (cmd === "mcp_save_server") {
        const original = args["originalName"];
        if (original != null) {
          mcpName(original);
          if (!Object.hasOwn(servers, original)) throw err("NOT_FOUND", "MCP 服务器不存在");
          if (original !== name) {
            if (Object.hasOwn(servers, name)) throw err("INVALID_INPUT", "服务器名称已存在，不能覆盖其他服务器");
            delete servers[original];
          }
        }
        Object.defineProperty(servers, name, { value: structuredClone(args["config"]), enumerable: true, writable: true, configurable: true });
      } else {
        if (!Object.hasOwn(servers, name)) throw err("NOT_FOUND", "MCP 服务器不存在");
        if (cmd === "mcp_delete_server") delete servers[name];
        else {
          const config = servers[name];
          if (!mcpObject(config)) throw err("INVALID_INPUT", "服务器配置必须是 JSON 对象");
          if (typeof args["enabled"] !== "boolean") throw err("INVALID_INPUT", "enabled 必须是布尔值");
          if (args["enabled"]) delete config["enabled"];
          else config["enabled"] = false;
          mcpConfig(config);
        }
      }
      const revision = await hash(document);
      file.document = document;
      file.revision = revision;
      return { revision };
    });
    pending = operation.catch(() => undefined);
    return operation;
  };
}

export interface MockHandle {
  itermCalls: string[];
}

export async function installMockBackend(): Promise<MockHandle> {
  const params = new URLSearchParams(window.location.search);
  const latency = Number(params.get("latency") ?? "0") || 0;
  const fail = new Set(
    (params.get("fail") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // 深拷贝夹具，保持跨测试/刷新有状态。
  let sessions: FixtureSession[] = structuredClone(FIXTURE_SESSIONS);
  const itermCalls: string[] = [];
  const newSessionCalls: string[] = [];
  const mcp = createMcpMock();
  const metadata = { installedAt: "2026-10-16T00:00:00.000Z", lastUpdated: "2026-10-16T00:00:00.000Z", installPath: null };
  let plugins: PluginSummary[] = [
    { ...metadata, id: "hello-plugin@probe-mkt", name: "hello-plugin", marketplace: "probe-mkt", version: "1.0.0", enabled: true },
    { ...metadata, id: "formatter@community", name: "formatter", marketplace: "community", version: "1.0.0", enabled: false },
  ];
  let marketplaces: MarketplaceSummary[] = [
    { name: "probe-mkt", source: "/tmp/omp-mkt" },
    { name: "community", source: "https://example.com/community.git" },
  ];
  const availableVersions = new Map(marketplaces.map((marketplace) => [marketplace.name, "1.1.0"]));
  const skills: SkillSummary[] = [
    { name: "registry-example", description: "由 registry 管理的示例技能", filePath: "/mock/.omp/skills/registry-example/SKILL.md", baseDir: "/mock/.omp/skills/registry-example", source: "registry", hide: false },
    { name: "agents-example", description: "由其他工具管理，不参与 omp skill update", filePath: "/mock/.agents/skills/agents-example/SKILL.md", baseDir: "/mock/.agents/skills/agents-example", source: "agents:user", hide: false },
  ];

  const find = (path: string): FixtureSession | undefined =>
    sessions.find((s) => s.summary.path === path);

  (window as unknown as { __ompMock?: unknown }).__ompMock = {
    calls: itermCalls,
    newSessionCalls,
    get sessions() {
      return sessions;
    },
  };

  mockIPC(async (cmd: string, rawArgs?: unknown) => {
    if (latency > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, latency);
      await promise;
    }
    if (fail.has(cmd)) throw err("IO", `mock 强制失败：${cmd}`);
    const args =
      rawArgs !== null && typeof rawArgs === "object"
        ? (rawArgs as Record<string, unknown>)
        : {};

    switch (cmd) {
      case "mcp_list":
      case "mcp_get_server":
      case "mcp_save_server":
      case "mcp_set_enabled":
      case "mcp_delete_server":
        return mcp(cmd, args);
      case "get_config":
        return {
          sessionsDir: "/Users/chenjing/.omp/agent/sessions",
          ownersDir: "/Users/chenjing/.omp/run/session-owners",
        };
      case "list_cleanup_candidates": {
        const olderThanDays = Number(args["olderThanDays"]);
        const topN = Number(args["topN"]);
        if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
          throw err("INVALID_INPUT", "超过天数须为 ≥1 的整数");
        }
        const LARGE_MIN = 5 * 1024 * 1024;
        // large 与真后端同义：跨全部会话按总字节排名前 topN 且 ≥5 MiB。
        const largePaths = new Set(
          [...sessions]
            .sort((a, b) => b.summary.sizeBytes - a.summary.sizeBytes)
            .slice(0, Number.isFinite(topN) ? Math.max(0, Math.floor(topN)) : 0)
            .filter((s) => s.summary.sizeBytes >= LARGE_MIN)
            .map((s) => s.summary.path),
        );
        const staleCut = Date.now() - olderThanDays * 86400000;
        return sessions
          .map((s): CleanupCandidate => {
            const summary = s.summary;
            const reasons: CleanupReason[] = [];
            if (summary.formatSupported && summary.messageCount === 0) reasons.push("empty");
            if (!summary.cwdExists) reasons.push("cwd_missing");
            if (largePaths.has(summary.path)) reasons.push("large");
            if (Date.parse(summary.modifiedAt) < staleCut) reasons.push("stale");
            return {
              path: summary.path,
              id: summary.id,
              title: summary.title,
              cwd: summary.cwd,
              mtime: summary.modifiedAt,
              bytes: summary.sizeBytes,
              reasons,
              inUse: summary.inUse,
              probeOk: summary.probeOk,
            };
          })
          .filter((c) => c.reasons.length > 0)
          .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
      }
      case "list_sessions":
        return buildListResult(sessions);
      case "get_session_usage": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (!s.summary.formatSupported) throw err("UNSUPPORTED_FORMAT", "该会话格式暂不支持用量统计");
        return structuredClone(mockSessionUsage);
      }
      case "get_usage_stats":
        return mockUsageStats((args["sinceDays"] as number | null) ?? null);
      case "check_session": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        return { inUse: s.summary.inUse, probeOk: s.summary.probeOk };
      }
      case "get_conversation": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (!s.summary.formatSupported)
          throw err("UNSUPPORTED_FORMAT", "该会话格式暂不支持预览");
        if (params.has("big")) return generateLargeConversation(3000);
        try {
          return conversationForPath(
            s,
            (args["nodeId"] as string | null) ?? null,
          );
        } catch (e) {
          throw e as AppError;
        }
      }
      case "get_tree": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (!s.summary.formatSupported)
          throw err("UNSUPPORTED_FORMAT", "该会话格式暂不支持预览");
        return s.tree;
      }
      case "delete_sessions": {
        const paths = (args["paths"] as string[]) ?? [];
        return paths.map((p) => {
          const s = find(p);
          if (!s) return { path: p, ok: false, error: err("NOT_FOUND", "会话文件不存在") };
          if (s.summary.inUse)
            return { path: p, ok: false, error: err("IN_USE", "会话正被另一个 omp 使用") };
          if (!s.summary.probeOk)
            return { path: p, ok: false, error: err("PROBE_FAILED", "占用探测失败，不敢删除") };
          sessions = sessions.filter((x) => x.summary.path !== p);
          return { path: p, ok: true, error: null };
        });
      }
      case "append_branch_marker": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (s.summary.inUse) throw err("IN_USE", "会话正被另一个 omp 使用");
        if (!s.summary.probeOk) throw err("PROBE_FAILED", "占用探测失败");
        const nodeId = args["nodeId"] as string;
        const byId = new Map(s.tree.nodes.map((n) => [n.id, n]));
        if (!byId.has(nodeId)) throw err("INVALID_NODE", "节点不存在");
        if (s.tree.leafId === nodeId) return { markerId: null };
        const markerId = randomHex8(new Set(byId.keys()));
        // marker 为 custom 行：树上不可见节点，但 leaf/active 语义变为指向该节点。
        const chain: string[] = [];
        let cur: string | null = nodeId;
        while (cur && byId.has(cur) && !chain.includes(cur)) {
          chain.unshift(cur);
          cur = byId.get(cur)?.parentId ?? null;
        }
        s.tree = {
          ...s.tree,
          leafId: nodeId,
          activePathIds: chain.slice().reverse(),
        };
        return { markerId };
      }
      case "open_in_iterm": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (s.summary.inUse) throw err("IN_USE", "会话正被另一个 omp 使用");
        if (!s.summary.cwdExists) throw err("CWD_MISSING", "项目目录不存在");
        itermCalls.push(s.summary.path);
        return null;
      }
      case "new_session_in_iterm": {
        const cwd = args["cwd"];
        if (typeof cwd !== "string" || !cwd.startsWith("/")) throw err("CWD_MISSING", "目录不存在或不是目录");
        newSessionCalls.push(cwd);
        return null;
      }
      case "choose_directory":
        return params.get("pick") === "cancel" ? null : "/Users/chenjing/my/omp-resume";
      case "get_session_recap": {
        // 仅第一个夹具会话有 recap，便于同时看到「有」与「无」两种详情。
        const sid = args["sessionId"];
        return sid === sessions[0]?.summary.id ? "本会话：修复了侧栏分组按钮的对齐，并补充了新会话入口的单测。下一步是验证 iTerm 冒烟。" : null;
      }
      case "search_prompt_history": {
        const q = (typeof args["query"] === "string" ? args["query"] : "").trim().toLowerCase();
        const first = sessions[0]?.summary;
        const entries: PromptHistoryEntry[] = [
          { id: 3, prompt: "给 Sidebar 加一个新会话按钮，点击后先选目录", cwd: first?.cwd ?? null, sessionId: first?.id ?? null, createdAt: "2026-10-16T01:00:00.000Z", useCount: 3 },
          { id: 2, prompt: "帮我看看 100% 的 CPU 占用", cwd: null, sessionId: "gone-session-id", createdAt: "2026-10-15T08:00:00.000Z", useCount: 1 },
          { id: 1, prompt: "fix README.md typo", cwd: "/Users/chenjing/my/other", sessionId: null, createdAt: "2026-10-14T03:00:00.000Z", useCount: 2 },
        ];
        return entries.filter((e) => q === "" || e.prompt.toLowerCase().includes(q));
      }
      case "omp_version":
        return { version: "18.11.1", path: "/Users/chenjing/.local/bin/omp" };
      case "omp_update_check": {
        const mode = params.get("omp");
        const current = "18.11.1";
        if (mode === "managed") return {
          current: null,
          latest: null,
          upToDate: false,
          raw: "/opt/homebrew/bin/omp is installed and kept up to date by Homebrew; update it from Homebrew.\n",
        };
        const latest = mode === "new" ? "18.12.0" : null;
        return {
          current,
          latest,
          upToDate: latest === null,
          raw: `Current version: ${current}\n${latest ? `New version available: ${latest}` : "✔ Already up to date"}\n`,
        };
      }
      case "omp_update_run": {
        const changed = params.get("omp") === "new";
        const after = changed ? "18.12.0" : "18.11.1";
        const output = changed
          ? `Downloading ...\nInstalling update...\n✔ Updated to ${after}\nRestart omp to use the new version\n`
          : "版本未变化；请通过安装 omp 的包管理器更新。\n";
        streamedOutput(args, output);
        return { before: "18.11.1", after, changed, output };
      }
      case "omp_plugins_list":
        return structuredClone({ plugins, npm: [{ name: "omp-enforce-uv", version: "0.3.0" }], marketplaces, warnings: [] });
      case "omp_plugin_discover": {
        const marketplace = args["marketplace"];
        if (typeof marketplace !== "string" || !marketplaces.some((entry) => entry.name === marketplace)) throw err("OMP_FAILED", "marketplace 不存在");
        return [
          { name: "hello-plugin", version: availableVersions.get(marketplace) ?? "1.0.0", description: "示例插件" },
          { name: "formatter", version: availableVersions.get(marketplace) ?? "1.0.0", description: "格式化工具" },
        ];
      }
      case "omp_plugin_install": {
        const id = args["id"];
        if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw err("INVALID_INPUT", "插件标识必须为 name@marketplace");
        const [name, marketplace] = id.split("@");
        if (!marketplaces.some((entry) => entry.name === marketplace)) throw err("OMP_FAILED", "marketplace 不存在");
        if (!plugins.some((entry) => entry.id === id)) plugins.push({ ...metadata, id, name, marketplace, version: availableVersions.get(marketplace) ?? "1.0.0", enabled: true });
        return streamedOutput(args, `✔ Installed ${id}\n`);
      }
      case "omp_plugin_uninstall":
      case "omp_plugin_set_enabled": {
        const plugin = plugins.find((entry) => entry.id === args["id"]);
        if (!plugin) throw err("OMP_FAILED", "插件不存在");
        if (cmd === "omp_plugin_uninstall") plugins = plugins.filter((entry) => entry.id !== plugin.id);
        else plugin.enabled = args["enabled"] === true;
        return streamedOutput(args, `✔ ${cmd === "omp_plugin_uninstall" ? "Uninstalled" : plugin.enabled ? "Enabled" : "Disabled"} ${plugin.id}\n`);
      }
      case "omp_plugin_upgrade": {
        const id = args["id"];
        const targets = id == null ? plugins : plugins.filter((entry) => entry.id === id);
        if (id != null && targets.length === 0) throw err("OMP_FAILED", "插件不存在");
        const changes: PluginUpgradeChange[] = [];
        for (const plugin of targets) {
          const to = availableVersions.get(plugin.marketplace) ?? plugin.version;
          if (to && plugin.version !== to) {
            changes.push({ id: plugin.id, scope: "user", from: plugin.version, to });
            plugin.version = to;
            plugin.lastUpdated = new Date().toISOString();
          }
        }
        const output = changes.length > 0
          ? `${changes.map((change) => `  ${change.id} (user): ${change.from ?? "unknown"} -> ${change.to}`).join("\n")}\n`
          : "All marketplace plugins are up to date.\n";
        return { ...streamedOutput(args, output), changes };
      }
      case "omp_marketplace_add": {
        const source = args["source"];
        if (typeof source !== "string" || !source) throw err("INVALID_INPUT", "marketplace 来源不能为空");
        const name = source.replace(/\/$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "marketplace";
        if (!marketplaces.some((entry) => entry.name === name)) marketplaces.push({ name, source });
        availableVersions.set(name, "1.0.0");
        return streamedOutput(args, `✔ Added marketplace: ${source}\n`);
      }
      case "omp_marketplace_remove": {
        const name = args["name"];
        if (typeof name !== "string" || !marketplaces.some((entry) => entry.name === name)) throw err("OMP_FAILED", "marketplace 不存在");
        marketplaces = marketplaces.filter((entry) => entry.name !== name);
        availableVersions.delete(name);
        return streamedOutput(args, `✔ Removed marketplace: ${name}\n`);
      }
      case "omp_marketplace_update": {
        const name = args["name"];
        const targets = name == null ? marketplaces : marketplaces.filter((entry) => entry.name === name);
        if (name != null && targets.length === 0) throw err("OMP_FAILED", "marketplace 不存在");
        for (const entry of targets) availableVersions.set(entry.name, "2.0.0");
        return streamedOutput(args, `${targets.map((entry) => `✔ Updated marketplace: ${entry.name}`).join("\n")}\n`);
      }
      case "omp_skills_list":
        return structuredClone({ skills, warnings: [] });
      case "omp_skills_update":
        for (const skill of skills) if (skill.source === "registry") skill.description = "由 registry 管理的示例技能（已更新）";
        return streamedOutput(args, "✔ Updated registry-example\n");
      default:
        throw err("UNKNOWN", `未知命令：${cmd}`);
    }
  });

  return { itermCalls };
}
