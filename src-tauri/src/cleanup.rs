//! 清理候选（CONTRACT §14）：只读扫描，列出满足任一清理规则的会话。
//!
//! 本模块**绝不删除或修改任何文件**；真正删除只走 `delete_sessions`
//! （占用门禁、路径限定、永久删除语义都在那里）。
//!
//! 体积 = 删除时会移除的字节：`<file>.jsonl` + 同 stem sibling 目录（递归，
//! 不跟随符号链接）+ `<file>.jsonl.*.bak`。sibling 若是普通文件则不计入
//! （删除时保持不动）；不可读的子目录按 0 计（尽力而为，不让整个列表失败）。
//!
//! 解析为流式单遍：逐行反序列化到只含所需字段的结构体，其余字段由 serde
//! 跳过，不构造整文件的 `Value` 树；仅首个 user 消息文本会额外解析一次。

use std::fs::File;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use crate::config::Config;
use crate::model::{AppError, CleanupCandidate, CleanupReason, ErrorCode};
use crate::sessions::{
    joined_text, mtime_iso, stem_id, truncate_chars, TITLE_FALLBACK_CHARS, UNTITLED,
};

/// `large` 原因的体积下限：总字节 ≥ 5 MiB。
pub const LARGE_MIN_BYTES: u64 = 5 * 1024 * 1024;
const SECS_PER_DAY: u64 = 86_400;

/// 计算清理候选。`now` 由调用方注入（测试可控）；`older_than_days` 为
/// `stale` 阈值；`top_n` 为按总字节排名的 `large` 名额（跨全部会话）。
/// 结果按总字节降序。
pub fn list_candidates(
    cfg: &Config,
    now: SystemTime,
    older_than_days: u32,
    top_n: u32,
) -> Result<Vec<CleanupCandidate>, AppError> {
    if older_than_days == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "超过天数须为 ≥1 的整数",
        ));
    }
    let (_root, files) = super::sessions::list::scan_top_level(&cfg.sessions_dir)?;
    let sessions = files
        .iter()
        .map(|(_, path)| scan_session(path))
        .collect::<Result<Vec<_>, _>>()?;

    let mut by_size: Vec<usize> = (0..sessions.len()).collect();
    by_size.sort_by(|&a, &b| sessions[b].bytes.cmp(&sessions[a].bytes));
    let large: Vec<usize> = by_size
        .iter()
        .take(top_n as usize)
        .copied()
        .filter(|&i| sessions[i].bytes >= LARGE_MIN_BYTES)
        .collect();
    let stale_before = now.checked_sub(Duration::from_secs(
        u64::from(older_than_days) * SECS_PER_DAY,
    ));

    let mut out = Vec::new();
    for (i, s) in sessions.iter().enumerate() {
        let mut reasons = Vec::new();
        if s.is_v3 && !s.has_user {
            reasons.push(CleanupReason::Empty);
        }
        if s.cwd_missing {
            reasons.push(CleanupReason::CwdMissing);
        }
        if large.contains(&i) {
            reasons.push(CleanupReason::Large);
        }
        if stale_before.is_some_and(|cut| s.mtime < cut) {
            reasons.push(CleanupReason::Stale);
        }
        if reasons.is_empty() {
            continue;
        }
        // 与列表/删除同一占用探测；id 同 list（header.id，缺失回退文件 stem）。
        let probe = crate::lock::probe(&cfg.owners_dir, &s.id);
        out.push(CleanupCandidate {
            path: s.path.to_string_lossy().into_owned(),
            id: s.id.clone(),
            title: s.title.clone(),
            cwd: s.cwd.clone(),
            mtime: s.mtime_iso.clone(),
            bytes: s.bytes,
            reasons,
            in_use: probe.in_use,
            probe_ok: probe.probe_ok,
        });
    }
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    Ok(out)
}

/// 单个会话的扫描事实（候选判定所需的全部输入）。
struct Scanned {
    path: PathBuf,
    id: String,
    cwd: String,
    cwd_missing: bool,
    title: String,
    mtime: SystemTime,
    mtime_iso: String,
    bytes: u64,
    /// header.version == 3；非 v3 不判定 `empty`。
    is_v3: bool,
    has_user: bool,
}

