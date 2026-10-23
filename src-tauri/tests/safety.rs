//! 独立安全审计：破坏性/写路径的对抗测试（CONTRACT §3 §4.6 §4.7 §4.8 §6）。
//!
//! - 只用 `tempfile::tempdir()` 隔离根目录，绝不触碰 `~/.omp`。
//! - 不启动 `omp` CLI，不打开 iTerm，不发模型请求。
//! - flock 占用：同进程线程 + 子进程 python3 `fcntl.flock` 双路验证。

mod common;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use common::{cfg, header, msg, write_bytes, write_lines};
use omp_resume_lib::config;
use omp_resume_lib::model::ErrorCode;
use omp_resume_lib::ops::commands as ops_cmds;
use omp_resume_lib::ops::iterm;
use omp_resume_lib::ops::marker;
use omp_resume_lib::sessions;
use serde_json::{json, Value};

fn user_msg(text: &str) -> Value {
    json!({"role":"user","content":[{"type":"text","text":text}]})
}

fn assistant_msg(text: &str) -> Value {
    json!({"role":"assistant","content":[{"type":"text","text":text}]})
}

/// 小分支：u1-a1-t1 与 u1-a1-u2-a2，c1 为被跳过的 custom。
fn branch_session(proj: &Path, name: &str, session_id: &str, cwd: &str) -> PathBuf {
    let lines = vec![
        header(session_id, cwd),
        msg("u1", None, user_msg("首条问题")),
        msg("a1", Some("u1"), assistant_msg("首条回答")),
        msg(
            "t1",
            Some("a1"),
            json!({"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"结果"}]}),
        ),
        msg("u2", Some("a1"), user_msg("分支问题")),
        json!({"type":"custom","customType":"tool_execution_start","data":{},"id":"c1","parentId":"u2","timestamp":"2026-10-14T00:00:01.100Z"}).to_string(),
        msg("a2", Some("u2"), assistant_msg("分支回答")),
    ];
    write_lines(proj, name, &lines)
}

/// 子进程持锁：python3 fcntl.flock 独立进程，与同进程线程形成双路验证。
/// 返回 Child，drop 前必须 kill + wait（测试内显式处理）。
fn hold_lock_child(owners: &Path, session_id: &str) -> std::process::Child {
    std::fs::create_dir_all(owners).unwrap();
    let lock_path = owners.join(format!("{session_id}.lock"));
    // 确保文件存在（omp 侧由写会话进程创建）。
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .unwrap();
    let script = format!(
        "import fcntl, time; f=open({:?}, 'r'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(60)",
        lock_path.to_string_lossy().to_string()
    );
    let mut child = std::process::Command::new("python3")
        .arg("-c")
        .arg(script)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn python3 flock holder");
    // 等到子进程打印 held（确保持锁后再探测）。
    use std::io::BufRead;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();
    // 5s 超时：简单轮询读一行。
    let start = std::time::Instant::now();
    loop {
        line.clear();
        // 非阻塞难做：用线程读一行 + 超时。
        // 简单起见：短 sleep 后检查子进程是否已输出（通过 try？）。
        // 此处用阻塞读但子进程必输出，整体测试超时由 cargo 控制。
        if start.elapsed() > std::time::Duration::from_secs(10) {
            let _ = child.kill();
            panic!("python flock holder 未在 10s 内就绪");
        }
        // 阻塞读一行（子进程启动即打印）。
        match reader.read_line(&mut line) {
            Ok(0) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
            Ok(_) if line.trim() == "held" => break,
            Ok(_) => continue,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
        }
    }
    // stdout 已 take 出 reader，reader drop 会关闭读端；子进程继续持锁 sleep。
    // 把 reader 泄漏避免关闭管道影响子进程？子进程只写过一次，已无影响。
    child
}

fn kill_child(mut child: std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------------------
// §6 路径校验
// ---------------------------------------------------------------------------

#[test]
fn safety_relative_tilde_and_empty_rejected() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    for p in [
        "proj/a.jsonl".to_string(),
        "a.jsonl".to_string(),
        "".to_string(),
        "~/sessions/proj/a.jsonl".to_string(),
    ] {
        let e = config::validate_session_path(&c, &p).unwrap_err();
        assert_eq!(e.code, ErrorCode::OutsideRoot, "path={p:?}");
    }
}

#[test]
fn safety_dotdot_and_nested_rejected() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let c = cfg(root);
    let proj = root.join("proj");
    std::fs::create_dir_all(proj.join("nested")).unwrap();
    // 真实存在的 `..` 逃逸目标（否则先报 NOT_FOUND，测不出形状分支）。
    std::fs::write(root.join("outside.jsonl"), "{}\n").unwrap();
    let evil = proj.join("..").join("outside.jsonl");
    let e = config::validate_session_path(&c, evil.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
    // 嵌套三段直接拒绝。
    let nested = write_lines(&proj.join("nested"), "a.jsonl", &[header("s", "/tmp")]);
    let e = config::validate_session_path(&c, nested.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
    // 顶层单段直接拒绝。
    let e = config::validate_session_path(&c, root.join("outside.jsonl").to_str().unwrap())
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
}

#[test]
fn safety_double_slash_normalizes_but_stays_same_file() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let f = write_lines(&proj, "a.jsonl", &[header("s-ds", "/tmp")]);
    // `//` 只是多余分隔符，canonicalize 后仍是同一文件：必须通过且指向同一位置。
    let doubled = format!("{}//a.jsonl", proj.display());
    let got = config::validate_session_path(&c, &doubled).unwrap();
    assert_eq!(got, std::fs::canonicalize(&f).unwrap());
}

#[test]
fn safety_trailing_slash_does_not_delete() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let f = write_lines(&proj, "a.jsonl", &[header("s-ts", "/tmp")]);
    // macOS 上文件后加 `/` 仍 canonicalize 到同一文件（Linux 上可能 ENOTDIR）：
    // 无论哪种，绝不能删错文件、绝不能误删邻居。此处锁定“同一文件”语义。
    let slashed = format!("{}/", f.display());
    match config::validate_session_path(&c, &slashed) {
        Ok(got) => {
            assert_eq!(got, std::fs::canonicalize(&f).unwrap());
            // 同一文件的删除是合法删除（调用方意图明确），但不得波及邻居。
            let neighbor = write_lines(&proj, "keep.jsonl", &[header("s-keep", "/tmp")]);
            let rs = ops_cmds::delete_sessions_impl(&c, &[slashed]);
            assert!(rs[0].ok, "{:?}", rs[0]);
            assert!(!f.exists());
            assert!(neighbor.exists());
        }
        Err(e) => {
            assert!(
                matches!(
                    e.code,
                    ErrorCode::Io | ErrorCode::NotFound | ErrorCode::OutsideRoot
                ),
                "unexpected {e:?}"
            );
            assert!(f.exists(), "拒绝时文件必须保留");
        }
    }
}

#[test]
#[cfg(unix)]
fn safety_symlinked_project_dir_outside_rejected() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("root");
    std::fs::create_dir_all(&root).unwrap();
    let c = cfg(&root);
    let victim = t.path().join("victim-dir");
    std::fs::create_dir_all(&victim).unwrap();
    std::fs::write(victim.join("real.jsonl"), "{}\n").unwrap();
    std::os::unix::fs::symlink(&victim, root.join("proj")).unwrap();
    let link_path = root.join("proj").join("real.jsonl");
    let e = config::validate_session_path(&c, link_path.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
    // 删除路径同样拒绝，受害文件完好。
    let before = std::fs::read(victim.join("real.jsonl")).unwrap();
    let rs = ops_cmds::delete_sessions_impl(&c, &[link_path.display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::OutsideRoot);
    assert_eq!(std::fs::read(victim.join("real.jsonl")).unwrap(), before);
}

#[test]
#[cfg(unix)]
fn safety_symlinked_file_outside_rejected() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("root");
    let proj = root.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let c = cfg(&root);
    let victim = t.path().join("victim.jsonl");
    std::fs::write(&victim, "{}\n").unwrap();
    std::os::unix::fs::symlink(&victim, proj.join("link.jsonl")).unwrap();
    let e =
        config::validate_session_path(&c, proj.join("link.jsonl").to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
    let rs = ops_cmds::delete_sessions_impl(&c, &[proj.join("link.jsonl").display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::OutsideRoot);
    assert!(victim.exists());
}

#[test]
#[cfg(unix)]
fn safety_symlink_at_sessions_root_still_works() {
    // sessions 根本身是符号链接时：两边同 canonicalize，合法文件仍应通过。
    let t = tempfile::tempdir().unwrap();
    let real = t.path().join("real-root");
    let proj = real.join("proj");
    let f = write_lines(&proj, "a.jsonl", &[header("s-linkroot", "/tmp")]);
    let linkroot = t.path().join("link-root");
    std::os::unix::fs::symlink(&real, &linkroot).unwrap();
    let c = cfg(&linkroot);
    let via_link = linkroot.join("proj").join("a.jsonl");
    let got = config::validate_session_path(&c, via_link.to_str().unwrap()).unwrap();
    assert_eq!(got, std::fs::canonicalize(&f).unwrap());
}

#[test]
fn safety_directory_named_jsonl_rejected() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    // `x.jsonl` 是目录：校验直接 OUTSIDE_ROOT，删除层绝不能碰它。
    let d = proj.join("x.jsonl");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("inner.txt"), "keep").unwrap();
    let e = config::validate_session_path(&c, d.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot, "{e:?}");
    let rs = ops_cmds::delete_sessions_impl(&c, &[d.display().to_string()]);
    assert!(!rs[0].ok);
    assert!(d.is_dir() && d.join("inner.txt").exists());
}

#[test]
fn safety_dot_project_dir_rejected() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    // 点项目目录：编码 cwd 恒以 `-` 开头，点目录保守拒绝。
    let p = write_lines(
        &t.path().join(".hidden"),
        "a.jsonl",
        &[header("s-dot", "/tmp")],
    );
    let e = config::validate_session_path(&c, p.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot, "{e:?}");
    let rs = ops_cmds::delete_sessions_impl(&c, &[p.display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::OutsideRoot);
    assert!(p.exists());
}

#[test]
fn safety_unicode_and_nfd_names() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    // CJK + 空格 + NFC。
    let f = write_lines(&proj, "未命名 会话.jsonl", &[header("s-uni", "/tmp")]);
    let got = config::validate_session_path(&c, f.to_str().unwrap()).unwrap();
    assert_eq!(got, std::fs::canonicalize(&f).unwrap());
    // NFD（e + 组合重音）与 NFC 是不同字节序列：文件系统按字节区分，
    // 不存在的一方必须报 NOT_FOUND 而非误判通过。
    let nfc = "caf\u{e9}.jsonl"; // café（NFC）
    let nfd = "cafe\u{301}.jsonl"; // e + U+0301（NFD）
    assert_ne!(nfc.as_bytes(), nfd.as_bytes());
    let pf = write_lines(&proj, nfc, &[header("s-nfc", "/tmp")]);
    config::validate_session_path(&c, pf.to_str().unwrap()).unwrap();
    let missing = proj.join(nfd);
    if !missing.exists() {
        let e = config::validate_session_path(&c, missing.to_str().unwrap()).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
    }
}

