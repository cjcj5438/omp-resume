use super::cache::UsageCache;
use super::redact::sanitize_message;
use super::stats::session_usage;
use super::*;
use chrono::DateTime;
use serde_json::json;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use tempfile::TempDir;

const DATE: &str = "2026-10-16T00:30:00Z";

fn setup() -> (TempDir, Config, UsageCache) {
    let tmp = TempDir::new().unwrap();
    let cfg = Config {
        sessions_dir: tmp.path().join("sessions"),
        owners_dir: tmp.path().join("owners"),
        extra_roots: vec![],
    };
    fs::create_dir_all(cfg.sessions_dir.join("project")).unwrap();
    (tmp, cfg, UsageCache::default())
}

fn assistant(id: &str, cost: f64) -> serde_json::Value {
    json!({"type":"message","id":id,"parentId":null,"timestamp":DATE,
        "message":{"role":"assistant","provider":"test","model":"model-a","timestamp":1792110600000_i64,
        "usage":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"totalTokens":100,"cost":{"total":cost}}}})
}

fn background(id: &str, cost: f64) -> serde_json::Value {
    json!({"type":"model_usage","id":id,"parentId":null,"timestamp":DATE,
        "provider":"test","model":"memory","usage":{"input":2,"output":3,"totalTokens":5,"cost":{"total":cost}}})
}

fn file(path: &Path, id: &str, parent: Option<&str>, entries: &[serde_json::Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut out = File::create(path).unwrap();
    writeln!(
        out,
        "{}",
        json!({"type":"session","version":3,"id":id,"cwd":"/my/project","parentSession":parent})
    )
    .unwrap();
    for entry in entries {
        writeln!(out, "{entry}").unwrap();
    }
}

fn usage(cfg: &Config, cache: &UsageCache, path: &Path) -> SessionUsage {
    session_usage(cfg, cache, path.to_str().unwrap()).unwrap()
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} != {b}");
}

/// RFC3339 → epoch 毫秒（测试内构造边界时间戳）。
fn ms(ts: &str) -> i64 {
    DateTime::parse_from_rfc3339(ts).unwrap().timestamp_millis()
}

fn assistant_at(id: &str, cost: f64, ts_ms: i64) -> serde_json::Value {
    json!({"type":"message","id":id,"parentId":null,"timestamp":DATE,
        "message":{"role":"assistant","provider":"test","model":"model-a","timestamp":ts_ms,
        "usage":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"totalTokens":100,"cost":{"total":cost}}}})
}

#[test]
fn sums_main_background_and_nested_without_task_toolresult_double_billing() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            json!({"type":"message","id":"u","timestamp":DATE,"message":{"role":"user"}}),
            assistant("a", 1.2),
            background("b", 0.3),
            json!({"type":"message","id":"task-result","timestamp":DATE,"message":{"role":"toolResult","toolName":"task","usage":{"cost":{"total":999}},"details":{"cost":999}}}),
        ],
    );
    file(
        &path.with_extension("").join("local/sub.jsonl"),
        "sub",
        Some("main"),
        &[assistant("s", 0.7), background("sb", 0.1)],
    );
    let result = usage(&cfg, &cache, &path);
    close(result.cost.main, 1.2);
    close(result.cost.background, 0.4);
    close(result.cost.subagent, 0.7);
    close(result.cost.total, 2.3);
    assert_eq!(result.tokens.total, 210);
    assert_eq!((result.messages.user, result.messages.assistant), (1, 2));
}

