//! 前后端共享的数据模型。
//!
//! 本文件是权威类型定义：`src/types.ts` 必须与此文件逐字段对应，
//! 语义规则见 `docs/CONTRACT.md`。所有命令返回 `AppResult<T>`，
//! 后端尚未实现任何命令（见 `lib.rs`），本模块只定义形状，不含逻辑。

use serde::{Deserialize, Serialize};

/// 所有命令的统一返回类型。
pub type AppResult<T> = Result<T, AppError>;

/// 错误码。序列化为 SCREAMING_SNAKE_CASE 字符串，前端以字符串联合类型镜像。
///
/// `Unknown` 永不由后端命令产生，仅供前端 `normalizeError` 归一化
/// 传输层 / 未预期的失败（见 `src/api.ts`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InUse,
    ProbeFailed,
    CwdMissing,
    NotFound,
    OutsideRoot,
    UnsupportedFormat,
    InvalidNode,
    Io,
    ItermFailed,
    OmpNotFound,
    OmpFailed,
    Busy,
    Timeout,
    InvalidInput,
    Conflict,
    MetaCorrupt,
    /// 配置键不在模型配置白名单内（仅 `update_model_config` 产生）。
    InvalidKey,
    Unknown,
}

/// 统一错误体。前端 `invoke` 失败时抛出的即为此形状。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

// ---------------------------------------------------------------------------
// get_config
// ---------------------------------------------------------------------------

/// `get_config` 返回：解析后的实际目录（解析规则见 CONTRACT.md）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConfigResult {
    pub sessions_dir: String,
    pub owners_dir: String,
}

// ---------------------------------------------------------------------------
// list_sessions
// ---------------------------------------------------------------------------

/// `list_sessions` 返回。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResult {
    /// 实际使用的 sessions 根目录（绝对路径）。
    pub sessions_dir: String,
    /// 因「无标题且零用户消息」被隐藏的会话数。
    pub hidden_empty: u64,
    /// 按组内最新会话 modifiedAt 倒序。
    pub groups: Vec<ProjectGroup>,
}

/// 同一项目目录下的会话组。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    /// 项目真实路径（会话 header 的 `cwd`）。
    pub cwd: String,
    /// sessions 根目录下的编码目录名（如 `-my-omp-resume`）。
    pub dir_name: String,
    /// 按 modifiedAt 倒序。
    pub sessions: Vec<SessionSummary>,
}

/// fork 血缘：`parentSession` 原始值及其解析结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkInfo {
    /// header `parentSession` 原始字符串（id 或路径）。
    pub parent_raw: String,
    /// 解析到的父会话标题；找不到则为 null。
    pub parent_title: Option<String>,
    /// 解析到的父会话绝对路径；找不到则为 null。
    pub parent_path: Option<String>,
}

/// 占用者信息（CONTRACT §3.1）：持有锁文件的 omp 进程归属应用（尽力识别，仅展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Occupant {
    /// 持有锁的进程 PID（`lsof` 所见最低 pid）。
    pub pid: u32,
    /// 归属应用展示名（如 `VS Code` / `iTerm2`）；无法识别时为 null。
    pub app: Option<String>,
    /// 应用版本（仅当与归属一致时填充）；未知时为 null。
    pub app_version: Option<String>,
}

/// 单个会话的列表行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// 会话 id（header.id；解析失败时回退为文件名 stem）。
    pub id: String,
    /// 会话文件绝对路径。
    pub path: String,
    /// 记录的工作目录（header.cwd）。
    pub cwd: String,
    /// `cwd` 是否仍存在且可进入。
    pub cwd_exists: bool,
    /// 最新标题 / 首用户消息 60 字 / `(无标题)`。
    pub title: String,
    /// header.timestamp（ISO-8601）。
    pub created_at: String,
    /// 文件 mtime（ISO-8601）。
    pub modified_at: String,
    /// 文件字节数。
    pub size_bytes: u64,
    /// active 路径上的 user + assistant 消息数。
    pub message_count: u64,
    /// 保留树中的叶子数（>1 时 UI 显示「N 个分支」）。
    pub branch_count: u64,
    /// flock 探测：是否正被 omp 进程占用。
    pub in_use: bool,
    /// flock 探测本身是否成功。
    pub probe_ok: bool,
    /// 占用者信息（CONTRACT §3.1）：非占用或未找到 PID 时为 null；
    /// 找到 PID 但应用无法识别时为 `{pid, app:null, appVersion:null}`。
    pub occupant: Option<Occupant>,
    /// fork 血缘；非 fork 会话为 null。
    pub fork: Option<ForkInfo>,
    /// 仅 v3 可预览 / 建树；非 v3 只填廉价字段。
    pub format_supported: bool,
    /// header.version；缺失为 null。
    pub version: Option<u32>,
    /// 宽容解析跳过的坏行数。
    pub bad_lines: u64,
    /// active 路径上最早 user 消息（截断至 200 字）；无则为 null。
    pub first_user_message: Option<String>,
}

// ---------------------------------------------------------------------------
// get_conversation
// ---------------------------------------------------------------------------

/// `get_conversation` 请求参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConversationRequest {
    pub path: String,
    /// 目标节点 id；缺省为 active leaf。
    pub node_id: Option<String>,
}

