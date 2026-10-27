//! OPS 命令集成测试（CONTRACT §4.6–§4.8）：tempdir fixture，不碰真实 `~/.omp`。
//!
//! 独立文件（而非追加到 `tests/backend.rs`），避免与 architect worker 的合并冲突。

mod common;

use std::path::{Path, PathBuf};

use common::{cfg, header, msg, write_lines};
use omp_resume_lib::config::{self, Config};
use omp_resume_lib::model::{AppError, ConversationItem, ErrorCode};
use omp_resume_lib::ops::commands as ops_cmds;
use omp_resume_lib::sessions;
use serde_json::{json, Value};

fn user_msg(text: &str) -> Value {
    json!({"role":"user","content":[{"type":"text","text":text}],"attribution":"user","timestamp":1_791_790_685_211i64})
}

fn assistant_msg(blocks: Value) -> Value {
    json!({"role":"assistant","content":blocks,"stopReason":"stop","timestamp":1_791_790_687_031i64})
}

/// 按住一个真实 flock（guard 存活即占用）。
fn hold_lock(owners: &Path, session_id: &str) -> std::fs::File {
    use std::os::unix::io::AsRawFd;
    std::fs::create_dir_all(owners).unwrap();
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(owners.join(format!("{session_id}.lock")))
        .unwrap();
    let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    assert_eq!(rc, 0, "测试 flock 加锁失败");
    f
}