#[test]
fn fork_chain_owns_copies_at_earliest_existing_ancestor() {
    let (_tmp, cfg, cache) = setup();
    let dir = cfg.sessions_dir.join("project");
    let first = dir.join("first.jsonl");
    let second = dir.join("second.jsonl");
    let third = dir.join("third.jsonl");
    file(
        &first,
        "first",
        None,
        &[assistant("same", 2.0), background("memory", 0.2)],
    );
    file(
        &second,
        "second",
        Some("first"),
        &[
            assistant("same", 2.0),
            background("memory", 0.2),
            assistant("new", 3.0),
        ],
    );
    file(
        &third,
        "third",
        Some(second.to_str().unwrap()),
        &[
            assistant("same", 2.0),
            assistant("new", 3.0),
            assistant("last", 4.0),
        ],
    );
    close(usage(&cfg, &cache, &first).cost.total, 2.2);
    close(usage(&cfg, &cache, &second).cost.total, 3.0);
    close(usage(&cfg, &cache, &third).cost.total, 4.0);
    fs::remove_file(first).unwrap();
    close(usage(&cfg, &cache, &second).cost.total, 5.2);
    close(usage(&cfg, &cache, &third).cost.total, 4.0);
}

#[test]
fn unrelated_advisors_with_colliding_entry_id_are_not_deduplicated() {
    let (_tmp, cfg, cache) = setup();
    let first = cfg.sessions_dir.join("project/first.jsonl");
    let second = cfg.sessions_dir.join("project/second.jsonl");
    file(&first, "first", None, &[]);
    file(&second, "second", None, &[]);
    // 即使 id、时间、用量完全相同，没有 fork 血缘也必须各算一次。
    file(
        &first.with_extension("").join("__advisor.jsonl"),
        "advisor-one",
        Some("first"),
        &[assistant("a417d51d", 2.0)],
    );
    file(
        &second.with_extension("").join("__advisor.jsonl"),
        "advisor-two",
        Some("second"),
        &[assistant("a417d51d", 2.0)],
    );
    close(usage(&cfg, &cache, &first).cost.total, 2.0);
    close(usage(&cfg, &cache, &second).cost.total, 2.0);
}

#[test]
fn missing_parent_and_unconfirmed_fork_collision_keep_own_usage() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/child.jsonl");
    file(
        &path,
        "child",
        Some("missing-parent"),
        &[assistant("same", 2.0)],
    );
    close(usage(&cfg, &cache, &path).cost.total, 2.0);
    let parent = cfg.sessions_dir.join("project/parent.jsonl");
    file(&parent, "missing-parent", None, &[assistant("same", 3.0)]);
    close(usage(&cfg, &cache, &path).cost.total, 2.0);
}

#[test]
fn cache_invalidates_top_nested_append_creation_deletion_and_same_size_replacement() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(&path, "main", None, &[assistant("a", 1.0)]);
    close(usage(&cfg, &cache, &path).cost.total, 1.0);
    let stamp = fs::metadata(&path).unwrap().modified().unwrap();
    file(&path, "main", None, &[assistant("a", 9.0)]);
    filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(stamp)).unwrap();
    close(usage(&cfg, &cache, &path).cost.total, 9.0);
    let nested = path.with_extension("").join("local/sub.jsonl");
    file(&nested, "sub", None, &[assistant("b", 2.0)]);
    close(usage(&cfg, &cache, &path).cost.total, 11.0);
    writeln!(
        fs::OpenOptions::new().append(true).open(&nested).unwrap(),
        "{}",
        assistant("c", 3.0)
    )
    .unwrap();
    close(usage(&cfg, &cache, &path).cost.total, 14.0);
    fs::remove_file(nested).unwrap();
    close(usage(&cfg, &cache, &path).cost.total, 9.0);
    writeln!(
        fs::OpenOptions::new().append(true).open(&path).unwrap(),
        "{}",
        assistant("d", 1.0)
    )
    .unwrap();
    close(usage(&cfg, &cache, &path).cost.total, 10.0);
}

#[test]
fn bad_lines_and_no_usage_do_not_hide_valid_entries() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            assistant("a", 1.0),
            json!({"type":"message","id":"empty","message":{"role":"assistant"}}),
            json!({"type":"message","message":{}}),
        ],
    );
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"not-json\n\xff\n{\"type\":\"message\",\"message\":null}\n")
        .unwrap();
    let result = usage(&cfg, &cache, &path);
    close(result.cost.total, 1.0);
    assert_eq!(result.messages.assistant, 2);
    assert_eq!(result.tokens.total, 100);
}