/// `get_conversation` 返回：根 → 目标节点的保留条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub path: String,
    /// 文件末物理条目向上最近的保留节点；无则为 null。
    pub leaf_id: Option<String>,
    /// 实际使用的目标节点（请求 nodeId 或 leaf）。
    pub target_id: String,
    pub items: Vec<ConversationItem>,
}

/// 会话条目（判别联合，以 `kind` 区分）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConversationItem {
    User(UserItem),
    Assistant(AssistantItem),
    ToolResult(ToolResultItem),
    BashExecution(BashExecutionItem),
    Compaction(CompactionItem),
    BranchSummary(BranchSummaryItem),
    Other(OtherItem),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserItem {
    /// text 块拼接（`\n` 连接，image 块记为 `[图片]`）。
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantItem {
    pub blocks: Vec<AssistantBlock>,
}

/// assistant 消息内容块。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssistantBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        args: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultItem {
    pub tool_call_id: String,
    pub tool_name: String,
    pub is_error: bool,
    /// text 块拼接（image 块记为 `[图片]`），超 `MAX_TEXT_BYTES` 截断。
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashExecutionItem {
    pub command: String,
    /// stdout/output，超 `MAX_TEXT_BYTES` 截断。
    pub text: String,
    pub truncated: bool,
    pub exit_code: Option<i64>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionItem {
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryItem {
    pub summary: String,
}

/// 其他 message 角色（developer 及未来角色），原文截断展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherItem {
    pub role: String,
    pub text: String,
}

// ---------------------------------------------------------------------------
// get_tree
// ---------------------------------------------------------------------------

/// `get_tree` 请求参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTreeRequest {
    pub path: String,
}

/// `get_tree` 返回：扁平节点表（链折叠由前端完成）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeData {
    pub path: String,
    /// 文件末物理条目向上最近的保留节点；无则为 null。
    pub leaf_id: Option<String>,
    /// 无 kept 父（或父缺失 / 环）的节点 id。
    pub root_ids: Vec<String>,
    /// leaf → 根的 active 路径节点 id（leaf 在前）。
    pub active_path_ids: Vec<String>,
    pub nodes: Vec<TreeNode>,
}

/// 可见节点类型：`message` / `compaction` / `branch_summary`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TreeNodeKind {
    Message,
    Compaction,
    BranchSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    /// kept 父；根节点为 null。
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub kind: TreeNodeKind,
    /// message 节点的 message.role；其他类型为 null。
    pub role: Option<String>,
    /// 条目 timestamp（ISO-8601）。
    pub timestamp: String,
    /// ≤80 字的预览（生成规则见 CONTRACT.md）。
    pub preview: String,
    /// 指向本节点的 `label` 条目最新值；无则为 null。
    pub label: Option<String>,
    pub is_compaction: bool,
    pub is_branch_summary: bool,
}

// ---------------------------------------------------------------------------
// check_session / delete_sessions / append_branch_marker / open_in_iterm
// ---------------------------------------------------------------------------

/// `check_session` 请求参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSessionRequest {
    pub path: String,
}

/// `check_session` 返回。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSessionResult {
    pub in_use: bool,
    pub probe_ok: bool,
}

/// `delete_sessions` 请求参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionsRequest {
    pub paths: Vec<String>,
}

/// `delete_sessions` 逐路径结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<AppError>,
}

/// `append_branch_marker` 请求参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendBranchMarkerRequest {
    pub path: String,
    pub node_id: String,
}

/// `append_branch_marker` 返回。
///
/// `marker_id` 为新标记条目 id；当 `node_id` 已是 leaf 时为 null（无操作）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendBranchMarkerResult {
    pub marker_id: Option<String>,
}

/// `open_in_iterm` 请求参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInItermRequest {
    pub path: String,
}

/// `omp_version` 返回；未找到或无法解析版本时为 null。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpVersion {
    pub version: Option<String>,
    pub path: Option<String>,
}

/// `omp_update_check` 返回；未识别输出不推断更新状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpUpdateCheck {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub up_to_date: bool,
    pub raw: String,
}

/// `omp_update_run` 返回；只有可识别的版本变化才算已更新。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpUpdateResult {
    pub before: Option<String>,
    pub after: Option<String>,
    pub changed: bool,
    pub output: String,
}

// ---------------------------------------------------------------------------
// MCP 原生配置（CONTRACT §4.30–§4.35）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    User,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpShadowedBy {
    Project,
    DisabledServers,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFileInfo {
    pub scope: McpScope,
    pub path: String,
    pub exists: bool,
    pub read_error: Option<String>,
    pub revision: String,
    pub disabled_servers: Vec<String>,
    pub enabled_servers: Vec<String>,
}

