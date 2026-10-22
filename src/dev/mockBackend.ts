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
import type { AgentDefinition, AppError, BenchRound, CleanupCandidate, CleanupReason, MarketplaceSummary, MetaSnapshot, ModelConfig, ModelInfo, ModelPerf, ModelSpec, ModelSpecPatch, ModelSpecsResult, ModelSpecUpdateResult, OmpOpResult, PluginSummary, PluginUpgradeChange, SessionMeta, SessionMetaInput, SkillSummary } from "../types";
import type { McpFileInfo, McpListResult, McpScope, McpServer, McpTransport } from "../types";
import type { PromptHistoryEntry, UsageRange } from "../types";
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
      user = hash(document).then((revision) => ({ scope: "user", path: `${home}/.omp/agent/mcp.json`, document, revision }));
    }
    return user;
  }

  function projectFile(project: string): Promise<McpMockFile> {
    let file = projects.get(project);
    if (!file) {
      const document = project === "/Users/demo/my/omp-resume"
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
  return (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_model_specs") return snapshot();
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
      // eslint-disable-next-line no-control-regex
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
      const seen = new Set(patch.input);
      if (seen.size !== patch.input.length) throw err("INVALID_INPUT", "输入类型不能重复");
      for (const item of patch.input) {
        if (item !== "text" && item !== "image") throw err("INVALID_INPUT", `不支持的输入类型：${item}`);
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
    const round = roundAt(selector, new Date().toISOString(), history.length * 7 + 1, selector === FAILING, true);
    history = [...history, round];
    return structuredClone(round);
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

  // 应用侧备注（内存态，镜像真后端的 revision 冲突与校验语义）。
  let metaRevision = 0;
  let metaSessions: Record<string, SessionMeta> = {};
  const metaSnapshot = (): MetaSnapshot =>
    structuredClone({ revision: metaRevision, sessions: metaSessions });

  (window as unknown as { __ompMock?: unknown }).__ompMock = {
    calls: itermCalls,
    newSessionCalls,
    get sessions() {
      return sessions;
    },
    get meta() {
      return metaSnapshot();
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
      case "mcp_list":
      case "mcp_get_server":
      case "mcp_save_server":
      case "mcp_set_enabled":
      case "mcp_delete_server":
        return mcp(cmd, args);
      case "get_config":
        return {
          sessionsDir: "/Users/demo/.omp/agent/sessions",
          ownersDir: "/Users/demo/.omp/run/session-owners",
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
      case "new_session_in_iterm": {
        const cwd = args["cwd"];
        if (typeof cwd !== "string" || !cwd.startsWith("/")) throw err("CWD_MISSING", "目录不存在或不是目录");
        newSessionCalls.push(cwd);
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
          { id: 3, prompt: "给 Sidebar 加一个新会话按钮，点击后先选目录", cwd: first?.cwd ?? null, sessionId: first?.id ?? null, createdAt: "2026-10-16T01:00:00.000Z", useCount: 3 },
          { id: 2, prompt: "帮我看看 100% 的 CPU 占用", cwd: null, sessionId: "gone-session-id", createdAt: "2026-10-15T08:00:00.000Z", useCount: 1 },
          { id: 1, prompt: "fix README.md typo", cwd: "/Users/demo/my/other", sessionId: null, createdAt: "2026-10-14T03:00:00.000Z", useCount: 2 },
        ];
        return entries.filter((e) => q === "" || e.prompt.toLowerCase().includes(q));
      }
      case "omp_version":
        return { version: "18.11.1", path: "/Users/demo/.local/bin/omp" };
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
      case "list_models":
      case "get_model_config":
      case "update_model_config":
        return model(cmd, args);
      case "get_model_specs":
      case "update_model_spec":
        return specs(cmd, args);
      case "model_bench_run":
      case "model_bench_history":
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
        return memory(cmd, args);
      default:
        throw err("UNKNOWN", `未知命令：${cmd}`);
    }
  });

  return { itermCalls };
}