#[test]
fn path_escape_rejected_and_nested_symlinks_not_followed() {
    use std::os::unix::fs::symlink;
    let (tmp, cfg, cache) = setup();
    let outside = tmp.path().join("outside.jsonl");
    file(&outside, "outside", None, &[assistant("a", 100.0)]);
    assert_eq!(
        session_usage(&cfg, &cache, outside.to_str().unwrap())
            .unwrap_err()
            .code,
        ErrorCode::OutsideRoot
    );
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(&path, "main", None, &[assistant("b", 1.0)]);
    fs::create_dir(path.with_extension("")).unwrap();
    symlink(outside, path.with_extension("").join("escape.jsonl")).unwrap();
    close(usage(&cfg, &cache, &path).cost.total, 1.0);
}

#[test]
fn error_message_is_single_line_capped_and_redacted() {
    // 多行折叠、超长截断到 200 字符（填充用短词，避免触发无特征长串脱敏）。
    let long = format!("line one\nline two  {}", "v ".repeat(150));
    let clean = sanitize_message(&long);
    assert!(!clean.contains('\n'));
    assert_eq!(clean.chars().count(), 200);
    assert!(clean.starts_with("line one line two"));
    // 密钥形态脱敏，普通请求 id 保留。
    let dirty = "call failed sk-abcdefgh12345678 Bearer tokengoeshere123 api_key=hunter2 requestId:sin1::abc";
    let clean = sanitize_message(dirty);
    assert!(!clean.contains("sk-abcdefgh12345678"));
    assert!(!clean.contains("tokengoeshere123"));
    assert!(!clean.contains("hunter2"));
    assert!(clean.contains("[已脱敏]"));
    assert!(clean.contains("requestId:sin1::abc"));
    // 截断发生在脱敏之后：尾部密钥即使超出 200 字符也不泄露片段。
    let tail = format!("{} sk-{}", "y".repeat(195), "z".repeat(40));
    let clean = sanitize_message(&tail);
    assert!(!clean.contains("sk-"));
    assert!(!clean.contains('z'));
}

#[test]
fn huge_token_values_saturate_instead_of_wrapping() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    let max = u64::MAX;
    let huge = |id: &str| {
        json!({"type":"message","id":id,"parentId":null,"timestamp":DATE,
        "message":{"role":"assistant","provider":"test","model":"model-a","timestamp":DATE,
        "usage":{"input":max,"output":1,"totalTokens":max,"cost":{"total":1.0}}}})
    };
    file(&path, "main", None, &[huge("h1"), huge("h2")]);
    // 两条 input=u64::MAX：普通 += 在 debug 下 panic、release 下回绕；饱和加钳在 MAX。
    let r = usage(&cfg, &cache, &path);
    assert_eq!(r.tokens.input, u64::MAX);
    assert_eq!(r.tokens.total, u64::MAX);
    close(r.cost.total, 2.0);
}

#[test]
fn multibyte_error_message_sanitizes_on_char_boundaries() {
    // 短消息原样保留（中文/emoji 不触发任何规则）。
    let raw = "请求失败：配额已用完 quota exceeded 😭 请稍后重试";
    assert_eq!(sanitize_message(raw), raw);
    // 超长多字节消息按字符截断到 200，不 panic，结果仍是有效字符串。
    let long = format!("{}{}{}", "错".repeat(50), "😭".repeat(100), "x".repeat(100));
    assert_eq!(long.chars().count(), 250);
    let clean = sanitize_message(&long);
    assert_eq!(clean.chars().count(), 200);
    assert!(clean.starts_with(&"错".repeat(50)));
}