/// 列表仅包含 secret 键名与参数数量，绝不包含可回写的掩码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub scope: McpScope,
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub arg_count: usize,
    pub url: Option<String>,
    pub enabled: bool,
    pub effective: bool,
    pub shadowed_by: Option<McpShadowedBy>,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub has_auth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListResult {
    pub files: Vec<McpFileInfo>,
    pub servers: Vec<McpServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListRequest {
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGetServerRequest {
    pub scope: McpScope,
    pub project: Option<String>,
    pub name: String,
}

/// 编辑框专用的真实配置，不得写入日志或当作列表结果。
/// SECURITY：手写 Debug，`config` 只打印占位符，防止 secret 经 `{:?}` 泄漏到日志。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRaw {
    pub config: serde_json::Value,
    pub revision: String,
}

impl std::fmt::Debug for McpServerRaw {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpServerRaw")
            .field("config", &"<redacted>")
            .field("revision", &self.revision)
            .finish()
    }
}

/// SECURITY：同上，`config` 可能携带 secret，Debug 必须脱敏。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSaveServerRequest {
    pub scope: McpScope,
    pub project: Option<String>,
    pub name: String,
    pub config: serde_json::Value,
    pub expected_revision: String,
    pub original_name: Option<String>,
}

impl std::fmt::Debug for McpSaveServerRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpSaveServerRequest")
            .field("scope", &self.scope)
            .field("project", &self.project)
            .field("name", &self.name)
            .field("config", &"<redacted>")
            .field("expected_revision", &self.expected_revision)
            .field("original_name", &self.original_name)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSaveResult {
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetEnabledRequest {
    pub scope: McpScope,
    pub project: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDeleteServerRequest {
    pub scope: McpScope,
    pub project: Option<String>,
    pub name: String,
    pub expected_revision: String,
}

/// omp 插件、marketplace 与技能写操作的完整输出。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpOpResult {
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: Option<String>,
    pub enabled: bool,
    pub installed_at: Option<String>,
    pub last_updated: Option<String>,
    pub install_path: Option<String>,
}

/// npm 插件仅展示，不进入 marketplace 插件的写操作。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmPluginSummary {
    pub name: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSummary {
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsListResult {
    pub plugins: Vec<PluginSummary>,
    pub npm: Vec<NpmPluginSummary>,
    pub marketplaces: Vec<MarketplaceSummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverEntry {
    pub name: String,
    pub version: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpgradeChange {
    pub id: String,
    pub scope: String,
    pub from: Option<String>,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpgradeResult {
    pub output: String,
    pub changes: Vec<PluginUpgradeChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub file_path: String,
    pub base_dir: String,
    pub source: String,
    pub hide: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResult {
    pub skills: Vec<SkillSummary>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// 提示词历史（CONTRACT §13.2，只读 history.db）
// ---------------------------------------------------------------------------

/// 一条提示词历史。`cwd` / `sessionId` 缺失或为空时为 null。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptHistoryEntry {
    pub id: i64,
    pub prompt: String,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    /// ISO-8601 UTC 毫秒（由 history 的秒级 epoch 转换）。
    pub created_at: String,
    pub use_count: i64,
}
// 会话别名 / 标签 / 备注（应用侧 meta.json，不碰会话文件）
// ---------------------------------------------------------------------------

/// 单个会话的应用侧备注。`Option` 字段序列化为 null（保持全字段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    /// 别名；无则为 null。trimmed，≤80 字符。
    pub alias: Option<String>,
    /// 标签；trimmed、非空、大小写不敏感去重，≤10 个、单个 ≤24 字符。
    pub tags: Vec<String>,
    /// 备注；无则为 null。trimmed，≤2000 字符。
    pub note: Option<String>,
    /// 最后修改时间（ISO-8601 UTC 毫秒）。
    pub updated_at: String,
}

/// `set_session_meta` 的输入条目：`None`（整包 null）表示删除该会话条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaInput {
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// meta.json 全量快照：键为会话 id（不用路径，路径含时间戳）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaSnapshot {
    pub revision: u64,
    pub sessions: std::collections::BTreeMap<String, SessionMeta>,
}

// ---------------------------------------------------------------------------
// list_cleanup_candidates（CONTRACT §14）
// ---------------------------------------------------------------------------

/// 清理候选原因（可叠加）；序列化为 snake_case。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupReason {
    /// 整个文件没有任何 user 消息（仅 v3 可判定）。
    Empty,
    /// header 记录的 cwd 目录已不存在。
    CwdMissing,
    /// 总字节排名前 N 且 ≥ 5 MiB。
    Large,
    /// mtime 超过 N 天。
    Stale,
}

/// 单个清理候选（只读；删除仍走 `delete_sessions`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    pub path: String,
    pub id: String,
    /// 同 list 的标题规则（简化：不走活动路径）。
    pub title: String,
    pub cwd: String,
    /// 文件 mtime（ISO-8601）。
    pub mtime: String,
    /// 删除时将释放的总字节：jsonl + sibling 目录（递归，不跟随符号链接）+ `.bak`。
    pub bytes: u64,
    pub reasons: Vec<CleanupReason>,
    /// flock 探测：正被 omp 占用。
    pub in_use: bool,
    /// flock 探测是否成功；false 时按保守规则不可删除（标注「占用未知」）。
    pub probe_ok: bool,
}

// ---------------------------------------------------------------------------
// 模型与 Agent 配置（CONTRACT §4.36–§4.38）
// ---------------------------------------------------------------------------

/// `list_models` 单行：精简模型信息。绝不包含凭据字段（apiKey 等）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub selector: String,
    pub provider: String,
    pub id: String,
    pub name: String,
    pub thinking_levels: Vec<String>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub reasoning: bool,
    #[serde(default)]
    pub input: Vec<String>,
    pub cost_input: Option<f64>,
    pub cost_output: Option<f64>,
    pub cost_cache_read: Option<f64>,
    pub cost_cache_write: Option<f64>,
}

/// agent 定义来源：内置（unpack 导出）或用户自建（`~/.omp/agent/agents`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSource {
    Builtin,
    User,
}