#[test]
fn safety_long_path_and_nul_do_not_panic() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    // 300 字节单文件名：ENAMETOOLONG → IO（绝不 panic，绝不 Ok）。
    let long_name = format!("{}.jsonl", "x".repeat(300));
    let e = config::validate_session_path(&c, proj.join(&long_name).to_str().unwrap()).unwrap_err();
    assert!(matches!(e.code, ErrorCode::Io | ErrorCode::NotFound));
    // NUL 字节：InvalidInput → IO（绝不 panic）。
    let nul = format!("{}/a\0b.jsonl", proj.display());
    let e = config::validate_session_path(&c, &nul).unwrap_err();
    assert!(matches!(e.code, ErrorCode::Io | ErrorCode::OutsideRoot));
}

// ---------------------------------------------------------------------------
// §4.6 删除
// ---------------------------------------------------------------------------

#[test]
#[cfg(unix)]
fn safety_delete_symlinked_sibling_keeps_victim_via_impl() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let sess = write_lines(&proj, "victim.jsonl", &[header("sess-sym", "/tmp")]);
    let outside = t.path().join("real-victim-dir");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("precious.txt"), "do not delete").unwrap();
    std::os::unix::fs::symlink(&outside, proj.join("victim")).unwrap();
    let rs = ops_cmds::delete_sessions_impl(&c, &[sess.display().to_string()]);
    assert!(rs[0].ok, "{:?}", rs[0]);
    assert!(!sess.exists());
    assert!(
        std::fs::symlink_metadata(proj.join("victim")).is_err(),
        "链接本身应被删除"
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("precious.txt")).unwrap(),
        "do not delete"
    );
}

