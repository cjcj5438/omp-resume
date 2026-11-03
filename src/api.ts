/**
 * 后端命令的类型化封装：每个命令一个函数，错误归一化为 `AppError`。
 * 命令名 snake_case，参数/返回值 JSON camelCase（见 docs/CONTRACT.md）。
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AppPaths, BuildInfo, CleanupCandidate, TrayPreview, TraySettings, TraySettingsPatch } from "./types";
import type {
  AgentDetail,
  AgentStage,
  AppendBranchMarkerRequest,
  AppendBranchMarkerResult,
  AppError,
  BenchRound,
  CheckSessionRequest,
  CheckSessionResult,
  Conversation,
  CreateAgentDefinitionResult,
  DeleteResult,
  DeleteSessionsRequest,
  ErrorCode,
  GetConversationRequest,
  GetTreeRequest,
  ListSessionsResult,
  McpDeleteServerRequest,
  McpGetServerRequest,
  McpHandshakeRequest,
  McpHandshakeResult,
  McpListRequest,
  McpListResult,
  McpSaveResult,
  McpSaveServerRequest,
  McpServerRaw,
  McpSetEnabledRequest,
  ModelConfig,
  ModelInfo,
  ModelPerf,
  ModelPresetsState,
  ModelPresetSnapshot,
  ModelSpecPatchRequest,
  ModelSpecUpdateResult,
  ModelSpecsResult,
  OpenInItermRequest,
  PromptHistoryEntry,
  RunningSession,
  OmpVersion,
  OmpUpdateCheck,
  OmpUpdateResult,
  OmpOpResult,
  PluginsListResult,
  DiscoverEntry,
  MetaSnapshot,
  PluginUpgradeResult,
  PluginCheckResult,
  SessionMetaInput,
  SkillsListResult,
  SuperagentHttpMethod,
  SuperagentResponse,
  SuperagentStatus,
  TreeData,
  SessionUsage,
  MemoryBackup,
  MemoryBackupAllResult,
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
  SUPERAGENT_UNAVAILABLE: true,
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
/** 聚焦占用会话的 iTerm 标签（在用恢复确认框用；只 activate+select）。 */
export function focusItermTab(path: string): Promise<void> {
  return call("focus_iterm_tab", { path });
}

/** 在 iTerm 新开 omp 会话（`cd '<cwd>' && omp [--model]`，不带 prompt）。 */
export function newSessionInIterm(cwd: string, model?: string | null): Promise<void> {
  return call("new_session_in_iterm", { cwd, model: model ?? null });
}

/** 写系统剪贴板（WebView 的 clipboard 在菜单动作里会因缺少用户激活被拒）。 */
export function copyTextToClipboard(text: string): Promise<void> {
  return call("copy_text", { text });
}

/** 生成续聊命令（与「在 iTerm 继续」完全同一套校验，但不做占用探测）。 */
export function getResumeCommand(path: string): Promise<string> {
  return call("resume_command_for", { path });
}

/** 在 Finder 中显示会话文件（选中该 `.jsonl`）。 */
export function revealSessionFile(path: string): Promise<void> {
  return call("reveal_session_file", { path });
}

/** 在 Finder 中显示任意文件（选中该文件；只接受绝对路径）。 */
export function revealFile(path: string): Promise<void> {
  return call("reveal_file", { path });
}

