//! 只读会话预览（CONTRACT §4.3）：根 → 目标节点的保留条目映射。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::model::{
    AppError, AssistantBlock, AssistantItem, BashExecutionItem, BranchSummaryItem, CompactionItem,
    Conversation, ConversationItem, ErrorCode, OtherItem, ToolResultItem, UsageItem, UserItem,
};

use super::parse::{self, RawEntry};
use super::{joined_text, truncate_chars, MAX_TEXT_BYTES, OTHER_TEXT_CHARS, TRUNC_SUFFIX};
use crate::util::truncate_bytes;

/// 会话预览：`path` 须已校验。`node_id` 缺省为 active leaf。
/// 非 v3 → `UNSUPPORTED_FORMAT`；空文件（无保留节点）→ 空 items。
pub fn get_conversation(
    validated_path: &Path,
    node_id: Option<&str>,
) -> Result<Conversation, AppError> {
    let parsed = parse::parse_file(validated_path)?;
    let version = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("version"))
        .and_then(|v| v.as_u64());
    if version != Some(3) {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            "仅支持 version 3 会话预览",
        ));
    }
    let idx = parse::build_index(&parsed);
    let target = match (node_id, &idx.leaf_id) {
        (Some(n), _) if idx.kept_pos.contains_key(n) => n.to_string(),
        (Some(_), _) => {
            return Err(AppError::new(
                ErrorCode::InvalidNode,
                "未知节点（非保留条目或不存在）",
            ));
        }
        (None, Some(leaf)) => leaf.clone(),
        (None, None) => {
            return Ok(Conversation {
                path: validated_path.to_string_lossy().into_owned(),
                leaf_id: None,
                target_id: String::new(),
                branch_point_id: None,
                items: Vec::new(),
            });
        }
    };
    let by_id: HashMap<&str, &RawEntry> = parsed
        .entries
        .iter()
        .filter_map(|e| e.id.as_deref().map(|id| (id, e)))
        .collect();
    // walk_up 起点在前 → 反转为根→目标。
    let ids: Vec<String> = idx.walk_up(&target).into_iter().rev().collect();
    // root→target 上每个 kept 节点的 items 下标（重 parentId 无 children 时回退文件顺序）。
    let mut kept_seq: HashMap<&str, usize> = HashMap::new();
    for (i, id) in ids.iter().enumerate() {
        kept_seq.entry(id.as_str()).or_insert(i);
    }
    // toolCallId → (toolResult 全集) / tool_execution_start 全集。
    let mut results: HashSet<&str> = HashSet::new();
    let mut starts: HashMap<&str, String> = HashMap::new();
    for e in &parsed.entries {
        if e.entry_type == "message" {
            if let Some(m) = e.value.get("message") {
                if m.get("role").and_then(|r| r.as_str()) == Some("toolResult") {
                    if let Some(cid) = m.get("toolCallId").and_then(|v| v.as_str()) {
                        results.insert(cid);
                    }
                }
            }
        } else if e.entry_type == "custom"
            && e.value.get("customType").and_then(|v| v.as_str()) == Some("tool_execution_start")
        {
            let data = e.value.get("data");
            if let (Some(cid), Some(at)) = (
                data.and_then(|d| d.get("toolCallId"))
                    .and_then(|v| v.as_str()),
                data.and_then(|d| d.get("startedAt"))
                    .and_then(|v| v.as_str()),
            ) {
                starts.entry(cid).or_insert_with(|| at.to_string());
            }
        }
    }
    let mut items = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Some(e) = by_id.get(id.as_str()) {
            if let Some(item) = map_entry(
                e,
                &Context {
                    results: &results,
                    starts: &starts,
                },
            ) {
                items.push(item);
            }
        }
    }
    // B6：usage 插入——按文件顺序，位于目标条目（含）之前的 model_usage 行。
    let target_seq = kept_seq.get(target.as_str()).copied().unwrap_or(usize::MAX);
    let mut insertions: Vec<(usize, ConversationItem)> = Vec::new();
    for e in &parsed.entries {
        if e.entry_type != "model_usage" {
            continue;
        }
        let pos = position_of(e, &kept_seq, target_seq);
        let Some(pos) = pos else { continue };
        if let Some(item) = map_usage(e) {
            insertions.push((pos, item));
        }
    }
    // 同位置多条保持文件顺序：稳定插入（pos 递增处理，后者插在前者之后）。
    insertions.sort_by_key(|(pos, _)| *pos);
    for (offset, (pos, item)) in insertions.into_iter().enumerate() {
        let at = (pos + offset).min(items.len());
        items.insert(at, item);
    }
    Ok(Conversation {
        path: validated_path.to_string_lossy().into_owned(),
        leaf_id: idx.leaf_id.clone(),
        target_id: target,
        branch_point_id: branch_point(&idx),
        items,
    })
}

/// 映射用共享上下文：全文件 toolResult 的 toolCallId 集 / start 记录。
struct Context<'a> {
    results: &'a HashSet<&'a str>,
    starts: &'a HashMap<&'a str, String>,
}

/// usage 行的插入位置：其 parentId 命中的 kept 条目之后（文件顺序号 +1）；
/// parentId 缺失/未命中 root→target 路径 → 该路径末尾（target_seq + 1）。
/// 位置超出 target → None（nodeId 预览时丢弃 target 之后的 usage）。
fn position_of(e: &RawEntry, kept_seq: &HashMap<&str, usize>, target_seq: usize) -> Option<usize> {
    let pos = e
        .parent_id
        .as_deref()
        .and_then(|p| kept_seq.get(p).copied().map(|s| s + 1))
        .unwrap_or(target_seq + 1);
    (pos <= target_seq + 1).then_some(pos)
}