#[test]
fn safety_delete_bak_crafted_names() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let sess = write_lines(&proj, "a.jsonl", &[header("sess-bak", "/tmp")]);
    // `<x>.jsonl..bak` 形如 `<x>.jsonl.` 前缀 + `.bak` 后缀：按上游前缀规则清理。
    std::fs::write(proj.join("a.jsonl..bak"), "stale").unwrap();
    std::fs::write(proj.join("a.jsonl.999.bak"), "stale2").unwrap();
    // 无 `.bak` 后缀的不碰；无关 .bak 不碰。
    std::fs::write(proj.join("a.jsonl.999"), "keep").unwrap();
    std::fs::write(proj.join("other.jsonl.1.bak"), "keep2").unwrap();
    // `.bak` 是非空目录时 remove_file 必失败 → best-effort 记录但整体仍 ok。
    let bak_dir = proj.join("a.jsonl.dir.bak");
    std::fs::create_dir_all(&bak_dir).unwrap();
    std::fs::write(bak_dir.join("inner.txt"), "x").unwrap();
    // 用底层原语以便断言 bak_failed（上层 impl 不透出该字段）。
    let report =
        omp_resume_lib::ops::delete::delete_session_files(&std::fs::canonicalize(&sess).unwrap())
            .unwrap();
    assert!(!sess.exists());
    assert!(!proj.join("a.jsonl..bak").exists());
    assert!(!proj.join("a.jsonl.999.bak").exists());
    assert!(proj.join("a.jsonl.999").exists());
    assert!(proj.join("other.jsonl.1.bak").exists());
    assert_eq!(report.bak_failed.len(), 1, "{report:?}");
    assert!(report.bak_failed[0].ends_with("a.jsonl.dir.bak"));
    // 用 impl 再走一遍空目录场景：整体仍是逐路径独立 ok。
    let sess2 = write_lines(&proj, "b.jsonl", &[header("sess-bak2", "/tmp")]);
    let rs = ops_cmds::delete_sessions_impl(&c, &[sess2.display().to_string()]);
    assert!(rs[0].ok);
    let _ = c;
}
#[test]
fn safety_delete_hostile_session_id_no_lock_escape() {
    // header.id 直接拼成 `<ownersDir>/<id>.lock`：`/` 与 `.` 必须被
    // `valid_session_id` 挡下，否则可探测/污染任意锁文件。
    // 此处锁定：非法 id → PROBE_FAILED（不敢删），文件保留。
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    for (name, evil_id) in [
        ("evil1.jsonl", "../escape"),
        ("evil2.jsonl", "a/b"),
        ("evil3.jsonl", "x.lock"),
        ("evil4.jsonl", "a!b"),
        ("evil5.jsonl", ""),
    ] {
        let p = write_lines(&proj, name, &[header(evil_id, "/tmp")]);
        let snap = std::fs::read(&p).unwrap();
        // probe 直调同样 fail-closed。
        let pb = omp_resume_lib::lock::probe(&c.owners_dir, evil_id);
        assert!(!pb.probe_ok && !pb.in_use, "{evil_id:?} -> {pb:?}");
        let rs = ops_cmds::delete_sessions_impl(&c, &[p.display().to_string()]);
        // 空 id 的 header 仍是合法 JSON 但 id 为空：header_info 通过，
        // probe 拒绝 → IN_USE/PROBE_FAILED；统一断言不敢删。
        assert!(!rs[0].ok, "{evil_id:?}: {:?}", rs[0]);
        assert_eq!(std::fs::read(&p).unwrap(), snap);
    }
}

