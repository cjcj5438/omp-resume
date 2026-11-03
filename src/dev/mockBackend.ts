/**
 * DEV-ONLY mock 后端：通过 `mockIPC` 实现全部命令，有状态。
 * 仅在 DEV + `?mock` 时由 main.tsx 动态 import，生产包不包含。
 *
 * 已知与真后端的分歧：
 * - user scope 的 `project` 参数在 mock 中不校验（真后端按 CONTRACT §4.30 返回 INVALID_INPUT）。
 * - mock 的 revision 是规范 JSON 的 SHA（真后端是原始文件 bytes 的 SHA），且永不为 "unreadable"。
 * - `list_cleanup_candidates` 的 `bytes` 直接用夹具的 `sizeBytes`（真后端会额外递归统计
 *   sibling 附件目录与 `.bak`）；夹具里把几个会话的 `sizeBytes` 调大以覆盖 `large` 原因。
 * - `?conflict=<命令名>`（逗号分隔）强制该命令报 CONFLICT（演示冲突刷新流程），
 *   `update_model_config` 在 expected 不匹配时本来就会报 CONFLICT。
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { Channel } from "@tauri-apps/api/core";
import { deepEqual } from "../modelConfig";
import type { AgentDefinition, AgentDetail, AppError, BenchRound, CleanupCandidate, CleanupReason, CreateAgentDefinitionResult, MarketplaceSummary, MetaSnapshot, ModelConfig, ModelInfo, ModelPerf, ModelSpec, ModelSpecPatch, ModelSpecsResult, ModelSpecUpdateResult, OmpOpResult, PluginSummary, PluginUpgradeChange, SessionMeta, SessionMetaInput, SkillSummary, SuperagentStatus } from "../types";
import type { ModelPreset, ModelPresetSnapshot, ModelPresetsState } from "../types";
import type { McpFileInfo, McpListResult, McpScope, McpServer, McpTransport } from "../types";
import type { PromptHistoryEntry, UsageRange } from "../types";
import type { AgentStage, StageActor, StageActorKind, StageActorState, StageActivity } from "../types";
import type { TrayPreview, TrayPreviewRow, TraySettings } from "../types";
import {
  FIXTURE_SESSIONS,
  buildListResult,
  conversationForPath,
  generateLargeConversation,
  type FixtureSession,
} from "./fixtures";
import { mockEmptyUsageHealth, mockEmptyUsageStats, mockSessionUsage, mockUsageHealth, mockUsageStats } from "./usageMock";
import { createMemoryMock } from "./memoryMock";

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
  modifiedAt: string | null;
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
  // 与后端 transport() 同口径：有 command 键 → stdio，有 url 键 → http。
  if (Object.hasOwn(config, "command")) return "stdio";
  return Object.hasOwn(config, "url") ? "http" : "unknown";
}

function mcpConfig(config: unknown): asserts config is McpObject {
  if (!mcpObject(config)) throw err("INVALID_INPUT", "服务器配置必须是 JSON 对象");
  if (Object.hasOwn(config, "command") && Object.hasOwn(config, "url")) throw err("INVALID_INPUT", "command 与 url 不能同时设置");
  const type = mcpTransport(config);
  // 与后端 validate_config() 同口径：unknown + 无 type 键 → 回落 stdio（自动推断）；
  // unknown + 有 type 键（含空串）→ 拒绝。
  const kind = type === "unknown" && !Object.hasOwn(config, "type") ? "stdio" : type;
  if (kind === "unknown") throw err("INVALID_INPUT", "type 仅支持 stdio、http 或 sse");
  const key = kind === "http" || kind === "sse" ? "url" : "command";
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
  const home = "/Users/demo";
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
      user = hash(document).then((revision) => ({ scope: "user", path: `${home}/.omp/agent/mcp.json`, document, revision, modifiedAt: "2026-10-31T10:00:00.000Z" }));
    }
    return user;
  }

  function projectFile(project: string): Promise<McpMockFile> {
    let file = projects.get(project);
    if (!file) {
      const document = project === "/Users/demo/my/omp-resume"
        ? { $schema: schema, mcpServers: { shared: { type: "http", url: "https://example.test/project-mcp" } } }
        : null;
      file = hash(document).then((revision) => ({ scope: "project", path: `${project}/.omp/mcp.json`, document, revision, modifiedAt: document === null ? null : "2026-10-30T10:00:00.000Z" }));
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
        modifiedAt: file.modifiedAt,
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
    if (cmd === "mcp_handshake") {
      // 不做真实握手：按 fixture transport 给固定答案（只读，不占 pending 串行）。
      mcpName(args["name"]);
      const file = await selected(args);
      const servers = serverMap(file.document);
      if (!Object.hasOwn(servers, args["name"])) throw err("NOT_FOUND", "MCP 服务器不存在");
      const raw = servers[args["name"]];
      const config: McpObject = mcpObject(raw) ? raw : {};
      const transport = mcpTransport(config);
      if (transport === "unknown") throw err("INVALID_INPUT", "type 仅支持 stdio、http 或 sse");
      if (transport === "sse") return { ok: true, tools: null, ms: 120, error: null };
      if (args["name"] === "blocked") return { ok: false, tools: null, ms: 233, error: "无法连接到服务器" };
      return { ok: true, tools: transport === "http" ? 4 : 9, ms: transport === "http" ? 180 : 95, error: null };
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

const MOCK_MODELS: ModelInfo[] = [
  { selector: "5438/deepseek-v4.1-flash", provider: "5438", id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash (5438)", thinkingLevels: ["low", "high", "max"], contextWindow: 1000000, maxTokens: 393216, reasoning: true, input: ["text", "image"], costInput: 0.3, costOutput: 1.2, costCacheRead: 0.006, costCacheWrite: 0 },
  { selector: "5438/glm-5.3-flash", provider: "5438", id: "glm-5.3-flash", name: "GLM 5.3 Flash (5438)", thinkingLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1048576, maxTokens: 131072, reasoning: true, input: ["text", "image"], costInput: 0.15, costOutput: 0.5, costCacheRead: 0.003, costCacheWrite: 0 },
  { selector: "5438/mimo-v2.6-pro", provider: "5438", id: "mimo-v2.6-pro", name: "MiMo v2.6 Pro (5438)", thinkingLevels: ["low", "medium", "high"], contextWindow: 200000, maxTokens: 65536, reasoning: true, input: ["text"], costInput: 1, costOutput: 4, costCacheRead: 0.02, costCacheWrite: 0 },
  { selector: "5438/muse-spark-1.3-contributor", provider: "5438", id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", thinkingLevels: ["minimal", "low", "medium", "high", "max"], contextWindow: 256000, maxTokens: 65536, reasoning: true, input: ["text", "image"], costInput: 2, costOutput: 8, costCacheRead: 0.04, costCacheWrite: 0 },
  { selector: "5438-claude/claude-sonnet-5-5", provider: "5438-claude", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", thinkingLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"], costInput: 3, costOutput: 15, costCacheRead: 0.3, costCacheWrite: 3.75 },
  { selector: "5438-claude/claude-opus-5-5", provider: "5438-claude", id: "claude-opus-5-5", name: "Claude Opus 5.5", thinkingLevels: ["low", "medium", "high", "max"], contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"], costInput: 15, costOutput: 75, costCacheRead: 1.5, costCacheWrite: 18.75 },
  { selector: "5438-claude/claude-haiku-5-5", provider: "5438-claude", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", thinkingLevels: ["low", "high"], contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text"], costInput: 1, costOutput: 5, costCacheRead: 0.1, costCacheWrite: 1.25 },
  { selector: "factory-droid/gpt-6.1-sol", provider: "factory-droid", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinkingLevels: ["medium", "high", "xhigh"], contextWindow: 300000, maxTokens: 100000, reasoning: true, input: ["text", "image"], costInput: 2, costOutput: 10, costCacheRead: 0.2, costCacheWrite: 0 },
  { selector: "factory-droid/claude-sonnet-5-5", provider: "factory-droid", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (factory-droid)", thinkingLevels: ["low", "high", "max"], contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"], costInput: 3, costOutput: 15, costCacheRead: 0.3, costCacheWrite: 3.75 },
];

const MOCK_AGENTS: AgentDefinition[] = [
  { name: "task", description: "通用子 agent，委派多步任务", source: "builtin", defaultModel: ["@task"], defaultThinkingLevel: "auto" },
  { name: "sonic", description: "低推理 agent，仅机械更新与数据收集", source: "builtin", defaultModel: ["@smol"], defaultThinkingLevel: "medium" },
  { name: "scout", description: "快速只读调研", source: "builtin", defaultModel: ["@smol"], defaultThinkingLevel: "medium" },
  { name: "reviewer", description: "代码评审专家", source: "builtin", defaultModel: ["@slow"], defaultThinkingLevel: null },
  { name: "security-reviewer", description: "只读安全审查", source: "builtin", defaultModel: [], defaultThinkingLevel: null },
  { name: "deployer", description: "自定义：发布与部署", source: "user", defaultModel: ["@smol"], defaultThinkingLevel: null },
];

/** `list_agent_details` 的附加字段（工具 / 派生 / 系统提示词）。 */
const MOCK_AGENT_EXTRA: Record<
  string,
  { tools: string[] | null; spawns: string[] | null; systemPrompt: string }