/// `get_model_config` 的 agent 行：内置默认（模型 / thinking，只读展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub source: AgentSource,
    pub default_model: Vec<String>,
    pub default_thinking_level: Option<String>,
}

/// 全局兜底开关（只读展示）：`retry.modelFallback` / `retry.fallbackOn` /
/// `retry.fallbackRevertPolicy`。读不到或形状异常时对应字段为 None（前端显示「未知」），
/// 不让整个 `get_model_config` 失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryStatus {
    pub model_fallback: Option<bool>,
    pub fallback_on: Option<String>,
    pub fallback_revert_policy: Option<String>,
}

/// `get_model_config` 返回：白名单 5 个可写 config key 的原始值 + agent 默认值 +
/// 只读兜底状态。
/// record / 数组内单个条目的值原样保留（可能不是字符串，前端只展示不改写）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub roles: serde_json::Map<String, serde_json::Value>,
    pub agent_overrides: serde_json::Map<String, serde_json::Value>,
    pub disabled_agents: Vec<serde_json::Value>,
    pub agent_advisor: serde_json::Map<String, serde_json::Value>,
    pub fallback_chains: serde_json::Map<String, serde_json::Value>,
    pub agents: Vec<AgentDefinition>,
    pub retry_status: RetryStatus,
}

