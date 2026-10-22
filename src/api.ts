/**
 * 后端命令的类型化封装：每个命令一个函数，错误归一化为 `AppError`。
 * 命令名 snake_case，参数/返回值 JSON camelCase（见 docs/CONTRACT.md）。
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { CleanupCandidate } from "./types";
import type {
  AppendBranchMarkerRequest,
  AppendBranchMarkerResult,
  AppError,
  BenchRound,
  CheckSessionRequest,
  CheckSessionResult,
  Conversation,
  DeleteResult,
  DeleteSessionsRequest,
  ErrorCode,
  GetConfigResult,
  GetConversationRequest,
  GetTreeRequest,
  ListSessionsResult,
  McpDeleteServerRequest,
  McpGetServerRequest,
  McpListRequest,
  McpListResult,
  McpSaveResult,
  McpSaveServerRequest,
  McpServerRaw,
  McpSetEnabledRequest,
  ModelConfig,
  ModelInfo,
  ModelPerf,
  ModelSpecPatchRequest,
  ModelSpecUpdateResult,
  ModelSpecsResult,
  OpenInItermRequest,
  PromptHistoryEntry,
  OmpVersion,
  OmpUpdateCheck,
  OmpUpdateResult,
  OmpOpResult,
  PluginsListResult,
  DiscoverEntry,
  MetaSnapshot,
  PluginUpgradeResult,
  SessionMetaInput,
  SkillsListResult,
  TreeData,
  SessionUsage,
  MemoryBackup,
  MemoryBankStatus,
  MemoryDeletePreview,
  MemoryDeleteResult,
  MemoryDetail,
  MemoryGraph,
  MemoryListRequest,
  MemoryOverview,
  MemoryPage,
  MemoryRestoreResult,
  UsageHealth,
  UsageRange,
  UsageStats,
  UpdateModelConfigResult,
} from "./types";

const KNOWN_CODES: Record<string, true> = {
  IN_USE: true,
  PROBE_FAILED: true,
  CWD_MISSING: true,
  NOT_FOUND: true,
  OUTSIDE_ROOT: true,
  UNSUPPORTED_FORMAT: true,
  INVALID_NODE: true,
  IO: true,
  ITERM_FAILED: true,
  OMP_NOT_FOUND: true,
  OMP_FAILED: true,
  BUSY: true,
  TIMEOUT: true,
  INVALID_INPUT: true,
  CONFLICT: true,
  META_CORRUPT: true,
  INVALID_KEY: true,
  UNKNOWN: true,
};

/** 把 `invoke` 抛出的任意值归一化为 `AppError`。 */
export function normalizeError(e: unknown): AppError {
  if (e !== null && typeof e === "object" && "code" in e && "message" in e) {
    const code = e.code;
    const message = e.message;
    if (typeof code === "string" && typeof message === "string") {
      return {
        code: KNOWN_CODES[code] ? (code as ErrorCode) : "UNKNOWN",
        message,
      };
    }
  }
  if (typeof e === "string") return { code: "UNKNOWN", message: e };
  if (e instanceof Error) return { code: "UNKNOWN", message: e.message };
  try {
    return { code: "UNKNOWN", message: JSON.stringify(e) };
  } catch {
    return { code: "UNKNOWN", message: "未知错误" };
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw normalizeError(e);
  }
}

export function getConfig(): Promise<GetConfigResult> {
  return call("get_config");
}

export function listSessions(): Promise<ListSessionsResult> {
  return call("list_sessions");
}

export function getConversation(
  req: GetConversationRequest,
): Promise<Conversation> {
  return call("get_conversation", { path: req.path, nodeId: req.nodeId ?? null });
}

export function getTree(req: GetTreeRequest): Promise<TreeData> {
  return call("get_tree", { path: req.path });
}

export function checkSession(req: CheckSessionRequest): Promise<CheckSessionResult> {
  return call("check_session", { path: req.path });
}

export function deleteSessions(
  req: DeleteSessionsRequest,
): Promise<DeleteResult[]> {
  return call("delete_sessions", { paths: req.paths });
}

/** 只读清理候选（CONTRACT §14）；不删除任何文件。 */
export function listCleanupCandidates(
  olderThanDays: number,
  topN: number,
): Promise<CleanupCandidate[]> {
  return call("list_cleanup_candidates", { olderThanDays, topN });
}

export function appendBranchMarker(
  req: AppendBranchMarkerRequest,
): Promise<AppendBranchMarkerResult> {
  return call("append_branch_marker", { path: req.path, nodeId: req.nodeId });
}

export function openInIterm(req: OpenInItermRequest): Promise<void> {
  return call("open_in_iterm", { path: req.path });
}

/** 在 iTerm 新开 omp 会话（仅 `cd '<cwd>' && omp`，不带 prompt 或任何参数）。 */
export function newSessionInIterm(cwd: string): Promise<void> {
  return call("new_session_in_iterm", { cwd });
}