fn scan_session(path: &Path) -> Result<Scanned, AppError> {
    let meta = std::fs::metadata(path).map_err(|e| io_error(path, e))?;
    let mtime = meta.modified().map_err(|e| io_error(path, e))?;
    let facts = read_facts(path)?;
    let cwd_missing = facts.cwd.is_empty() || !Path::new(&facts.cwd).is_dir();
    let title = if facts.title.is_empty() {
        facts.first_user.unwrap_or_else(|| UNTITLED.to_string())
    } else {
        facts.title
    };
    Ok(Scanned {
        path: path.to_path_buf(),
        id: facts.id.unwrap_or_else(|| stem_id(path)),
        cwd: facts.cwd,
        cwd_missing,
        title,
        mtime,
        mtime_iso: mtime_iso(path)?,
        bytes: meta.len() + sibling_bytes(path),
        is_v3: facts.version == Some(3),
        has_user: facts.has_user,
    })
}

/// 流式解析所需的最小字段；其余字段（`content` 等）由 serde 跳过。
#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    cwd: Option<String>,
    version: Option<u64>,
    title: Option<String>,
    message: Option<Msg>,
}

#[derive(Deserialize)]
struct Msg {
    role: Option<String>,
}

/// 单遍读取得到的会话事实。
#[derive(Default)]
struct Facts {
    id: Option<String>,
    cwd: String,
    version: Option<u64>,
    /// 与 list 同一规则：title 记录 → header → title_change，取最后非空。
    title: String,
    /// 首个含文本的 user 消息，截断至标题长度（无标题兜底用）。
    first_user: Option<String>,
    has_user: bool,
}

/// 读取 header 与标题/user 事实。坏行（非 JSON / 无 type）跳过。
/// 非 v3 读到 header 即停（候选只需 cwd/mtime/体积）。
fn read_facts(path: &Path) -> Result<Facts, AppError> {
    let file = File::open(path).map_err(|e| io_error(path, e))?;
    let mut facts = Facts::default();
    let mut header_seen = false;
    let mut first_valid = true;
    for line in std::io::BufReader::new(file).lines() {
        let line = line.map_err(|e| io_error(path, e))?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Line>(&line) else {
            continue;
        };
        let Some(kind) = v.kind.as_deref() else {
            continue;
        };
        // 与 parse_file 一致：仅首个合法行为 title 记录。
        let was_first = std::mem::replace(&mut first_valid, false);
        match kind {
            "title" if was_first => set_title(&mut facts.title, v.title),
            "session" if !header_seen => {
                header_seen = true;
                facts.id = v.id;
                facts.cwd = v.cwd.unwrap_or_default();
                facts.version = v.version;
                set_title(&mut facts.title, v.title);
                if facts.version != Some(3) {
                    break;
                }
            }
            "title_change" => set_title(&mut facts.title, v.title),
            "message" if v.message.as_ref().and_then(|m| m.role.as_deref()) == Some("user") => {
                facts.has_user = true;
                if facts.first_user.is_none() {
                    facts.first_user = first_user_text(&line);
                }
            }
            _ => {}
        }
    }
    Ok(facts)
}

fn set_title(slot: &mut String, title: Option<String>) {
    if let Some(t) = title.filter(|t| !t.is_empty()) {
        *slot = t;
    }
}

/// 解析单行 user 消息的正文（仅对首个 user 消息调用一次）。
fn first_user_text(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let text = joined_text(v.get("message")?.get("content")?);
    let text = text.trim();
    (!text.is_empty()).then(|| truncate_chars(text, TITLE_FALLBACK_CHARS))
}

/// 删除时会一并移除的附属字节（不跟随符号链接）。
fn sibling_bytes(path: &Path) -> u64 {
    let (Some(parent), Some(stem), Some(file_name)) =
        (path.parent(), path.file_stem(), path.file_name())
    else {
        return 0;
    };
    let mut total = 0;
    // 同 stem sibling 目录：仅真实目录递归（符号链接只删链接本身，计 0）。
    let sibling = parent.join(stem);
    if std::fs::symlink_metadata(&sibling).is_ok_and(|m| m.is_dir()) {
        total += tree_bytes(&sibling);
    }
    // `<file>.*.bak`：与 delete 的前缀 + 后缀匹配一致，仅普通文件计入。
    let prefix = format!("{}.", file_name.to_string_lossy());
    if let Ok(entries) = std::fs::read_dir(parent) {
        for e in entries.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix)
                && name.ends_with(".bak")
                && e.file_type().is_ok_and(|t| t.is_file())
            {
                total += e.metadata().map_or(0, |m| m.len());
            }
        }
    }
    total
}