/// `update_model_config` 返回：写后复读的新值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateModelConfigResult {
    pub key: String,
    pub value: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_serializes_screaming_snake() {
        let e = AppError::new(ErrorCode::InUse, "会话正被 omp 使用");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "IN_USE");
        assert_eq!(v["message"], "会话正被 omp 使用");
    }

    #[test]
    fn conversation_item_tagged_by_kind() {
        let item = ConversationItem::ToolResult(ToolResultItem {
            tool_call_id: "call_1".into(),
            tool_name: "read".into(),
            is_error: false,
            text: "ok".into(),
            truncated: false,
        });
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["kind"], "toolResult");
        assert_eq!(v["toolCallId"], "call_1");
    }

    #[test]
    fn tree_node_kind_uses_camel_case() {
        let v = serde_json::to_value(TreeNodeKind::BranchSummary).unwrap();
        assert_eq!(v, "branchSummary");
    }

    #[test]
    fn omp_contract_uses_camel_case_and_nulls() {
        for (code, expected) in [
            (ErrorCode::OmpNotFound, "OMP_NOT_FOUND"),
            (ErrorCode::OmpFailed, "OMP_FAILED"),
            (ErrorCode::Busy, "BUSY"),
            (ErrorCode::Timeout, "TIMEOUT"),
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), expected);
        }
        let check = serde_json::to_value(OmpUpdateCheck {
            current: None,
            latest: None,
            up_to_date: false,
            raw: String::new(),
        })
        .unwrap();
        assert_eq!(
            check,
            serde_json::json!({"current": null, "latest": null, "upToDate": false, "raw": ""})
        );
        let version = serde_json::to_value(OmpVersion {
            version: None,
            path: None,
        })
        .unwrap();
        assert_eq!(version, serde_json::json!({"version": null, "path": null}));
        let update = serde_json::to_value(OmpUpdateResult {
            before: None,
            after: Some("18.12.0".into()),
            changed: true,
            output: "updated".into(),
        })
        .unwrap();
        assert_eq!(
            update,
            serde_json::json!({"before": null, "after": "18.12.0", "changed": true, "output": "updated"})
        );
    }

    #[test]
    fn memory_contract_shapes_match_typescript() {
        // 枚举线形：小写 / camelCase / kebab-case / snake_case。
        for (value, want) in [
            (
                serde_json::to_value(MemoryKind::Working).unwrap(),
                "working",
            ),
            (
                serde_json::to_value(MemoryKind::Episodic).unwrap(),
                "episodic",
            ),
            (serde_json::to_value(MemoryKindFilter::All).unwrap(), "all"),
            (
                serde_json::to_value(MemorySort::MostRecalled).unwrap(),
                "mostRecalled",
            ),
            (
                serde_json::to_value(MemoryBackupKind::BeforeDelete).unwrap(),
                "before-delete",
            ),
            (
                serde_json::to_value(MemoryBackupKind::BankRemoved).unwrap(),
                "bank-removed",
            ),
            (
                serde_json::to_value(MemorySkipReason::NotFound).unwrap(),
                "not_found",
            ),
        ] {
            assert_eq!(value, want);
        }
        assert_eq!(
            serde_json::from_str::<MemorySort>("\"mostRecalled\"").unwrap(),
            MemorySort::MostRecalled
        );
        assert_eq!(
            serde_json::from_str::<MemoryBackupKind>("\"before-restore\"").unwrap(),
            MemoryBackupKind::BeforeRestore
        );
        // `flatten` 让详情与列表行同属一层（TS `extends` 对应扁平 JSON）。
        let v = serde_json::to_value(&MemoryDetail {
            item: MemoryItem {
                id: "m1".into(),
                kind: MemoryKind::Working,
                snippet: "hi".into(),
                content_chars: 2,
                created_at: None,
                source_session_id: None,
                source_session_exists: None,
                recall_count: 0,
                last_recalled_at: None,
                importance: None,
                veracity: None,
                memory_type: None,
                consolidated: false,
                superseded: false,
            },
            content: "hi".into(),
            truncated: false,
            embed_text: None,
            metadata: None,
            facts: vec![],
            summary_of: vec![],
            related_edges: 0,
        })
        .unwrap();
        assert_eq!(v["id"], "m1");
        assert_eq!(v["kind"], "working");
        assert_eq!(v["contentChars"], 2);
        assert_eq!(v["sourceSessionExists"], serde_json::Value::Null);
        assert_eq!(v["memoryType"], serde_json::Value::Null);
        assert_eq!(v["embedText"], serde_json::Value::Null);
        assert!(v.get("item").is_none());
        let s = serde_json::to_value(&MemoryBankStatus {
            bank: "b".into(),
            in_use: true,
            probe_failed: false,
            holders: vec![MemoryHolder {
                pid: 1,
                command: "omp".into(),
            }],
            backups: vec![],
        })
        .unwrap();
        assert_eq!(s["inUse"], true);
        assert_eq!(s["probeFailed"], false);
        assert_eq!(s["holders"][0]["pid"], 1);
    }

    #[test]
    fn secret_configs_are_redacted_in_debug() {
        let raw = McpServerRaw {
            config: serde_json::json!({"env": {"TOKEN": "super-secret-aaa"}}),
            revision: "rev".into(),
        };
        let debug = format!("{raw:?}");
        assert!(!debug.contains("super-secret-aaa"), "{debug}");
        assert!(debug.contains("<redacted>"), "{debug}");
        assert!(debug.contains("rev"), "{debug}");
        let request = McpSaveServerRequest {
            scope: McpScope::User,
            project: None,
            name: "secret".into(),
            config: serde_json::json!({"headers": {"X": "super-secret-bbb"}}),
            expected_revision: "rev".into(),
            original_name: None,
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("super-secret-bbb"), "{debug}");
        assert!(debug.contains("<redacted>"), "{debug}");
        assert!(debug.contains("secret"), "{debug}");
    }

    #[test]
    fn model_config_types_use_camel_case_and_nulls() {
        assert_eq!(
            serde_json::to_value(ErrorCode::InvalidKey).unwrap(),
            "INVALID_KEY"
        );
        let info = serde_json::to_value(ModelInfo {
            selector: "5438/deepseek-v4.1-flash".into(),
            provider: "5438".into(),
            id: "deepseek-v4.1-flash".into(),
            name: "DeepSeek v4.1 Flash".into(),
            thinking_levels: vec!["low".into(), "high".into()],
            context_window: None,
            max_tokens: Some(393_216),
            reasoning: true,
            input: vec!["text".into(), "image".into()],
            cost_input: Some(0.3),
            cost_output: None,
            cost_cache_read: Some(0.006),
            cost_cache_write: Some(0.0),
        })
        .unwrap();
        assert_eq!(info["selector"], "5438/deepseek-v4.1-flash");
        assert_eq!(info["thinkingLevels"], serde_json::json!(["low", "high"]));
        assert_eq!(info["contextWindow"], serde_json::Value::Null);
        assert_eq!(info["maxTokens"], 393_216);
        assert_eq!(info["input"], serde_json::json!(["text", "image"]));
        assert_eq!(info["costInput"], 0.3);
        assert_eq!(info["costOutput"], serde_json::Value::Null);
        assert_eq!(info["costCacheRead"], 0.006);
        assert_eq!(info["costCacheWrite"], 0.0);
        // 旧快照无 input 字段仍可反序列化（缺省空数组）。
        let legacy: ModelInfo = serde_json::from_value(serde_json::json!({
            "selector": "p/m", "provider": "p", "id": "m", "name": "M",
            "thinkingLevels": [], "contextWindow": null, "maxTokens": null,
            "reasoning": false, "costInput": null, "costOutput": null,
            "costCacheRead": null, "costCacheWrite": null
        }))
        .unwrap();
        assert!(legacy.input.is_empty());
        let agent = serde_json::to_value(AgentDefinition {
            name: "scout".into(),
            description: "调研".into(),
            source: AgentSource::Builtin,
            default_model: vec!["@smol".into()],
            default_thinking_level: None,
        })
        .unwrap();
        assert_eq!(
            agent,
            serde_json::json!({"name": "scout", "description": "调研", "source": "builtin",
                "defaultModel": ["@smol"], "defaultThinkingLevel": null})
        );
        let retry = serde_json::to_value(RetryStatus {
            model_fallback: Some(false),
            fallback_on: Some("any".into()),
            fallback_revert_policy: None,
        })
        .unwrap();
        assert_eq!(
            retry,
            serde_json::json!({"modelFallback": false, "fallbackOn": "any",
                "fallbackRevertPolicy": null})
        );
    }

    #[test]
    fn meta_snapshot_uses_camel_case_and_nulls() {
        assert_eq!(
            serde_json::to_value(ErrorCode::MetaCorrupt).unwrap(),
            "META_CORRUPT"
        );
        let snap = MetaSnapshot {
            revision: 3,
            sessions: [(
                "s1".to_owned(),
                SessionMeta {
                    alias: None,
                    tags: vec!["bug".to_owned()],
                    note: Some("n".to_owned()),
                    updated_at: "2026-10-16T00:00:00.000Z".to_owned(),
                },
            )]
            .into_iter()
            .collect(),
        };
        let v = serde_json::to_value(&snap).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "revision": 3,
                "sessions": {
                    "s1": {"alias": null, "tags": ["bug"], "note": "n", "updatedAt": "2026-10-16T00:00:00.000Z"}
                }
            })
        );
        // 输入缺省字段可反序列化（前端可只传 tags）。
        let input: SessionMetaInput =
            serde_json::from_value(serde_json::json!({"tags": []})).unwrap();
        assert_eq!(input.alias, None);
        assert_eq!(input.note, None);
    }
}