> = {
  task: {
    tools: null,
    spawns: ["*"],
    systemPrompt: "你是通用执行子代理。\n按委派说明完成任务，最后汇报改动与验证结果。",
  },
  sonic: {
    tools: null,
    spawns: null,
    systemPrompt: "只做机械更新与数据收集，不做设计决策。",
  },
  scout: {
    tools: ["read", "find", "grep", "glob", "web_search"],
    spawns: null,
    systemPrompt: "快速只读调研：返回压缩后的结论、文件引用与结构说明。",
  },
  reviewer: {
    tools: ["read", "find", "grep", "glob", "bash", "lsp", "web_search", "ast_grep"],
    spawns: ["scout"],
    systemPrompt: "审查给定改动：只报具体的正确性/安全问题，附文件行号。",
  },
  "security-reviewer": {
    tools: ["read", "find", "grep", "glob", "lsp", "ast_grep"],
    spawns: null,
    systemPrompt: "只读安全审查：找可复现的漏洞证据，按严重度排序。",
  },
  deployer: {
    tools: ["bash"],
    spawns: null,
    systemPrompt: "执行发布与部署步骤，失败时报告具体命令与输出。",
  },
};

/** 模型与 Agent 配置 mock：白名单 5 键的读-比-写 + 模型列表 + 只读兜底状态。 */
function createModelMock(forceConflict: boolean, fallbackOff: boolean) {
  // 与后端一致的原始值（unknown 保留）；含别名 @smol、未知 selector、
  // 按角色/按模型/通配/未知 key 四种兜底演示。
  const state: Record<string, unknown> = {
    modelRoles: {
      judge: "typesafe/jev-latest",
      plan: "5438-claude/claude-sonnet-5-5:xhigh",
      slow: "5438-claude/claude-opus-5-5:high",
      commit: "5438/deepseek-v4.1-flash:max",
      image: "factory-droid/gpt-6.1-sol:high",
      default: "5438/muse-spark-1.3-contributor:max",
    },
    "task.agentModelOverrides": {
      task: "5438/muse-spark-1.3-contributor:max",
      sonic: "factory-droid/claude-haiku-5-5:high",
      scout: "5438/deepseek-v4.1-flash",
      reviewer: "5438/mimo-v2.6-pro",
      "security-reviewer": "5438/mimo-v2.6-pro",
      deployer: "@smol",
    },
    "task.disabledAgents": ["reviewer"],
    "task.agentAdvisor": { sonic: "on", task: "on" },
    "retry.fallbackChains": {
      default: ["5438/muse-spark-1.3-contributor:max"],
      task: ["5438/mimo-v2.6-pro", "factory-droid/gpt-6.1-sol"],
      "5438/muse-spark-1.3-contributor": ["5438/mimo-v2.6-pro"],
      "5438-claude/*": ["factory-droid/claude-sonnet-5-5"],
      "5438/mimo-v2.6-pro": ["5438/muse-spark-1.3-contributor:max"],
      "retired/old-model": ["5438/deepseek-v4.1-flash", "retired/older"],
      sonic: ["5438/glm-5.3-flash"],
    },
  };
  // 只读兜底状态（不可写）；`?fallback=off` 模拟总开关关闭。
  const retryStatus = {
    modelFallback: !fallbackOff,
    fallbackOn: "any",
    fallbackRevertPolicy: "cooldown-expiry",
  };

  return (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "list_models") return structuredClone(MOCK_MODELS);
    if (cmd === "list_agent_details") {
      return structuredClone(
        MOCK_AGENTS.map((agent): AgentDetail => ({
          ...agent,
          ...(MOCK_AGENT_EXTRA[agent.name] ?? { tools: null, spawns: null, systemPrompt: "" }),
        })),
      );
    }
    if (cmd === "get_model_config") {
      return {
        roles: structuredClone(state["modelRoles"]) as Record<string, unknown>,
        agentOverrides: structuredClone(state["task.agentModelOverrides"]) as Record<string, unknown>,
        disabledAgents: structuredClone(state["task.disabledAgents"]) as unknown[],
        agentAdvisor: structuredClone(state["task.agentAdvisor"]) as Record<string, unknown>,
        fallbackChains: structuredClone(state["retry.fallbackChains"]) as Record<string, unknown>,
        agents: structuredClone(MOCK_AGENTS),
        retryStatus: structuredClone(retryStatus),
      } satisfies ModelConfig;
    }
    if (cmd === "create_agent_definition") {
      const name = args["name"];
      const description = args["description"];
      if (typeof name !== "string" || !/^[a-z0-9-_]{1,64}$/.test(name)) {
        throw err("INVALID_INPUT", "agent 名称须为 1–64 个小写字母、数字、下划线或连字符");
      }
      const trimmed = typeof description === "string" ? description.trim() : "";
      if (trimmed.length < 1 || trimmed.length > 500) {
        throw err("INVALID_INPUT", "agent 描述须为 1–500 字符");
      }
      if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
        throw err("INVALID_INPUT", "agent 描述不能包含控制字符");
      }
      // 只对用户文件判重：内置同名（如 scout）允许建同名 .md，走 §16.4 覆盖（同源合并为一行，source 仍为 builtin）。
      const existing = MOCK_AGENTS.findIndex((agent) => agent.name === name);
      if (existing >= 0 && MOCK_AGENTS[existing].source === "user") {
        throw err("INVALID_INPUT", `agent 定义已存在：${name}`);
      }
      const row = { name, description: trimmed, source: "user" as const, defaultModel: [] as string[], defaultThinkingLevel: null as string | null };
      if (existing >= 0) {
        MOCK_AGENTS[existing] = { ...MOCK_AGENTS[existing], description: trimmed };
      } else {
        MOCK_AGENTS.push(row);
      }
      return { name, path: `~/.omp/agent/agents/${name}.md` } satisfies CreateAgentDefinitionResult;
    }
    const key = args["key"];
    if (typeof key !== "string" || !Object.hasOwn(state, key)) {
      throw err("INVALID_KEY", `不支持的配置键：${String(key)}`);
    }
    if (forceConflict) throw err("CONFLICT", "配置已被外部修改，请刷新后重试");
    if (!deepEqual(state[key], args["expected"])) {
      throw err("CONFLICT", "配置已被外部修改，请刷新后重试");
    }
    state[key] = args["value"];
    return { key, value: structuredClone(state[key]) };
  };
}