/// 小分支 fixture：u1─a1─┬─t1
///                     └─u2(┬c1 custom 跳过)─a2(leaf)
fn branch_session(proj: &Path, name: &str, session_id: &str, cwd: &str) -> PathBuf {
    let lines = vec![
        header(session_id, cwd),
        msg("u1", None, user_msg("首条问题")),
        msg(
            "a1",
            Some("u1"),
            assistant_msg(json!([{"type":"text","text":"首条回答"}])),
        ),
        msg(
            "t1",
            Some("a1"),
            json!({"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"结果"}],"isError":false,"timestamp":1}),
        ),
        msg("u2", Some("a1"), user_msg("分支问题")),
        json!({"type":"custom","customType":"tool_execution_start","data":{},"id":"c1","parentId":"u2","timestamp":"2026-10-14T00:00:01.100Z"}).to_string(),
        msg(
            "a2",
            Some("u2"),
            assistant_msg(json!([{"type":"text","text":"分支回答"}])),
        ),
    ];
    write_lines(proj, name, &lines)
}

fn branch_count(tree: &omp_resume_lib::model::TreeData) -> usize {
    tree.nodes.iter().filter(|n| n.child_ids.is_empty()).count()
}

#[test]
fn delete_partial_batch() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let c = cfg(root);
    let proj = root.join("proj");
    std::fs::create_dir_all(&proj).unwrap();

    // ok：jsonl + sibling 目录 + .bak。
    let ok = write_lines(&proj, "ok.jsonl", &[header("sess-ok", "/tmp")]);
    std::fs::create_dir_all(proj.join("ok")).unwrap();
    std::fs::write(proj.join("ok").join("art.txt"), "a").unwrap();
    std::fs::write(proj.join("ok.jsonl.7.bak"), "b").unwrap();
    // busy：被真实 flock 占用。
    let busy = write_lines(&proj, "busy.jsonl", &[header("sess-busy", "/tmp")]);
    let busy_bytes = std::fs::read(&busy).unwrap();
    std::fs::create_dir_all(proj.join("busy")).unwrap();
    std::fs::write(proj.join("busy").join("keep.txt"), "k").unwrap();
    let _guard = hold_lock(&c.owners_dir, "sess-busy");
    // outside：`..` 逃出项目层（目标须存在，否则 canonicalize 先报 NOT_FOUND）；
    // missing：不存在。
    std::fs::write(root.join("outside.jsonl"), "{}\n").unwrap();
    let outside = format!("{}/../outside.jsonl", proj.display());
    let missing_s = proj.join("missing.jsonl").display().to_string();

    let paths = vec![
        ok.display().to_string(),
        busy.display().to_string(),
        outside.clone(),
        missing_s.clone(),
    ];
    let rs = ops_cmds::delete_sessions_impl(&c, &paths);
    assert_eq!(rs.len(), 4);
    assert_eq!(rs[0].path, ok.display().to_string());
    assert!(rs[0].ok && rs[0].error.is_none(), "{:?}", rs[0]);
    assert_eq!(rs[1].error.as_ref().unwrap().code, ErrorCode::InUse);
    assert!(!rs[1].ok);
    assert_eq!(rs[2].error.as_ref().unwrap().code, ErrorCode::OutsideRoot);
    assert_eq!(rs[3].error.as_ref().unwrap().code, ErrorCode::NotFound);

    // 只有 ok 的三样消失。
    assert!(!ok.exists() && !proj.join("ok").exists() && !proj.join("ok.jsonl.7.bak").exists());
    assert_eq!(
        std::fs::read(&busy).unwrap(),
        busy_bytes,
        "in-use 会话必须字节一致"
    );
    assert!(proj.join("busy").join("keep.txt").exists());
}

#[test]
fn delete_corrupt_header_is_probe_failed() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let p = write_lines(&proj, "bad.jsonl", &["{not json".to_string()]);
    let rs = ops_cmds::delete_sessions_impl(&c, &[p.display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::ProbeFailed);
    assert!(p.exists(), "不敢删：文件必须保留");
}

#[test]
fn marker_end_to_end_branch() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let p = branch_session(&proj, "b.jsonl", "sess-m1", "/tmp");
    let ps = p.display().to_string();
    let valid = config::validate_session_path(&c, &ps).unwrap();

    let before_raw = std::fs::read(&p).unwrap();
    let before = sessions::tree::get_tree(&valid).unwrap();
    assert_eq!(before.leaf_id, Some("a2".to_string()));
    assert_eq!(branch_count(&before), 2);

    let r = ops_cmds::append_branch_marker_impl(&c, &ps, "u2").unwrap();
    let mid = r.marker_id.clone().expect("应写入 marker");
    assert_eq!(mid.len(), 8);
    assert!(
        mid.chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()),
        "{mid}"
    );

    // 文件：前缀字节一致 + 末行 marker。
    let raw = std::fs::read(&p).unwrap();
    assert_eq!(&raw[..before_raw.len()], &before_raw[..]);
    let last_line = String::from_utf8(raw[before_raw.len()..].to_vec()).unwrap();
    assert!(last_line.ends_with('\n') && last_line.matches('\n').count() == 1);
    let v: Value = serde_json::from_str(last_line.trim_end()).unwrap();
    assert_eq!(v["type"], "custom");
    assert_eq!(
        v["customType"],
        omp_resume_lib::ops::marker::MARKER_CUSTOM_TYPE
    );
    assert_eq!(v["id"], mid.as_str());
    assert_eq!(v["parentId"], "u2");

    // 树/会话视角：leaf 回到 u2。
    let after = sessions::tree::get_tree(&valid).unwrap();
    assert_eq!(after.leaf_id, Some("u2".to_string()));
    assert_eq!(
        after.active_path_ids,
        vec!["u2".to_string(), "a1".to_string(), "u1".to_string()]
    );
    assert_eq!(branch_count(&after), 2, "marker 跳过，不增分支");
    assert!(after.nodes.iter().all(|n| n.id != mid));
    let conv = sessions::conversation::get_conversation(&valid, None).unwrap();
    assert_eq!(conv.target_id, "u2");
    match conv.items.last().unwrap() {
        ConversationItem::User(u) => assert_eq!(u.text, "分支问题"),
        other => panic!("unexpected tail: {other:?}"),
    }

    // 已是 leaf → 无操作，文件不动。
    let snap = std::fs::read(&p).unwrap();
    let r2 = ops_cmds::append_branch_marker_impl(&c, &ps, "u2").unwrap();
    assert_eq!(r2.marker_id, None);
    assert_eq!(std::fs::read(&p).unwrap(), snap);
}

