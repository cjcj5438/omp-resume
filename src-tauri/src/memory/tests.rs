//! `memory` 纯函数单测（不碰真实库）。

use super::*;
use crate::model::ErrorCode;

#[test]
fn snippet_folds_truncates_and_stays_char_safe() {
    assert_eq!(make_snippet("a  b\n\tc", 7), "a b c");
    assert_eq!(make_snippet("", 0), "");
    assert_eq!(make_snippet("   ", 3), "");
    // 前缀外还有正文 ⇒ 加 `…`（即使折叠后不足 240）。
    assert_eq!(make_snippet("hi", 600), "hi…");
    let full240: String = "字".repeat(240);
    assert_eq!(make_snippet(&full240, 240), full240);
    assert_eq!(
        make_snippet(&("字".repeat(241)), 241),
        format!("{full240}…")
    );
    // 混合多字节截断仍合法且恰为 240 + `…`。
    let text: String = "a字😀".repeat(200);
    let out = make_snippet(&text, text.chars().count() as u64);
    assert_eq!(out.chars().count(), SNIPPET_CHARS + 1);
    assert!(out.ends_with('…'));
    assert!(out.is_char_boundary(out.len() - '…'.len_utf8()));
}

#[test]
fn parse_memory_ts_accepts_real_shapes() {
    for (raw, want) in [
        ("2026-10-12T15:49:48.332Z", "2026-10-12T15:49:48.332Z"),
        ("2026-10-12T23:49:48+08:00", "2026-10-12T15:49:48.000Z"),
        ("2026-10-12 15:49:48", "2026-10-12T15:49:48.000Z"),
    ] {
        let dt = parse_memory_ts(raw).unwrap();
        assert_eq!(
            dt.to_rfc3339_opts(SecondsFormat::Millis, true),
            want,
            "{raw}"
        );
    }
    assert_eq!(
        iso_millis_opt(Some("2026-10-12 15:49:48")),
        Some("2026-10-12T15:49:48.000Z".into())
    );
    for bad in ["", "not-a-time", "2026-13-99T99:99:99Z"] {
        assert_eq!(parse_memory_ts(bad), None, "{bad}");
    }
    assert_eq!(iso_millis_opt(None), None);
}