/** 模型模式 mock：内存 `modelPresets`，排序/active/expected 语义镜像真后端（CONTRACT §24）。 */
function createPresetsMock() {
  let rawPresets: Record<string, unknown> = {
    "deep-work": {
      modelRoles: { default: "5438/muse-spark-1.3-contributor:max" },
      defaultThinkingLevel: "max",
      agentModelOverrides: { task: "5438/mimo-v2.6-pro" },
    },
    "fast-triage": {
      modelRoles: { default: "5438/deepseek-v4.1-flash" },
      defaultThinkingLevel: null,
      agentModelOverrides: null,
    },
  };
  const current = (): ModelPresetSnapshot => ({
    modelRoles: { default: "5438/muse-spark-1.3-contributor:max" },
    agentModelOverrides: { task: "5438/mimo-v2.6-pro" },
    defaultThinkingLevel: "max",
  });
  const parsePreset = (name: string, value: unknown): ModelPreset => {
    const invalid = (reason: string): ModelPreset => ({
      name,
      modelRoles: {},
      defaultThinkingLevel: null,
      agentModelOverrides: null,
      invalidReason: reason,
    });
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("模式条目必须是对象");
    const o = value as Record<string, unknown>;
    const roles = o["modelRoles"];
    if (roles === null || typeof roles !== "object" || Array.isArray(roles)) return invalid("modelRoles 必须是对象");
    const thinking = o["defaultThinkingLevel"];
    if (thinking !== null && thinking !== undefined && typeof thinking !== "string") {
      return invalid("defaultThinkingLevel 必须是字符串或 null");
    }
    const overrides = o["agentModelOverrides"];
    if (overrides !== null && overrides !== undefined && (typeof overrides !== "object" || Array.isArray(overrides))) {
      return invalid("agentModelOverrides 必须是对象或 null");
    }
    return {
      name,
      modelRoles: roles as Record<string, unknown>,
      defaultThinkingLevel: (thinking as string | null | undefined) ?? null,
      agentModelOverrides: (overrides as Record<string, unknown> | null | undefined) ?? null,
      invalidReason: null,
    };
  };
  const snapshot = (): ModelPresetsState => {
    const presets = Object.entries(rawPresets)
      .map(([name, value]) => parsePreset(name, value))
      .sort((a, b) =>
        a.name.toLowerCase() < b.name.toLowerCase() ? -1
        : a.name.toLowerCase() > b.name.toLowerCase() ? 1
        : a.name < b.name ? -1
        : a.name > b.name ? 1
        : 0,
      );
    const cur = current();
    const active =
      presets.find(
        (p) =>
          p.invalidReason === null &&
          deepEqual(p.modelRoles, cur.modelRoles) &&
          (p.defaultThinkingLevel === null || p.defaultThinkingLevel === cur.defaultThinkingLevel) &&
          (p.agentModelOverrides === null || deepEqual(p.agentModelOverrides, cur.agentModelOverrides)),
      )?.name ?? null;
    return { presets: structuredClone(presets), active, current: cur, rawPresets: structuredClone(rawPresets) };
  };
  return (cmd: string, args: Record<string, unknown>): ModelPresetsState => {
    if (cmd === "list_model_presets") return snapshot();
    const name = args["name"];
    if (cmd === "switch_model_preset") {
      if (typeof name !== "string" || !Object.hasOwn(rawPresets, name)) throw err("NOT_FOUND", `模式不存在：${String(name)}`);
      const preset = parsePreset(name, rawPresets[name]);
      if (preset.invalidReason !== null) throw err("INVALID_INPUT", `模式无效：${preset.invalidReason}`);
      if (!deepEqual(current(), args["expected"])) throw err("CONFLICT", "配置已被外部修改，请刷新后重试");
      return snapshot();
    }
    // save/delete：名称只要求非空；expectedPresets 过期 CONFLICT。
    if (typeof name !== "string" || name.length === 0) throw err("INVALID_INPUT", "模式名称不能为空");
    if (!deepEqual(rawPresets, args["expectedPresets"])) throw err("CONFLICT", "模式列表已被外部修改，请刷新后重试");
    if (cmd === "save_model_preset") {
      if (Object.hasOwn(rawPresets, name) && args["overwrite"] !== true) {
        throw err("INVALID_INPUT", `模式已存在：${name}`);
      }
      const cur = current();
      rawPresets = {
        ...rawPresets,
        [name]: {
          modelRoles: structuredClone(cur.modelRoles),
          defaultThinkingLevel: cur.defaultThinkingLevel,
          agentModelOverrides: structuredClone(cur.agentModelOverrides),
        },
      };
      return snapshot();
    }
    // delete_model_preset：只删保存记录，不改当前配置。
    if (!Object.hasOwn(rawPresets, name)) throw err("NOT_FOUND", `模式不存在：${name}`);
    const { [name]: _removed, ...rest } = rawPresets;
    rawPresets = rest;
    return snapshot();
  };
}