/// B7：active 路径（leaf→根顺序的反转）上第一个有兄弟的节点。
fn branch_point(idx: &parse::TreeIndex) -> Option<String> {
    let leaf = idx.leaf_id.as_deref()?;
    let path: Vec<String> = idx.walk_up(leaf).into_iter().rev().collect();
    for id in path {
        let parent = idx.kept_parent.get(&id).cloned().flatten()?;
        let siblings = idx.children.get(&parent).map(|c| c.len()).unwrap_or(0);
        if siblings > 1 {
            return Some(id);
        }
    }
    None
}

/// 包络 timestamp 字符串；缺失/非字符串 → None。
fn envelope_ts(e: &RawEntry) -> Option<String> {
    e.value
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// RFC3339 → epoch 毫秒；失败 → None。
fn ts_millis(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// B5：toolResult 耗时毫秒（包络 − startedAt）；无配对/不可解析/负值 → None。
fn tool_duration(e: &RawEntry, ctx: &Context) -> Option<i64> {
    let m = e.value.get("message")?;
    let cid = m.get("toolCallId").and_then(|v| v.as_str())?;
    let start = ctx.starts.get(cid)?;
    let end = e.value.get("timestamp").and_then(|v| v.as_str())?;
    let ms = ts_millis(end)?.checked_sub(ts_millis(start)?)?;
    (ms >= 0).then_some(ms)
}

/// B6：`model_usage` 行 → usage 条目；无 id → None。
fn map_usage(e: &RawEntry) -> Option<ConversationItem> {
    let id = e.id.clone()?;
    let u = e.value.get("usage");
    let num = |k: &str| {
        u.and_then(|v| v.get(k))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    Some(ConversationItem::Usage(UsageItem {
        id,
        timestamp: envelope_ts(e),
        purpose: e
            .value
            .get("purpose")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        provider: e
            .value
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        model: e
            .value
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        input: num("input"),
        output: num("output"),
        cache_read: num("cacheRead"),
        cache_write: num("cacheWrite"),
        cost: u
            .and_then(|v| v.get("cost"))
            .and_then(|c| c.get("total"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
    }))
}

/// 保留条目 → 会话条目（kept 类型必有映射；防御性返回 None 时跳过）。
fn map_entry(e: &RawEntry, ctx: &Context) -> Option<ConversationItem> {
    match e.entry_type.as_str() {
        "message" => map_message(e, ctx),
        "compaction" => Some(ConversationItem::Compaction(CompactionItem {
            id: e.id.clone()?,
            timestamp: envelope_ts(e),
            summary: e
                .value
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })),
        "branch_summary" => Some(ConversationItem::BranchSummary(BranchSummaryItem {
            id: e.id.clone()?,
            timestamp: envelope_ts(e),
            summary: e
                .value
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })),
        _ => None,
    }
}

fn message_role(e: &RawEntry) -> &str {
    e.value
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        .unwrap_or("")
}

fn map_message(e: &RawEntry, ctx: &Context) -> Option<ConversationItem> {
    let m = e.value.get("message")?;
    let id = e.id.clone()?;
    let timestamp = envelope_ts(e);
    Some(match message_role(e) {
        "user" => ConversationItem::User(UserItem {
            id,
            timestamp,
            text: m.get("content").map(joined_text).unwrap_or_default(),
        }),
        "assistant" => ConversationItem::Assistant(AssistantItem {
            id,
            timestamp,
            blocks: assistant_blocks(m.get("content"), ctx.results),
        }),
        "toolResult" => {
            let text = m.get("content").map(joined_text).unwrap_or_default();
            let (text, truncated) = truncate_bytes(&text, MAX_TEXT_BYTES, TRUNC_SUFFIX);
            ConversationItem::ToolResult(ToolResultItem {
                id,
                timestamp,
                tool_call_id: m
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                tool_name: m
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                is_error: m.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
                text,
                truncated,
                duration_ms: tool_duration(e, ctx),
                diff: m
                    .get("details")
                    .and_then(|d| d.get("diff"))
                    .and_then(|v| v.as_str())
                    .map(|s| truncate_chars(s, OTHER_TEXT_CHARS)),
            })
        }
        "bashExecution" => {
            let output = m.get("output").and_then(|v| v.as_str()).unwrap_or("");
            let (text, truncated) = truncate_bytes(output, MAX_TEXT_BYTES, TRUNC_SUFFIX);
            ConversationItem::BashExecution(BashExecutionItem {
                id,
                timestamp,
                command: m
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                text,
                truncated,
                exit_code: m.get("exitCode").and_then(|v| v.as_i64()),
                cancelled: m
                    .get("cancelled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            })
        }
        role => ConversationItem::Other(OtherItem {
            id,
            timestamp,
            role: role.to_string(),
            text: truncate_chars(
                &m.get("content").map(joined_text).unwrap_or_default(),
                OTHER_TEXT_CHARS,
            ),
        }),
    })
}

/// assistant 内容块映射：未知块类型跳过。
fn assistant_blocks(
    content: Option<&serde_json::Value>,
    results: &HashSet<&str>,
) -> Vec<AssistantBlock> {
    let Some(arr) = content.and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for b in arr {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => out.push(AssistantBlock::Text {
                text: b
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            }),
            Some("thinking") => out.push(AssistantBlock::Thinking {
                text: b
                    .get("thinking")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            }),
            Some("toolCall") => {
                let id = b
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                out.push(AssistantBlock::ToolCall {
                    id: id.clone(),
                    name: b
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    args: b
                        .get("arguments")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                    pending: !id.is_empty() && !results.contains(id.as_str()),
                })
            }
            _ => {}
        }
    }
    out
}