#[test]
fn metadata_extract_and_secret_stripping() {
    let meta = Some(r#"{"cwd":"/tmp/p","session_id":"abc","n":1}"#);
    assert_eq!(metadata_field(meta, "cwd").as_deref(), Some("/tmp/p"));
    assert_eq!(metadata_field(meta, "session_id").as_deref(), Some("abc"));
    // 缺失 / 非字符串 / 空串 / 非对象 / 脏 JSON ⇒ None。
    for bad in [
        metadata_field(meta, "n"),
        metadata_field(meta, "missing"),
        metadata_field(Some(r#"{"cwd":""}"#), "cwd"),
        metadata_field(Some("[]"), "cwd"),
        metadata_field(Some("{oops"), "cwd"),
        metadata_field(None, "cwd"),
    ] {
        assert_eq!(bad, None);
    }
    // 顶层疑似密钥键删除；数组/标量/脏 JSON ⇒ None；嵌套不动。
    let meta = Some(
        r#"{"cwd":"/p","api_key":"K","TOKEN":"T","password_hash":"H","nested":{"key":"keep"}}"#,
    );
    let value = metadata_object(meta).unwrap();
    let object = value.as_object().unwrap();
    assert_eq!(object.get("cwd").unwrap(), "/p");
    assert!(object.get("nested").is_some());
    assert!(!object
        .keys()
        .any(|k| k.contains("key") || k == "TOKEN" || k == "password_hash"));
    assert_eq!(metadata_object(Some("[1]")), None);
    assert_eq!(metadata_object(Some("{bad")), None);
    assert_eq!(metadata_object(None), None);
}

#[test]
fn display_name_and_bank_root_resolution() {
    assert_eq!(
        display_name("my-jes4bv6giqhb", Some("/Users/demo/my")),
        "my"
    );
    // cwd 未知 ⇒ 去 hash 后缀；无后缀原样；cwd 无 basename ⇒ 回退 hash 规则。
    assert_eq!(display_name("my-jes4bv6giqhb", None), "my");
    assert_eq!(display_name("plainbank", None), "plainbank");
    assert_eq!(display_name("my-jes4bv6giqhb", Some("/")), "my");
    let home = Path::new("/Users/demo");
    assert_eq!(
        resolve_bank_root_with(|_| None, home),
        home.join(".omp/agent/memories/mnemopi/banks")
    );
    assert_eq!(
        resolve_bank_root_with(
            |k| (k == MEMORY_DIR_ENV).then(|| "/tmp/banks".to_owned()),
            home
        ),
        PathBuf::from("/tmp/banks")
    );
}

#[test]
fn validate_bank_rejects_traversal_and_accepts_plain_names() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(root.join("proj-abc123")).unwrap();
    std::fs::write(root.join("afile"), b"x").unwrap();
    for bad in [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "a\0b",
        "../escape",
        "sub/../x",
    ] {
        let err = validate_bank(&root, bad).unwrap_err();
        assert_eq!(err.code, ErrorCode::OutsideRoot, "{bad:?}");
    }
    // 不存在 / 指向文件 / 根缺失 ⇒ NOT_FOUND。
    for (root, bank) in [
        (root.clone(), "nope"),
        (root.clone(), "afile"),
        (root.join("missing-root"), "x"),
    ] {
        assert_eq!(
            validate_bank(&root, bank).unwrap_err().code,
            ErrorCode::NotFound,
            "{bank}"
        );
    }
    let dir = validate_bank(&root, "proj-abc123").unwrap();
    assert!(dir.ends_with("proj-abc123") && dir.is_absolute());
}

#[test]
#[cfg(unix)]
fn validate_bank_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let outside = tmp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    symlink(&outside, root.join("evil")).unwrap();
    symlink(root.join("missing-target"), root.join("dangling")).unwrap();
    assert_eq!(
        validate_bank(&root, "evil").unwrap_err().code,
        ErrorCode::OutsideRoot
    );
    assert_eq!(
        validate_bank(&root, "dangling").unwrap_err().code,
        ErrorCode::NotFound
    );
    // 根内合法链接允许。
    std::fs::create_dir_all(root.join("real-1")).unwrap();
    symlink(root.join("real-1"), root.join("alias")).unwrap();
    assert!(validate_bank(&root, "alias").is_ok());
}

#[test]
fn scan_session_uuids_matches_top_level_jsonl_only() {
    let tmp = tempfile::tempdir().unwrap();
    let proj = tmp.path().join("sessions").join("-proj");
    std::fs::create_dir_all(&proj).unwrap();
    let good = "2026-10-14T02-18-47-387Z_01a13834-1111-2222-3333-444444444444.jsonl";
    std::fs::write(proj.join(good), "{}\n").unwrap();
    // 干扰项：点文件、bak、嵌套、坏名、无下划线。
    std::fs::write(proj.join(format!(".{good}.lock.os")), "").unwrap();
    std::fs::write(proj.join(format!("{good}.9.bak")), "").unwrap();
    std::fs::create_dir_all(proj.join("nested")).unwrap();
    std::fs::write(
        proj.join("nested")
            .join(good.replace("01a13834", "02b24945")),
        "",
    )
    .unwrap();
    std::fs::write(proj.join("2026-10-14T02-18-47-387Z_not-a-uuid.jsonl"), "").unwrap();
    std::fs::write(proj.join("nouuid.jsonl"), "").unwrap();
    let sessions = tmp.path().join("sessions");
    let set = scan_session_uuids(&sessions);
    assert_eq!(set.len(), 1);
    assert!(set.contains("01a13834-1111-2222-3333-444444444444"));
    assert!(scan_session_uuids(&proj.join("missing")).is_empty());
}