/** 原生选择项目目录；用户取消返回 null。 */
export function chooseDirectory(): Promise<string | null> {
  return call("choose_directory");
}

/** 会话最新 recap（CONTRACT §13.1）；无 recap 为 null。 */
export function getSessionRecap(sessionId: string): Promise<string | null> {
  return call("get_session_recap", { sessionId });
}

/** 提示词历史搜索（CONTRACT §13.2）；query 为空则返回全部（按时间倒序）。 */
export function searchPromptHistory(query?: string): Promise<PromptHistoryEntry[]> {
  return call("search_prompt_history", { query: query ?? null });
}

export function getOmpVersion(): Promise<OmpVersion> {
  return call("omp_version");
}

export function checkOmpUpdate(): Promise<OmpUpdateCheck> {
  return call("omp_update_check");
}

function streamedCall<T>(cmd: string, onLine: (line: string) => void, args: Record<string, unknown> = {}): Promise<T> {
  const channel = new Channel<string>();
  channel.onmessage = onLine;
  return call(cmd, { ...args, onLine: channel });
}

export function runOmpUpdate(onLine: (line: string) => void): Promise<OmpUpdateResult> {
  return streamedCall("omp_update_run", onLine);
}

export function listOmpPlugins(): Promise<PluginsListResult> {
  return call("omp_plugins_list");
}

export function discoverOmpPlugins(marketplace: string): Promise<DiscoverEntry[]> {
  return call("omp_plugin_discover", { marketplace });
}

export function installOmpPlugin(id: string, onLine: (line: string) => void): Promise<OmpOpResult> {
  return streamedCall("omp_plugin_install", onLine, { id });
}

export function uninstallOmpPlugin(id: string, onLine: (line: string) => void): Promise<OmpOpResult> {
  return streamedCall("omp_plugin_uninstall", onLine, { id });
}

export function setOmpPluginEnabled(id: string, enabled: boolean, onLine: (line: string) => void): Promise<OmpOpResult> {
  return streamedCall("omp_plugin_set_enabled", onLine, { id, enabled });
}

export function upgradeOmpPlugins(id: string | null, onLine: (line: string) => void): Promise<PluginUpgradeResult> {
  return streamedCall("omp_plugin_upgrade", onLine, { id });
}

export function updateOmpMarketplaces(name: string | null, onLine: (line: string) => void): Promise<OmpOpResult> {
  return streamedCall("omp_marketplace_update", onLine, { name });
}

export function addOmpMarketplace(source: string, onLine: (line: string) => void): Promise<OmpOpResult> {
  return streamedCall("omp_marketplace_add", onLine, { source });
}

export function removeOmpMarketplace(name: string, onLine: (line: string) => void): Promise<OmpOpResult> {
  return streamedCall("omp_marketplace_remove", onLine, { name });
}

export function listOmpSkills(): Promise<SkillsListResult> {
  return call("omp_skills_list");
}

export function updateOmpSkills(onLine: (line: string) => void): Promise<OmpOpResult> {
  return streamedCall("omp_skills_update", onLine);
}

export function listMcp(req: McpListRequest = {}): Promise<McpListResult> {
  return call("mcp_list", { project: req.project ?? null });
}

export function getMcpServer(req: McpGetServerRequest): Promise<McpServerRaw> {
  return call("mcp_get_server", {
    scope: req.scope,
    project: req.project ?? null,
    name: req.name,
  });
}

export function saveMcpServer(req: McpSaveServerRequest): Promise<McpSaveResult> {
  return call("mcp_save_server", {
    scope: req.scope,
    project: req.project ?? null,
    name: req.name,
    config: req.config,
    expectedRevision: req.expectedRevision,
    originalName: req.originalName ?? null,
  });
}

export function setMcpEnabled(req: McpSetEnabledRequest): Promise<McpSaveResult> {
  return call("mcp_set_enabled", {
    scope: req.scope,
    project: req.project ?? null,
    name: req.name,
    enabled: req.enabled,
    expectedRevision: req.expectedRevision,
  });
}

export function deleteMcpServer(req: McpDeleteServerRequest): Promise<McpSaveResult> {
  return call("mcp_delete_server", {
    scope: req.scope,
    project: req.project ?? null,
    name: req.name,
    expectedRevision: req.expectedRevision,
  });
}

export function getSessionUsage(req: { path: string }): Promise<SessionUsage> {
  return call("get_session_usage", { path: req.path });
}

export function getUsageStats(req: { range: UsageRange }): Promise<UsageStats> {
  return call("get_usage_stats", { range: req.range });
}

export function getUsageHealth(req: { range: UsageRange }): Promise<UsageHealth> {
  return call("get_usage_health", { range: req.range });
}

export function getMeta(): Promise<MetaSnapshot> {
  return call("get_meta");
}