#[test]
fn safety_delete_stem_prefix_isolation() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let a = write_lines(&proj, "a.jsonl", &[header("sess-a", "/tmp")]);
    std::fs::create_dir_all(proj.join("a")).unwrap();
    std::fs::write(proj.join("a").join("art.txt"), "a-art").unwrap();
    // stem 仅前缀相同：`a2.jsonl` 与 `a.jsonl.old.jsonl` 都不是同一会话。
    let a2 = write_lines(&proj, "a2.jsonl", &[header("sess-a2", "/tmp")]);
    std::fs::create_dir_all(proj.join("a2")).unwrap();
    std::fs::write(proj.join("a2").join("keep.txt"), "k").unwrap();
    let a_old = write_lines(&proj, "a.jsonl.old.jsonl", &[header("sess-old", "/tmp")]);
    std::fs::write(proj.join("a.jsonl.1.bak"), "stale-a").unwrap();
    std::fs::write(proj.join("a2.jsonl.1.bak"), "stale-a2").unwrap();
    let rs = ops_cmds::delete_sessions_impl(&c, &[a.display().to_string()]);
    assert!(rs[0].ok, "{:?}", rs[0]);
    assert!(!a.exists() && !proj.join("a").exists());
    assert!(!proj.join("a.jsonl.1.bak").exists());
    assert!(a2.exists() && proj.join("a2").join("keep.txt").exists());
    assert!(proj.join("a2.jsonl.1.bak").exists(), " чужой .bak 必须保留");
    assert!(a_old.exists(), "a.jsonl.old.jsonl 必须保留");
}

#[test]
fn safety_delete_nested_sibling_jsonl_not_directly_deletable() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let top = write_lines(&proj, "top.jsonl", &[header("sess-top", "/tmp")]);
    // sibling 目录内的子 agent 嵌套 jsonl：深度 3，删除入口必须拒绝。
    let sib = proj.join("top");
    let nested = write_bytes(&sib.join("sub"), "nested.jsonl", b"{}\n");
    let rs = ops_cmds::delete_sessions_impl(&c, &[nested.display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::OutsideRoot);
    assert!(nested.exists());
    // 删顶层时 sibling（含嵌套）整体消失，但顶层之外的东西不动。
    let rs = ops_cmds::delete_sessions_impl(&c, &[top.display().to_string()]);
    assert!(rs[0].ok, "{:?}", rs[0]);
    assert!(!sib.exists());
}

