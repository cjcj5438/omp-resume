//! 会话列表（CONTRACT §4.2）：扫描、摘要、分组、排序、隐藏规则。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::model::{
    AppError, ErrorCode, ForkInfo, ListSessionsResult, ProjectGroup, SessionSummary,
};

use super::parse::{self, ParsedFile, TreeIndex};
use super::{
    file_size, joined_text, mtime_iso, session_id_of, truncate_chars, FIRST_USER_MESSAGE_CHARS,
    TITLE_FALLBACK_CHARS, UNTITLED,
};

fn is_top_jsonl(name: &str) -> bool {
    name.ends_with(".jsonl") && !name.starts_with('.') && name.len() > ".jsonl".len()
}

/// 列出全部会话（每个文件只解析一次）。
pub fn list_sessions(cfg: &Config) -> Result<ListSessionsResult, AppError> {
    let root = std::fs::canonicalize(&cfg.sessions_dir).map_err(|e| {
        AppError::new(
            ErrorCode::Io,
            format!("会话根目录不可用：{}：{e}", cfg.sessions_dir.display()),
        )
    })?;
    // 第一遍：各项目目录顶层 .jsonl（忽略点文件、嵌套目录、.bak）。
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let dirs = std::fs::read_dir(&root)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法扫描 {}：{e}", root.display())))?;
    for dir in dirs {
        let dir = dir.map_err(|e| {
            AppError::new(ErrorCode::Io, format!("无法扫描 {}：{e}", root.display()))
        })?;
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = dir.file_name().to_string_lossy().into_owned();
        if dir_name.starts_with('.') {
            continue;
        }
        let entries = std::fs::read_dir(dir.path()).map_err(|e| {
            AppError::new(
                ErrorCode::Io,
                format!("无法扫描 {}：{e}", dir.path().display()),
            )
        })?;
        for ent in entries {
            let ent =
                ent.map_err(|e| AppError::new(ErrorCode::Io, format!("无法扫描目录：{e}")))?;
            if !ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue; // sibling artifacts 目录、嵌套会话一律忽略
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            if !is_top_jsonl(&name) {
                continue;
            }
            files.push((dir_name.clone(), ent.path()));
        }
    }

    // 第二遍：逐文件一次解析 → 摘要；同时建 fork 用全局表。
    struct Row {
        dir_name: String,
        id: String,
        path: PathBuf,
        parent_raw: Option<String>,
        summary: Option<SessionSummary>,
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut hidden_empty: u64 = 0;
    for (dir_name, path) in &files {
        let parsed = parse::parse_file(path)?;
        let modified_at = mtime_iso(path)?;
        let size_bytes = file_size(path)?;
        let id = session_id_of(&parsed, path);
        let parent_raw = parsed
            .header
            .as_ref()
            .and_then(|h| h.get("parentSession"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let summary = summarize(path, &parsed, size_bytes, &modified_at, cfg);
        if summary.is_none() {
            hidden_empty += 1;
        }
        rows.push(Row {
            dir_name: dir_name.clone(),
            id,
            path: path.clone(),
            parent_raw,
            summary,
        });
    }

    // id → (标题, 路径)：含被隐藏会话（标题未知则空串，fork 显示 null 标题）。
    let mut id_map: HashMap<String, (String, PathBuf)> = HashMap::new();
    for r in &rows {
        let title = r
            .summary
            .as_ref()
            .map(|s| s.title.clone())
            .unwrap_or_default();
        id_map.insert(r.id.clone(), (title, r.path.clone()));
    }

    // 补 fork 字段并分组（组内 modifiedAt 倒序；组按最新会话倒序）。
    // 占用者回填：仅当 ≥1 可见 in-use 会话时做一次 lsof 批量查询（CONTRACT §3.1）；
    // 失败静默降级（occupant 保持 None），不影响 in_use / probe_ok。
    let in_use_ids: Vec<String> = rows
        .iter()
        .filter(|r| r.summary.as_ref().is_some_and(|s| s.in_use))
        .map(|r| r.id.clone())
        .collect();
    let occupants = crate::occupant::resolve_occupants(&cfg.owners_dir, &in_use_ids);
    let mut groups: HashMap<String, Vec<SessionSummary>> = HashMap::new();
    for r in rows {
        let Some(mut s) = r.summary else { continue };
        if let Some(raw) = r.parent_raw {
            s.fork = Some(resolve_fork(&raw, &id_map));
        }
        if s.in_use {
            s.occupant = occupants.get(&s.id).cloned();
        }
        groups.entry(r.dir_name).or_default().push(s);
    }
    let mut out: Vec<ProjectGroup> = Vec::new();
    for (dir_name, mut sessions) in groups {
        sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(b.path.cmp(&a.path)));
        // 组 cwd 取最新会话的 cwd（同目录 header 通常一致）。
        let cwd = sessions.first().map(|s| s.cwd.clone()).unwrap_or_default();
        out.push(ProjectGroup {
            cwd,
            dir_name,
            sessions,
        });
    }
    out.sort_by(|a, b| {
        let am = a
            .sessions
            .first()
            .map(|s| s.modified_at.clone())
            .unwrap_or_default();
        let bm = b
            .sessions
            .first()
            .map(|s| s.modified_at.clone())
            .unwrap_or_default();
        bm.cmp(&am).then(a.dir_name.cmp(&b.dir_name))
    });

    Ok(ListSessionsResult {
        sessions_dir: root.to_string_lossy().into_owned(),
        hidden_empty,
        groups: out,
    })
}

/// parentSession 解析：id 命中表 → 标题/路径；绝对（或根相对）存在的
/// `.jsonl` 路径 → 廉价标题；否则 nulls。`previousSessionFiles` 不是 fork。
fn resolve_fork(raw: &str, id_map: &HashMap<String, (String, PathBuf)>) -> ForkInfo {
    if let Some((title, path)) = id_map.get(raw) {
        return ForkInfo {
            parent_raw: raw.to_string(),
            parent_title: if title.is_empty() {
                None
            } else {
                Some(title.clone())
            },
            parent_path: Some(path.to_string_lossy().into_owned()),
        };
    }
    let p = Path::new(raw);
    if p.extension().map(|e| e == "jsonl").unwrap_or(false) && p.is_absolute() && p.is_file() {
        let title = cheap_title(p).filter(|t| !t.is_empty());
        return ForkInfo {
            parent_raw: raw.to_string(),
            parent_title: title,
            parent_path: Some(p.to_string_lossy().into_owned()),
        };
    }
    ForkInfo {
        parent_raw: raw.to_string(),
        parent_title: None,
        parent_path: None,
    }
}

/// 只读 title 行 + header 的廉价标题。
fn cheap_title(path: &Path) -> Option<String> {
    let content = std::fs::read(path).ok()?;
    let mut lines = content.split(|&b| b == b'\n');
    for line in [lines.next()?, lines.next()?] {
        let v: serde_json::Value = serde_json::from_slice(line).ok()?;
        let kind = v.get("type").and_then(|t| t.as_str());
        let t = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
        if (kind == Some("title") || kind == Some("session")) && !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

/// 单文件摘要；隐藏规则（无标题且零用户消息）命中时返回 None。
#[allow(clippy::too_many_arguments)]
fn summarize(
    path: &Path,
    parsed: &ParsedFile,
    size_bytes: u64,
    modified_at: &str,
    cfg: &Config,
) -> Option<SessionSummary> {
    let id = session_id_of(parsed, path);
    let cwd = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cwd_exists = !cwd.is_empty() && Path::new(&cwd).is_dir();
    let version = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("version"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);
    let created_at = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("timestamp"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let probe = crate::lock::probe(&cfg.owners_dir, &id);
    let base = |title: String| SessionSummary {
        id: id.clone(),
        path: path.to_string_lossy().into_owned(),
        cwd: cwd.clone(),
        cwd_exists,
        title,
        created_at: created_at.clone(),
        modified_at: modified_at.to_string(),
        size_bytes,
        message_count: 0,
        branch_count: 0,
        in_use: probe.in_use,
        probe_ok: probe.probe_ok,
        occupant: None, // list_sessions 末尾统一回填（需一次 lsof 查全部 in-use 会话）
        fork: None,     // 调用方统一补（需要全局 id 表）
        format_supported: version == Some(3),
        version,
        bad_lines: parsed.bad_lines,
        first_user_message: None,
    };

    if version != Some(3) {
        // 降级：只填廉价字段（title 行 + header），无预览/树。
        let mut title = parsed.title_record.clone().unwrap_or_default();
        if title.is_empty() {
            title = parsed
                .header
                .as_ref()
                .and_then(|h| h.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
        if title.is_empty() {
            return None; // 无标题（降级不计消息）→ 隐藏
        }
        return Some(base(title));
    }

    let idx = parse::build_index(parsed);
    summarize_v3(parsed, &idx, base)
}

/// v3 摘要（需要树索引）。
fn summarize_v3(
    parsed: &ParsedFile,
    idx: &TreeIndex,
    make: impl FnOnce(String) -> SessionSummary,
) -> Option<SessionSummary> {
    // 全文件 user 消息计数（隐藏规则用）。
    let mut total_user = 0u64;
    for e in &parsed.entries {
        if e.entry_type == "message" && message_role(e) == Some("user") {
            total_user += 1;
        }
    }
    // active 路径（leaf→根），反转为根→leaf。
    let active: Vec<String> = idx
        .leaf_id
        .as_deref()
        .map(|l| idx.walk_up(l))
        .unwrap_or_default();
    let by_id: HashMap<&str, &parse::RawEntry> = parsed
        .entries
        .iter()
        .filter_map(|e| e.id.as_deref().map(|id| (id, e)))
        .collect();

    let mut message_count = 0u64;
    let mut first_user: Option<String> = None;
    for eid in active.iter().rev() {
        let Some(e) = by_id.get(eid.as_str()) else {
            continue;
        };
        match message_role(e) {
            Some("user") => {
                message_count += 1;
                if first_user.is_none() {
                    let t = e
                        .value
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .map(joined_text)
                        .unwrap_or_default();
                    if !t.trim().is_empty() {
                        first_user = Some(truncate_chars(&t, FIRST_USER_MESSAGE_CHARS));
                    }
                }
            }
            Some("assistant") => message_count += 1,
            _ => {}
        }
    }
    let branch_count = idx
        .kept_order
        .iter()
        .filter(|id| idx.children.get(*id).map(|c| c.is_empty()).unwrap_or(true))
        .count() as u64;

    let title = resolve_title(parsed, first_user.as_deref());
    if title.is_empty() && total_user == 0 {
        return None; // 隐藏：无标题且零用户消息
    }
    let title = if title.is_empty() {
        UNTITLED.to_string()
    } else {
        title
    };
    let mut out = make(title);
    out.message_count = message_count;
    out.first_user_message = first_user;
    out.branch_count = branch_count;
    Some(out)
}

fn message_role(e: &parse::RawEntry) -> Option<&str> {
    e.value.get("message")?.get("role")?.as_str()
}

/// 标题：最后一个非空（title 行 → header → title_change 顺序），
/// 全空 → 首用户消息 60 字 → ""（调用方兜底 `(无标题)`）。
fn resolve_title(parsed: &ParsedFile, first_user: Option<&str>) -> String {
    let mut title = parsed.title_record.clone().unwrap_or_default();
    if let Some(h) = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("title"))
        .and_then(|v| v.as_str())
    {
        if !h.is_empty() {
            title = h.to_string();
        }
    }
    for e in &parsed.entries {
        if e.entry_type == "title_change" {
            if let Some(t) = e.value.get("title").and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    title = t.to_string();
                }
            }
        }
    }
    if !title.is_empty() {
        return title;
    }
    first_user
        .map(|t| truncate_chars(t, TITLE_FALLBACK_CHARS))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn top_jsonl_filter() {
        assert!(is_top_jsonl("2026-10-14T02-18-47-387Z_abc.jsonl"));
        assert!(!is_top_jsonl(".a.jsonl.lock.os"));
        assert!(!is_top_jsonl("a.jsonl.123.bak"));
        assert!(!is_top_jsonl("a.json"));
        assert!(!is_top_jsonl(".jsonl"));
    }

    fn write_session(proj: &std::path::Path, name: &str, id: &str) {
        std::fs::create_dir_all(proj).unwrap();
        let lines = [
            serde_json::json!({"type":"title","v":1,"title":"占用者测试","source":"auto","updatedAt":"2026-10-14T00:00:00.000Z","pad":"   "}).to_string(),
            serde_json::json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-14T00:00:00.000Z","cwd":"/tmp"}).to_string(),
            serde_json::json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-10-14T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}).to_string(),
        ];
        std::fs::write(proj.join(name), lines.join("\n") + "\n").unwrap();
    }

    fn only_session(result: &ListSessionsResult) -> SessionSummary {
        assert_eq!(result.hidden_empty, 0);
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].sessions.len(), 1);
        result.groups[0].sessions[0].clone()
    }

    #[test]
    fn free_session_has_no_occupant() {
        let t = tempfile::tempdir().unwrap();
        let sessions = t.path().join("sessions");
        write_session(
            &sessions.join("-p"),
            "2026-10-14T00-00-00-000Z_sess-occ-free.jsonl",
            "sess-occ-free",
        );
        let cfg = Config {
            sessions_dir: sessions,
            owners_dir: t.path().join("owners"),
        };
        let s = only_session(&list_sessions(&cfg).unwrap());
        assert!(!s.in_use && s.probe_ok);
        assert!(s.occupant.is_none());
    }

    /// 持锁（子线程 flock）→ `in_use` 仍为 true（占用者 machinery 不影响写门禁）；
    /// `lsof` 若找到持锁者，PID 必为测试进程自身，否则降级为 None。
    #[test]
    fn held_lock_keeps_in_use_with_matching_or_absent_occupant() {
        use std::os::unix::io::AsRawFd;
        use std::sync::mpsc;
        let t = tempfile::tempdir().unwrap();
        let sessions = t.path().join("sessions");
        write_session(
            &sessions.join("-p"),
            "2026-10-14T00-00-00-000Z_sess-occ-held.jsonl",
            "sess-occ-held",
        );
        let owners = t.path().join("owners");
        std::fs::create_dir_all(&owners).unwrap();
        let lock_path = owners.join("sess-occ-held.lock");
        std::fs::write(&lock_path, "").unwrap();
        let (tx, rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let f = std::fs::OpenOptions::new()
                .read(true)
                .open(&lock_path)
                .unwrap();
            let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
            assert_eq!(rc, 0);
            tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(10));
            unsafe {
                libc::flock(f.as_raw_fd(), libc::LOCK_UN);
            }
        });
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        let cfg = Config {
            sessions_dir: sessions,
            owners_dir: owners,
        };
        let s = only_session(&list_sessions(&cfg).unwrap());
        assert!(s.in_use && s.probe_ok);
        if let Some(o) = &s.occupant {
            // 持锁的正是本测试进程：lsof 必须指回自己，而非别的进程。
            assert_eq!(o.pid, std::process::id());
        }
        std::mem::forget(holder);
    }
}