// 用量统计（只读，CONTRACT「用量与花费统计」）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub total: f64,
    pub main: f64,
    pub background: f64,
    pub subagent: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMessages {
    pub user: u64,
    pub assistant: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub messages: UsageMessages,
    pub tokens: UsageTokens,
    pub cost: UsageCost,
    pub models: Vec<UsageModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModel {
    pub provider: String,
    pub model: String,
    pub messages: u64,
    pub cost: f64,
    pub tokens: UsageTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProject {
    pub cwd: String,
    pub cost: f64,
    pub tokens: UsageTokens,
    pub sessions: u64,
}

/// 用量时间范围（JSON 为 "today" | "24h" | "7d" | "30d" | "all"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UsageRange {
    #[serde(rename = "today")]
    Today,
    #[serde(rename = "24h")]
    Last24Hours,
    #[serde(rename = "7d")]
    Last7Days,
    #[serde(rename = "30d")]
    Last30Days,
    #[serde(rename = "all")]
    All,
}

/// 趋势 / 时间线分桶单位（JSON 为 "hour" | "day"）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrendUnit {
    Hour,
    #[default]
    Day,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendPoint {
    pub key: String,
    pub cost: f64,
    pub tokens: UsageTokens,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrend {
    pub unit: TrendUnit,
    pub points: Vec<UsageTrendPoint>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub total: SessionUsage,
    pub by_project: Vec<UsageProject>,
    pub by_model: Vec<UsageModel>,
    pub trend: UsageTrend,
    pub sessions: u64,
    pub timing: UsageTiming,
    pub top_sessions: Vec<UsageSession>,
    pub activity: Vec<UsageTrendPoint>,
}

/// 仅主对话：子代理与主对话并行，累加会超过挂钟时间。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTiming {
    pub wait_ms: u64,
    pub gen_ms: u64,
    pub tool_ms: u64,
    pub tool_calls: u64,
    pub calls: u64,
    pub tps: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSession {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub cost: f64,
    pub tokens: u64,
    pub calls: u64,
    pub last_ms: i64,
}

/// 运行错误分类（启发式，见 usage.rs `classify_error`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Quota,
    RateLimit,
    Auth,
    Timeout,
    Network,
    Server,
    #[default]
    Other,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorKindCount {
    pub kind: ErrorKind,
    pub count: u64,
}

/// 最近错误：time 为 epoch 毫秒；message 已截断为单行 ≤200 字符并脱敏。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorRecent {
    pub time: i64,
    pub provider: String,
    pub model: String,
    pub kind: ErrorKind,
    pub message: String,
}

/// 错误统计：total 只计 stopReason=="error"；aborted（用户中断）单独计，不含在内。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageErrors {
    pub total: u64,
    pub aborted: u64,
    pub by_kind: Vec<ErrorKindCount>,
    pub recent: Vec<ErrorRecent>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackTarget {
    pub provider: String,
    pub model: String,
    pub count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackRecent {
    pub time: i64,
    pub from: Option<ModelRef>,
    pub to: ModelRef,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFallbacks {
    pub total: u64,
    pub by_target: Vec<FallbackTarget>,
    pub recent: Vec<FallbackRecent>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheByModel {
    pub provider: String,
    pub model: String,
    pub requests: u64,
    pub hit_rate: Option<f64>,
}

/// 缓存统计：hitRate = cacheRead / (input + cacheRead + cacheWrite)；
/// 分母为 0，或范围内 cacheRead + cacheWrite 全为 0（上游不报缓存）时为 null。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCacheStats {
    pub hit_rate: Option<f64>,
    pub read: u64,
    pub write: u64,
    pub input: u64,
    pub by_model: Vec<CacheByModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePoint {
    pub key: String,
    pub requests: u64,
    pub errors: u64,
    pub fallbacks: u64,
    pub cache_read: u64,
    pub prompt_tokens: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTimeline {
    pub unit: TrendUnit,
    pub points: Vec<TimelinePoint>,
}

/// 运行健康统计：requests = assistant（含子代理，含 error/aborted）+ model_usage。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHealth {
    pub requests: u64,
    pub errors: UsageErrors,
    pub fallbacks: UsageFallbacks,
    pub cache: UsageCacheStats,
    pub timeline: UsageTimeline,
}
// ---------------------------------------------------------------------------
// 记忆库（CONTRACT §18：浏览 + 写操作）
// ---------------------------------------------------------------------------

/// 记忆行种类（JSON：`"working"` | `"episodic"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Working,
    Episodic,
}

/// `memory_list` 的 kind 过滤（JSON：`"all"` | `"working"` | `"episodic"`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKindFilter {
    #[default]
    All,
    Working,
    Episodic,
}

/// `memory_list` 排序（JSON：`"newest"` | `"oldest"` | `"mostRecalled"`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemorySort {
    #[default]
    Newest,
    Oldest,
    MostRecalled,
}

/// `memory_overview` 全局合计。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTotals {
    pub banks: u64,
    pub working: u64,
    pub episodic: u64,
    pub facts: u64,
    pub bytes: u64,
    pub never_recalled: u64,
    pub unconsolidated: u64,
    pub missing_source_sessions: u64,
    pub source_sessions: u64,
}