#[test]
fn safety_delete_dotfile_rejected() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let dot = write_bytes(&proj, ".x.jsonl", b"{}\n");
    let e = config::validate_session_path(&c, dot.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
    let rs = ops_cmds::delete_sessions_impl(&c, &[dot.display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::OutsideRoot);
    assert!(dot.exists());
}

#[test]
fn safety_delete_in_use_child_flock_leaves_bytes() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let busy = write_lines(&proj, "busy.jsonl", &[header("sess-child-busy", "/tmp")]);
    std::fs::create_dir_all(proj.join("busy")).unwrap();
    std::fs::write(proj.join("busy").join("keep.txt"), "k").unwrap();
    let before = std::fs::read(&busy).unwrap();
    let child = hold_lock_child(&c.owners_dir, "sess-child-busy");
    let rs = ops_cmds::delete_sessions_impl(&c, &[busy.display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::InUse);
    assert_eq!(std::fs::read(&busy).unwrap(), before, "占用中必须字节一致");
    assert!(proj.join("busy").join("keep.txt").exists());
    kill_child(child);
    // 锁释放后同一文件可删（确保持锁确实生效过，而非探测恒失败）。
    let rs = ops_cmds::delete_sessions_impl(&c, &[busy.display().to_string()]);
    assert!(rs[0].ok, "{:?}", rs[0]);
}

#[test]
fn safety_delete_corrupt_header_keeps_file() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    for (name, bytes) in [
        ("bad.jsonl", b"{not json\n".as_slice()),
        ("empty.jsonl", b"".as_slice()),
        (
            "noid.jsonl",
            b"{\"type\":\"session\",\"version\":3}\n".as_slice(),
        ),
    ] {
        let p = write_bytes(&proj, name, bytes);
        let snap = std::fs::read(&p).unwrap();
        let rs = ops_cmds::delete_sessions_impl(&c, &[p.display().to_string()]);
        // 空文件：validate 先报 OUTSIDE_ROOT（不是常规文件检查在 metadata len？
        // 不，空文件仍是常规文件，validate 通过，header 失败 → PROBE_FAILED）。
        // 统一断言：绝不 ok，且字节保留。
        assert!(!rs[0].ok, "{name}: {:?}", rs[0]);
        assert_eq!(std::fs::read(&p).unwrap(), snap, "{name} 必须保留");
    }
    // 坏 header 的精确码：非空损坏 → PROBE_FAILED（不敢盲删）。
    let p = write_bytes(&proj, "bad2.jsonl", b"{not json\n");
    let rs = ops_cmds::delete_sessions_impl(&c, &[p.display().to_string()]);
    assert_eq!(rs[0].error.as_ref().unwrap().code, ErrorCode::ProbeFailed);
}

#[test]
fn safety_delete_batch_duplicates() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let a = write_lines(&proj, "dup.jsonl", &[header("sess-dup", "/tmp")]);
    let missing = proj.join("missing.jsonl").display().to_string();
    let rs = ops_cmds::delete_sessions_impl(
        &c,
        &[
            a.display().to_string(),
            a.display().to_string(),
            missing.clone(),
        ],
    );
    assert_eq!(rs.len(), 3);
    assert!(rs[0].ok, "{:?}", rs[0]);
    // 同一批第二次：文件已无 → NOT_FOUND（不是二次删除崩溃）。
    assert_eq!(rs[1].error.as_ref().unwrap().code, ErrorCode::NotFound);
    assert_eq!(rs[2].error.as_ref().unwrap().code, ErrorCode::NotFound);
    assert!(!a.exists());
}

// ---------------------------------------------------------------------------
// §4.7 marker 追加
// ---------------------------------------------------------------------------

#[test]
fn safety_marker_concurrent_appends_no_interleave() {
    // O_APPEND 单次 write_all 行级原子：两线程各 25 行 must 无交错、无缺行。
    // 残余竞态（文档化，无法消除）：若 omp 在探测→写之间追加了新行，marker
    // 可能不再是末行（分支被覆盖），续聊前重查 leaf 即可发现；文件本身不坏行。
    let t = tempfile::tempdir().unwrap();
    let p = write_lines(
        &t.path().join("m"),
        "s.jsonl",
        &[header("sess-conc", "/tmp")],
    );
    let per_thread = 25;
    std::thread::scope(|s| {
        for th in 0..2 {
            let p = &p;
            s.spawn(move || {
                for i in 0..per_thread {
                    let line = marker::build_marker_line(
                        &format!("t{th}{i:06x}"),
                        "u1",
                        "2026-10-14T02:18:47.387Z",
                    );
                    marker::append_marker_line(p, &line).unwrap();
                }
            });
        }
    });
    let content = std::fs::read_to_string(&p).unwrap();
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1 + 2 * per_thread);
    let mut ids = HashSet::new();
    for line in lines.into_iter().skip(1) {
        let v: Value = serde_json::from_str(line).expect("断行/交错");
        assert!(ids.insert(v["id"].as_str().unwrap().to_owned()));
    }
}

