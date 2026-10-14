//! 会话文件解析与树索引（CONTRACT §2 / §5）。
//!
//! 单遍流式读取（BufReader 逐行），宽容解析：坏行计数跳过。
//! 树索引由 [`build_index`] 构造，供 list / conversation / tree 共用。

use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::Path;

use crate::model::{AppError, ErrorCode};

/// 保留为可见节点的条目类型（CONTRACT §2.7）。
pub fn is_kept_type(t: &str) -> bool {
    matches!(t, "message" | "compaction" | "branch_summary")
}

/// 解析后的一行条目（title 记录与 header 除外）。
pub struct RawEntry {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub entry_type: String,
    pub value: serde_json::Value,
}

/// 单遍解析结果。
pub struct ParsedFile {
    /// 首行 title 记录的 `.title`（无则 None）。
    pub title_record: Option<String>,
    /// header 的原始 JSON（无则 None）。
    pub header: Option<serde_json::Value>,
    /// title/header 之外的全部合法行（含跳过类型）。
    pub entries: Vec<RawEntry>,
    /// 跳过的坏行数（非 JSON / 无 `type` 字符串）。
    pub bad_lines: u64,
    /// 文件是否以 `\n` 结尾（空文件视为 true）。
    pub ends_with_newline: bool,
}

fn entry_id(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(|s| s.to_string())
}

/// 流式解析整个文件（一次性打开，按行处理，不做二次全量序列化）。
pub fn parse_file(path: &Path) -> Result<ParsedFile, AppError> {
    let mut file = std::fs::File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                ErrorCode::NotFound,
                format!("会话文件不存在：{}", path.display()),
            )
        } else {
            AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
        }
    })?;
    // 是否以换行结尾：只看最后一个字节，之后倒回文件头。
    let ends_with_newline = {
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len == 0 {
            true
        } else {
            use std::io::{Read, Seek};
            let mut buf = [0u8; 1];
            file.seek(std::io::SeekFrom::End(-1)).map_err(|e| {
                AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
            })?;
            file.read_exact(&mut buf).map_err(|e| {
                AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
            })?;
            file.seek(std::io::SeekFrom::Start(0)).map_err(|e| {
                AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
            })?;
            buf[0] == b'\n'
        }
    };

    let mut out = ParsedFile {
        title_record: None,
        header: None,
        entries: Vec::new(),
        bad_lines: 0,
        ends_with_newline,
    };
    let mut first_line = true;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines() {
        let line = line.map_err(|e| {
            AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                out.bad_lines += 1;
                continue;
            }
        };
        let t = v.get("type").and_then(|t| t.as_str());
        let t = match t {
            Some(t) => t,
            None => {
                out.bad_lines += 1;
                continue;
            }
        };
        if first_line && t == "title" {
            first_line = false;
            out.title_record = v
                .get("title")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
            continue;
        }
        first_line = false;
        if t == "session" && out.header.is_none() {
            out.header = Some(v);
            continue;
        }
        out.entries.push(RawEntry {
            id: entry_id(&v, "id"),
            parent_id: entry_id(&v, "parentId"),
            entry_type: t.to_string(),
            value: v,
        });
    }
    Ok(out)
}

/// 保留树索引（CONTRACT §5）。
pub struct TreeIndex {
    /// kept 节点 id → 文件顺序下标（entries 内）。
    pub kept_pos: HashMap<String, usize>,
    /// 文件顺序的 kept 节点 id。
    pub kept_order: Vec<String>,
    /// kept 节点 id → 重链接后的 kept 父（无则 None）。
    pub kept_parent: HashMap<String, Option<String>>,
    /// kept 节点 id → 子节点 id（文件顺序）。
    pub children: HashMap<String, Vec<String>>,
    /// label 目标 id → 最新 label（None = 被清除）。
    pub labels: HashMap<String, Option<String>>,
    /// 文件末物理条目向上最近的保留节点。
    pub leaf_id: Option<String>,
    /// 文件内全部条目 id（含跳过类型，用于 marker id 唯一性）。
    pub all_ids: HashSet<String>,
    /// 全部条目 id → 其 parentId（首次出现为准）。
    all_parent: HashMap<String, Option<String>>,
}

impl TreeIndex {
    fn resolve_parent(&self, own_id: &str, parent: Option<&str>) -> Option<String> {
        let mut cur = parent.map(|s| s.to_string());
        let mut seen = HashSet::new();
        while let Some(pid) = cur {
            if pid == own_id {
                return None; // 自环 → 根
            }
            if self.kept_pos.contains_key(&pid) {
                return Some(pid);
            }
            if !seen.insert(pid.clone()) {
                return None; // 环 → 根
            }
            cur = self.all_parent.get(&pid).cloned().flatten(); // 悬空 → None → 根
        }
        None
    }

    /// 从某 id 沿 kept 父上溯（环保护），返回 id 序列（起点在前）。
    pub fn walk_up(&self, start: &str) -> Vec<String> {
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let mut cur = Some(start.to_string());
        while let Some(id) = cur {
            if !seen.insert(id.clone()) {
                break;
            }
            path.push(id.clone());
            cur = self.kept_parent.get(&id).cloned().flatten();
        }
        path
    }
}