/** 模型规格 mock：9 个 MOCK_MODELS 的内存规格，可编辑，revision 自增。永不读真实文件。 */
function createSpecsMock(forceConflict: boolean) {
  let revision = 0;
  // haiku 行故意缺 maxTokens/input/cost 子集，演示 null 规格。
  const specs: ModelSpec[] = MOCK_MODELS.map((model): ModelSpec => ({
    provider: model.provider,
    id: model.id,
    selector: model.selector,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.id === "claude-haiku-5-5" ? null : model.maxTokens,
    reasoning: model.reasoning,
    input: model.id === "claude-haiku-5-5" ? null : [...model.input],
    costInput: model.costInput,
    costOutput: model.costOutput,
    costCacheRead: model.id === "claude-haiku-5-5" ? null : model.costCacheRead,
    costCacheWrite: model.costCacheWrite,
    // haiku 行演示分层价：四费用 None 化由 Rust 侧做，mock 直接标 tiered。
    costTiered: model.id === "claude-haiku-5-5",
  }));
  const snapshot = (): ModelSpecsResult => ({
    path: "/mock/.omp/agent/models.yml",
    available: true,
    revision: `mock-rev-${revision}`,
    specs: structuredClone(specs),
    error: null,
  });
  const createSpec = (args: Record<string, unknown>): ModelSpecUpdateResult => {
    const provider = args["provider"];
    const id = args["id"];
    const expectedRevision = args["expectedRevision"];
    // 与 Rust validate_target 同口径。
    for (const [label, value] of [["provider", provider], ["模型 id", id]] as const) {
      if (typeof value !== "string" || value.trim() === "") throw err("INVALID_INPUT", `${label}不能为空`);
      if (value.length > 200) throw err("INVALID_INPUT", `${label}过长（最多 200 个字符）`);
      if (value.includes("\n") || value.includes("\r")) throw err("INVALID_INPUT", `${label}不能换行`);
    }
    const providerStr = provider as string;
    const idStr = id as string;
    if (providerStr.includes("/") || idStr.includes("/")) {
      throw err("INVALID_INPUT", "provider 与模型 id 不能包含 /");
    }
    // provider 必须已存在（mock 以首个同 provider 规格为据，不新建 provider）。
    if (!specs.some((spec) => spec.provider === providerStr)) {
      throw err("INVALID_INPUT", "未找到指定的 provider");
    }
    if (specs.some((spec) => spec.provider === providerStr && spec.id === idStr)) {
      throw err("INVALID_INPUT", `模型 ${providerStr}/${idStr} 已存在，请换个 id 或直接修改它`);
    }
    if (typeof expectedRevision !== "string" || expectedRevision.trim() === "") {
      throw err("INVALID_INPUT", "缺少 revision，请刷新后重试");
    }
    if (expectedRevision === "absent" || expectedRevision === "unreadable") {
      throw err("INVALID_INPUT", "模型规格文件不可写，请刷新后重试");
    }
    if (forceConflict || expectedRevision !== `mock-rev-${revision}`) {
      throw err("CONFLICT", "模型规格文件已被外部修改，请刷新后重试");
    }
    const patch = (args["patch"] ?? {}) as ModelSpecPatch;
    // 只用 name/contextWindow/maxTokens（与 Rust create 侧一致，其余字段忽略）。
    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || patch.name.trim() === "") throw err("INVALID_INPUT", "模型名称不能为空");
      if ([...patch.name].length > 200) throw err("INVALID_INPUT", "模型名称过长（最多 200 个字符）");
      if (patch.name.includes("\n") || patch.name.includes("\r")) throw err("INVALID_INPUT", "模型名称不能换行");
      if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(patch.name)) {
        throw err("INVALID_INPUT", "模型名称包含非法字符");
      }
    }
    for (const [label, value] of [["上下文窗口", patch.contextWindow], ["最大输出", patch.maxTokens]] as const) {
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw err("INVALID_INPUT", `${label}必须大于 0`);
      }
    }
    const created: ModelSpec = {
      provider: providerStr,
      id: idStr,
      selector: `${providerStr}/${idStr}`,
      name: patch.name ?? idStr,
      contextWindow: patch.contextWindow ?? null,
      maxTokens: patch.maxTokens ?? null,
      reasoning: null,
      input: null,
      costInput: null,
      costOutput: null,
      costCacheRead: null,
      costCacheWrite: null,
      costTiered: false,
    };
    specs.push(created);
    revision += 1;
    return {
      revision: `mock-rev-${revision}`,
      spec: structuredClone(created),
      backupPath: `/mock/.omp/agent/models.yml.omp-resume.mock-${revision}.bak`,
    };
  };
  return (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_model_specs") return snapshot();
    if (cmd === "create_model_spec") return createSpec(args);
    const provider = args["provider"];
    const id = args["id"];
    const expectedRevision = args["expectedRevision"];
    // 与 Rust validate_target 同口径（model_specs.rs:863-879）。
    for (const [label, value] of [["provider", provider], ["模型 id", id]] as const) {
      if (typeof value !== "string" || value.trim() === "") throw err("INVALID_INPUT", `${label}不能为空`);
      if (value.length > 200) throw err("INVALID_INPUT", `${label}过长（最多 200 个字符）`);
      if (value.includes("\n") || value.includes("\r")) throw err("INVALID_INPUT", `${label}不能换行`);
    }
    if ((provider as string).includes("/") || (id as string).includes("/")) {
      throw err("INVALID_INPUT", "provider 与模型 id 不能包含 /");
    }
    const target = specs.find((spec) => spec.provider === provider && spec.id === id);
    if (!target) throw err("INVALID_INPUT", "未找到指定的模型");
    if (typeof expectedRevision !== "string" || expectedRevision.trim() === "") {
      throw err("INVALID_INPUT", "缺少 revision，请刷新后重试");
    }
    if (expectedRevision === "absent" || expectedRevision === "unreadable") {
      throw err("INVALID_INPUT", "模型规格文件不可写，请刷新后重试");
    }
    if (forceConflict || expectedRevision !== `mock-rev-${revision}`) {
      throw err("CONFLICT", "模型规格文件已被外部修改，请刷新后重试");
    }
    const patch = (args["patch"] ?? {}) as ModelSpecPatch;
    // 分层价模型整模型拒改（与 Rust 写侧一致）。
    if (target.costTiered) {
      throw err("INVALID_INPUT", "该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml");
    }
    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || patch.name.trim() === "") throw err("INVALID_INPUT", "模型名称不能为空");
      if ([...patch.name].length > 200) throw err("INVALID_INPUT", "模型名称过长（最多 200 个字符）");
      if (patch.name.includes("\n") || patch.name.includes("\r")) throw err("INVALID_INPUT", "模型名称不能换行");
      // 与 Rust 同口径：全部 Cc 控制字符 + YAML 换行符（含 \t）。
      if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(patch.name)) {
        throw err("INVALID_INPUT", "模型名称包含非法字符");
      }
    }
    for (const [label, value] of [["上下文窗口", patch.contextWindow], ["最大输出", patch.maxTokens]] as const) {
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw err("INVALID_INPUT", `${label}必须大于 0`);
      }
    }
    if (patch.input !== undefined) {
      if (!Array.isArray(patch.input) || patch.input.length === 0) throw err("INVALID_INPUT", "输入类型不能为空");
      if (patch.input.length > 8) throw err("INVALID_INPUT", "输入类型过多（最多 8 个）");
      const seen = new Set<string>();
      for (const item of patch.input) {
        if (typeof item !== "string" || item.trim() === "") throw err("INVALID_INPUT", "输入类型不能含空项");
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(item)) throw err("INVALID_INPUT", `不支持的输入类型：${item}`);
        if (seen.has(item)) throw err("INVALID_INPUT", "输入类型不能重复");
        seen.add(item);
      }
    }
    if (patch.cost !== undefined) {
      const entries = [["输入价格", patch.cost.input], ["输出价格", patch.cost.output], ["缓存读取价格", patch.cost.cacheRead], ["缓存写入价格", patch.cost.cacheWrite]] as const;
      for (const [label, value] of entries) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) {
          throw err("INVALID_INPUT", `${label}必须是非负有限数`);
        }
      }
    }
    // 无变化补丁：与 Rust 一致返回原 revision + 空备份路径，不自增。
    const noop =
      (patch.name === undefined || patch.name === target.name) &&
      (patch.contextWindow === undefined || patch.contextWindow === target.contextWindow) &&
      (patch.maxTokens === undefined || patch.maxTokens === target.maxTokens) &&
      (patch.reasoning === undefined || patch.reasoning === target.reasoning) &&
      (patch.input === undefined || (target.input !== null && patch.input.length === target.input.length && patch.input.every((v, i) => v === (target.input as string[])[i]))) &&
      (patch.cost === undefined ||
        (patch.cost.input === target.costInput && patch.cost.output === target.costOutput && patch.cost.cacheRead === target.costCacheRead && patch.cost.cacheWrite === target.costCacheWrite));
    if (noop) {
      return {
        revision: `mock-rev-${revision}`,
        spec: structuredClone(target),
        backupPath: "",
      } satisfies ModelSpecUpdateResult;
    }
    if (patch.name !== undefined) target.name = patch.name;
    if (patch.contextWindow !== undefined) target.contextWindow = patch.contextWindow;
    if (patch.maxTokens !== undefined) target.maxTokens = patch.maxTokens;
    if (patch.reasoning !== undefined) target.reasoning = patch.reasoning;
    if (patch.input !== undefined) target.input = [...patch.input];
    if (patch.cost !== undefined) {
      target.costInput = patch.cost.input;
      target.costOutput = patch.cost.output;
      target.costCacheRead = patch.cost.cacheRead;
      target.costCacheWrite = patch.cost.cacheWrite;
    }
    revision += 1;
    const result: ModelSpecUpdateResult = {
      revision: `mock-rev-${revision}`,
      spec: structuredClone(target),
      backupPath: `/mock/.omp/agent/models.yml.omp-resume.mock-${revision}.bak`,
    };
    return result;
  };
}

