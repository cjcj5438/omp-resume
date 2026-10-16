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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProject {
    pub cwd: String,
    pub cost: f64,
    pub tokens: UsageTokens,
    pub sessions: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub date: String,
    pub cost: f64,
    pub tokens: UsageTokens,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub total: SessionUsage,
    pub by_project: Vec<UsageProject>,
    pub by_model: Vec<UsageModel>,
    pub by_day: Vec<UsageDay>,
}