#[test]
fn safety_marker_crlf_bom_empty_headeronly_whitespace() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");

    // CRLF：末字节仍是 \n，通过；追加后混合换行仍逐行可解析。
    let crlf = proj.join("crlf.jsonl");
    std::fs::create_dir_all(&proj).unwrap();
    let crlf_bytes = format!(
        "{}\r\n{}\r\n",
        header("sess-crlf", "/tmp"),
        msg("u1", None, user_msg("hi"))
    );
    std::fs::write(&crlf, &crlf_bytes).unwrap();
    let r = ops_cmds::append_branch_marker_impl(&c, &crlf.display().to_string(), "u1");
    // u1 已是 leaf（单保留节点）→ 无操作，而非追加。
    assert!(r.unwrap().marker_id.is_none());
    assert_eq!(std::fs::read(&crlf).unwrap(), crlf_bytes.as_bytes());

    // CRLF 两节点：u1 非 leaf，可追加且不破坏原有字节。
    let crlf2 = proj.join("crlf2.jsonl");
    let crlf2_bytes = format!(
        "{}\r\n{}\r\n{}\r\n",
        header("sess-crlf2", "/tmp"),
        msg("u1", None, user_msg("hi")),
        msg("a1", Some("u1"), assistant_msg("yo"))
    );
    std::fs::write(&crlf2, &crlf2_bytes).unwrap();
    let r = ops_cmds::append_branch_marker_impl(&c, &crlf2.display().to_string(), "u1").unwrap();
    assert!(r.marker_id.is_some());
    let raw = std::fs::read(&crlf2).unwrap();
    assert_eq!(&raw[..crlf2_bytes.len()], crlf2_bytes.as_bytes());
    assert!(raw.ends_with(b"\n"));

    // UTF-8 BOM：header_info 严格（BOM 行 JSON 失败 → header 不可读），
    // parse/marker 则宽容跳过坏行。两者不一致是故意的保守差：
    // 删除不敢删（PROBE_FAILED），marker 若 header 可达仍可追加。
    // 此处只锁定“不损坏”：追加前后前缀字节一致。
    let bom = proj.join("bom.jsonl");
    let mut bom_bytes = vec![0xEF, 0xBB, 0xBF];
    bom_bytes.extend_from_slice(
        format!(
            "{}\n{}\n{}\n",
            header("sess-bom", "/tmp"),
            msg("u1", None, user_msg("hi")),
            msg("a1", Some("u1"), assistant_msg("yo"))
        )
        .as_bytes(),
    );
    std::fs::write(&bom, &bom_bytes).unwrap();
    let info = sessions::header_info(
        &config::validate_session_path(&c, bom.to_str().unwrap()).unwrap_or_else(|_| {
            // validate 本身应通过（常规文件、形状合法）；若失败则直接记录。
            panic!("bom validate 应通过");
        }),
    );
    // header_info 对 BOM 的态度：首行 BOM+`{...` 若在同一行则失败；
    // 此处 BOM 独立成行前缀（BOM+`{` 同行）→ JSON 失败 → Io。
    assert!(info.is_err(), "BOM 头应被 header_info 视为损坏: {info:?}");
    let snap = std::fs::read(&bom).unwrap();
    // marker 路径：parse 跳过坏行仍能找到 header，u1 非 leaf 则追加成功；
    // 无论成功与否，失败时文件必须字节一致。
    match ops_cmds::append_branch_marker_impl(&c, &bom.display().to_string(), "u1") {
        Ok(r) => {
            assert!(r.marker_id.is_some());
            let raw = std::fs::read(&bom).unwrap();
            assert_eq!(&raw[..snap.len()], &snap[..]);
        }
        Err(e) => {
            assert_eq!(std::fs::read(&bom).unwrap(), snap);
            // 允许的码：Ano? 当前实现 parse 能找到 header，应成功；若失败只许 IO 系。
            assert!(
                matches!(
                    e.code,
                    ErrorCode::Io | ErrorCode::UnsupportedFormat | ErrorCode::ProbeFailed
                ),
                "{e:?}"
            );
        }
    }

    // 空文件：impl 在 marker_context 即报 UNSUPPORTED_FORMAT（无 header version），文件不动。
    let empty = write_bytes(&proj, "empty.jsonl", b"");
    let snap = std::fs::read(&empty).unwrap();
    let e =
        ops_cmds::append_branch_marker_impl(&c, &empty.display().to_string(), "u1").unwrap_err();
    assert_eq!(e.code, ErrorCode::UnsupportedFormat, "{e:?}");
    assert_eq!(std::fs::read(&empty).unwrap(), snap);
    // 底层原语对空文件直接 IO。
    let e = marker::append_marker_line(&empty, "{\"a\":1}\n").unwrap_err();
    assert_eq!(e.code, ErrorCode::Io);

    // header-only：无保留节点，任意 nodeId 都是 INVALID_NODE。
    let ho = write_lines(&proj, "ho.jsonl", &[header("sess-ho", "/tmp")]);
    let snap = std::fs::read(&ho).unwrap();
    let e = ops_cmds::append_branch_marker_impl(&c, &ho.display().to_string(), "u1").unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidNode);
    assert_eq!(std::fs::read(&ho).unwrap(), snap);

    // 末行空白（"   \n"）：末字节 \n，通过；parse 跳过空行，leaf 不变。
    let ws = proj.join("ws.jsonl");
    let ws_bytes = format!(
        "{}\n{}\n{}\n   \n",
        header("sess-ws", "/tmp"),
        msg("u1", None, user_msg("hi")),
        msg("a1", Some("u1"), assistant_msg("yo"))
    );
    std::fs::write(&ws, &ws_bytes).unwrap();
    let r = ops_cmds::append_branch_marker_impl(&c, &ws.display().to_string(), "u1").unwrap();
    assert!(r.marker_id.is_some());
    let raw = std::fs::read(&ws).unwrap();
    assert_eq!(&raw[..ws_bytes.len()], ws_bytes.as_bytes());
}