/** 模型测试器 mock：7 天 bench 历史（5 模型 × 3 provider，含一个常挂 403 模型）。 */
function createBenchMock() {
  // 与上方 model mock 的 modelRoles 值逐字对齐（含 :thinking 后缀）：
  // default / slow / plan / commit / image。其中 commit 的常挂 403（chat 角色，行可见）。
  const MOCK_BENCH_SELECTORS = [
    "5438/muse-spark-1.3-contributor:max",
    "5438-claude/claude-opus-5-5:high",
    "5438-claude/claude-sonnet-5-5:xhigh",
    "5438/deepseek-v4.1-flash:max",
    "factory-droid/gpt-6.1-sol:high",
  ];
  const FAILING = "5438/deepseek-v4.1-flash:max";
  const weight = (i: number, salt: number): number => {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const roundAt = (sel: string, at: string, seed: number, failing: boolean, recent: boolean): BenchRound => {
    if (failing) {
      return {
        at, selector: sel, total: 8, ok: 0, ttftP50Ms: null, ttftP95Ms: null,
        tpsP50: null, tpsCv: null, cost: 0, errors: ["403 Forbidden: invalid API key"],
      };
    }
    // 近两天的轮次全成功（演示一键推荐），更早的偶发一次失败。
    const ok = recent || weight(seed, 3) >= 0.12 ? 8 : 7;
    const ttft = 400 + weight(seed, 5) * 1600;
    const tps = 18 + weight(seed, 7) * 42;
    return {
      at, selector: sel, total: 8, ok,
      ttftP50Ms: Math.round(ttft),
      ttftP95Ms: Math.round(ttft * (1.3 + weight(seed, 9) * 0.5)),
      tpsP50: Math.round(tps * 10) / 10,
      tpsCv: Math.round(weight(seed, 11) * 0.25 * 1000) / 1000,
      cost: Math.round((0.002 + weight(seed, 13) * 0.02) * 10000) / 10000,
      errors: ok === 8 ? [] : ["timeout after 360s"],
    };
  };
  const now = Date.now();
  const day = 86400000;
  let history: BenchRound[] = [];
  MOCK_BENCH_SELECTORS.forEach((sel, mi) => {
    for (let d = 6; d >= 0; d -= 1) {
      // 最近两天每天两轮（24h 样本 ≥5），更早每天一轮；最后一轮落在 1 小时内。
      const times = d < 2 ? [now - d * day - 3600000 * (2 + mi), now - d * day - 3600000 * (8 + mi)] : [now - d * day - 3600000 * (4 + mi)];
      times.forEach((t, ti) => {
        history.push(roundAt(sel, new Date(t).toISOString(), mi * 100 + d * 10 + ti, sel === FAILING, d < 2));
      });
    }
  });
  history.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "model_bench_history") return structuredClone(history);
    if (cmd === "model_perf_list") {
      const perfs: ModelPerf[] = MOCK_BENCH_SELECTORS.slice(0, 4).map((sel, i) => ({
        selector: sel.includes(":") ? sel.split(":")[0] : sel,
        samples: 120 - i * 17,
        ttftMs: Math.round(700 + weight(i, 21) * 900),
        tps: Math.round((22 + weight(i, 23) * 30) * 10) / 10,
        updatedAt: new Date(now - 3600000 * (1 + i * 5)).toISOString(),
      }));
      return perfs;
    }
    const selector = args["selector"];
    if (typeof selector !== "string" || !selector.includes("/")) {
      throw err("INVALID_INPUT", "selector 必须是 provider/model[:thinking]");
    }
    if (cmd === "model_bench_delete") {
      const at = args["at"];
      const keep = history.filter((r) => !(r.selector === selector && (typeof at !== "string" || r.at === at)));
      const deleted = history.length - keep.length;
      if (deleted > 0) history = keep;
      return deleted;
    }
    const round = roundAt(selector, new Date().toISOString(), history.length * 7 + 1, selector === FAILING, true);
    history = [...history, round];
    return structuredClone(round);
  };
}

// ---- 菜单栏预览 mock（CONTRACT §17.10–17.11） ----

// 状态中文名前端按 key 映射（见 TrayView `STATUS_NAME`）。

/** 用夹具会话按设置生成预览（与 `list_running_sessions` 同一份夹具）。 */
function mockTrayPreview(sessions: FixtureSession[], settings: TraySettings): TrayPreview {
  // 状态按位置轮换，保证四态在预览里都有机会出现；计数与行一致。
  const cycle: TrayPreviewRow["status"][] = ["working", "waiting", "stuck", "idle"];
  const running = sessions
    .filter((s) => s.summary.inUse)
    .map((s, i) => ({ s, status: cycle[i % cycle.length] }));
  const working = running.filter((r) => r.status === "working").length;
  const waiting = running.filter((r) => r.status === "waiting").length;
  const stuck = running.filter((r) => r.status === "stuck").length;
  const total = running.length;
  const trayTitle =
    total === 0 || settings.badgeStyle === "icon"
      ? null
      : settings.badgeStyle === "dot"
        ? waiting + stuck > 0
          ? "●"
          : "○"
        : `${working + stuck}·${waiting}${stuck > 0 ? "!" : ""}`;
  const rank: Record<string, number> = { stuck: 0, waiting: 1, working: 2, idle: 3 };
  const visible = [...running]
    .sort((a, b) => rank[a.status] - rank[b.status])
    .filter((r) => settings.showIdle || r.status !== "idle");
  const toRow = ({ s, status }: { s: FixtureSession; status: TrayPreviewRow["status"] }): TrayPreviewRow => {
    const segs = s.summary.cwd.split("/").filter(Boolean);
    return {
      sessionId: s.summary.id,
      status,
      title: s.summary.title,
      project: segs.length > 0 ? segs[segs.length - 1] : null,
      subagents: status === "working" ? 1 : 0,
      elapsedSecs: 120,
      enabled: true,
      disabledReason: null,
    };
  };
  const rows = visible.slice(0, 8).map(toRow);
  const overflow = visible.slice(8).map(toRow);
  const recent = sessions.slice(0, 3).map((s) => {
    const segs = s.summary.cwd.split("/").filter(Boolean);
    const project = segs.length > 0 ? segs[segs.length - 1] : "";
    return { key: s.summary.id, text: `${s.summary.title} · ${project}` };
  });
  const projects = [...new Set(sessions.map((s) => s.summary.cwd))]
    .slice(0, 3)
    .map((cwd) => ({ key: cwd, text: cwd }));
  // 固定样例计数（同 Rust `badge_samples`）：与当前运行数无关。
  const badgeSamples = (
    [
      ["working", "2·0", "○"],
      ["waiting", "0·1", "●"],
      ["idle", "0·0", "○"],
      ["stuck", "1·0!", "●"],
    ] as const
  ).map(([state, count, dot]) => ({
    state,
    title:
      settings.badgeStyle === "icon"
        ? null
        : settings.badgeStyle === "dot"
          ? dot
          : count,
  }));
  return {
    ready: true,
    trayTitle,
    costUsd: settings.showCost ? 1.2 : null,
    requestCount: settings.showCost ? 7 : null,
    rows,
    overflow,
    recent,
    projects,
    modes: [
      { name: "默认", active: true, enabled: true },
      { name: "省钱", active: false, enabled: true },
    ],
    badgeSamples,
  };
}

// ---- 舞台 mock（CONTRACT §23） ----

/** 舞台场景（`?stage=`）：live 逐相位演示 / review 全终态 / many 溢出 / empty 只有主。 */
type StageScenario = "live" | "review" | "many" | "empty";

/** 首次调用时刻（live 场景以它为 t0 推进相位）。 */
let stageT0: number | null = null;

const PHASES: { main: StageActorState; actors: Record<string, StageActorState> }[] = [
  { main: "running", actors: { api: "queued", tests: "queued", docs: "queued", lint: "queued", advisor: "idle" } },
  { main: "running", actors: { api: "running", tests: "queued", docs: "queued", lint: "queued", advisor: "idle" } },
  { main: "running", actors: { api: "running", tests: "running", docs: "queued", lint: "queued", advisor: "running" } },
  { main: "running", actors: { api: "running", tests: "running", docs: "running", lint: "queued", advisor: "running" } },
  { main: "running", actors: { api: "running", tests: "done", docs: "running", lint: "queued", advisor: "running" } },
  { main: "running", actors: { api: "failed", tests: "done", docs: "running", lint: "queued", advisor: "idle" } },
  { main: "running", actors: { api: "failed", tests: "done", docs: "done", lint: "lost", advisor: "idle" } },
  { main: "idle", actors: { api: "failed", tests: "done", docs: "done", lint: "lost", advisor: "idle" } },
];
const TOOL_CYCLE = ["read", "edit", "bash", "task"];

/** 各角色工具活动文案：首条含反引号（覆盖 code pill），次条纯文本。 */
const TOOL_BRIEFS: [string, string][] = [
  ["分派 `tree_layout.rs` 给 tree-builder", "读取子任务返回并合并结论"],
  ["运行 `cargo test api::` 等待编译", "修复校验失败的边界分支"],
  ["补齐 `session_roundtrip` 端到端断言", "确认失败用例已恢复通过"],
  ["更新 `contract.md` 的接口小节", "核对示例与实现一致"],
  ["跑 `cargo clippy` 收敛告警", "格式化改动文件"],
  ["复审本轮改动并记录结论", "汇总 token 与成本写入备注"],
];
const REPLY_BRIEFS = [
  "本轮改动已收尾，等待下一轮输入",
  "已把结论写回会话，继续观察",
  "上下文压缩前保存检查点",
  "排队中：等待主会话释放写锁",
];