/** 在 Finder 中打开项目目录。 */
export function openProjectDir(cwd: string): Promise<void> {
  return call("open_project_dir", { cwd });
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

export function checkOmpPluginUpdate(id: string | null): Promise<PluginCheckResult> {
  return call("omp_plugin_check_update", { id });
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

export function handshakeMcpServer(req: McpHandshakeRequest): Promise<McpHandshakeResult> {
  return call("mcp_handshake", {
    scope: req.scope,
    project: req.project ?? null,
    name: req.name,
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

/** 新建用户 agent 定义（`~/.omp/agent/agents/<name>.md`，同名报 `INVALID_INPUT`）。 */
export function createAgentDefinition(req: {
  name: string;
  description: string;
}): Promise<CreateAgentDefinitionResult> {
  return call("create_agent_definition", {
    name: req.name,
    description: req.description,
  });
}

/** 模型模式列表（omp `modelPresets`）+ 当前激活项 + 两份 expected。 */
export function listModelPresets(): Promise<ModelPresetsState> {
  return call("list_model_presets");
}

/** 把当前模型配置存为模式（`overwrite` 为 true 时覆盖同名）。 */
export function saveModelPreset(req: {
  name: string;
  overwrite: boolean;
  expectedPresets: unknown;
}): Promise<ModelPresetsState> {
  return call("save_model_preset", {
    name: req.name,
    overwrite: req.overwrite,
    expectedPresets: req.expectedPresets,
  });
}

/** 切换到某个模式；`expected` 与后端当前值不一致时报 `CONFLICT`。 */
export function switchModelPreset(req: {
  name: string;
  expected: ModelPresetSnapshot;
}): Promise<ModelPresetsState> {
  return call("switch_model_preset", { name: req.name, expected: req.expected });
}

/** 删除某个模式（只删保存记录，不改当前配置）。 */
export function deleteModelPreset(req: {
  name: string;
  expectedPresets: unknown;
}): Promise<ModelPresetsState> {
  return call("delete_model_preset", {
    name: req.name,
    expectedPresets: req.expectedPresets,
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

/** 全库快照（CONTRACT §18.8.9）；逐库独立成败，无参数。 */
export function memoryBackupAll(): Promise<MemoryBackupAllResult> {
  return call("memory_backup_all");
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

/** 删除 bench 记录：at 为 null 时清空该模型全部轮次；返回删除条数。 */
export function modelBenchDelete(req: { selector: string; at: string | null }): Promise<number> {
  return call("model_bench_delete", req);
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

/** 在已存在 provider 的 models 列表末尾追加新模型（CONTRACT §21.9）；只用 patch 的 name/contextWindow/maxTokens。 */
export function createModelSpec(req: ModelSpecPatchRequest): Promise<ModelSpecUpdateResult> {
  return call("create_model_spec", {
    provider: req.provider,
    id: req.id,
    patch: req.patch,
    expectedRevision: req.expectedRevision,
  });
}

/** CONTRACT §4.57：单个会话的舞台（只读）。 */
export function getAgentStage(path: string): Promise<AgentStage> {
  return call("get_agent_stage", { path });
}

/** CONTRACT §4.58：运行中会话快照（菜单栏轮询器每 3 秒发布）。 */
export function listRunningSessions(): Promise<RunningSession[]> {
  return call("list_running_sessions");
}

/** CONTRACT §4.59：agent 定义的完整只读视图（工具 / 派生 / 系统提示词）。 */
export function listAgentDetails(): Promise<AgentDetail[]> {
  return call("list_agent_details");
}

/** CONTRACT §17.10：读菜单栏设置。 */
export function getTraySettings(): Promise<TraySettings> {
  return call("get_tray_settings");
}

/** CONTRACT §17.10：按补丁改菜单栏设置（成功返回完整设置）。 */
export function setTraySettings(patch: TraySettingsPatch): Promise<TraySettings> {
  return call("set_tray_settings", { patch });
}

/** CONTRACT §17.10：面板/菜单栏页预览（只读，由缓存模型 + 行快照 join 映射）。 */
export function getTrayPreview(): Promise<TrayPreview> {
  return call("get_tray_preview");
}

/** CONTRACT §17.11：面板点会话行 = 聚焦其 iTerm 标签。 */
export function trayFocusSession(sessionId: string): Promise<void> {
  return call("tray_focus_session", { sessionId });
}

/** CONTRACT §17.11：面板「最近会话」恢复（iTerm 新 tab）。 */
export function trayResumeRecent(sessionId: string): Promise<void> {
  return call("tray_resume_recent", { sessionId });
}

/** CONTRACT §17.11：打开主窗口；`page` 非空时附带路由跳转/新建会话事件。 */
export function openMainWindow(page?: string): Promise<void> {
  return call("open_main_window", { page: page ?? null });
}

/** CONTRACT §17.11：退出应用。 */
export function quitApp(): Promise<void> {
  return call("quit_app");
}

/** CONTRACT §17.11：构建信息（设置页关于卡用）。 */
export function getBuildInfo(): Promise<BuildInfo> {
  return call("get_build_info");
}

/** CONTRACT §4.68：应用关键路径（只读展示）。 */
export function getAppPaths(): Promise<AppPaths> {
  return call("get_app_paths");
}

// Superagent（CONTRACT §26 / §4.76–§4.80）。

/** 守护进程托管状态（只读；服务页/管理面板轮询它）。 */
export function superagentStatus(): Promise<SuperagentStatus> {
  return call("superagent_status");
}

/** 启用/停用守护进程（落盘设置 + 按需启停）。 */
export function superagentSetEnabled(enabled: boolean): Promise<SuperagentStatus> {
  return call("superagent_set_enabled", { enabled });
}

/** 重启守护进程（未启用时后端报 INVALID_INPUT）。 */
export function superagentRestart(): Promise<SuperagentStatus> {
  return call("superagent_restart");
}

/** 经 unix socket 代理到守护进程 HTTP 的请求（面板与会话列表都走它）。 */
export function superagentRequest(
  method: SuperagentHttpMethod,
  path: string,
  body?: unknown,
): Promise<SuperagentResponse> {
  return call("superagent_request", { method, path, body: body ?? null });
}

/** 守护进程日志末尾 N 行（1..=2000，后端钳制之外前端也只传合法值）。 */
export function superagentLogTail(lines: number): Promise<string[]> {
  return call("superagent_log_tail", { lines });
}
