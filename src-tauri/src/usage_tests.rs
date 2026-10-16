use super::*;
use serde_json::json;
use std::io::Write;
use tempfile::TempDir;

const DATE: &str = "2026-10-16T00:30:00Z";

fn setup() -> (TempDir, Config, UsageCache) {
    let tmp = TempDir::new().unwrap();
    let cfg = Config {
        sessions_dir: tmp.path().join("sessions"),
        owners_dir: tmp.path().join("owners"),
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
    close(
        usage_stats(&cfg, &cache, None).unwrap().total.cost.total,
        2.3,
    );
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
    close(
        usage_stats(&cfg, &cache, None).unwrap().total.cost.total,
        9.2,
    );
    fs::remove_file(first).unwrap();
    close(usage(&cfg, &cache, &second).cost.total, 5.2);
    close(usage(&cfg, &cache, &third).cost.total, 4.0);
    close(
        usage_stats(&cfg, &cache, None).unwrap().total.cost.total,
        9.2,
    );
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
    close(
        usage_stats(&cfg, &cache, None).unwrap().total.cost.total,
        4.0,
    );
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
    close(
        usage_stats(&cfg, &cache, None).unwrap().total.cost.total,
        5.0,
    );
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
fn groups_days_in_local_zone_and_filters_by_message_not_file_time() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    let mut old = assistant("old", 1.0);
    old["message"]["timestamp"] = json!("2026-09-01T00:00:00Z");
    let mut recent = assistant("recent", 2.0);
    recent["message"]["timestamp"] = json!("2026-10-16T00:30:00Z");
    file(&path, "main", None, &[old, recent]);
    let now = DateTime::parse_from_rfc3339("2026-10-16T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let west = chrono::FixedOffset::west_opt(7 * 3600).unwrap();
    let result = stats_at(&cfg, &cache, Some(30), now, &west).unwrap();
    close(result.total.cost.total, 2.0);
    assert_eq!(result.by_day[0].date, "2026-10-15");
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    assert_eq!(
        stats_at(&cfg, &cache, Some(30), now, &east).unwrap().by_day[0].date,
        "2026-10-16"
    );
    assert_eq!(
        stats_at(&cfg, &cache, None, now, &west)
            .unwrap()
            .by_day
            .len(),
        2
    );
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
#[ignore = "真实会话只读扫描（显式运行一次）"]
fn real_usage_readonly() {
    let cfg = crate::config::resolve(None);
    let cache = UsageCache::default();
    let start = std::time::Instant::now();
    let stats = usage_stats(&cfg, &cache, None).unwrap();
    let cold = start.elapsed();
    let start = std::time::Instant::now();
    let warm = usage_stats(&cfg, &cache, None).unwrap();
    let cached = start.elapsed();
    let files = cache
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .len();
    println!("USAGE real files={files}, main=${:.8}, background=${:.8}, subagent=${:.8}, total=${:.8}, tokens={}, cold={cold:?}, warm={cached:?}", stats.total.cost.main, stats.total.cost.background, stats.total.cost.subagent, stats.total.cost.total, stats.total.tokens.total);
    assert!(warm.total.cost.total >= 0.0);
}