/** provenance 真实形态（derive.rs 实际标签）：running 按后端口径为 null。 */
const PROVENANCE: Record<StageActorState, string | null> = {
  running: null,
  idle: "lifecycle:turn-settled",
  queued: "spawn + lifecycle",
  done: "session_exit:normal",
  failed: "tail: last assistant error",
  lost: "parent gone, dirty tail",
};

const ACTOR_META: Record<string, { name: string; kind: StageActorKind; agent: string | null; brief: string }> = {
  api: { name: "api", kind: "subagent", agent: "task", brief: "实现 REST 端点与校验" },
  tests: { name: "tests", kind: "subagent", agent: "task", brief: "补齐端到端测试" },
  docs: { name: "docs", kind: "worker", agent: "scout", brief: "更新接口文档" },
  lint: { name: "lint", kind: "worker", agent: "sonic", brief: "跑 lint 与格式化" },
  advisor: { name: "__advisor", kind: "advisor", agent: null, brief: "复审实现" },
};

const STATE_TEXT: Record<string, string | null> = {
  running: null,
  queued: null,
  idle: "待命",
  done: "已结束",
  failed: "error",
  lost: "会话已退出",
};

function stageActor(
  id: string,
  state: StageActorState,
  meta: { name: string; kind: StageActorKind; agent: string | null; brief: string },
  t0: number,
  index: number,
): StageActor {
  const startedAt = new Date(t0 + index * 1000).toISOString();
  const ended = state === "done" || state === "failed" || state === "lost";
  const closedAt = new Date(t0 + 20000 + index * 4000).toISOString();
  const tool = TOOL_CYCLE[index % TOOL_CYCLE.length];
  const calls = state === "queued" ? 0 : 6 + index * 3;
  const briefs = TOOL_BRIEFS[index % TOOL_BRIEFS.length];
  const recent: StageActivity[] = [];
  for (let i = 0; i < 4; i += 1) {
    const even = i % 2 === 0;
    recent.push({
      at: new Date(t0 + index * 1000 + i * 1500).toISOString(),
      kind: even ? "tool" : "reply",
      tool: even ? TOOL_CYCLE[(index + i) % TOOL_CYCLE.length] : null,
      text: even ? briefs[i >> 1] : REPLY_BRIEFS[(index + i) % REPLY_BRIEFS.length],
    });
  }
  return {
    id,
    kind: meta.kind,
    parentId: null,
    name: meta.name,
    agent: meta.agent,
    brief: meta.brief,
    state,
    statusText: STATE_TEXT[state] ?? null,
    startedAt,
    endedAt: ended ? closedAt : null,
    lastActivityAt: new Date(t0 + 30000 + index * 1000).toISOString(),
    model: "amr-link/deepseek-v4.1-flash",
    contextTokens: state === "queued" ? 0 : 12000 + index * 3400,
    cost: state === "queued" ? 0 : 0.0012 * (index + 1),
    provenance: PROVENANCE[state],
    toolCalls: calls,
    current:
      state === "running"
        ? { at: new Date(t0 + 30000).toISOString(), kind: "tool", tool, text: `运行 ${tool}` }
        : null,
    recent,
  };
}