#[test]
fn safety_marker_kept_vs_skipped_vs_self_idempotent() {
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    let p = branch_session(&proj, "b.jsonl", "sess-mk", "/tmp");
    let ps = p.display().to_string();

    // 被跳过的 custom id 与未知 id：INVALID_NODE。
    for bad in ["c1", "zzzzzzzz"] {
        let e = ops_cmds::append_branch_marker_impl(&c, &ps, bad).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidNode, "{bad}");
    }
    // 中部 kept 节点：追加成功，leaf 回到该节点（marker 跳过）。
    let before = std::fs::read(&p).unwrap();
    let mid = ops_cmds::append_branch_marker_impl(&c, &ps, "u2")
        .unwrap()
        .marker_id
        .expect("应写入");
    assert_eq!(mid.len(), 8);
    let raw = std::fs::read(&p).unwrap();
    assert_eq!(&raw[..before.len()], &before[..]);
    // marker 自身 id：custom 跳过类型 → INVALID_NODE（绝不以 marker 为父再套 marker）。
    let e = ops_cmds::append_branch_marker_impl(&c, &ps, &mid).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidNode);
    // 幂等：同一 node 再次追加 → 无操作（marker 已使 tree-leaf 回到 u2），文件不动。
    let snap = std::fs::read(&p).unwrap();
    let r2 = ops_cmds::append_branch_marker_impl(&c, &ps, "u2").unwrap();
    assert_eq!(r2.marker_id, None);
    assert_eq!(std::fs::read(&p).unwrap(), snap);
    // 重复追加永不损坏：逐行可解析，且 marker 行恰好一行。
    let content = std::fs::read_to_string(&p).unwrap();
    assert_eq!(content.matches('\n').count(), content.lines().count());
    for line in content.lines() {
        let _: Value = serde_json::from_str(line).expect("坏行");
    }
}

