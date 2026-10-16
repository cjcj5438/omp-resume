/**
 * 前端类型镜像：必须与 `src-tauri/src/model.rs` 逐字段对应。
 * 命名：JSON 侧一律 camelCase；语义规则见 `docs/CONTRACT.md`。
 */

export type ErrorCode =
  | "IN_USE"
  | "PROBE_FAILED"
  | "CWD_MISSING"
  | "NOT_FOUND"
  | "OUTSIDE_ROOT"
  | "UNSUPPORTED_FORMAT"
  | "INVALID_NODE"
  | "IO"
  | "ITERM_FAILED"
  | "OMP_NOT_FOUND"
  | "OMP_FAILED"
  | "BUSY"
  | "TIMEOUT"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "META_CORRUPT"
  | "INVALID_KEY"
  | "UNKNOWN";

export interface AppError {
  code: ErrorCode;
  message: string;
}

export interface GetConfigResult {
  sessionsDir: string;
  ownersDir: string;
}

export interface ListSessionsResult {
  sessionsDir: string;
  hiddenEmpty: number;
  groups: ProjectGroup[];
}

export interface ProjectGroup {
  cwd: string;
  dirName: string;
  sessions: SessionSummary[];
}

export interface ForkInfo {
  parentRaw: string;
  parentTitle: string | null;
  parentPath: string | null;
}

export interface Occupant {
  pid: number;
  app: string | null;
  appVersion: string | null;
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  cwdExists: boolean;
  title: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
  messageCount: number;
  branchCount: number;
  inUse: boolean;
  probeOk: boolean;
  occupant: Occupant | null;
  fork: ForkInfo | null;
  formatSupported: boolean;
  version: number | null;
  badLines: number;
  firstUserMessage: string | null;
}

export interface GetConversationRequest {
  path: string;
  nodeId?: string | null;
}

export interface Conversation {
  path: string;
  leafId: string | null;
  targetId: string;
  items: ConversationItem[];
}

export type ConversationItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; blocks: AssistantBlock[] }
  | {
      kind: "toolResult";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "bashExecution";
      command: string;
      text: string;
      truncated: boolean;
      exitCode: number | null;
      cancelled: boolean;
    }
  | { kind: "compaction"; summary: string }
  | { kind: "branchSummary"; summary: string }
  | { kind: "other"; role: string; text: string };

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; id: string; name: string; args: unknown };

export interface GetTreeRequest {
  path: string;
}

export interface TreeData {
  path: string;
  leafId: string | null;
  rootIds: string[];
  activePathIds: string[];
  nodes: TreeNode[];
}

export type TreeNodeKind = "message" | "compaction" | "branchSummary";

export interface TreeNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  kind: TreeNodeKind;
  role: string | null;
  timestamp: string;
  preview: string;
  label: string | null;
  isCompaction: boolean;
  isBranchSummary: boolean;
}

export interface CheckSessionRequest {
  path: string;
}

export interface CheckSessionResult {
  inUse: boolean;
  probeOk: boolean;
}

export interface DeleteSessionsRequest {
  paths: string[];
}

export interface DeleteResult {
  path: string;
  ok: boolean;
  error: AppError | null;
}

/** 清理候选原因（可叠加）；与 model.rs `CleanupReason` 对应。 */
export type CleanupReason = "empty" | "cwd_missing" | "large" | "stale";

/** 清理候选（CONTRACT §14）：只读列出，删除仍走 delete_sessions。 */
export interface CleanupCandidate {
  path: string;
  id: string;
  title: string;
  cwd: string;
  /** 文件 mtime（ISO-8601）。 */
  mtime: string;
  /** 删除时将释放的总字节（jsonl + 附属目录 + .bak）。 */
  bytes: number;
  reasons: CleanupReason[];
  inUse: boolean;
  probeOk: boolean;
}

export interface AppendBranchMarkerRequest {
  path: string;
  nodeId: string;
}

export interface AppendBranchMarkerResult {
  /** 新标记条目 id；nodeId 已是 leaf 时为 null（无操作）。 */
  markerId: string | null;
}

export interface OpenInItermRequest {
  path: string;
}

/** 提示词历史条目（CONTRACT §13.2）。cwd / sessionId 缺失或为空时为 null。 */
export interface PromptHistoryEntry {
  id: number;
  prompt: string;
  cwd: string | null;
  sessionId: string | null;
  /** ISO-8601 UTC 毫秒。 */
  createdAt: string;
  useCount: number;
}

export interface OmpVersion {
  version: string | null;
  path: string | null;
}

export interface OmpUpdateCheck {
  current: string | null;
  latest: string | null;
  upToDate: boolean;
  raw: string;
}

export interface OmpUpdateResult {
  before: string | null;
  after: string | null;
  changed: boolean;
  output: string;
}

// MCP 原生配置（CONTRACT §4.30–§4.35）。
export type McpScope = "user" | "project";
export type McpTransport = "stdio" | "http" | "sse" | "unknown";
export type McpShadowedBy = "project" | "disabledServers" | "disabled";