function mockStage(scenario: StageScenario, path: string, title: string): AgentStage {
  const now = Date.now();
  if (scenario === "empty") {
    return {
      path,
      sessionId: "mock-empty",
      title,
      cwd: "/mock/project",
      inUse: true,
      probeOk: true,
      updatedAt: new Date(now).toISOString(),
      omitted: 0,
      actors: [
        {
          ...stageActor("main", "running", { name: "管理员", kind: "main", agent: null, brief: "" }, now - 240000, 0),
          kind: "main",
          name: "管理员",
        },
      ],
    };
  }
  if (scenario === "many") {
    const actors: StageActor[] = [
      { ...stageActor("main", "running", { name: "管理员", kind: "main", agent: null, brief: "" }, now - 600000, 0), kind: "main", name: "管理员" },
    ];
    for (let i = 0; i < 25; i += 1) {
      const state: StageActorState = i % 7 === 0 ? "done" : i % 11 === 0 ? "failed" : i % 5 === 0 ? "idle" : "running";
      const agent = ["task", "scout", "sonic", "reviewer", "security-reviewer"][i % 5];
      actors.push(
        stageActor(
          `actor-${i}`,
          state,
          { name: `worker-${i}`, kind: i % 3 === 0 ? "worker" : "subagent", agent, brief: `并行任务 ${i}` },
          now - 500000,
          i + 1,
        ),
      );
    }
    return {
      path,
      sessionId: "mock-many",
      title,
      cwd: "/mock/project",
      inUse: true,
      probeOk: true,
      updatedAt: new Date(now).toISOString(),
      omitted: 0,
      actors,
    };
  }
  if (scenario === "review") {
    const actors: StageActor[] = [
      { ...stageActor("main", "done", { name: "管理员", kind: "main", agent: null, brief: "" }, now - 900000, 0), kind: "main", name: "管理员" },
    ];
    const states: StageActorState[] = ["done", "done", "done", "done", "failed", "lost"];
    const keys = ["api", "tests", "docs", "lint", "advisor", "extra"];
    states.forEach((state, i) => {
      const key = keys[i];
      const meta = ACTOR_META[key] ?? { name: key, kind: "subagent" as StageActorKind, agent: "task", brief: `任务 ${key}` };
      actors.push(stageActor(key, state, meta, now - 880000, i + 1));
    });
    return {
      path,
      sessionId: "mock-review",
      title,
      cwd: "/mock/project",
      inUse: false,
      probeOk: true,
      updatedAt: new Date(now).toISOString(),
      omitted: 0,
      actors,
    };
  }
  // live：相位由首次调用时刻推进，4s 一档。
  stageT0 ??= now;
  const phaseIndex = Math.floor((now - stageT0) / 4000) % PHASES.length;
  const phase = PHASES[phaseIndex];
  const actors: StageActor[] = [
    {
      ...stageActor("main", phase.main, { name: "管理员", kind: "main", agent: null, brief: "" }, stageT0, 0),
      kind: "main",
      name: "管理员",
      statusText: phase.main === "idle" ? "等待输入" : null,
      cost: 0.0421 + phaseIndex * 0.003,
      toolCalls: 32 + phaseIndex * 4,
    },
  ];
  let index = 1;
  for (const key of ["api", "tests", "docs", "lint", "advisor"]) {
    const state = phase.actors[key];
    const meta = ACTOR_META[key];
    const actor = stageActor(key, state, meta, stageT0, index);
    actors.push({
      ...actor,
      cost: actor.cost + phaseIndex * 0.0004,
      toolCalls: actor.toolCalls + phaseIndex,
    });
    index += 1;
  }
  return {
    path,
    sessionId: "mock-live",
    title,
    cwd: "/mock/project",
    inUse: true,
    probeOk: true,
    updatedAt: new Date(now).toISOString(),
    omitted: 0,
    actors,
  };
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
  const model = createModelMock(
    (params.get("conflict") ?? "").split(",").includes("update_model_config"),
    params.get("fallback") === "off",
  );
  const presets = createPresetsMock();
  const specs = createSpecsMock(
    (params.get("conflict") ?? "").split(",").includes("update_model_spec"),
  );
  const bench = createBenchMock();
  const memory = createMemoryMock({
    available: params.get("memory") !== "off",
    backend: params.get("memoryBackend") ?? "mnemopi",
    inUseBank: params.get("memoryInUse"),
    probeFailed: params.get("memoryProbe") === "fail",
    bulkBanks: Number(params.get("memoryBanks") ?? 0),
  });
  const metadata = { installedAt: "2026-10-16T00:00:00.000Z", lastUpdated: "2026-10-16T00:00:00.000Z", installPath: null };
  let plugins: PluginSummary[] = [
    { ...metadata, id: "hello-plugin@probe-mkt", name: "hello-plugin", marketplace: "probe-mkt", version: "1.0.0", description: "示例插件", enabled: true },
    { ...metadata, id: "formatter@community", name: "formatter", marketplace: "community", version: "1.0.0", description: null, enabled: false },
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

  // 应用侧备注（内存态，镜像真后端的 revision 冲突与校验语义）。
  let metaRevision = 0;
  let metaSessions: Record<string, SessionMeta> = {};
  const metaSnapshot = (): MetaSnapshot =>
    structuredClone({ revision: metaRevision, sessions: metaSessions });

  // 菜单栏设置（内存态，默认值同 Rust `Settings::default`）。
  let traySettings: TraySettings = {
    notifyOnWaiting: true,
    notifyOnStuck: true,
    notifyOnFinish: false,
    badgeStyle: "count",
    titleWidth: "standard",
    showCost: true,
    showProject: false,
    showIdle: true,
    compactRows: false,
    clickAction: "panel",
    showSearch: true,
    showDockIcon: false,
  };
  // Superagent 托管状态（内存态，初始未启用；启用后切 running）。
  let superagent: SuperagentStatus = {
    state: "disabled",
    enabled: false,
    pid: null,
    startedAt: null,
    restarts: 0,
    lastError: null,
    stateDir: "/mock/superagent",
    socketPath: "/mock/superagent/daemon.sock",
    logPath: "/mock/superagent/logs/daemon.log",
    assetsDir: "/mock/superagent-assets",
    ompBin: "/mock/omp",
  };

  (window as unknown as { __ompMock?: unknown }).__ompMock = {
    calls: itermCalls,
    newSessionCalls,
    get sessions() {
      return sessions;
    },
    get meta() {
      return metaSnapshot();
    },
    get traySettings() {
      return traySettings;
    },
    /** 冒烟用：模拟外部修改，把 revision 顶掉一次，使下次保存触发 CONFLICT。 */
    bumpMeta() {
      metaRevision += 1;
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
      case "list_running_sessions": {
        const scenario = (params.get("stage") ?? "live") as StageScenario;
        // 回看/空场景没有运行中会话（否则左栏会出现自相矛盾的「运行中」行）。
        if (scenario === "empty" || scenario === "review") return [];
        const first = sessions[0]?.summary;
        return [
          {
            id: first?.id ?? "mock-session",
            path: first?.path ?? "/mock/-mock-project/session.jsonl",
            title: first?.title ?? "mock 会话",
            status: "working",
            statusText: "工作中",
            subagents: scenario === "many" ? 25 : 4,
            durationSecs: 320,
            app: "iTerm2",
          },
        ];
      }
      case "get_agent_stage": {
        const scenario = (params.get("stage") ?? "live") as StageScenario;
        const path = (args["path"] as string | undefined) ?? "/mock/-mock-project/session.jsonl";
        const hit = find(path);
        if (!hit && !path.startsWith("/mock")) throw err("NOT_FOUND", "会话文件不存在");
        if (params.has("stageMissing")) throw err("NOT_FOUND", "会话文件不存在");
        if (params.get("stage") === "unsupported") throw err("UNSUPPORTED_FORMAT", "该会话格式暂不支持");
        return mockStage(scenario, path, hit?.summary.title ?? "mock 舞台会话");
      }
      case "mcp_list":
      case "mcp_get_server":
      case "mcp_save_server":
      case "mcp_set_enabled":
      case "mcp_delete_server":
      case "mcp_handshake":
        return mcp(cmd, args);
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
      case "get_usage_stats": {
        const range = (args["range"] as UsageRange | undefined) ?? "30d";
        const empty = params.get("usage") === "empty";
        const stats = (empty ? mockEmptyUsageStats : mockUsageStats)(range);
        if (!empty) {
          stats.topSessions.forEach((s, i) => {
            const fixture = sessions[i]?.summary;
            if (!fixture) return;
            s.id = fixture.id;
            s.path = fixture.path;
            s.cwd = fixture.cwd;
          });
        }
        return stats;
      }
      case "get_usage_health": {
        const range = (args["range"] as UsageRange | undefined) ?? "30d";
        const empty = params.get("usage") === "empty";
        return (empty ? mockEmptyUsageHealth : mockUsageHealth)(range);
      }
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
          // 镜像真后端：删除成功联动清应用侧条目。
          delete metaSessions[s.summary.id];
          return { path: p, ok: true, error: null };
        });
      }
      case "get_meta":
        return metaSnapshot();
      case "set_session_meta": {
        const sessionId = args["sessionId"];
        const expectedRevision = args["expectedRevision"];
        if (typeof sessionId !== "string" || !sessionId.trim())
          throw err("INVALID_INPUT", "会话 id 不能为空");
        if (expectedRevision !== metaRevision)
          throw err("CONFLICT", "备注已被外部修改，请重新载入后重试");
        const input = args["meta"] as SessionMetaInput | null;
        const alias = input?.alias?.trim() || null;
        if (alias !== null && alias.length > 80) throw err("INVALID_INPUT", "别名最多 80 个字符");
        const tags: string[] = [];
        for (const raw of input?.tags ?? []) {
          const t = raw.trim();
          if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
          if (t.length > 24) throw err("INVALID_INPUT", `单个标签最多 24 个字符：${t}`);
          tags.push(t);
        }
        if (tags.length > 10) throw err("INVALID_INPUT", "标签最多 10 个");
        const note = input?.note?.trim() || null;
        if (note !== null && note.length > 2000) throw err("INVALID_INPUT", "备注最多 2000 个字符");
        if (alias === null && tags.length === 0 && note === null) {
          delete metaSessions[sessionId];
        } else {
          metaSessions[sessionId] = { alias, tags, note, updatedAt: new Date().toISOString() };
        }
        metaRevision += 1;
        return metaSnapshot();
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
      case "focus_iterm_tab": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (!s.summary.probeOk) throw err("PROBE_FAILED", "占用探测失败，不敢聚焦");
        if (!s.summary.inUse) throw err("INVALID_INPUT", "该会话当前未被占用，无需聚焦");
        if (s.summary.occupant?.app !== "iTerm2") throw err("ITERM_FAILED", "仅 iTerm 中的会话可聚焦");
        return null;
      }
      case "new_session_in_iterm": {
        const cwd = args["cwd"];
        if (typeof cwd !== "string" || !cwd.startsWith("/")) throw err("CWD_MISSING", "目录不存在或不是目录");
        const model = args["model"];
        if (model !== null && model !== undefined && String(model).trim() !== "") {
          const m = String(model).trim();
          // 与真后端同口径：≤256 字、无控制字符、不以 `-` 开头。
          // eslint-disable-next-line no-control-regex
          if (m.length > 256 || /[\u0000-\u001F\u007F]/.test(m)) throw err("INVALID_INPUT", "模型名不合法（≤256 字、无控制字符）");
          if (m.startsWith("-")) throw err("INVALID_INPUT", "模型名不能以 `-` 开头");
        }
        newSessionCalls.push(cwd);
        return null;
      }
      case "resume_command_for": {
        // 与真后端同口径：校验同 open_in_iterm，但不做占用探测（CONTRACT §25.2）。
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (!s.summary.cwdExists) throw err("CWD_MISSING", "项目目录不存在");
        const quote = (v: string): string => `'${v.replace(/'/g, `'\"'\"'`)}'`;
        return `cd ${quote(s.summary.cwd)} && omp --resume ${quote(s.summary.path)}`;
      }
      case "copy_text":
        // 系统剪贴板在 mock 下无从验证：只校验参数形状，视为成功。
        if (typeof args["text"] !== "string") throw err("INVALID_INPUT", "text 必须为字符串");
        return null;
      case "reveal_session_file": {
        // 只做与真后端相同的存在性校验（CONTRACT §25.4），不调 Finder。
        if (!find(args["path"] as string)) throw err("NOT_FOUND", "会话文件不存在");
        return null;
      }
      case "reveal_file": {
        // 口径同真后端 §4.72（绝对路径+无控制字符；存在性由真后端校验），不调 Finder。
        const path = args["path"];
        if (typeof path !== "string" || !path.startsWith("/")) throw err("INVALID_INPUT", "只能在 Finder 中显示绝对路径");
        if (/[\0-\x1F\x7F]/.test(path)) throw err("INVALID_INPUT", "路径含控制字符，拒绝在 Finder 中显示");
        return null;
      }
      case "open_project_dir": {
        // 校验口径同 new_session_in_iterm（CONTRACT §25.5），不调 Finder。
        const cwd = args["cwd"];
        if (typeof cwd !== "string" || !cwd.startsWith("/")) throw err("CWD_MISSING", "目录不存在或不是目录");
        return null;
      }
      case "choose_directory":
        return params.get("pick") === "cancel" ? null : "/Users/demo/my/omp-resume";
      case "get_session_recap": {
        // 仅第一个夹具会话有 recap，便于同时看到「有」与「无」两种详情。
        const sid = args["sessionId"];
        return sid === sessions[0]?.summary.id ? "本会话：修复了侧栏分组按钮的对齐，并补充了新会话入口的单测。下一步是验证 iTerm 冒烟。" : null;
      }
      case "search_prompt_history": {
        const q = (typeof args["query"] === "string" ? args["query"] : "").trim().toLowerCase();
        const first = sessions[0]?.summary;
        const entries: PromptHistoryEntry[] = [
          { id: 3, prompt: "给 Sidebar 加一个新会话按钮，点击后先选目录", cwd: first?.cwd ?? null, sessionId: first?.id ?? null, createdAt: "2026-10-16T01:00:00.000Z", useCount: 3, sessionTitle: "侧栏新会话入口" },
          { id: 2, prompt: "帮我看看 100% 的 CPU 占用", cwd: null, sessionId: "gone-session-id", createdAt: "2026-10-15T08:00:00.000Z", useCount: 1, sessionTitle: null },
          { id: 1, prompt: "fix README.md typo", cwd: "/Users/demo/my/other", sessionId: null, createdAt: "2026-10-14T03:00:00.000Z", useCount: 2, sessionTitle: null },
        ];
        return entries.filter((e) => q === "" || e.prompt.toLowerCase().includes(q) || (e.cwd ?? "").toLowerCase().includes(q) || (e.sessionTitle ?? "").toLowerCase().includes(q));
      }
      case "omp_version":
        return { version: "18.16.0", path: "/Users/demo/.local/bin/omp" };
      case "omp_update_check": {
        const mode = params.get("omp");
        const current = "18.16.0";
        if (mode === "managed") return {
          current: null,
          latest: null,
          upToDate: false,
          raw: "/opt/homebrew/bin/omp is installed and kept up to date by Homebrew; update it from Homebrew.\n",
        };
        const latest = mode === "new" ? "18.17.0" : null;
        return {
          current,
          latest,
          upToDate: latest === null,
          raw: `Current version: ${current}\n${latest ? `New version available: ${latest}` : "✔ Already up to date"}\n`,
        };
      }
      case "omp_update_run": {
        const changed = params.get("omp") === "new";
        const after = changed ? "18.17.0" : "18.16.0";
        const output = changed
          ? `Downloading ...\nInstalling update...\n✔ Updated to ${after}\nRestart omp to use the new version\n`
          : "版本未变化；请通过安装 omp 的包管理器更新。\n";
        streamedOutput(args, output);
        return { before: "18.16.0", after, changed, output };
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
        if (!plugins.some((entry) => entry.id === id)) plugins.push({ ...metadata, id, name, marketplace, version: availableVersions.get(marketplace) ?? "1.0.0", description: null, enabled: true });
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
      case "omp_plugin_check_update": {
        // 只读预检：判 availableVersions 与当前 version 差集，不改夹具。
        const id = args["id"];
        const targets = id == null ? plugins : plugins.filter((entry) => entry.id === id);
        if (id != null && targets.length === 0) throw err("OMP_FAILED", "插件不存在");
        const changes: PluginUpgradeChange[] = [];
        for (const plugin of targets) {
          const to = availableVersions.get(plugin.marketplace) ?? plugin.version;
          if (to && plugin.version !== to) changes.push({ id: plugin.id, scope: "user", from: plugin.version, to });
        }
        const upToDate = changes.length === 0;
        const output = upToDate
          ? "[dry-run] All marketplace plugins are up to date\n"
          : `[dry-run]\n${changes.map((change) => `  ${change.id} (user): ${change.from ?? "unknown"} -> ${change.to}`).join("\n")}\n`;
        return { upToDate, changes, output };
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
      case "list_models":
      case "list_agent_details":
      case "get_model_config":
      case "update_model_config":
      case "create_agent_definition":
        return model(cmd, args);
      case "list_model_presets":
      case "save_model_preset":
      case "switch_model_preset":
      case "delete_model_preset":
        return presets(cmd, args);
      case "get_model_specs":
      case "update_model_spec":
      case "create_model_spec":
        return specs(cmd, args);
      case "model_bench_run":
      case "model_bench_history":
      case "model_bench_delete":
      case "model_perf_list":
        return bench(cmd, args);
      case "memory_overview":
      case "memory_list":
      case "memory_detail":
      case "memory_graph":
      case "memory_bank_status":
      case "memory_backups":
      case "memory_delete_preview":
      case "memory_delete_items":
      case "memory_delete_bank":
      case "memory_restore":
      case "memory_delete_backup":
      case "memory_backup_all":
        return memory(cmd, args);
      case "get_tray_settings":
        return structuredClone(traySettings);
      case "set_tray_settings": {
        const patch = args["patch"];
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
          throw err("INVALID_INPUT", "patch 必须为对象");
        }
        const known = new Set(Object.keys(traySettings));
        for (const key of Object.keys(patch)) {
          if (!known.has(key)) throw err("INVALID_INPUT", `未知设置键：${key}`);
        }
        traySettings = structuredClone({ ...traySettings, ...patch });
        return structuredClone(traySettings);
      }
      case "get_tray_preview":
        return mockTrayPreview(sessions, traySettings);
      case "tray_focus_session": {
        const sessionId = args["sessionId"];
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw err("INVALID_INPUT", "sessionId 必须为非空字符串");
        }
        if (!sessions.some((s) => s.summary.id === sessionId && s.summary.inUse)) {
          throw err("IO", "找不到该会话的终端");
        }
        return undefined;
      }
      case "tray_resume_recent": {
        const sessionId = args["sessionId"];
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw err("INVALID_INPUT", "sessionId 必须为非空字符串");
        }
        if (!sessions.some((s) => s.summary.id === sessionId)) {
          throw err("IO", "找不到该会话的路径");
        }
        return undefined;
      }
      case "open_main_window":
        return undefined;
      case "quit_app":
        return undefined;
      case "get_build_info":
        return { os: "macos", arch: "aarch64" };
      case "get_app_paths":
        return {
          sessionsDir: "/Users/demo/.omp/agent/sessions",
          ownersDir: "/Users/demo/.omp/run/session-owners",
          historyDb: "/Users/demo/.omp/agent/history.db",
          memoryDir: "/Users/demo/.omp/agent/memories/mnemopi/banks",
          dataDir: "/Users/demo/Library/Application Support/omp-resume",
          ompBin: "/Users/demo/.local/bin/omp",
        };
      case "superagent_status":
        return structuredClone(superagent);
      case "superagent_set_enabled": {
        const enabled = args["enabled"];
        if (typeof enabled !== "boolean") throw err("INVALID_INPUT", "enabled 必须为布尔值");
        superagent = enabled
          ? { ...superagent, state: "running", enabled: true, pid: 4242, startedAt: "2026-11-02T10:00:00.000Z", lastError: null }
          : { ...superagent, state: "disabled", enabled: false, pid: null, startedAt: null };
        return structuredClone(superagent);
      }
      case "superagent_restart": {
        if (!superagent.enabled) throw err("INVALID_INPUT", "Superagent 未启用");
        superagent = { ...superagent, state: "running", restarts: superagent.restarts + 1 };
        return structuredClone(superagent);
      }
      case "superagent_request":
        throw err("SUPERAGENT_UNAVAILABLE", "mock：没有 Superagent 守护进程");
      case "superagent_log_tail": {
        const lines = args["lines"];
        if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 2000) {
          throw err("INVALID_INPUT", "lines 须为 1..=2000 的整数");
        }
        return ["mock log line"];
      }
      default:
        throw err("UNKNOWN", `未知命令：${cmd}`);
    }
  });

  return { itermCalls };
}