#[test]
fn redaction_covers_secret_shapes_without_swallowing_normal_text() {
    // （原文，绝不能泄露的片段）：各类密钥形态。
    let hex64 = "0123456789abcdef".repeat(4);
    let b64 = "YWJjZGVmZ2hpams=".repeat(4);
    let jwt_std = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJ";
    let jwt_plain = "abcd1234efgh.ijkl5678mnop.qrst9012uvwx";
    let jwt_std_msg = format!("failed {jwt_std}");
    let jwt_plain_msg = format!("failed {jwt_plain}");
    let hex_msg = format!("hash {hex64}");
    let b64_msg = format!("blob {b64}");
    let redacted = [
        ("call failed sk-abcdefgh12345678 ok", "sk-abcdefgh"),
        ("auth Bearer tokengoeshere123 done", "tokengoeshere"),
        (
            "err Authorization: secretTokenValue99 x",
            "secretTokenValue",
        ),
        (
            "err Authorization:BearerCompactForm1 x",
            "BearerCompactForm",
        ),
        ("login api_key=hunter2 ok", "hunter2"),
        ("login apikey=hunter3 ok", "hunter3"),
        ("t=1 token=abc123def456 ok", "abc123def456"),
        ("cfg secret=s3cr3tvalue ok", "s3cr3tvalue"),
        (jwt_std_msg.as_str(), "SflKxwRJ"),
        (jwt_plain_msg.as_str(), "qrst9012"),
        ("key ghp_abcdefghij1234567890 end", "ghp_abcdef"),
        ("key github_pat_abcdefghij1234567890 end", "github_pat_a"),
        ("key xoxb-123456789012-abcdefg end", "xoxb-1234"),
        ("key xoxs-abcdefghij12345 end", "xoxs-abcd"),
        ("key AKIAIOSFODNN7EXAMPLE end", "AKIAIOSF"),
        (hex_msg.as_str(), &hex64[..16]),
        (b64_msg.as_str(), "YWJjZGVmZ2hpams"),
    ];
    for (message, leaked) in redacted {
        let clean = sanitize_message(message);
        assert!(!clean.contains(leaked), "{message} -> {clean}");
        assert!(clean.contains("[已脱敏]"), "{message} -> {clean}");
    }
    // 正常文本必须原样保留。
    let kept = [
        "requestId:sin1::abc done",
        "see https://example.com/v1/chat ok",
        "id 123e4567-e89b-12d3-a456-426614174000 end",
        "402 usage limit exceeded, quota reached",
        "path /Users/test/sessions/abc-123/main.jsonl end",
        "omp 18.11.1 released",
        "ECONNRESET: socket closed",
    ];
    for message in kept {
        assert_eq!(sanitize_message(message), message, "{message}");
    }
}

#[test]
fn normal_402_text_survives_redaction() {
    let raw = r#"402 {"error":{"message":"usage limit exceeded, quota reached"}}"#;
    let clean = sanitize_message(raw);
    assert!(!clean.contains("[已脱敏]"), "{clean}");
    assert!(clean.contains("402"), "{clean}");
    assert!(clean.contains("usage limit exceeded"), "{clean}");
    assert!(clean.contains("quota"), "{clean}");
}

#[test]
fn corrupt_lines_and_extreme_timestamps_neither_panic_nor_fail_session_usage() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            assistant_at("ok", 1.0, ms("2026-10-16T00:30:00Z")),
            // 负毫秒是合法的 1970 年前时间；超大毫秒非法 → 无时间戳。
            assistant_at("neg", 2.0, -1000),
            assistant_at("huge", 3.0, i64::MAX),
            // 字段缺失的 model_change 与 usage 缺字段的 assistant。
            json!({"type":"model_change","id":"mc"}),
            json!({"type":"message","id":"bare","parentId":null,
                "message":{"role":"assistant","provider":"t","model":"m"}}),
        ],
    );
    // 文件中途损坏的行：非 JSON、形状损坏、类型损坏。
    {
        let mut out = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(out, "{{not json").unwrap();
        writeln!(out, "{{\"type\":123}}").unwrap();
        writeln!(out, "{{\"type\":\"message\",\"timestamp\":1.5}}").unwrap();
    }
    let r = usage(&cfg, &cache, &path);
    close(r.cost.total, 6.0);
    assert_eq!(r.messages.assistant, 4);
}
