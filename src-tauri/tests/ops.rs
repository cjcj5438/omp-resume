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
        extra_roots: vec![],
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

    // 带身份的 opener：返回值用于把启动证据绑定到本次标签页。
    let got = RefCell::new(String::new());
    let opener = |cmd: &str| -> Result<(String, String), AppError> {
        got.replace(cmd.to_owned());
        Ok(("tab-test".to_owned(), "/dev/ttys003".to_owned()))
    };
    // 注入快照/证据/诊断：不跑真实 ps、lsof、osascript，也不等 10 秒。
    let empty_snapshot = |_: &str| Ok(std::collections::HashSet::new());
    let started = |_: &str, _: &str, _: &str, _: &std::collections::HashSet<u32>| true;
    let no_diag = |_: &str| String::new();
    let open = |c: &Config, p: &str| {
        ops_cmds::open_in_iterm_impl_observed(
            c,
            p,
            &opener,
            std::time::Duration::from_secs(2),
            &empty_snapshot,
            &started,
            &no_diag,
        )
    };
    open(&c, &ps).unwrap();
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
    let e = open(&c, &gone.display().to_string()).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    let f = t.path().join("afile");
    std::fs::write(&f, "x").unwrap();
    let gf = branch_session(&proj, "g2.jsonl", "sess-g2", &f.display().to_string());
    let e = open(&c, &gf.display().to_string()).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);

    // IN_USE 拒绝且 opener 未被调用；PROBE_FAILED 放行。
    let b = branch_session(&proj, "b2.jsonl", "sess-busy2", &cwd.display().to_string());
    let bs = b.display().to_string();
    let _guard = hold_lock(&c.owners_dir, "sess-busy2");
    got.replace(String::new());
    let e = open(&c, &bs).unwrap_err();
    assert_eq!(e.code, ErrorCode::InUse);
    assert!(got.borrow().is_empty());
    drop(_guard);
    let t3 = tempfile::tempdir().unwrap();
    std::fs::write(t3.path().join("BLOCK"), "x").unwrap();
    let c3 = Config {
        sessions_dir: t.path().to_path_buf(),
        owners_dir: t3.path().join("BLOCK"),
        extra_roots: vec![],
    };
    got.replace(String::new());
    open(&c3, &bs).unwrap();
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
    let e = open(&c, &evil.display().to_string()).unwrap_err();
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
    let e = open(&c, &evil2.display().to_string()).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert!(got.borrow().is_empty());
}

