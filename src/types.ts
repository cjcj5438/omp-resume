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
  tps?: number | null;
  ttftMs?: number | null;
}

export interface SessionUsage {
  messages: { user: number; assistant: number };
  tokens: UsageTokens;
  cost: UsageCost;
  models: UsageModel[];
}

/** 用量统计范围：今天（自然日）/ 近 24 小时 / 近 7 天 / 近 30 天 / 全部。 */
export type UsageRange = "today" | "24h" | "7d" | "30d" | "all";

export type UsageTrendUnit = "hour" | "day";

export interface UsageTrendPoint {
  /** hour 桶为本地时区 "YYYY-MM-DD HH"，day 桶为 "YYYY-MM-DD"。 */
  key: string;
  cost: number;
  tokens: UsageTokens;
}

export interface UsageTrend {
  unit: UsageTrendUnit;
  points: UsageTrendPoint[];
}

export interface UsageTiming {
  waitMs: number;
  genMs: number;
  toolMs: number;
  toolCalls: number;
  calls: number;
  tps: number | null;
}

export interface UsageSession {
  id: string;
  path: string;
  cwd: string;
  cost: number;
  tokens: number;
  calls: number;
  lastMs: number;
}

export interface UsageStats {
  total: SessionUsage;
  byProject: { cwd: string; cost: number; tokens: UsageTokens; sessions: number }[];
  byModel: UsageModel[];
  trend: UsageTrend;
  sessions: number;
  timing: UsageTiming;
  topSessions: UsageSession[];
  activity: UsageTrendPoint[];
}

/** 运行看板错误类型。 */
export type ErrorKind = "quota" | "rate_limit" | "auth" | "timeout" | "network" | "server" | "other";

export interface UsageHealthError {
  time: number;
  provider: string;
  model: string;
  kind: ErrorKind;
  message: string;
}

export interface UsageHealthFallback {
  time: number;
  from: { provider: string; model: string } | null;
  to: { provider: string; model: string };
}

export interface UsageHealthTimelinePoint {
  key: string;
  requests: number;
  errors: number;
  fallbacks: number;
  cacheRead: number;
  promptTokens: number;
}

