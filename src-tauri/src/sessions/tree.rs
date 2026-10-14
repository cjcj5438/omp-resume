//! 树视图（CONTRACT §4.4）：扁平节点表，链折叠由前端完成。

use std::collections::HashMap;
use std::path::Path;

use crate::model::{AppError, ErrorCode, TreeData, TreeNode, TreeNodeKind};

use super::parse::{self, RawEntry};
use super::{joined_text, truncate_chars, TREE_PREVIEW_CHARS};

/// 树数据：`path` 须已校验。非 v3 → `UNSUPPORTED_FORMAT`。
pub fn get_tree(validated_path: &Path) -> Result<TreeData, AppError> {
    let parsed = parse::parse_file(validated_path)?;
    let version = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("version"))
        .and_then(|v| v.as_u64());
    if version != Some(3) {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            "仅支持 version 3 会话建树",
        ));
    }
    let idx = parse::build_index(&parsed);
    let by_id: HashMap<&str, &RawEntry> = parsed
        .entries
        .iter()
        .filter_map(|e| e.id.as_deref().map(|id| (id, e)))
        .collect();

    let mut nodes = Vec::with_capacity(idx.kept_order.len());
    let mut root_ids = Vec::new();
    for id in &idx.kept_order {
        let e = by_id.get(id.as_str()).expect("kept 节点必有条目");
        let parent = idx.kept_parent.get(id).cloned().flatten();
        if parent.is_none() {
            root_ids.push(id.clone());
        }
        let (kind, role) = match e.entry_type.as_str() {
            "compaction" => (TreeNodeKind::Compaction, None),
            "branch_summary" => (TreeNodeKind::BranchSummary, None),
            _ => (TreeNodeKind::Message, Some(message_role(e).to_string())),
        };
        nodes.push(TreeNode {
            id: id.clone(),
            parent_id: parent,
            child_ids: idx.children.get(id).cloned().unwrap_or_default(),
            kind,
            role,
            timestamp: e
                .value
                .get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            preview: preview(e),
            label: idx.labels.get(id).cloned().flatten(),
            is_compaction: matches!(kind, TreeNodeKind::Compaction),
            is_branch_summary: matches!(kind, TreeNodeKind::BranchSummary),
        });
    }
    let active_path_ids = idx
        .leaf_id
        .as_deref()
        .map(|l| idx.walk_up(l))
        .unwrap_or_default();
    Ok(TreeData {
        path: validated_path.to_string_lossy().into_owned(),
        leaf_id: idx.leaf_id.clone(),
        root_ids,
        active_path_ids,
        nodes,
    })
}

fn message_role(e: &RawEntry) -> &str {
    e.value
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        .unwrap_or("")
}

/// 节点预览（≤80 字，规则见 CONTRACT §4.4）。
fn preview(e: &RawEntry) -> String {
    let head = match e.entry_type.as_str() {
        "compaction" | "branch_summary" => e
            .value
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "message" => message_preview(e),
        _ => String::new(),
    };
    truncate_chars(head.trim(), TREE_PREVIEW_CHARS)
}

fn first_text(content: Option<&serde_json::Value>) -> Option<String> {
    let arr = content?.as_array()?;
    arr.iter().find_map(|b| {
        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
            b.get("text")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        } else {
            None
        }
    })
}

fn message_preview(e: &RawEntry) -> String {
    let m = match e.value.get("message") {
        Some(m) => m,
        None => return String::new(),
    };
    let content = m.get("content");
    match message_role(e) {
        "user" => first_text(content).unwrap_or_default(),
        "assistant" => {
            if let Some(t) = first_text(content) {
                return t;
            }
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                if let Some(th) = arr.iter().find_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("thinking") {
                        b.get("thinking").and_then(|v| v.as_str())
                    } else {
                        None
                    }
                }) {
                    return th.to_string();
                }
                let names: Vec<&str> = arr
                    .iter()
                    .filter_map(|b| {
                        if b.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                            b.get("name").and_then(|v| v.as_str())
                        } else {
                            None
                        }
                    })
                    .collect();
                if !names.is_empty() {
                    return names.join(", ");
                }
            }
            String::new()
        }
        "toolResult" => content.map(joined_text).unwrap_or_default(),
        "bashExecution" => {
            let cmd = m.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let out = m.get("output").and_then(|v| v.as_str()).unwrap_or("");
            if out.trim().is_empty() {
                cmd.to_string()
            } else {
                // 取 output 头部（按行首段，避免巨输出；最终仍 80 字截断）。
                let head: String = out.chars().take(200).collect();
                format!("{cmd} {head}")
            }
        }
        _ => content.map(joined_text).unwrap_or_default(),
    }
}