export function setSessionMeta(
  sessionId: string,
  meta: SessionMetaInput | null,
  expectedRevision: number,
): Promise<MetaSnapshot> {
  return call("set_session_meta", { sessionId, meta, expectedRevision });
}

export function listModels(): Promise<ModelInfo[]> {
  return call("list_models");
}

export function getModelConfig(): Promise<ModelConfig> {
  return call("get_model_config");
}

/** 白名单 key 的读-比-写；`expected` 为前端读到的原值，冲突时后端报 `CONFLICT`。 */
export function updateModelConfig(req: {
  key: string;
  value: unknown;
  expected: unknown;
}): Promise<UpdateModelConfigResult> {
  return call("update_model_config", {
    key: req.key,
    value: req.value,
    expected: req.expected,
  });
}

/** 记忆库总览（CONTRACT §18）；available:false 为正常状态（无本地库）。 */
export function memoryOverview(): Promise<MemoryOverview> {
  return call("memory_overview");
}

/** 记忆库分页列表；limit 默认 50、上限 200。 */
export function memoryList(req: MemoryListRequest): Promise<MemoryPage> {
  return call("memory_list", {
    bank: req.bank,
    query: req.query ?? null,
    kind: req.kind ?? "all",
    onlyNeverRecalled: req.onlyNeverRecalled ?? false,
    onlyUnconsolidated: req.onlyUnconsolidated ?? false,
    onlyMissingSource: req.onlyMissingSource ?? false,
    sort: req.sort ?? "newest",
    limit: req.limit ?? 50,
    offset: req.offset ?? 0,
  });
}

/** 单条记忆详情（含全文与 facts）。 */
export function memoryDetail(req: { bank: string; id: string }): Promise<MemoryDetail> {
  return call("memory_detail", { bank: req.bank, id: req.id });
}

/** 引用关系图（CONTRACT §18.10）；空库返回空图而非报错。 */
export function memoryGraph(req: { bank: string }): Promise<MemoryGraph> {
  return call("memory_graph", { bank: req.bank });
}

/** 库占用状态与该库备份（只读，无门禁；lsof 失败时 probeFailed=true）。 */
export function memoryBankStatus(req: { bank: string }): Promise<MemoryBankStatus> {
  return call("memory_bank_status", { bank: req.bank });
}

/** 备份列表（newest first）；bank 为 null 时返回全部。 */
export function memoryBackups(req: { bank?: string | null } = {}): Promise<MemoryBackup[]> {
  return call("memory_backups", { bank: req.bank ?? null });
}

/** 删除预览（纯只读）；ids 去重后不能为空且不超过 500。 */
export function memoryDeletePreview(req: { bank: string; ids: string[] }): Promise<MemoryDeletePreview> {
  return call("memory_delete_preview", { bank: req.bank, ids: req.ids });
}

/** 删除所选记忆（先自动备份整库）；返回已删 id 与跳过项。 */
export function memoryDeleteItems(req: { bank: string; ids: string[] }): Promise<MemoryDeleteResult> {
  return call("memory_delete_items", { bank: req.bank, ids: req.ids });
}

/** 移除整库（目录移入备份区，可恢复）；返回 bank-removed 备份。 */
export function memoryDeleteBank(req: { bank: string }): Promise<MemoryBackup> {
  return call("memory_delete_bank", { bank: req.bank });
}

/** 从备份恢复；目标库存在时先自动创建恢复前安全备份。 */
export function memoryRestore(req: { backupId: string }): Promise<MemoryRestoreResult> {
  return call("memory_restore", { backupId: req.backupId });
}

/** 永久删除一份备份（不可撤销）。 */
export function memoryDeleteBackup(req: { backupId: string }): Promise<null> {
  return call("memory_delete_backup", { backupId: req.backupId });
}

/** 跑一轮 bench（CONTRACT §20.1）：短探针 + 长探针合成，返回即已记入历史。 */
export function modelBenchRun(selector: string): Promise<BenchRound> {
  return call("model_bench_run", { selector });
}

/** 最近 30 天的 bench 历史（早→晚排序）。 */
export function modelBenchHistory(): Promise<BenchRound[]> {
  return call("model_bench_history");
}

/** omp 自家记录的日常实测；读不到时为空数组（前端隐藏该列）。 */
export function modelPerfList(): Promise<ModelPerf[]> {
  return call("model_perf_list");
}

/** 模型规格快照（CONTRACT §21）：models.yml 非凭据字段；无文件时 available=false。 */
export function getModelSpecs(): Promise<ModelSpecsResult> {
  return call("get_model_specs");
}

/** 写一个模型的规格（读-比-写）；成功返回新 revision 与备份路径。 */
export function updateModelSpec(req: ModelSpecPatchRequest): Promise<ModelSpecUpdateResult> {
  return call("update_model_spec", {
    provider: req.provider,
    id: req.id,
    patch: req.patch,
    expectedRevision: req.expectedRevision,
  });
}