export interface UsageHealth {
  requests: number;
  errors: {
    /** 不含 aborted；aborted 为用户中断，另计。 */
    total: number;
    aborted: number;
    byKind: { kind: ErrorKind; count: number }[];
    /** ≤20 条，新→旧。 */
    recent: UsageHealthError[];
  };
  fallbacks: {
    total: number;
    byTarget: { provider: string; model: string; count: number }[];
    recent: UsageHealthFallback[];
  };
  cache: {
    /** 0..1；null = 上游不报缓存或无数据。 */
    hitRate: number | null;
    read: number;
    write: number;
    input: number;
    byModel: { provider: string; model: string; requests: number; hitRate: number | null }[];
  };
  timeline: { unit: UsageTrendUnit; points: UsageHealthTimelinePoint[] };
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
  maxTokens: number | null;
  reasoning: boolean;
  input: string[];
  costInput: number | null;
  costOutput: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
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

/** 全局兜底状态（只读）；读不到或形状异常时对应字段为 null（显示「未知」）。 */
export interface RetryStatus {
  modelFallback: boolean | null;
  fallbackOn: string | null;
  fallbackRevertPolicy: string | null;
}

/** 白名单 config key 的原始值；条目值保持 unknown，未识别的键/值原样保留。 */
export interface ModelConfig {
  roles: Record<string, unknown>;
  agentOverrides: Record<string, unknown>;
  disabledAgents: unknown[];
  agentAdvisor: Record<string, unknown>;
  fallbackChains: Record<string, unknown>;
  agents: AgentDefinition[];
  retryStatus: RetryStatus;
}

/** `update_model_config` 返回：写后复读的新值。 */
export interface UpdateModelConfigResult {
  key: string;
  value: unknown;
}

// 模型规格编辑（CONTRACT §21）：models.yml 非凭据字段的读-改-写。

/** 单个模型的规格快照：只含非凭据字段；`selector` 为 `provider/id`。 */
export interface ModelSpec {
  provider: string;
  id: string;
  selector: string;
  name: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
  input: string[] | null;
  costInput: number | null;
  costOutput: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  costTiered: boolean;
}

/** `get_model_specs` 返回（`available=false` 为正常空状态）。 */
export interface ModelSpecsResult {
  path: string;
  available: boolean;
  revision: string;
  specs: ModelSpec[];
  error: string | null;
}

/** 费用整体替换：四个数字必须齐全。 */
export interface ModelCostPatch {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 规格补丁：缺席字段不触碰。 */
export interface ModelSpecPatch {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCostPatch;
}

/** `update_model_spec` 请求：`expectedRevision` 为文件字节 SHA256。 */
export interface ModelSpecPatchRequest {
  provider: string;
  id: string;
  patch: ModelSpecPatch;
  expectedRevision: string;
}

/** `update_model_spec` 返回：新 revision + 写后规格 + 备份路径。 */
export interface ModelSpecUpdateResult {
  revision: string;
  spec: ModelSpec;
  backupPath: string;
}
// 记忆库（CONTRACT §18）：本地 Mnemopi 记忆库浏览与维护。

export interface MemoryTotals {
  banks: number;
  working: number;
  episodic: number;
  facts: number;
  bytes: number;
  neverRecalled: number;
  unconsolidated: number;
  missingSourceSessions: number;
  sourceSessions: number;
}

export interface MemoryBankSummary {
  bank: string;
  displayName: string;
  cwd: string | null;
  cwdExists: boolean | null;
  working: number;
  episodic: number;
  facts: number;
  bytes: number;
  firstMemoryAt: string | null;
  lastMemoryAt: string | null;
  neverRecalled: number;
  unconsolidated: number;
  sourceSessions: number;
  missingSourceSessions: number;
  readable: boolean;
  error: string | null;
}

export interface MemoryOverview {
  available: boolean;
  backend: string | null;
  root: string;
  banks: MemoryBankSummary[];
  totals: MemoryTotals;
}

export type MemoryKind = "working" | "episodic";
export type MemoryKindFilter = "all" | MemoryKind;
export type MemorySort = "newest" | "oldest" | "mostRecalled";

export interface MemoryListRequest {
  bank: string;
  query?: string | null;
  kind?: MemoryKindFilter;
  onlyNeverRecalled?: boolean;
  onlyUnconsolidated?: boolean;
  onlyMissingSource?: boolean;
  sort?: MemorySort;
  limit?: number;
  offset?: number;
}

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  snippet: string;
  contentChars: number;
  createdAt: string | null;
  sourceSessionId: string | null;
  sourceSessionExists: boolean | null;
  recallCount: number;
  lastRecalledAt: string | null;
  importance: number | null;
  veracity: string | null;
  memoryType: string | null;
  consolidated: boolean;
  superseded: boolean;
}

export interface MemoryPage {
  total: number;
  items: MemoryItem[];
}

export interface MemoryFact {
  subject: string | null;
  predicate: string | null;
  object: string | null;
  key: string | null;
}

export interface MemoryDetail extends MemoryItem {
  content: string;
  truncated: boolean;
  embedText: string | null;
  metadata: Record<string, unknown> | null;
  facts: MemoryFact[];
  summaryOf: string[];
  relatedEdges: number;
}

// 引用关系图（CONTRACT §18.10）：选中 bank 内记忆的引用边。

/** 边种类：摘要（情节→原记忆）/ 关联（图谱边）/ 上下文（ctx 边）。 */
export type MemoryGraphEdgeKind = "summary" | "related" | "context";

export interface MemoryGraphNode {
  id: string;
  kind: MemoryKind;
  snippet: string;
  createdAt: string | null;
  recallCount: number;
  importance: number | null;
  /** 关联边数；节点越大表示关联越多（图例注明）。 */
  degree: number;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  kind: MemoryGraphEdgeKind;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  truncated: boolean;
  totalNodes: number;
  totalEdges: number;
  unlinkedCount: number;
}

// 记忆库写操作（CONTRACT §18.8）：备份/删除/恢复，JSON camelCase。

export type MemoryBackupKind = "before-delete" | "before-restore" | "bank-removed";

export interface MemoryBackupHolder {
  pid: number;
  command: string;
}

export interface MemoryBackup {
  id: string;
  bank: string;
  kind: MemoryBackupKind;
  createdAt: string;
  bytes: number;
  working: number | null;
  episodic: number | null;
  cwd: string | null;
}

export interface MemoryBankStatus {
  bank: string;
  inUse: boolean;
  probeFailed: boolean;
  holders: MemoryBackupHolder[];
  backups: MemoryBackup[];
}

export type MemorySkippedReason = "not_found" | "unsupported";

export interface MemoryDeleteSkipped {
  id: string;
  reason: MemorySkippedReason;
}

export interface MemoryDeletePreview {
  requested: number;
  deletable: { working: number; episodic: number };
  unsupported: number;
  notFound: number;
  cascade: { facts: number; embeddings: number; annotations: number; edges: number; other: number };
  citedBySummaries: number;
}

export interface MemoryDeleteResult {
  deleted: string[];
  skipped: MemoryDeleteSkipped[];
  backup: MemoryBackup;
}

export interface MemoryRestoreResult {
  bank: string;
  restoredFrom: MemoryBackup;
  safetyBackup: MemoryBackup | null;
}

// 模型测试器（CONTRACT §20）：omp bench 测速结果 + omp 日常实测记录。

/** 一轮 bench：短探针（5 次）+ 长探针（3 次）合成，正常 total=8。 */
export interface BenchRound {
  at: string;
  selector: string;
  total: number;
  ok: number;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  tpsP50: number | null;
  tpsCv: number | null;
  cost: number;
  errors: string[];
}

/** omp 自家记录的日常实测（agent.db model_perf 表聚合）。 */
export interface ModelPerf {
  selector: string;
  samples: number;
  ttftMs: number | null;
  tps: number | null;
  updatedAt: string;
}