export interface McpFileInfo {
  scope: McpScope;
  path: string;
  exists: boolean;
  readError: string | null;
  /** 不存在："absent"；bytes 不可读："unreadable"（禁止变更）；否则原始 bytes 的 hex SHA-256，解析失败仍用真实 hash。 */
  revision: string;
  disabledServers: string[];
  enabledServers: string[];
}

export interface McpServer {
  scope: McpScope;
  name: string;
  transport: McpTransport;
  command: string | null;
  argCount: number;
  url: string | null;
  enabled: boolean;
  effective: boolean;
  shadowedBy: McpShadowedBy | null;
  envKeys: string[];
  headerKeys: string[];
  hasAuth: boolean;
}

export interface McpListResult {
  files: McpFileInfo[];
  servers: McpServer[];
}

export interface McpListRequest {
  project?: string | null;
}

export interface McpGetServerRequest {
  scope: McpScope;
  project?: string | null;
  name: string;
}

/** 编辑框专用：config 包含真实 secret，不可写入日志。 */
export interface McpServerRaw {
  config: unknown;
  revision: string;
}

export interface McpSaveServerRequest {
  scope: McpScope;
  project?: string | null;
  name: string;
  config: unknown;
  expectedRevision: string;
  originalName?: string | null;
}

export interface McpSaveResult {
  revision: string;
}

export interface McpSetEnabledRequest {
  scope: McpScope;
  project?: string | null;
  name: string;
  enabled: boolean;
  expectedRevision: string;
}

export interface McpDeleteServerRequest {
  scope: McpScope;
  project?: string | null;
  name: string;
  expectedRevision: string;
}

export interface OmpOpResult {
  output: string;
}

export interface PluginSummary {
  id: string;
  name: string;
  marketplace: string;
  version: string | null;
  enabled: boolean;
  installedAt: string | null;
  lastUpdated: string | null;
  installPath: string | null;
}

export interface NpmPluginSummary {
  name: string;
  version: string | null;
}

export interface MarketplaceSummary {
  name: string;
  source: string;
}

export interface PluginsListResult {
  plugins: PluginSummary[];
  npm: NpmPluginSummary[];
  marketplaces: MarketplaceSummary[];
  warnings: string[];
}

export interface DiscoverEntry {
  name: string;
  version: string;
  description: string;
}

export interface PluginUpgradeChange {
  id: string;
  scope: string;
  from: string | null;
  to: string;
}

export interface PluginUpgradeResult {
  output: string;
  changes: PluginUpgradeChange[];
}

export interface SkillSummary {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  hide: boolean;
}

export interface SkillsListResult {
  skills: SkillSummary[];
  warnings: string[];
}

/** 只读用量统计；USD，沿 fork 链归属，详见 CONTRACT。 */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageCost {
  total: number;
  main: number;
  background: number;
  subagent: number;
}

export interface UsageModel {
  provider: string;
  model: string;
  messages: number;
  cost: number;
  tokens: UsageTokens;
}

export interface SessionUsage {
  messages: { user: number; assistant: number };
  tokens: UsageTokens;
  cost: UsageCost;
  models: UsageModel[];
}

export interface UsageStats {
  total: SessionUsage;
  byProject: { cwd: string; cost: number; tokens: UsageTokens; sessions: number }[];
  byModel: UsageModel[];
  byDay: { date: string; cost: number; tokens: UsageTokens }[];
}
// 会话别名 / 标签 / 备注（应用侧 meta.json，以会话 id 为键）。
export interface SessionMeta {
  alias: string | null;
  tags: string[];
  note: string | null;
  updatedAt: string;
}

export interface MetaSnapshot {
  revision: number;
  sessions: Record<string, SessionMeta>;
}

export interface SessionMetaInput {
  alias?: string | null;
  tags: string[];
  note?: string | null;
}

// 模型与 Agent 配置（CONTRACT §4.36–§4.38）。

/** `list_models` 单行：精简模型信息，不含凭据字段。 */
export interface ModelInfo {
  selector: string;
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
  contextWindow: number | null;
  reasoning: boolean;
  costInput: number | null;
  costOutput: number | null;
}

export type AgentSource = "builtin" | "user";

/** agent 内置默认值（只读展示）；source 为 user 时是用户自建 agent。 */
export interface AgentDefinition {
  name: string;
  description: string;
  source: AgentSource;
  defaultModel: string[];
  defaultThinkingLevel: string | null;
}

/** 白名单 config key 的原始值；条目值保持 unknown，未识别的键/值原样保留。 */
export interface ModelConfig {
  roles: Record<string, unknown>;
  agentOverrides: Record<string, unknown>;
  disabledAgents: unknown[];
  agentAdvisor: Record<string, unknown>;
  fallbackChains: Record<string, unknown>;
  agents: AgentDefinition[];
}

/** `update_model_config` 返回：写后复读的新值。 */
export interface UpdateModelConfigResult {
  key: string;
  value: unknown;
}