/// 单个 bank 的概览行。`readable=false` 时计数按 0，UI 置灰并显示 `error`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBankSummary {
    pub bank: String,
    pub display_name: String,
    pub cwd: Option<String>,
    pub cwd_exists: Option<bool>,
    pub working: u64,
    pub episodic: u64,
    pub facts: u64,
    pub bytes: u64,
    pub first_memory_at: Option<String>,
    pub last_memory_at: Option<String>,
    pub never_recalled: u64,
    pub unconsolidated: u64,
    pub source_sessions: u64,
    pub missing_source_sessions: u64,
    pub readable: bool,
    pub error: Option<String>,
}

/// `memory_overview` 返回。`available=false` 是正常状态（无本地库），不是错误。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOverview {
    pub available: bool,
    pub backend: Option<String>,
    pub root: String,
    pub banks: Vec<MemoryBankSummary>,
    pub totals: MemoryTotals,
}

/// 记忆列表行（`memory_list` / `memory_detail` 共用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub kind: MemoryKind,
    pub snippet: String,
    pub content_chars: u64,
    pub created_at: Option<String>,
    pub source_session_id: Option<String>,
    pub source_session_exists: Option<bool>,
    pub recall_count: i64,
    pub last_recalled_at: Option<String>,
    pub importance: Option<f64>,
    pub veracity: Option<String>,
    pub memory_type: Option<String>,
    pub consolidated: bool,
    pub superseded: bool,
}

/// `memory_list` 返回：`total` 为过滤后总数（与分页无关）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPage {
    pub total: u64,
    pub items: Vec<MemoryItem>,
}

/// 指向一条记忆的 fact 行。`facts` 表的行 `key` 为 null；
/// `memoria_facts` 表的行 `subject` 为 null（见 CONTRACT §18.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFact {
    pub subject: Option<String>,
    pub predicate: Option<String>,
    pub object: Option<String>,
    pub key: Option<String>,
}

/// `memory_detail` 返回：列表行 + 全文与关联。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDetail {
    #[serde(flatten)]
    pub item: MemoryItem,
    pub content: String,
    pub truncated: bool,
    pub embed_text: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub facts: Vec<MemoryFact>,
    pub summary_of: Vec<String>,
    pub related_edges: u64,
}

/// 引用关系边种类（JSON：`"summary"` | `"related"` | `"context"`，见 CONTRACT §18.10）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryGraphEdgeKind {
    Summary,
    Related,
    Context,
}

/// 关系图节点：列表行的轻量子集 + 关联度（边数）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphNode {
    pub id: String,
    pub kind: MemoryKind,
    pub snippet: String,
    pub created_at: Option<String>,
    pub recall_count: i64,
    pub importance: Option<f64>,
    pub degree: u64,
}

/// 引用关系边（两端点恒为已返回节点的 id）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: MemoryGraphEdgeKind,
}

/// `memory_graph` 返回：`nodes` 只含有关联的记忆（`degree > 0`），按关联度/新近截断；
/// `unlinked_count` 为无任何引用关系的记忆数（默认不渲染，只展示数字）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraph {
    pub nodes: Vec<MemoryGraphNode>,
    pub edges: Vec<MemoryGraphEdge>,
    pub truncated: bool,
    pub total_nodes: u64,
    pub total_edges: u64,
    pub unlinked_count: u64,
}

// ---------------------------------------------------------------------------
// 记忆库写操作（CONTRACT §18.8）
// ---------------------------------------------------------------------------

/// 备份种类（JSON：`"before-delete"` | `"before-restore"` | `"bank-removed"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryBackupKind {
    BeforeDelete,
    BeforeRestore,
    BankRemoved,
}

/// 单个备份条目（`id` 为 `{bank}@{dirname}` 不透明 token，见 §18.8.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBackup {
    pub id: String,
    pub bank: String,
    pub kind: MemoryBackupKind,
    pub created_at: String,
    pub bytes: u64,
    pub working: Option<u64>,
    pub episodic: Option<u64>,
    pub cwd: Option<String>,
}