/// 递归求和普通文件字节；符号链接与特殊文件计 0，不可读目录计 0。
fn tree_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            // DirEntry::file_type / metadata 均不跟随符号链接。
            Ok(t) if t.is_dir() => tree_bytes(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

fn io_error(path: &Path, e: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CleanupReason::{CwdMissing, Empty, Large, Stale};
    use serde_json::json;
    use std::os::unix::io::AsRawFd;
    use std::sync::mpsc;

    /// 不存在的 cwd：让会话必然命中 `cwd_missing`，便于断言候选体积等字段。
    const MISSING_CWD: &str = "/nonexistent-omp-resume-cleanup-test";

    fn cfg(root: &Path) -> Config {
        Config {
            sessions_dir: root.join("sessions"),
            owners_dir: root.join("owners"),
        }
    }

    fn header(id: &str, cwd: &str) -> String {
        json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-14T00:00:00.000Z","cwd":cwd})
            .to_string()
    }

    fn user_line(id: &str, text: &str) -> String {
        json!({"type":"message","id":id,"parentId":null,"timestamp":"2026-10-14T00:00:01.000Z",
            "message":{"role":"user","content":[{"type":"text","text":text}]}})
        .to_string()
    }

    fn assistant_line(id: &str) -> String {
        json!({"type":"message","id":id,"parentId":null,"timestamp":"2026-10-14T00:00:01.000Z",
            "message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}})
        .to_string()
    }

    /// 写 `<root>/sessions/<proj>/<name>.jsonl`，返回路径。
    fn write_session(root: &Path, name: &str, lines: &[String]) -> PathBuf {
        let dir = root.join("sessions").join("-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{name}.jsonl"));
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        p
    }

    fn set_mtime_days_ago(p: &Path, days: u64) {
        let t = SystemTime::now() - Duration::from_secs(days * SECS_PER_DAY);
        filetime::set_file_mtime(p, filetime::FileTime::from_system_time(t)).unwrap();
    }

    fn run(root: &Path, days: u32, top_n: u32) -> Vec<CleanupCandidate> {
        list_candidates(&cfg(root), SystemTime::now(), days, top_n).unwrap()
    }

    fn find<'a>(list: &'a [CleanupCandidate], id: &str) -> Option<&'a CleanupCandidate> {
        list.iter().find(|c| c.id == id)
    }

    #[test]
    fn bytes_include_jsonl_artifacts_and_bak_but_not_neighbors() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let p = write_session(
            root,
            "2026-10-14T00-00-00-000Z_s1",
            &[header("s1", MISSING_CWD), user_line("u1", "hi")],
        );
        let jsonl_len = std::fs::metadata(&p).unwrap().len();
        // 同 stem sibling 目录：文件 + 嵌套子目录文件。
        let sib = root.join("sessions/-proj/2026-10-14T00-00-00-000Z_s1");
        std::fs::create_dir_all(sib.join("sub")).unwrap();
        std::fs::write(sib.join("artifact.txt"), vec![b'a'; 2000]).unwrap();
        std::fs::write(sib.join("sub/nested.jsonl"), vec![b'n'; 300]).unwrap();
        // 本会话的 .bak 计入；前缀不同的 .bak 与普通 sibling 文件不计。
        std::fs::write(p.with_extension("jsonl.12345.bak"), vec![b'b'; 500]).unwrap();
        std::fs::write(
            root.join("sessions/-proj/2026-10-14T00-00-00-000Z_s1.other.bak"),
            vec![b'x'; 7000],
        )
        .unwrap();
        std::fs::write(
            root.join("sessions/-proj/2026-10-14T00-00-00-000Z_s1x"),
            vec![b'f'; 9000],
        )
        .unwrap();

        let got = run(root, 30, 10);
        let c = find(&got, "s1").expect("cwd 缺失应命中候选");
        assert_eq!(c.bytes, jsonl_len + 2000 + 300 + 500);
    }

    #[test]
    fn symlinked_sibling_contents_are_not_followed() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("big.bin"), vec![b'z'; 9000]).unwrap();
        // 真实 sibling 目录内的符号链接：删除只移除链接，不计入体积。
        let p = write_session(
            root,
            "inner",
            &[header("inner", MISSING_CWD), user_line("u1", "hi")],
        );
        let inner_len = std::fs::metadata(&p).unwrap().len();
        let sib = root.join("sessions/-proj/inner");
        std::fs::create_dir_all(&sib).unwrap();
        std::os::unix::fs::symlink(&outside, sib.join("linked")).unwrap();
        // sibling 本身是符号链接：同样只计 0。
        let p2 = write_session(
            root,
            "whole",
            &[header("whole", MISSING_CWD), user_line("u1", "hi")],
        );
        let whole_len = std::fs::metadata(&p2).unwrap().len();
        std::os::unix::fs::symlink(&outside, root.join("sessions/-proj/whole")).unwrap();

        let got = run(root, 30, 10);
        assert_eq!(find(&got, "inner").unwrap().bytes, inner_len);
        assert_eq!(find(&got, "whole").unwrap().bytes, whole_len);
    }

    #[test]
    fn empty_means_no_user_message_in_v3() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let cwd = root.to_str().unwrap();
        // 仅 assistant：empty。
        write_session(
            root,
            "a",
            &[header("only-assistant", cwd), assistant_line("a1")],
        );
        // 仅 custom 行（不是 message）：empty。
        write_session(
            root,
            "c",
            &[
                header("only-custom", cwd),
                json!({"type":"custom","customType":"tool_execution_start","id":"c1","parentId":null,
                       "timestamp":"2026-10-14T00:00:01.000Z","data":{}})
                .to_string(),
            ],
        );
        // 有 user：不是候选（cwd 存在、未久未更新、体积小）。
        write_session(root, "u", &[header("has-user", cwd), user_line("u1", "hi")]);

        let got = run(root, 30, 10);
        assert_eq!(find(&got, "only-assistant").unwrap().reasons, vec![Empty]);
        assert_eq!(find(&got, "only-custom").unwrap().reasons, vec![Empty]);
        assert!(find(&got, "has-user").is_none());
    }

    #[test]
    fn large_needs_five_mib_and_fits_top_n() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let cwd = root.to_str().unwrap();
        const MIB: u64 = 1024 * 1024;
        // 有 user 行 + 稀疏扩展到目标大小（NUL 行解析失败被跳过，不影响判定）。
        let sized = |name: &str, id: &str, size: u64| {
            let p = write_session(root, name, &[header(id, cwd), user_line("u1", "hi")]);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&p)
                .unwrap()
                .set_len(size)
                .unwrap();
        };
        sized("big", "big", 6 * MIB);
        sized("mid", "mid", 5 * MIB);
        sized("near", "near", 5 * MIB - 1); // 低于下限：即使排名靠前也不 large
        sized("small", "small", 1024);

        let got = run(root, 30, 10);
        assert_eq!(find(&got, "big").unwrap().reasons, vec![Large]);
        assert_eq!(find(&got, "mid").unwrap().reasons, vec![Large]);
        assert!(find(&got, "near").is_none());
        assert!(find(&got, "small").is_none());

        let top1 = run(root, 30, 1);
        assert_eq!(find(&top1, "big").unwrap().reasons, vec![Large]);
        assert!(find(&top1, "mid").is_none(), "top_n=1 时只取第一名");
    }

    #[test]
    fn stale_follows_mtime_and_days() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let cwd = root.to_str().unwrap();
        let old = write_session(root, "old", &[header("old", cwd), user_line("u1", "hi")]);
        set_mtime_days_ago(&old, 40);
        write_session(root, "new", &[header("new", cwd), user_line("u1", "hi")]);

        let got = run(root, 30, 10);
        assert_eq!(find(&got, "old").unwrap().reasons, vec![Stale]);
        assert!(find(&got, "new").is_none());
        // 阈值放宽到 60 天：old 不再命中。
        assert!(find(&run(root, 60, 10), "old").is_none());
    }

    #[test]
    fn reasons_stack_in_fixed_order() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let p = write_session(
            root,
            "all",
            &[header("all", MISSING_CWD), assistant_line("a1")],
        );
        set_mtime_days_ago(&p, 40);

        let got = run(root, 30, 10);
        assert_eq!(
            find(&got, "all").unwrap().reasons,
            vec![Empty, CwdMissing, Stale]
        );
    }

    #[test]
    fn held_lock_marks_in_use_and_candidate_stays_listed() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        write_session(
            root,
            "busy",
            &[header("busy", MISSING_CWD), user_line("u1", "hi")],
        );
        let owners = root.join("owners");
        std::fs::create_dir_all(&owners).unwrap();
        let lock_path = owners.join("busy.lock");
        std::fs::write(&lock_path, "").unwrap();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let f = std::fs::OpenOptions::new()
                .read(true)
                .open(&lock_path)
                .unwrap();
            assert_eq!(unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) }, 0);
            locked_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_UN) };
        });
        locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        let got = run(root, 30, 10);
        let c = find(&got, "busy").expect("占用中的会话仍列出");
        assert!(c.in_use && c.probe_ok);

        release_tx.send(()).unwrap();
        holder.join().unwrap();
    }

    #[test]
    fn probe_failure_is_unknown_not_in_use() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        write_session(
            root,
            "unk",
            &[header("unk", MISSING_CWD), user_line("u1", "hi")],
        );
        let owners = root.join("owners");
        std::fs::create_dir_all(&owners).unwrap();
        let lock = owners.join("unk.lock");
        std::fs::write(&lock, "").unwrap();
        // 无读权限 → open 失败 → 探测未知（不可断言空闲）。
        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o000)).unwrap();

        let got = run(root, 30, 10);
        let c = find(&got, "unk").expect("候选");
        assert!(!c.probe_ok && !c.in_use);

        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn bad_lines_are_skipped_and_title_falls_back_to_first_user() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        write_session(
            root,
            "bad",
            &[
                "not json at all".to_string(),
                json!({"no":"type"}).to_string(),
                header("bad", MISSING_CWD),
                user_line("u1", "第一条 user 消息"),
            ],
        );

        let got = run(root, 30, 10);
        let c = find(&got, "bad").unwrap();
        assert_eq!(c.reasons, vec![CwdMissing], "坏行不得导致误判 empty");
        assert_eq!(c.title, "第一条 user 消息");
    }

    #[test]
    fn non_v3_never_judged_empty() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let v2 = json!({"type":"session","version":2,"id":"v2","timestamp":"2026-10-14T00:00:00.000Z","cwd":MISSING_CWD})
            .to_string();
        write_session(root, "v2", &[v2]);

        let got = run(root, 30, 10);
        assert_eq!(find(&got, "v2").unwrap().reasons, vec![CwdMissing]);
    }

    /// 真实数据只读验证（`cargo test --lib real_data_cleanup -- --ignored --nocapture`）：
    /// 打印候选数量、各原因计数与可释放总量。永不写 `~/.omp`。
    #[test]
    #[ignore]
    fn real_data_cleanup_summary() {
        let home = std::env::var("HOME").unwrap();
        let cfg = Config {
            sessions_dir: PathBuf::from(format!("{home}/.omp/agent/sessions")),
            owners_dir: PathBuf::from(format!("{home}/.omp/run/session-owners")),
        };
        if !cfg.sessions_dir.is_dir() {
            println!("无真实 sessions 目录，跳过");
            return;
        }
        let started = std::time::Instant::now();
        let got = list_candidates(&cfg, SystemTime::now(), 30, 10).unwrap();
        println!("耗时 {:?}，候选 {} 个", started.elapsed(), got.len());
        for r in [Empty, CwdMissing, Large, Stale] {
            let n = got.iter().filter(|c| c.reasons.contains(&r)).count();
            println!("  {r:?}: {n}");
        }
        let total: u64 = got.iter().map(|c| c.bytes).sum();
        let in_use = got.iter().filter(|c| c.in_use).count();
        let unknown = got.iter().filter(|c| !c.probe_ok).count();
        println!("  可释放合计 {total} 字节；占用中 {in_use}；占用未知 {unknown}");
        for c in &got {
            println!(
                "    {:>10} {:?} {} {}",
                c.bytes, c.reasons, c.in_use, c.path
            );
        }
    }
}