#[test]
#[cfg(unix)]
fn safety_marker_symlink_refused_victim_untouched() {
    // 回归：校验→追加之间文件被换成指向根外的链接时，跟随写入会污染受害文件。
    // 修复后：symlink 快拒 + O_NOFOLLOW，追加失败且受害字节一致。
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let victim = t.path().join("victim-target.txt");
    let victim_before = b"{\"type\":\"session\",\"version\":3,\"id\":\"v\"}\n";
    std::fs::write(&victim, victim_before).unwrap();
    // 会话文件先是真实文件（validate 可通过），随后被换成链接（模拟竞态）。
    let sess = write_lines(&proj, "race.jsonl", &[header("sess-race", "/tmp")]);
    let _valid = config::validate_session_path(&c, sess.to_str().unwrap()).unwrap();
    std::fs::remove_file(&sess).unwrap();
    std::os::unix::fs::symlink(&victim, &sess).unwrap();
    let line = marker::build_marker_line("deadbeef", "u1", "2026-10-14T02:18:47.387Z");
    let e = marker::append_marker_line(&sess, &line).unwrap_err();
    assert_eq!(e.code, ErrorCode::Io, "{e:?}");
    assert_eq!(std::fs::read(&victim).unwrap(), victim_before);
    // 初始即链接的会话路径：validate 已 canonicalize 到根外 → OUTSIDE_ROOT。
    let e = config::validate_session_path(&c, sess.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
}

// ---------------------------------------------------------------------------
// §4.8 iTerm（纯函数断言，绝不启动 iTerm/omp）
// ---------------------------------------------------------------------------

#[test]
fn safety_iterm_hostile_quoting_no_breakout() {
    //  hostile 语料：引号 / $() / 反引号 / 分号 / 换行 / unicode / 前导 `-`。
    let cases = [
        ("a'b", "'a'\"'\"'b'"),
        ("a$HOME`id`;rm -rf /", "'a$HOME`id`;rm -rf /'"),
        ("$(evil)", "'$(evil)'"),
        ("`evil`", "'`evil`'"),
        ("a;b|c&d", "'a;b|c&d'"),
        ("/Users/x/未命名文件夹", "'/Users/x/未命名文件夹'"),
        ("-n", "'-n'"),
        ("", "''"),
    ];
    for (raw, quoted) in cases {
        assert_eq!(iterm::shell_quote(raw), quoted, "raw={raw:?}");
    }
    // resume_command 精确形：cd '<cwd>' && omp --resume '<path>'。
    let cmd = iterm::resume_command("/tmp/$HOME", "/s/a`id`;x.jsonl");
    assert_eq!(cmd, "cd '/tmp/$HOME' && omp --resume '/s/a`id`;x.jsonl'");
    // 前导 `-` 的 cwd 恒为绝对路径（以 `/` 开头），不会被 cd 误作选项。
    let cmd2 = iterm::resume_command("/-evil", "/s/a.jsonl");
    assert!(cmd2.starts_with("cd '/-evil'"));

    // AppleScript：`"` 与 `\` 转义，控制字符剥离，绝不能跳出 `"..."`。
    for hostile in [
        "'; rm -rf /; echo '",
        "\"; tell application \"Finder\" to delete every file; echo \"",
        "a\\b\"c",
        "echo a\necho b",
        "cd '/tmp'; omp --resume '/s/x'; evil",
        "未命名\"文件\\",
    ] {
        let script = iterm::build_script(hostile);
        // write text 的参数必须是单行双引号字符串：剥离换行后仍只有一对语义引号。
        assert!(!script.contains("echo a\necho b"), "{script}");
        // 粗暴但有效：脚本中 `write text "` 之后到行尾不应出现未转义的 `"` 闭合注入。
        // 转义后的 hostile 不得含有裸换行（AppleScript 字面量不能跨行）。
        let escaped = iterm::applescript_escape(hostile);
        assert!(
            !escaped.chars().any(|ch| ch == '\n' || ch == '\r'),
            "{hostile:?}"
        );
        assert!(
            script.contains(&format!("write text \"{escaped}\"")),
            "{script}"
        );
    }
    // 换行剥离是 fail-safe（文档化决策）：调用方本就不应传入控制字符；
    // 此处锁定“剥离不断行”，而非静默执行半截命令。
    assert_eq!(iterm::applescript_escape("a\nb\rc\td"), "abcd");
    let multiline = iterm::build_script("echo a\necho b");
    assert!(
        multiline.contains("write text \"echo aecho b\""),
        "{multiline}"
    );
    // 反斜杠先转义，引号后转义：`a\b"c` → `a\\b\"c`。
    assert_eq!(iterm::applescript_escape("a\\b\"c"), "a\\\\b\\\"c");
}

#[test]
fn safety_iterm_impl_uses_quoting_and_refusals() {
    use std::cell::RefCell;
    let t = tempfile::tempdir().unwrap();
    let c = cfg(t.path());
    let proj = t.path().join("proj");
    // 含空格/CJK/单引号的 cwd 与会话路径。
    let cwd = t.path().join("my dir 未命名'x");
    std::fs::create_dir_all(&cwd).unwrap();
    let p = branch_session(&proj, "i.jsonl", "sess-i9", &cwd.display().to_string());
    let got = RefCell::new(String::new());
    let opener = |cmd: &str| -> Result<(), omp_resume_lib::model::AppError> {
        got.replace(cmd.to_owned());
        Ok(())
    };
    ops_cmds::open_in_iterm_impl(&c, &p.display().to_string(), &opener).unwrap();
    let valid = config::validate_session_path(&c, &p.display().to_string()).unwrap();
    assert_eq!(
        got.borrow().as_str(),
        &format!(
            "cd '{}' && omp --resume '{}'",
            cwd.display().to_string().replace('\'', "'\"'\"'"),
            valid.display(),
        )
    );
    // IN_USE 拒绝且 opener 未调用；PROBE_FAILED 放行（只读打开不占租约 §4.8）。
    let b = branch_session(&proj, "b2.jsonl", "sess-busy9", &cwd.display().to_string());
    let _guard = {
        std::fs::create_dir_all(&c.owners_dir).unwrap();
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(c.owners_dir.join("sess-busy9.lock"))
            .unwrap();
        use std::os::unix::io::AsRawFd;
        let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(rc, 0);
        f
    };
    got.replace(String::new());
    let e = ops_cmds::open_in_iterm_impl(&c, &b.display().to_string(), &opener).unwrap_err();
    assert_eq!(e.code, ErrorCode::InUse);
    assert!(got.borrow().is_empty());
}