/// bank 占用者（lsof 持有者 pid + 命令名）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHolder {
    pub pid: u32,
    pub command: String,
}

/// `memory_bank_status` 返回：lsof 问题 ⇒ `probe_failed=true`（非错误）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBankStatus {
    pub bank: String,
    pub in_use: bool,
    pub probe_failed: bool,
    pub holders: Vec<MemoryHolder>,
    pub backups: Vec<MemoryBackup>,
}

/// preview 可删计数。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteDeletable {
    pub working: u64,
    pub episodic: u64,
}

/// preview 级联计数（`other` = gists + 5 张 memoria_*）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteCascade {
    pub facts: u64,
    pub embeddings: u64,
    pub annotations: u64,
    pub edges: u64,
    pub other: u64,
}

/// `memory_delete_preview` 返回（纯只读）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeletePreview {
    pub requested: u64,
    pub deletable: MemoryDeleteDeletable,
    pub unsupported: u64,
    pub not_found: u64,
    pub cascade: MemoryDeleteCascade,
    pub cited_by_summaries: u64,
}

/// 跳过原因（JSON：`"not_found"` | `"unsupported"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySkipReason {
    NotFound,
    Unsupported,
}

/// 被跳过的 id 及其原因。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySkipped {
    pub id: String,
    pub reason: MemorySkipReason,
}

/// `memory_delete_items` 返回。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteResult {
    pub deleted: Vec<String>,
    pub skipped: Vec<MemorySkipped>,
    pub backup: MemoryBackup,
}

/// `memory_restore` 返回。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRestoreResult {
    pub bank: String,
    pub restored_from: MemoryBackup,
    pub safety_backup: Option<MemoryBackup>,
}
// ---------------------------------------------------------------------------
// model_bench (CONTRACT §20)
// ---------------------------------------------------------------------------

/// `model_bench_run` 返回 / `model_bench_history` 条目：两次 bench 探针合成的一轮。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchRound {
    /// 本轮开始时间（ISO-8601 UTC 毫秒）。
    pub at: String,
    /// 原样 selector（含 `:thinking`）。
    pub selector: String,
    /// 请求总数（正常 8）。
    pub total: u64,
    /// 成功数。
    pub ok: u64,
    /// 成功请求 ttftMs 的 p50 / p95（最近秩法）；无样本为 null。
    pub ttft_p50_ms: Option<f64>,
    pub ttft_p95_ms: Option<f64>,
    /// 成功请求 generationTps 的 p50；无样本为 null。
    pub tps_p50: Option<f64>,
    /// generationTps 的变异系数（总体标准差/均值）；样本少于 2 时为 null。
    pub tps_cv: Option<f64>,
    /// 成功请求 cost 之和（美元），缺失按 0。
    pub cost: f64,
    /// 失败请求的错误文本：去重，每条截到 200 字符，最多 5 条。
    pub errors: Vec<String>,
}

/// `model_perf_list` 条目：omp 日常实测统计（只读聚合）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPerf {
    /// omp 侧模型键。
    pub selector: String,
    /// 样本数（`round(samples)`）。
    pub samples: i64,
    /// 平均 TTFT 毫秒（`ttft_ms/ttft_samples`，无样本为 null）。
    pub ttft_ms: Option<f64>,
    /// 生成速度 tok/s（`output_tokens/(gen_ms/1000)`，无计时为 null）。
    pub tps: Option<f64>,
    /// omp 侧更新时间（ISO-8601 UTC 毫秒）。
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// 模型规格编辑（CONTRACT §21：§4.54–§4.55）
// ---------------------------------------------------------------------------

/// 单个模型的规格快照：只含非凭据字段。`selector` 为 `provider/id`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub provider: String,
    pub id: String,
    pub selector: String,
    pub name: Option<String>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub reasoning: Option<bool>,
    pub input: Option<Vec<String>>,
    pub cost_input: Option<f64>,
    pub cost_output: Option<f64>,
    pub cost_cache_read: Option<f64>,
    pub cost_cache_write: Option<f64>,
    /// cost 块含嵌套分层价（如 longContext）：读侧四费用为 None，写侧整模型拒改。
    #[serde(default)]
    pub cost_tiered: bool,
}

/// `get_model_specs` 返回（`available=false` 为正常空状态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpecsResult {
    pub path: String,
    pub available: bool,
    pub revision: String,
    pub specs: Vec<ModelSpec>,
    pub error: Option<String>,
}

/// 费用整体替换（必须四个数字齐全，见 CONTRACT §21）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostPatch {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// 规格补丁：`None` 字段不触碰。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpecPatch {
    pub name: Option<String>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub reasoning: Option<bool>,
    pub input: Option<Vec<String>>,
    pub cost: Option<ModelCostPatch>,
}

/// `update_model_spec` 请求：`expected_revision` 为文件字节 SHA256。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpecPatchRequest {
    pub provider: String,
    pub id: String,
    pub patch: ModelSpecPatch,
    pub expected_revision: String,
}

/// `update_model_spec` 返回：新 revision + 写后规格 + 备份路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpecUpdateResult {
    pub revision: String,
    pub spec: ModelSpec,
    pub backup_path: String,
}