#[test]
fn marker_refusals() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let p = branch_session(&proj, "r.jsonl", "sess-m2", "/tmp");
    let ps = p.display().to_string();

    // 未知 id 与被跳过 custom 条目的 id。
    for bad in ["zzzzzzzz", "c1"] {
        let e = ops_cmds::append_branch_marker_impl(&c, &ps, bad).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidNode, "{bad}: {e:?}");
    }
    // 占用中。
    let _guard = hold_lock(&c.owners_dir, "sess-m2");
    let e = ops_cmds::append_branch_marker_impl(&c, &ps, "u1").unwrap_err();
    assert_eq!(e.code, ErrorCode::InUse);
    drop(_guard);
    // 探测失败（owners 是文件）。
    let t2 = tempfile::tempdir().unwrap();
    std::fs::write(t2.path().join("BLOCK"), "x").unwrap();
    let c2 = Config {
        sessions_dir: t.path().to_path_buf(),
        owners_dir: t2.path().join("BLOCK"),
    };
    let e = ops_cmds::append_branch_marker_impl(&c2, &ps, "u1").unwrap_err();
    assert_eq!(e.code, ErrorCode::ProbeFailed);
    // 非 v3。
    let nv = write_lines(
        &proj,
        "old.jsonl",
        &[
            json!({"type":"session","version":2,"id":"sess-old","timestamp":"2026-10-14T00:00:00.000Z","cwd":"/tmp"})
                .to_string(),
        ],
    );
    let e = ops_cmds::append_branch_marker_impl(&c, &nv.display().to_string(), "u1").unwrap_err();
    assert_eq!(e.code, ErrorCode::UnsupportedFormat);
    // 无末尾换行（须有两个保留节点，使 u1 通过 kept 校验并走到追加步）。
    let uf = proj.join("unterminated.jsonl");
    let no_nl = format!(
        "{}\n{}\n{}",
        header("sess-u", "/tmp"),
        msg("u1", None, user_msg("hi")),
        msg(
            "a1",
            Some("u1"),
            assistant_msg(json!([{"type":"text","text":"yo"}]))
        ),
    );
    std::fs::write(&uf, &no_nl).unwrap();
    let e = ops_cmds::append_branch_marker_impl(&c, &uf.display().to_string(), "u1").unwrap_err();
    assert_eq!(e.code, ErrorCode::Io);
    assert!(e.message.contains("换行"), "{e:?}");
}