/// 由解析结果建索引：跳过非保留类型并重链接，收集 label，定 leaf。
pub fn build_index(parsed: &ParsedFile) -> TreeIndex {
    let mut idx = TreeIndex {
        kept_pos: HashMap::new(),
        kept_order: Vec::new(),
        kept_parent: HashMap::new(),
        children: HashMap::new(),
        labels: HashMap::new(),
        leaf_id: None,
        all_ids: HashSet::new(),
        all_parent: HashMap::new(),
    };
    // 第一遍：登记全部 id 与 label。
    for (i, e) in parsed.entries.iter().enumerate() {
        if let Some(id) = &e.id {
            idx.all_ids.insert(id.clone());
            idx.all_parent
                .entry(id.clone())
                .or_insert_with(|| e.parent_id.clone());
            let _ = i;
        }
        if e.entry_type == "label" {
            if let Some(target) = e.value.get("targetId").and_then(|v| v.as_str()) {
                let label = e
                    .value
                    .get("label")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                idx.labels.insert(target.to_string(), label);
            }
        }
    }
    // 第二遍：kept 节点与重链接。
    for (i, e) in parsed.entries.iter().enumerate() {
        let Some(id) = &e.id else { continue }; // 无 id 行不参与树
        if !is_kept_type(&e.entry_type) {
            continue;
        }
        if idx.kept_pos.contains_key(id) {
            continue; // 重复 id：首次出现为准
        }
        idx.kept_pos.insert(id.clone(), i);
        idx.kept_order.push(id.clone());
        idx.children.entry(id.clone()).or_default();
    }
    for id in idx.kept_order.clone() {
        let pos = idx.kept_pos[&id];
        let parent = idx.resolve_parent(&id, parsed.entries[pos].parent_id.as_deref());
        idx.kept_parent.insert(id.clone(), parent.clone());
        if let Some(p) = parent {
            idx.children.entry(p).or_default().push(id);
        }
    }
    // leaf：文件末有 id 条目向上最近的保留节点。
    idx.leaf_id = parsed
        .entries
        .iter()
        .rev()
        .find_map(|e| e.id.as_deref())
        .and_then(|last| {
            if idx.kept_pos.contains_key(last) {
                Some(last.to_string())
            } else {
                // 沿全部父链上溯找 kept（跳过节点之上）。
                let mut cur = idx.all_parent.get(last).cloned().flatten();
                let mut seen = HashSet::new();
                while let Some(pid) = cur {
                    if idx.kept_pos.contains_key(&pid) {
                        return Some(pid);
                    }
                    if !seen.insert(pid.clone()) {
                        break;
                    }
                    cur = idx.all_parent.get(&pid).cloned().flatten();
                }
                None
            }
        });
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn entry(id: &str, parent: Option<&str>, t: &str) -> RawEntry {
        RawEntry {
            id: Some(id.into()),
            parent_id: parent.map(|s| s.into()),
            entry_type: t.into(),
            value: serde_json::json!({"type": t, "id": id}),
        }
    }

    fn parsed(entries: Vec<RawEntry>) -> ParsedFile {
        ParsedFile {
            title_record: None,
            header: None,
            entries,
            bad_lines: 0,
            ends_with_newline: true,
        }
    }

    #[test]
    fn relinks_through_skipped_custom() {
        // assistant → custom(tool_execution_start) → toolResult
        let p = parsed(vec![
            entry("a", None, "message"),
            entry("c", Some("a"), "custom"),
            entry("t", Some("c"), "message"),
        ]);
        let idx = build_index(&p);
        assert_eq!(idx.kept_parent["t"], Some("a".to_string()));
        assert_eq!(idx.children["a"], vec!["t".to_string()]);
        assert_eq!(idx.leaf_id, Some("t".to_string()));
    }

    #[test]
    fn dangling_and_cycle() {
        let p = parsed(vec![
            entry("d", Some("missing"), "message"),
            entry("x", Some("y"), "message"),
            entry("y", Some("x"), "message"),
            entry("s", Some("s"), "message"),
        ]);
        let idx = build_index(&p);
        // 悬空 → 根；自环 → 根
        assert_eq!(idx.kept_parent["d"], None);
        assert_eq!(idx.kept_parent["s"], None);
        // kept 环：链接保留（与 omp 一致），walk 时遇重复截断
        assert_eq!(idx.kept_parent["x"], Some("y".to_string()));
        assert_eq!(idx.kept_parent["y"], Some("x".to_string()));
        assert_eq!(idx.walk_up("x"), vec!["x".to_string(), "y".to_string()]);
    }

    #[test]
    fn entries_without_id_ignored() {
        let mut p = parsed(vec![entry("a", None, "message")]);
        p.entries.push(RawEntry {
            id: None,
            parent_id: None,
            entry_type: "custom_message".into(),
            value: serde_json::json!({"type": "custom_message"}),
        });
        let idx = build_index(&p);
        assert_eq!(idx.kept_order, vec!["a".to_string()]);
        assert!(idx.all_ids.contains("a"));
        assert_eq!(idx.all_ids.len(), 1);
    }
}
