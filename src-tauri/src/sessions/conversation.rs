//! 只读会话预览（CONTRACT §4.3）：根 → 目标节点的保留条目映射。

use std::collections::HashMap;
use std::path::Path;

use crate::model::{
    AppError, AssistantBlock, AssistantItem, BashExecutionItem, BranchSummaryItem, CompactionItem,
    Conversation, ConversationItem, ErrorCode, OtherItem, ToolResultItem, UserItem,
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
    let mut items = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Some(e) = by_id.get(id.as_str()) {
            if let Some(item) = map_entry(e) {
                items.push(item);
            }
        }
    }
    Ok(Conversation {
        path: validated_path.to_string_lossy().into_owned(),
        leaf_id: idx.leaf_id.clone(),
        target_id: target,
        items,
    })
}

/// 保留条目 → 会话条目（kept 类型必有映射；防御性返回 None 时跳过）。
fn map_entry(e: &RawEntry) -> Option<ConversationItem> {
    match e.entry_type.as_str() {
        "message" => map_message(e),
        "compaction" => Some(ConversationItem::Compaction(CompactionItem {
            summary: e
                .value
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })),
        "branch_summary" => Some(ConversationItem::BranchSummary(BranchSummaryItem {
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

fn map_message(e: &RawEntry) -> Option<ConversationItem> {
    let m = e.value.get("message")?;
    Some(match message_role(e) {
        "user" => ConversationItem::User(UserItem {
            text: m.get("content").map(joined_text).unwrap_or_default(),
        }),
        "assistant" => ConversationItem::Assistant(AssistantItem {
            blocks: assistant_blocks(m.get("content")),
        }),
        "toolResult" => {
            let text = m.get("content").map(joined_text).unwrap_or_default();
            let (text, truncated) = truncate_bytes(&text, MAX_TEXT_BYTES, TRUNC_SUFFIX);
            ConversationItem::ToolResult(ToolResultItem {
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
            })
        }
        "bashExecution" => {
            let output = m.get("output").and_then(|v| v.as_str()).unwrap_or("");
            let (text, truncated) = truncate_bytes(output, MAX_TEXT_BYTES, TRUNC_SUFFIX);
            ConversationItem::BashExecution(BashExecutionItem {
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
            role: role.to_string(),
            text: truncate_chars(
                &m.get("content").map(joined_text).unwrap_or_default(),
                OTHER_TEXT_CHARS,
            ),
        }),
    })
}

/// assistant 内容块映射：未知块类型跳过。
fn assistant_blocks(content: Option<&serde_json::Value>) -> Vec<AssistantBlock> {
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
            Some("toolCall") => out.push(AssistantBlock::ToolCall {
                id: b
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: b
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                args: b
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            }),
            _ => {}
        }
    }
    out
}
