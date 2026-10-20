//! `memory` 纯函数单测（不碰真实库）。

use super::*;
use crate::model::ErrorCode;

#[test]
fn like_pattern_escapes_wildcards() {
    assert_eq!(like_pattern("abc"), "%abc%");
    assert_eq!(like_pattern("100%_\\"), "%100\\%\\_\\\\%");
    // CJK 原样通过。
    assert_eq!(like_pattern("原生桌面"), "%原生桌面%");
}

#[test]
fn snippet_folds_whitespace_and_marks_truncation() {
    assert_eq!(make_snippet("a  b\n\tc", 7), "a b c");
    assert_eq!(make_snippet("", 0), "");
    assert_eq!(make_snippet("   ", 3), "");
    // 前缀外还有正文 ⇒ 加 `…`（即使折叠后不足 240）。
    assert_eq!(make_snippet("hi", 600), "hi…");
    // 240 字符整 ⇒ 不加；241 ⇒ 加。
    let full240: String = "字".repeat(240);
    assert_eq!(make_snippet(&full240, 240), full240);
    let full241: String = "字".repeat(241);
    assert_eq!(
        make_snippet(&full241, 241),
        format!("{}…", "字".repeat(240))
    );
}

#[test]
fn snippet_cut_is_char_boundary_safe() {
    // 混合多字节：截断后仍为合法字符串且恰为 240 字符 + `…`。
    let text: String = "a字😀".repeat(200);
    let out = make_snippet(&text, text.chars().count() as u64);
    assert_eq!(out.chars().count(), SNIPPET_CHARS + 1);
    assert!(out.ends_with('…'));
    assert!(out.is_char_boundary(out.len() - '…'.len_utf8()));
}

#[test]
fn truncate_bytes_respects_char_boundary() {
    let (s, t) = truncate_bytes("abcdef", 6);
    assert_eq!((s.as_str(), t), ("abcdef", false));
    let (s, t) = truncate_bytes("abcdef", 4);
    assert_eq!((s.as_str(), t), ("abcd", true));
    // `字` 3 字节：cap=4 时退到字符边界（3 字节）。
    let (s, t) = truncate_bytes("a字b", 4);
    assert_eq!((s.as_str(), t), ("a字", true));
    assert!(s.len() <= 4);
}

#[test]
fn parse_memory_ts_accepts_real_shapes() {
    // 上游 `toISOString` 形态。
    let dt = parse_memory_ts("2026-10-12T15:49:48.332Z").unwrap();
    assert_eq!(
        dt.to_rfc3339_opts(SecondsFormat::Millis, true),
        "2026-10-12T15:49:48.332Z"
    );
    // 偏移量归一到 UTC。
    let dt = parse_memory_ts("2026-10-12T23:49:48+08:00").unwrap();
    assert_eq!(
        dt.to_rfc3339_opts(SecondsFormat::Millis, true),
        "2026-10-12T15:49:48.000Z"
    );
    // SQLite `CURRENT_TIMESTAMP`（UTC 无时区）。
    let dt = parse_memory_ts("2026-10-12 15:49:48").unwrap();
    assert_eq!(
        dt.to_rfc3339_opts(SecondsFormat::Millis, true),
        "2026-10-12T15:49:48.000Z"
    );
    assert_eq!(
        iso_millis_opt(Some("2026-10-12 15:49:48")),
        Some("2026-10-12T15:49:48.000Z".into())
    );
    // 垃圾 ⇒ None。
    assert_eq!(parse_memory_ts(""), None);
    assert_eq!(parse_memory_ts("not-a-time"), None);
    assert_eq!(parse_memory_ts("2026-13-99T99:99:99Z"), None);
    assert_eq!(iso_millis_opt(None), None);
}