/// 恢复成功必须有绑定本次标签页的运行证据：未确认就不报成功、不重发命令；
/// 门禁失败时不产生任何副作用（opener 根本没被调用）。
#[test]
fn iterm_resume_requires_tracked_evidence() {
    use std::cell::Cell;
    use std::collections::HashSet;
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let cwd = t.path().join("wd");
    std::fs::create_dir_all(&cwd).unwrap();
    let none = HashSet::new();

    // 证据成立 → 成功（成功路径给足 2s，避免与 100ms 轮询抢调度余量）。
    let p = branch_session(&proj, "ok.jsonl", "sess-ok1", &cwd.display().to_string());
    let calls = Cell::new(0);
    let opener = |_: &str| -> Result<(String, String), AppError> {
        calls.set(calls.get() + 1);
        Ok(("tab-1".to_owned(), "/dev/ttys009".to_owned()))
    };
    ops_cmds::open_in_iterm_impl_observed(
        &c,
        &p.display().to_string(),
        &opener,
        std::time::Duration::from_secs(2),
        &|_: &str| Ok(HashSet::new()),
        &|_, _, _, _| true,
        &|_: &str| String::new(),
    )
    .unwrap();
    assert!(calls.get() >= 1);

    // 证据始终不成立 → ITERM_FAILED（不是成功），opener 只被调用一次。
    let q = branch_session(&proj, "slow.jsonl", "sess-slow", &cwd.display().to_string());
    let calls = Cell::new(0);
    let opener = |_: &str| -> Result<(String, String), AppError> {
        calls.set(calls.get() + 1);
        Ok(("tab-2".to_owned(), "/dev/ttys010".to_owned()))
    };
    let e = ops_cmds::open_in_iterm_impl_observed(
        &c,
        &q.display().to_string(),
        &opener,
        std::time::Duration::from_millis(150),
        &|_: &str| Ok(HashSet::new()),
        &|_, _, _, _| false,
        &|_: &str| "command not found".to_owned(),
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::ItermFailed);
    assert!(e.message.contains("未检测到 omp 启动该会话"), "{e:?}");
    assert_eq!(calls.get(), 1, "未确认不得自动重发命令");

    // wrongTTY：证据闭包拿到的 tty 与进程 tty 不一致（别的终端抢占）→ 失败。
    let w = branch_session(
        &proj,
        "wrongtty.jsonl",
        "sess-wrong",
        &cwd.display().to_string(),
    );
    let calls = Cell::new(0);
    let opener = |_: &str| -> Result<(String, String), AppError> {
        calls.set(calls.get() + 1);
        Ok(("tab-5".to_owned(), "/dev/ttys020".to_owned()))
    };
    let e = ops_cmds::open_in_iterm_impl_observed(
        &c,
        &w.display().to_string(),
        &opener,
        std::time::Duration::from_millis(150),
        &|_: &str| Ok(none.clone()),
        // 真实判定：观测到的进程在另一个 tty 上，不构成本次标签页的启动。
        &|_, _, tracked: &str, _| {
            omp_resume_lib::ops::iterm::tty_matches_start(tracked, Some("/dev/ttys021"))
        },
        &|_: &str| String::new(),
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::ItermFailed);
    assert!(e.message.contains("未检测到 omp 启动该会话"), "{e:?}");
    assert_eq!(calls.get(), 1);

    // 快照失败（ps 不可用）→ 失败且 opener 根本没被调用（无副作用）。
    let r = branch_session(&proj, "nops.jsonl", "sess-nops", &cwd.display().to_string());
    let calls = Cell::new(0);
    let opener = |_: &str| -> Result<(String, String), AppError> {
        calls.set(calls.get() + 1);
        Ok(("tab-3".to_owned(), "/dev/ttys011".to_owned()))
    };
    let e = ops_cmds::open_in_iterm_impl_observed(
        &c,
        &r.display().to_string(),
        &opener,
        std::time::Duration::from_millis(150),
        &|_: &str| Err("boom".to_owned()),
        &|_, _, _, _| true,
        &|_: &str| String::new(),
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::ItermFailed);
    assert!(e.message.contains("ps 不可用"), "{e:?}");
    assert_eq!(calls.get(), 0, "快照失败必须早于 opener");

    // opener 自身失败：错误上抛、不进入确认阶段（不会被误报成功）。
    let s = branch_session(
        &proj,
        "noiterm.jsonl",
        "sess-noiterm",
        &cwd.display().to_string(),
    );
    let opener = |_: &str| -> Result<(String, String), AppError> {
        Err(AppError::new(ErrorCode::ItermFailed, "osascript 退出码 1"))
    };
    let e = ops_cmds::open_in_iterm_impl_observed(
        &c,
        &s.display().to_string(),
        &opener,
        std::time::Duration::from_secs(2),
        &|_: &str| Ok(HashSet::new()),
        &|_, _, _, _| true,
        &|_: &str| String::new(),
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::ItermFailed);
    assert!(e.message.contains("退出码 1"), "{e:?}");

    // 拿不到 tty（身份不完整）：不猜，直接失败。
    let u = branch_session(
        &proj,
        "notty.jsonl",
        "sess-notty",
        &cwd.display().to_string(),
    );
    let opener =
        |_: &str| -> Result<(String, String), AppError> { Ok(("tab-4".to_owned(), String::new())) };
    let e = ops_cmds::open_in_iterm_impl_observed(
        &c,
        &u.display().to_string(),
        &opener,
        std::time::Duration::from_secs(2),
        &|_: &str| Ok(HashSet::new()),
        &|_, _, _, _| true,
        &|_: &str| String::new(),
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::ItermFailed);
    assert!(e.message.contains("tty"), "{e:?}");
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
    ops_cmds::new_session_in_iterm_impl(&cwd.display().to_string(), None, &opener).unwrap();
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

    // 尾部空格是目录名的一部分：原样放行（NAS 真实目录名 `…dsh-superagent-prototype `）。
    got.replace(None);
    let trailing = t.path().join("trailing-space ");
    std::fs::create_dir_all(&trailing).unwrap();
    ops_cmds::new_session_in_iterm_impl(&trailing.display().to_string(), None, &opener).unwrap();
    assert_eq!(
        got.borrow().as_deref(),
        Some(format!("cd '{}' && omp", trailing.display()).as_str()),
    );

    // 首尾含空格的错误路径：CWD_MISSING 文案带去歧义提示。
    got.replace(None);
    let e = ops_cmds::new_session_in_iterm_impl(
        &format!("{} ", t.path().join("gone").display()),
        None,
        &opener,
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    assert!(e.message.contains("首尾含空格"), "{}", e.message);
    assert!(got.borrow().is_none());
    // CWD_MISSING：不存在 / 是文件 / 相对路径；opener 均不得被调用。
    got.replace(None);
    let gone = t.path().join("gone");
    let e = ops_cmds::new_session_in_iterm_impl(&gone.display().to_string(), None, &opener)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    let f = t.path().join("afile");
    std::fs::write(&f, "x").unwrap();
    let e =
        ops_cmds::new_session_in_iterm_impl(&f.display().to_string(), None, &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    let e = ops_cmds::new_session_in_iterm_impl("relative/dir", None, &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    assert!(got.borrow().is_none(), "拒绝路径不应调用 opener");

    // 含换行的路径：拒绝（转义会静默剥离换行，改变 cd 目标）。
    let nl = t.path().join("a\nb");
    std::fs::create_dir_all(&nl).unwrap();
    let e =
        ops_cmds::new_session_in_iterm_impl(&nl.display().to_string(), None, &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert!(got.borrow().is_none());

    // 模型参数：合法 selector 追加 --model（转义），空串等同 None。
    got.replace(None);
    ops_cmds::new_session_in_iterm_impl(
        &cwd.display().to_string(),
        Some("5438/deepseek-v4.1-flash"),
        &opener,
    )
    .unwrap();
    assert_eq!(
        got.borrow().as_deref(),
        Some(
            format!(
                "cd '{}' && omp --model '5438/deepseek-v4.1-flash'",
                cwd.display().to_string().replace('\'', "'\"'\"'")
            )
            .as_str()
        ),
    );
    ops_cmds::new_session_in_iterm_impl(&cwd.display().to_string(), Some("  "), &opener).unwrap();
    assert!(got
        .borrow()
        .as_deref()
        .is_some_and(|c| c.ends_with("&& omp")));

    // 非法模型：超长 / 控制字符 / 以 `-` 开头；opener 不得被调用。
    got.replace(None);
    let long = "m".repeat(257);
    for bad in [long.as_str(), "a\nb", "-x"] {
        let e = ops_cmds::new_session_in_iterm_impl(&cwd.display().to_string(), Some(bad), &opener)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput, "{bad:?}");
    }
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
        extra_roots: vec![],
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
    // 尾部空格目录名同样放行（与 new_session_in_iterm 同一校验口径）。
    let trailing = t.path().join("trailing ");
    std::fs::create_dir_all(&trailing).unwrap();
    ops_cmds::open_project_dir_impl(&trailing.display().to_string(), &project_runner).unwrap();
    {
        let calls = project_runner.calls.lock().unwrap();
        assert_eq!(calls[1].0, "/usr/bin/open");
        assert_eq!(calls[1].1, vec![trailing.display().to_string()]);
    }
    let gone = t.path().join("gone");
    let e =
        ops_cmds::open_project_dir_impl(&gone.display().to_string(), &project_runner).unwrap_err();
    assert_eq!(e.code, ErrorCode::CwdMissing);
    assert_eq!(project_runner.calls.lock().unwrap().len(), 2);

    // runner 失败 → IO 且文案带用途。
    let bad = RecordRunner {
        fail: true,
        ..Default::default()
    };
    let e = ops_cmds::reveal_session_file_impl(&c, &ps, &bad).unwrap_err();
    assert_eq!(e.code, ErrorCode::Io);
    assert!(e.message.contains("Finder"), "{}", e.message);
}

#[test]
fn reveal_file_accepts_only_absolute_existing_files() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("mcp.json");
    std::fs::write(&file, "{}").unwrap();
    let path = file.display().to_string();
    let runner = RecordRunner::default();
    ops_cmds::reveal_file_impl(&path, &runner).unwrap();
    {
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "/usr/bin/open");
        assert_eq!(calls[0].1, vec!["-R".to_string(), path.clone()]);
    }
    // 相对路径 / 不存在 / 目录 / 控制字符：拒绝且不再调用 runner。
    assert_eq!(
        ops_cmds::reveal_file_impl("rel/mcp.json", &runner)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        ops_cmds::reveal_file_impl(&t.path().join("gone").display().to_string(), &runner)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        ops_cmds::reveal_file_impl(&t.path().display().to_string(), &runner)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        ops_cmds::reveal_file_impl(&format!("{path}\n"), &runner)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
}
