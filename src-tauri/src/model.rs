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
}