#[test]
fn metadata_field_extracts_non_empty_strings() {
    let meta = Some(r#"{"cwd":"/tmp/p","session_id":"abc","n":1}"#);
    assert_eq!(metadata_field(meta, "cwd").as_deref(), Some("/tmp/p"));
    assert_eq!(metadata_field(meta, "session_id").as_deref(), Some("abc"));
    assert_eq!(metadata_field(meta, "n"), None);
    assert_eq!(metadata_field(meta, "missing"), None);
    assert_eq!(metadata_field(Some(r#"{"cwd":""}"#), "cwd"), None);
    assert_eq!(metadata_field(Some("[]"), "cwd"), None);
    assert_eq!(metadata_field(Some("{oops"), "cwd"), None);
    assert_eq!(metadata_field(None, "cwd"), None);
}

#[test]
fn metadata_object_strips_secret_like_keys() {
    let meta = Some(
        r#"{"cwd":"/tmp/p","api_key":"K","TOKEN":"T","password_hash":"H","nested":{"key":"keep"}}"#,
    );
    let v = metadata_object(meta).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.get("cwd").unwrap(), "/tmp/p");
    assert!(obj.get("api_key").is_none());
    assert!(obj.get("TOKEN").is_none());
    assert!(obj.get("password_hash").is_none());
    // 仅处理顶层：嵌套原样保留。
    assert!(obj.get("nested").is_some());
    assert_eq!(metadata_object(Some("[1]")), None);
    assert_eq!(metadata_object(Some("{bad")), None);
    assert_eq!(metadata_object(None), None);
}

#[test]
fn display_name_prefers_cwd_basename() {
    assert_eq!(
        display_name("my-jes4bv6giqhb", Some("/Users/demo/my")),
        "my"
    );
    // cwd 未知 ⇒ 去 hash 后缀；无后缀原样。
    assert_eq!(display_name("my-jes4bv6giqhb", None), "my");
    assert_eq!(display_name("plainbank", None), "plainbank");
    // cwd 无 basename（根目录）⇒ 回退 hash 规则。
    assert_eq!(display_name("my-jes4bv6giqhb", Some("/")), "my");
}

#[test]
fn resolve_bank_root_prefers_env() {
    let home = Path::new("/Users/demo");
    let root = resolve_bank_root_with(|_| None, home);
    assert_eq!(root, home.join(".omp/agent/memories/mnemopi/banks"));
    let root = resolve_bank_root_with(
        |k| (k == MEMORY_DIR_ENV).then(|| "/tmp/banks".to_owned()),
        home,
    );
    assert_eq!(root, PathBuf::from("/tmp/banks"));
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
    // 不存在 ⇒ NOT_FOUND；指向文件 ⇒ NOT_FOUND。
    assert_eq!(
        validate_bank(&root, "nope").unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        validate_bank(&root, "afile").unwrap_err().code,
        ErrorCode::NotFound
    );
    // 根目录缺失 ⇒ NOT_FOUND（非 panic）。
    assert_eq!(
        validate_bank(&root.join("missing-root"), "x")
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let dir = validate_bank(&root, "proj-abc123").unwrap();
    assert!(dir.ends_with("proj-abc123"));
    assert!(dir.is_absolute());
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
    // 悬空链接 ⇒ NOT_FOUND。
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
    let sessions = tmp.path().join("sessions");
    let proj = sessions.join("-proj");
    std::fs::create_dir_all(&proj).unwrap();
    let good = "2026-10-14T02-18-47-387Z_01a13834-1111-2222-3333-444444444444.jsonl";
    std::fs::write(proj.join(good), "{}\n").unwrap();
    // 干扰项：点文件、bak、嵌套、坏名、无下划线。
    std::fs::write(
        proj.join(".2026-10-14T02-18-47-387Z_01a13834-1111-2222-3333-444444444444.jsonl.lock.os"),
        "",
    )
    .unwrap();
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

    let set = scan_session_uuids(&sessions);
    assert_eq!(set.len(), 1);
    assert!(set.contains("01a13834-1111-2222-3333-444444444444"));
    // 不可读目录 ⇒ 空集（非 panic）。
    assert!(scan_session_uuids(&sessions.join("missing")).is_empty());
}

/// 锁定 `onlyMissingSource` 依赖的 SQLite JSON 语义：裸 `json_extract` 遇脏
/// JSON 直接报错（故 SQL 必须用 `json_valid` 守卫，见 `where_clauses`）；
/// 守卫后脏 JSON / 非对象 / 数字 id 一律落到 NULL / 非 text，
/// 与 Rust 侧 `metadata_field`（非字符串 ⇒ None）一致。
#[test]
fn sqlite_json_extract_needs_valid_guard() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // 无守卫：脏 JSON 报错（这就是必须守卫的原因）。
    let err = conn
        .query_row("SELECT json_extract('{oops', '$.session_id')", [], |row| {
            row.get::<_, Option<String>>(0)
        })
        .unwrap_err();
    assert!(err.to_string().contains("malformed"), "{err}");
    // 有守卫：与 `where_clauses` 同形的 CASE 表达式。
    let guarded = "(CASE WHEN json_valid(value) \
                   THEN json_extract(value, '$.session_id') ELSE NULL END)";
    let guarded_type = "(CASE WHEN json_valid(value) \
                        THEN json_type(value, '$.session_id') ELSE NULL END)";
    for (doc, expected) in [
        ("{oops", None),
        ("[1,2]", None),
        (r#"{"session_id":"s1"}"#, Some("s1")),
    ] {
        let got: Option<String> = conn
            .query_row(
                &format!("SELECT {guarded} FROM (SELECT ?1 AS value)"),
                [doc],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(got.as_deref(), expected, "{doc}");
    }
    // 数字 id 抽出来是整数（生产 SQL 里由 `json_type = 'text'` 排除）。
    let num: Option<i64> = conn
        .query_row(
            &format!("SELECT {guarded} FROM (SELECT ?1 AS value)"),
            [r#"{"session_id":42}"#],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(num, Some(42));
    // 数字 id 不是 text（SQL 侧用 `json_type` 排除，与 Rust 侧一致）。
    let ty: Option<String> = conn
        .query_row(
            &format!("SELECT {guarded_type} FROM (SELECT ?1 AS value)"),
            [r#"{"session_id":42}"#],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ty.as_deref(), Some("integer"));
    let ty: Option<String> = conn
        .query_row(
            &format!("SELECT {guarded_type} FROM (SELECT ?1 AS value)"),
            ["{oops"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ty, None);
}

#[test]
fn bucket_local_day_shapes_date_or_none() {
    let day = bucket_local_day(Some("2026-10-12T15:49:48.332Z")).unwrap();
    assert_eq!(day.len(), 10);
    assert_eq!(&day[4..5], "-");
    assert_eq!(bucket_local_day(Some("garbage")), None);
    assert_eq!(bucket_local_day(None), None);
}

#[test]
fn unreadable_reason_distinguishes_missing_file() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("mnemopi.db");
    assert_eq!(unreadable_reason(&missing), "数据库文件缺失");
    std::fs::write(&missing, b"not sqlite").unwrap();
    assert_eq!(unreadable_reason(&missing), "数据库文件损坏");
}