#[test]
fn iterm_command_string_and_refusals() {
    use std::cell::RefCell;
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");

    // 含空格/CJK/单引号的 cwd。
    let cwd = t.path().join("my dir 未命名'x");
    std::fs::create_dir_all(&cwd).unwrap();
    let p = branch_session(&proj, "i.jsonl", "sess-i1", &cwd.display().to_string());
    let ps = p.display().to_string();
    let valid = config::validate_session_path(&c, &ps).unwrap();

    let got = RefCell::new(String::new());
    let opener = |cmd: &str| -> Result<(), AppError> {
        got.replace(cmd.to_owned());
        Ok(())
    };
    ops_cmds::open_in_iterm_impl(&c, &ps, &opener).unwrap();
    assert_eq!(
        got.borrow().as_str(),
        &format!(
            "cd '{}' && omp --resume '{}'",
            cwd.display().to_string().replace('\'', "'\"'\"'"),
            valid.display(),
        )
    );

    // CWD_MISSING：不存在 / 是文件。
    let gone = branch_session(
        &proj,
        "g.jsonl",
        "sess-g",
        &t.path().join("gone").display().to_string(),
    );
    let e = ops_cmds::open_in_iterm_impl(&c, &gone.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    let f = t.path().join("afile");
    std::fs::write(&f, "x").unwrap();
    let gf = branch_session(&proj, "g2.jsonl", "sess-g2", &f.display().to_string());
    let e = ops_cmds::open_in_iterm_impl(&c, &gf.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);

    // IN_USE 拒绝且 opener 未被调用；PROBE_FAILED 放行。
    let b = branch_session(&proj, "b2.jsonl", "sess-busy2", &cwd.display().to_string());
    let bs = b.display().to_string();
    let _guard = hold_lock(&c.owners_dir, "sess-busy2");
    got.replace(String::new());
    let e = ops_cmds::open_in_iterm_impl(&c, &bs, &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::InUse);
    assert!(got.borrow().is_empty());
    drop(_guard);
    let t3 = tempfile::tempdir().unwrap();
    std::fs::write(t3.path().join("BLOCK"), "x").unwrap();
    let c3 = Config {
        sessions_dir: t.path().to_path_buf(),
        owners_dir: t3.path().join("BLOCK"),
    };
    got.replace(String::new());
    ops_cmds::open_in_iterm_impl(&c3, &bs, &opener).unwrap();
    assert!(!got.borrow().is_empty(), "PROBE_FAILED 应放行");

    // 控制字符拒绝：cwd 含换行（目录真实存在，走到控制字符检查）。
    let evil_cwd = t.path().join("a\nb");
    std::fs::create_dir_all(&evil_cwd).unwrap();
    let evil = branch_session(
        &proj,
        "evil.jsonl",
        "sess-evil",
        &evil_cwd.display().to_string(),
    );
    got.replace(String::new());
    let e = ops_cmds::open_in_iterm_impl(&c, &evil.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert!(got.borrow().is_empty());

    // 控制字符拒绝：会话文件名含换行。
    let evil2 = branch_session(
        &proj,
        "a\nb.jsonl",
        "sess-evil2",
        &cwd.display().to_string(),
    );
    got.replace(String::new());
    let e = ops_cmds::open_in_iterm_impl(&c, &evil2.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert!(got.borrow().is_empty());
}

#[test]
fn new_session_in_iterm_refusals_and_command() {
    use std::cell::RefCell;
    let t = tempfile::tempdir().unwrap();
    let got = RefCell::new(None::<String>);
    let opener = |cmd: &str| -> Result<(), AppError> {
        got.replace(Some(cmd.to_owned()));
        Ok(())
    };

    // 合法目录（空格 + 单引号 + 中文）：仅 `cd && omp`，无任何参数。
    let cwd = t.path().join("my dir 未命名'x");
    std::fs::create_dir_all(&cwd).unwrap();
    ops_cmds::new_session_in_iterm_impl(&cwd.display().to_string(), &opener).unwrap();
    assert_eq!(
        got.borrow().as_deref(),
        Some(
            format!(
                "cd '{}' && omp",
                cwd.display().to_string().replace('\'', "'\"'\"'")
            )
            .as_str()
        ),
    );

    // CWD_MISSING：不存在 / 是文件 / 相对路径；opener 均不得被调用。
    got.replace(None);
    let gone = t.path().join("gone");
    let e = ops_cmds::new_session_in_iterm_impl(&gone.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    let f = t.path().join("afile");
    std::fs::write(&f, "x").unwrap();
    let e = ops_cmds::new_session_in_iterm_impl(&f.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    let e = ops_cmds::new_session_in_iterm_impl("relative/dir", &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    assert!(got.borrow().is_none(), "拒绝路径不应调用 opener");

    // 含换行的路径：拒绝（转义会静默剥离换行，改变 cd 目标）。
    let nl = t.path().join("a\nb");
    std::fs::create_dir_all(&nl).unwrap();
    let e = ops_cmds::new_session_in_iterm_impl(&nl.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert!(got.borrow().is_none());
}

/// 真实回归冒烟（手动 `cargo test --test ops -- --ignored smoke_marker_real`）：
/// 对隔离 agent 目录里的**分支**会话调用 `append_branch_marker_impl`
/// 追加 marker，随后由 bash 用 `omp --resume` + tmux 验证转录止于目标节点。
///
/// 环境变量：`OMP_RESUME_SMOKE_SESSIONS`（sessions 根）、
/// `OMP_RESUME_SMOKE_FILE`（会话文件）、`OMP_RESUME_SMOKE_NODE`（目标节点 id）。
/// 不触碰真实 `~/.omp`（owners 指向临时目录）。
#[test]
#[ignore]
fn smoke_marker_real() {
    let sessions = std::env::var("OMP_RESUME_SMOKE_SESSIONS").expect("OMP_RESUME_SMOKE_SESSIONS");
    let file = std::env::var("OMP_RESUME_SMOKE_FILE").expect("OMP_RESUME_SMOKE_FILE");
    let node = std::env::var("OMP_RESUME_SMOKE_NODE").expect("OMP_RESUME_SMOKE_NODE");
    let owners =
        std::env::temp_dir().join(format!("omp-resume-smoke-owners-{}", std::process::id()));
    std::fs::create_dir_all(&owners).unwrap();
    let c = Config {
        sessions_dir: PathBuf::from(&sessions),
        owners_dir: owners.clone(),
    };
    let valid = config::validate_session_path(&c, &file).unwrap();
    let before = sessions::tree::get_tree(&valid).unwrap();
    println!(
        "smoke before: leaf={:?} active={:?}",
        before.leaf_id, before.active_path_ids
    );
    let r = ops_cmds::append_branch_marker_impl(&c, &file, &node).unwrap();
    let mid = r.marker_id.clone().expect("marker 应写入");
    let after = sessions::tree::get_tree(&valid).unwrap();
    println!(
        "smoke after: marker={mid} leaf={:?} active={:?}",
        after.leaf_id, after.active_path_ids
    );
    assert_eq!(
        after.leaf_id,
        Some(node.clone()),
        "marker 后 leaf 应为 {node}"
    );
    assert_eq!(after.active_path_ids.first(), Some(&node));
    std::fs::remove_dir_all(&owners).unwrap();
}

#[test]
fn resume_command_matches_open_in_iterm_and_skips_lock_probe() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let cwd = t.path().join("my dir 未命名'x");
    std::fs::create_dir_all(&cwd).unwrap();
    let p = branch_session(&proj, "r.jsonl", "sess-r", &cwd.display().to_string());
    let ps = p.display().to_string();
    let valid = config::validate_session_path(&c, &ps).unwrap();
    let expect = format!(
        "cd '{}' && omp --resume '{}'",
        cwd.display().to_string().replace('\'', "'\"'\"'"),
        valid.display(),
    );
    assert_eq!(ops_cmds::resume_command_impl(&c, &ps).unwrap(), expect);

    // 占用中也能拿到命令（菜单「复制续聊命令」不该被 IN_USE 拦住）。
    let _guard = hold_lock(&c.owners_dir, "sess-r");
    assert_eq!(ops_cmds::resume_command_impl(&c, &ps).unwrap(), expect);

    // 校验失败仍报 CWD_MISSING。
    let gone = branch_session(
        &proj,
        "rg.jsonl",
        "sess-rg",
        &t.path().join("gone").display().to_string(),
    );
    let e = ops_cmds::resume_command_impl(&c, &gone.display().to_string()).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
}

/// 假 Runner：记录每次调用的 (prog, args)，可按需返回错误。
#[derive(Default)]
struct RecordRunner {
    calls: std::sync::Mutex<Vec<(String, Vec<String>)>>,
    fail: bool,
}

impl omp_resume_lib::menubar::iterm::Runner for RecordRunner {
    fn run(&self, prog: &str, args: &[&str]) -> Result<String, String> {
        self.calls.lock().unwrap().push((
            prog.to_string(),
            args.iter().map(|a| a.to_string()).collect(),
        ));
        if self.fail {
            Err("boom".into())
        } else {
            Ok(String::new())
        }
    }
}

#[test]
fn reveal_session_file_and_open_project_dir() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let cwd = t.path().join("projdir");
    std::fs::create_dir_all(&cwd).unwrap();
    let p = branch_session(&proj, "v.jsonl", "sess-v", &cwd.display().to_string());
    let ps = p.display().to_string();
    let valid = config::validate_session_path(&c, &ps).unwrap();

    let runner = RecordRunner::default();
    ops_cmds::reveal_session_file_impl(&c, &ps, &runner).unwrap();
    {
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "/usr/bin/open");
        assert_eq!(
            calls[0].1,
            vec!["-R".to_string(), valid.display().to_string()]
        );
    }

    // 非会话路径：拒绝且不再调用 runner。
    let outside = t.path().join("outside.jsonl");
    std::fs::write(&outside, "{}").unwrap();
    let e = ops_cmds::reveal_session_file_impl(&c, &outside.display().to_string(), &runner)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
    assert_eq!(runner.calls.lock().unwrap().len(), 1);

    // open_project_dir：合法目录 → `open <cwd>`；不存在 → CWD_MISSING 且不调用。
    let project_runner = RecordRunner::default();
    ops_cmds::open_project_dir_impl(&cwd.display().to_string(), &project_runner).unwrap();
    {
        let calls = project_runner.calls.lock().unwrap();
        assert_eq!(calls[0].0, "/usr/bin/open");
        assert_eq!(calls[0].1, vec![cwd.display().to_string()]);
    }
    let gone = t.path().join("gone");
    let e =
        ops_cmds::open_project_dir_impl(&gone.display().to_string(), &project_runner).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    assert_eq!(project_runner.calls.lock().unwrap().len(), 1);

    // runner 失败 → IO 且文案带用途。
    let bad = RecordRunner {
        fail: true,
        ..Default::default()
    };
    let e = ops_cmds::reveal_session_file_impl(&c, &ps, &bad).unwrap_err();
    assert_eq!(e.code, ErrorCode::Io);
    assert!(e.message.contains("Finder"), "{}", e.message);
}
