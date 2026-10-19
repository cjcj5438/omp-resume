use super::*;
use chrono::{FixedOffset, MappedLocalTime, NaiveDate, NaiveDateTime, Timelike};
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

fn now(ts: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(ts)
        .unwrap()
        .with_timezone(&Utc)
}

fn assistant_at(id: &str, cost: f64, ts_ms: i64) -> serde_json::Value {
    json!({"type":"message","id":id,"parentId":null,"timestamp":DATE,
        "message":{"role":"assistant","provider":"test","model":"model-a","timestamp":ts_ms,
        "usage":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"totalTokens":100,"cost":{"total":cost}}}})
}

fn assistant_err(id: &str, ts_ms: i64, stop: &str, err: &str) -> serde_json::Value {
    json!({"type":"message","id":id,"parentId":null,"timestamp":DATE,
        "message":{"role":"assistant","provider":"test","model":"model-a","timestamp":ts_ms,
        "stopReason":stop,"errorMessage":err,
        "usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":30,"cost":{"total":0.5}}}})
}

fn model_change(
    id: &str,
    ts: &str,
    model: &str,
    role: Option<&str>,
    fallback: bool,
) -> serde_json::Value {
    let mut v = json!({"type":"model_change","id":id,"parentId":null,"timestamp":ts,
        "model":model,"resolvedModelIsFallback":fallback});
    if let Some(role) = role {
        v["role"] = json!(role);
    }
    v
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
        usage_stats(&cfg, &cache, UsageRange::All)
            .unwrap()
            .total
            .cost
            .total,
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
        usage_stats(&cfg, &cache, UsageRange::All)
            .unwrap()
            .total
            .cost
            .total,
        9.2,
    );
    fs::remove_file(first).unwrap();
    close(usage(&cfg, &cache, &second).cost.total, 5.2);
    close(usage(&cfg, &cache, &third).cost.total, 4.0);
    close(
        usage_stats(&cfg, &cache, UsageRange::All)
            .unwrap()
            .total
            .cost
            .total,
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
        usage_stats(&cfg, &cache, UsageRange::All)
            .unwrap()
            .total
            .cost
            .total,
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
        usage_stats(&cfg, &cache, UsageRange::All)
            .unwrap()
            .total
            .cost
            .total,
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
fn range_names_deserialize_from_contract_strings() {
    let cases = [
        ("today", UsageRange::Today),
        ("24h", UsageRange::Last24Hours),
        ("7d", UsageRange::Last7Days),
        ("30d", UsageRange::Last30Days),
        ("all", UsageRange::All),
    ];
    for (name, range) in cases {
        assert_eq!(
            serde_json::from_value::<UsageRange>(json!(name)).unwrap(),
            range
        );
    }
    assert_eq!(
        serde_json::from_value::<ErrorKind>(json!("rate_limit")).unwrap(),
        ErrorKind::RateLimit
    );
}

#[test]
fn today_window_starts_at_local_midnight_and_fills_hour_buckets() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    // now 东八区 10-16 20:00；today 起点 = 10-15T16:00:00Z。
    let start = ms("2026-10-15T16:00:00Z");
    file(
        &path,
        "main",
        None,
        &[
            assistant_at("at-start", 1.0, start),
            assistant_at("before", 99.0, start - 1),
            assistant_at("at-now", 2.0, ms("2026-10-16T12:00:00Z")),
            assistant_at("future", 99.0, ms("2026-10-16T12:00:00.001Z")),
        ],
    );
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    let stats = stats_at(
        &cfg,
        &cache,
        UsageRange::Today,
        now("2026-10-16T12:00:00Z"),
        &east,
    )
    .unwrap();
    close(stats.total.cost.total, 3.0);
    assert_eq!(stats.trend.unit, TrendUnit::Hour);
    assert_eq!(stats.trend.points.len(), 21);
    assert_eq!(stats.trend.points[0].key, "2026-10-16 00");
    assert_eq!(stats.trend.points[20].key, "2026-10-16 20");
    close(stats.trend.points[0].cost, 1.0);
    close(stats.trend.points[20].cost, 2.0);
    // 中间桶补零且升序。
    let keys: Vec<_> = stats.trend.points.iter().map(|p| &p.key).collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
    assert!(stats.trend.points[1..20].iter().all(|p| p.cost == 0.0));
    let sum: f64 = stats.trend.points.iter().map(|p| p.cost).sum();
    close(sum, stats.total.cost.total);
}

#[test]
fn last_24h_window_aligns_to_hour_buckets() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    // now 东八区 10-16 20:34；起点 = 当前整点 − 23h = 10-15T13:00:00Z。
    let start = ms("2026-10-15T13:00:00Z");
    file(
        &path,
        "main",
        None,
        &[
            assistant_at("at-start", 1.0, start),
            assistant_at("before", 99.0, start - 1),
            assistant_at("mid", 2.0, ms("2026-10-16T00:00:00Z")),
            assistant_at("future", 99.0, ms("2026-10-16T13:34:57Z")),
        ],
    );
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    let stats = stats_at(
        &cfg,
        &cache,
        UsageRange::Last24Hours,
        now("2026-10-16T12:34:56Z"),
        &east,
    )
    .unwrap();
    close(stats.total.cost.total, 3.0);
    assert_eq!(stats.trend.unit, TrendUnit::Hour);
    assert_eq!(stats.trend.points.len(), 24);
    assert_eq!(stats.trend.points[0].key, "2026-10-15 21");
    assert_eq!(stats.trend.points[23].key, "2026-10-16 20");
    close(stats.trend.points[0].cost, 1.0);
    // mid（UTC 10-16 00:00 = 本地 08:00）落到对应整点桶。
    let mid = stats
        .trend
        .points
        .iter()
        .find(|p| p.key == "2026-10-16 08")
        .unwrap();
    close(mid.cost, 2.0);
    let sum: f64 = stats.trend.points.iter().map(|p| p.cost).sum();
    close(sum, stats.total.cost.total);
}

#[test]
fn last_7d_and_30d_windows_cover_natural_days() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    // now 东八区 10-16；7d 起点 = 10-09T16:00:00Z（10-10 00:00+08）。
    let start7 = ms("2026-10-09T16:00:00Z");
    // 30d 起点 = 09-16T16:00:00Z（09-17 00:00+08）。
    let start30 = ms("2026-09-16T16:00:00Z");
    file(
        &path,
        "main",
        None,
        &[
            assistant_at("at-7d-start", 1.0, start7),
            assistant_at("before-7d", 4.0, start7 - 1),
            assistant_at("at-30d-start", 8.0, start30),
            assistant_at("before-30d", 99.0, start30 - 1),
        ],
    );
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    let at = now("2026-10-16T12:00:00Z");
    let week = stats_at(&cfg, &cache, UsageRange::Last7Days, at, &east).unwrap();
    close(week.total.cost.total, 1.0);
    assert_eq!(week.trend.unit, TrendUnit::Day);
    assert_eq!(week.trend.points.len(), 7);
    assert_eq!(week.trend.points[0].key, "2026-10-10");
    assert_eq!(week.trend.points[6].key, "2026-10-16");
    close(week.trend.points[0].cost, 1.0);
    let month = stats_at(&cfg, &cache, UsageRange::Last30Days, at, &east).unwrap();
    close(month.total.cost.total, 13.0);
    assert_eq!(month.trend.points.len(), 30);
    assert_eq!(month.trend.points[0].key, "2026-09-17");
    assert_eq!(month.trend.points[29].key, "2026-10-16");
    close(month.trend.points[0].cost, 8.0);
    for stats in [&week, &month] {
        let sum: f64 = stats.trend.points.iter().map(|p| p.cost).sum();
        close(sum, stats.total.cost.total);
    }
}

#[test]
fn all_range_keeps_untimed_entries_in_totals_but_not_in_trend() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            assistant_at("timed", 1.0, ms("2026-10-16T00:30:00Z")),
            json!({"type":"message","id":"untimed","parentId":null,
                "message":{"role":"assistant","provider":"test","model":"model-a",
                "usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":2.0}}}}),
        ],
    );
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    let at = now("2026-10-16T12:00:00Z");
    let all = stats_at(&cfg, &cache, UsageRange::All, at, &east).unwrap();
    close(all.total.cost.total, 3.0);
    // all 只含带时间条目的日期。
    assert_eq!(all.trend.points.len(), 1);
    assert_eq!(all.trend.points[0].key, "2026-10-16");
    close(all.trend.points[0].cost, 1.0);
    // 带窗口范围收不到无时间条目。
    let today = stats_at(&cfg, &cache, UsageRange::Today, at, &east).unwrap();
    close(today.total.cost.total, 1.0);
    let health = health_at(&cfg, &cache, UsageRange::All, at, &east).unwrap();
    assert_eq!(health.requests, 2);
    let health_today = health_at(&cfg, &cache, UsageRange::Today, at, &east).unwrap();
    assert_eq!(health_today.requests, 1);
}

#[test]
fn trend_and_timeline_sums_match_totals_in_fixed_windows() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            assistant_at("a", 1.5, ms("2026-10-16T01:00:00Z")),
            assistant_at("b", 2.5, ms("2026-10-16T02:00:00Z")),
            background("bg", 0.5),
            model_change("fb", "2026-10-16T03:00:00Z", "p/m", Some("fallback"), true),
        ],
    );
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    let at = now("2026-10-16T12:00:00Z");
    for range in [
        UsageRange::Today,
        UsageRange::Last24Hours,
        UsageRange::Last7Days,
        UsageRange::Last30Days,
    ] {
        let stats = stats_at(&cfg, &cache, range, at, &east).unwrap();
        let cost: f64 = stats.trend.points.iter().map(|p| p.cost).sum();
        close(cost, stats.total.cost.total);
        let tokens: u64 = stats.trend.points.iter().map(|p| p.tokens.total).sum();
        assert_eq!(tokens, stats.total.tokens.total);
        let health = health_at(&cfg, &cache, range, at, &east).unwrap();
        let requests: u64 = health.timeline.points.iter().map(|p| p.requests).sum();
        assert_eq!(requests, health.requests);
        let errors: u64 = health.timeline.points.iter().map(|p| p.errors).sum();
        assert_eq!(errors, health.errors.total);
        let fallbacks: u64 = health.timeline.points.iter().map(|p| p.fallbacks).sum();
        assert_eq!(fallbacks, health.fallbacks.total);
        assert_eq!(health.timeline.points.len(), stats.trend.points.len());
    }
}

#[test]
fn day_boundary_differs_across_timezones() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[assistant_at("a", 1.0, ms("2026-10-16T00:30:00Z"))],
    );
    let at = now("2026-10-16T12:00:00Z");
    let west = chrono::FixedOffset::west_opt(7 * 3600).unwrap();
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    // 同一瞬间：西七区是 10-15（不在 today 内），东八区是 10-16。
    let west_today = stats_at(&cfg, &cache, UsageRange::Today, at, &west).unwrap();
    close(west_today.total.cost.total, 0.0);
    let east_today = stats_at(&cfg, &cache, UsageRange::Today, at, &east).unwrap();
    close(east_today.total.cost.total, 1.0);
    let west_all = stats_at(&cfg, &cache, UsageRange::All, at, &west).unwrap();
    assert_eq!(west_all.trend.points[0].key, "2026-10-15");
    let east_all = stats_at(&cfg, &cache, UsageRange::All, at, &east).unwrap();
    assert_eq!(east_all.trend.points[0].key, "2026-10-16");
    // 健康时间线分桶规则与趋势一致。
    let west_health = health_at(&cfg, &cache, UsageRange::All, at, &west).unwrap();
    assert_eq!(west_health.timeline.points[0].key, "2026-10-15");
    let east_health = health_at(&cfg, &cache, UsageRange::All, at, &east).unwrap();
    assert_eq!(east_health.timeline.points[0].key, "2026-10-16");
}

#[test]
fn aborted_counts_apart_from_error_total() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            assistant("ok", 1.0),
            assistant_err(
                "err",
                ms("2026-10-16T01:00:00Z"),
                "error",
                "ECONNRESET: socket closed",
            ),
            assistant_err(
                "abort",
                ms("2026-10-16T02:00:00Z"),
                "aborted",
                "Interrupted by user",
            ),
            background("bg", 0.1),
        ],
    );
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    // assistant × 3（含 error/aborted）+ 后台 × 1。
    assert_eq!(health.requests, 4);
    assert_eq!(health.errors.total, 1);
    assert_eq!(health.errors.aborted, 1);
    assert_eq!(health.errors.by_kind.len(), 1);
    assert_eq!(health.errors.by_kind[0].kind, ErrorKind::Network);
    assert_eq!(health.errors.by_kind[0].count, 1);
    // 中断不进错误 recent。
    assert_eq!(health.errors.recent.len(), 1);
    assert_eq!(health.errors.recent[0].message, "ECONNRESET: socket closed");
}

#[test]
fn error_kinds_follow_real_world_heuristics() {
    let cases = [
        (
            "402 {\"detail\":\"You've reached your monthly standard usage limit\"}",
            ErrorKind::Quota,
        ),
        (
            "403 Upstream request failed: Your Go subscription ended because its payment method needs authorization.",
            ErrorKind::Quota,
        ),
        (
            "OpenAI completions stream timed out while waiting for the first event",
            ErrorKind::Timeout,
        ),
        (
            "Anthropic stream stalled while waiting for the next event",
            ErrorKind::Timeout,
        ),
        (
            "Anthropic stream error (stream_timeout): upstream stream idle",
            ErrorKind::Timeout,
        ),
        ("ECONNRESET: socket closed unexpectedly", ErrorKind::Network),
        ("Connection error.", ErrorKind::Network),
        (
            "Upstream response stream was interrupted",
            ErrorKind::Network,
        ),
        (
            "Retry budget exhausted after 10 retries: ECONNRESET: socket closed",
            ErrorKind::Network,
        ),
        (
            "server_error: The model failed to generate a response.",
            ErrorKind::Server,
        ),
        (
            "503 {\"error\":{\"message\":\"No available accounts\"}}",
            ErrorKind::Server,
        ),
        (
            "400 Upstream request failed: Model is unavailable.",
            ErrorKind::Server,
        ),
        ("429 Too Many Requests", ErrorKind::RateLimit),
        ("rate limit exceeded, retry later", ErrorKind::RateLimit),
        ("401 Unauthorized", ErrorKind::Auth),
        ("invalid_api_key: check your key", ErrorKind::Auth),
        ("404 Application not found", ErrorKind::Other),
        (
            "404 Model \"x\" is not supported by any configured account",
            ErrorKind::Other,
        ),
        ("Provider finish_reason: content_filter", ErrorKind::Other),
        ("", ErrorKind::Other),
    ];
    for (message, kind) in cases {
        assert_eq!(classify_error(message), kind, "{message}");
    }
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
fn fallback_from_follows_latest_model_change_or_assistant() {
    let (_tmp, cfg, cache) = setup();
    let dir = cfg.sessions_dir.join("project");
    let main = dir.join("main.jsonl");
    file(
        &main,
        "main",
        None,
        &[
            model_change("m0", "2026-10-16T01:00:00Z", "prov-a/model-a", None, false),
            model_change(
                "m1",
                "2026-10-16T01:01:00Z",
                "prov-s/sub-model",
                Some("subagent:x"),
                false,
            ),
            assistant_at("a", 1.0, ms("2026-10-16T01:02:00Z")),
            // from 取此前最近的 assistant（test/model-a），而非更早的 model_change。
            model_change(
                "fb1",
                "2026-10-16T01:03:00Z",
                "prov-c/model-c",
                Some("fallback"),
                true,
            ),
            // role=fallback 但 resolved=false：不是兜底事件，但仍是生效模型。
            model_change(
                "not-fb",
                "2026-10-16T01:04:00Z",
                "prov-e/model-e",
                Some("fallback"),
                false,
            ),
            // model 名本身含 '/'：只拆首个。
            model_change(
                "fb2",
                "2026-10-16T01:05:00Z",
                "prov-d/sub/model",
                Some("fallback"),
                true,
            ),
        ],
    );
    // 兜底是文件内首个模型事件：from 为 null。
    let lonely = dir.join("lonely.jsonl");
    file(
        &lonely,
        "lonely",
        None,
        &[model_change(
            "fb0",
            "2026-10-16T02:00:00Z",
            "prov-z/model-z",
            Some("fallback"),
            true,
        )],
    );
    // 嵌套文件里的兜底同样计入。
    file(
        &main.with_extension("").join("agent/sub.jsonl"),
        "sub",
        Some("main"),
        &[
            assistant_at("sa", 1.0, ms("2026-10-16T03:00:00Z")),
            model_change(
                "fb3",
                "2026-10-16T03:01:00Z",
                "prov-n/model-n",
                Some("fallback"),
                true,
            ),
        ],
    );
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    assert_eq!(health.fallbacks.total, 4);
    // byTarget：count 降序（此处全 1，按 provider/model 升序）。
    let targets: Vec<_> = health
        .fallbacks
        .by_target
        .iter()
        .map(|t| (t.provider.as_str(), t.model.as_str(), t.count))
        .collect();
    assert_eq!(
        targets,
        [
            ("prov-c", "model-c", 1),
            ("prov-d", "sub/model", 1),
            ("prov-n", "model-n", 1),
            ("prov-z", "model-z", 1),
        ]
    );
    // recent 新 → 旧。
    let recent = &health.fallbacks.recent;
    assert_eq!(recent.len(), 4);
    assert!(recent.windows(2).all(|w| w[0].time >= w[1].time));
    let fb1 = recent.iter().find(|r| r.to.model == "model-c").unwrap();
    assert_eq!(fb1.from.as_ref().unwrap().provider, "test");
    assert_eq!(fb1.from.as_ref().unwrap().model, "model-a");
    let fb2 = recent.iter().find(|r| r.to.model == "sub/model").unwrap();
    assert_eq!(fb2.to.provider, "prov-d");
    assert_eq!(fb2.from.as_ref().unwrap().provider, "prov-e");
    assert_eq!(fb2.from.as_ref().unwrap().model, "model-e");
    let fb0 = recent.iter().find(|r| r.to.model == "model-z").unwrap();
    assert!(fb0.from.is_none());
    let fb3 = recent.iter().find(|r| r.to.model == "model-n").unwrap();
    assert_eq!(fb3.from.as_ref().unwrap().model, "model-a");
}

#[test]
fn fork_inherited_errors_and_fallbacks_count_once() {
    let (_tmp, cfg, cache) = setup();
    let dir = cfg.sessions_dir.join("project");
    let parent = dir.join("parent.jsonl");
    let copied_err = assistant_err(
        "err",
        ms("2026-10-16T01:00:00Z"),
        "error",
        "Connection error.",
    );
    let copied_fb = model_change(
        "fb",
        "2026-10-16T01:01:00Z",
        "prov-c/model-c",
        Some("fallback"),
        true,
    );
    let copied_bg = background("bg", 0.2);
    file(
        &parent,
        "parent",
        None,
        &[copied_err.clone(), copied_fb.clone(), copied_bg.clone()],
    );
    let child = dir.join("child.jsonl");
    file(
        &child,
        "child",
        Some("parent"),
        &[
            copied_err,
            copied_fb,
            copied_bg,
            assistant_err(
                "new-err",
                ms("2026-10-16T02:00:00Z"),
                "error",
                "Connection error.",
            ),
            model_change(
                "new-fb",
                "2026-10-16T02:01:00Z",
                "prov-n/model-n",
                Some("fallback"),
                true,
            ),
        ],
    );
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    // 继承来的错误/兜底/请求只计一次。
    assert_eq!(health.errors.total, 2);
    assert_eq!(health.fallbacks.total, 2);
    // 父：assistant + 后台；子：新增 assistant。
    assert_eq!(health.requests, 3);
    let stats = usage_stats(&cfg, &cache, UsageRange::All).unwrap();
    close(stats.total.cost.total, 1.2);
}

#[test]
fn cache_hit_rate_is_null_when_zero_or_unreported() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            // 有缓存上报：300 / (100 + 300 + 100) = 0.6。
            json!({"type":"message","id":"cached","parentId":null,"timestamp":DATE,
                "message":{"role":"assistant","provider":"p","model":"cached-model","timestamp":1792110600000_i64,
                "usage":{"input":100,"output":10,"cacheRead":300,"cacheWrite":100,"totalTokens":510,"cost":{"total":1.0}}}}),
            // 上游不报缓存：input > 0 但 cacheRead + cacheWrite = 0。
            json!({"type":"message","id":"plain","parentId":null,"timestamp":DATE,
                "message":{"role":"assistant","provider":"p","model":"plain-model","timestamp":1792110600000_i64,
                "usage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55,"cost":{"total":1.0}}}}),
            // 无 usage：分母为 0 的一部分。
            json!({"type":"message","id":"empty","parentId":null,"timestamp":DATE,
                "message":{"role":"assistant","provider":"p","model":"empty-model","timestamp":1792110600000_i64}}),
        ],
    );
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    assert_eq!(health.cache.input, 150);
    assert_eq!(health.cache.read, 300);
    assert_eq!(health.cache.write, 100);
    close(health.cache.hit_rate.unwrap(), 300.0 / 550.0);
    let by_model = &health.cache.by_model;
    assert_eq!(by_model.len(), 3);
    let cached = by_model.iter().find(|m| m.model == "cached-model").unwrap();
    close(cached.hit_rate.unwrap(), 0.6);
    // 上游不报缓存 → null，不是 0。
    let plain = by_model.iter().find(|m| m.model == "plain-model").unwrap();
    assert_eq!(plain.hit_rate, None);
    let empty = by_model.iter().find(|m| m.model == "empty-model").unwrap();
    assert_eq!(empty.hit_rate, None);
    // 空窗口：分母为 0 → null（条目在 10-16，取 10-17 的 today）。
    let at = now("2026-10-17T12:00:00Z");
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    let health = health_at(&cfg, &cache, UsageRange::Today, at, &east).unwrap();
    assert_eq!(health.requests, 0);
    assert_eq!(health.cache.hit_rate, None);
    assert_eq!(health.cache.by_model.len(), 0);
    // 时间线在空窗口下全零，但桶齐全。
    assert_eq!(health.timeline.points.len(), 21);
    assert!(health.timeline.points.iter().all(|p| p.requests == 0));
}

#[test]
fn model_usage_stop_and_error_message_do_not_feed_error_stats() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            json!({"type":"model_usage","id":"mu","parentId":null,"timestamp":DATE,
                "provider":"p","model":"m","stopReason":"error","errorMessage":"ECONNRESET: x",
                "usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0.1}}}),
        ],
    );
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    // 后台调用计 requests，但不计错误。
    assert_eq!(health.requests, 1);
    assert_eq!(health.errors.total, 0);
    assert_eq!(health.errors.aborted, 0);
    assert!(health.errors.recent.is_empty());
}

#[test]
#[ignore = "真实会话只读扫描（显式运行一次）"]
fn real_usage_readonly() {
    let cfg = crate::config::resolve(None);
    let cache = UsageCache::default();
    let start = std::time::Instant::now();
    let stats = usage_stats(&cfg, &cache, UsageRange::All).unwrap();
    let cold = start.elapsed();
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    let files = cache
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .len();
    println!("USAGE real files={files}, main=${:.8}, background=${:.8}, subagent=${:.8}, total=${:.8}, tokens={}, cold={cold:?}", stats.total.cost.main, stats.total.cost.background, stats.total.cost.subagent, stats.total.cost.total, stats.total.tokens.total);
    println!(
        "HEALTH real requests={} errors={} aborted={} fallbacks={} hitRate={:?}",
        health.requests,
        health.errors.total,
        health.errors.aborted,
        health.fallbacks.total,
        health.cache.hit_rate
    );
    assert!(stats.total.cost.total >= 0.0);
}

/// 最小 DST 测试时区：`gap_day` 当天本地 `[gap_hour, gap_hour+1)` 不存在
/// （1 小时缺口）；缺口之前偏移 +00:00，之后 +01:00，
/// 跳变瞬间 T = gap_day gap_hour:00 UTC。
#[derive(Clone, Copy)]
struct GapTz {
    gap_day: NaiveDate,
    gap_hour: u32,
}

impl GapTz {
    fn before() -> FixedOffset {
        FixedOffset::east_opt(0).unwrap()
    }

    fn after() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }

    fn transition_utc(&self) -> NaiveDateTime {
        self.gap_day.and_hms_opt(self.gap_hour, 0, 0).unwrap()
    }
}

impl TimeZone for GapTz {
    type Offset = FixedOffset;

    fn from_offset(_offset: &Self::Offset) -> Self {
        unreachable!("测试路径不经 offset 反查时区");
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
        use std::cmp::Ordering::*;
        match local.cmp(&self.gap_day) {
            Less => MappedLocalTime::Single(Self::before()),
            Greater => MappedLocalTime::Single(Self::after()),
            // 缺口日横跨两个偏移（仅 deprecated 的 from_local_date 用到）。
            Equal => MappedLocalTime::Ambiguous(Self::before(), Self::after()),
        }
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> MappedLocalTime<FixedOffset> {
        use std::cmp::Ordering::*;
        match local.date().cmp(&self.gap_day) {
            Less => MappedLocalTime::Single(Self::before()),
            Greater => MappedLocalTime::Single(Self::after()),
            Equal if local.hour() < self.gap_hour => MappedLocalTime::Single(Self::before()),
            Equal if local.hour() > self.gap_hour => MappedLocalTime::Single(Self::after()),
            // 缺口内的本地时刻不存在。
            _ => MappedLocalTime::None,
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
        if *utc < self.gap_day {
            Self::before()
        } else {
            Self::after()
        }
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
        if *utc < self.transition_utc() {
            Self::before()
        } else {
            Self::after()
        }
    }
}

#[test]
fn dst_gap_swallowing_24h_start_keeps_window_bounded() {
    // 缺口：2026-03-29 本地 02:00–03:00 不存在，偏移 +00:00 → +01:00。
    let gap_day = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
    let tz = GapTz {
        gap_day,
        gap_hour: 2,
    };
    // now UTC 03-30 00:30 = 本地 03-30 01:30；整点 −23h = 本地 03-29 02:00，正落缺口。
    let at = now("2026-03-30T00:30:00Z");
    let gap_naive = gap_day.and_hms_opt(2, 0, 0).unwrap();
    // 前提：缺口时刻确实无对应瞬间（旧代码此处 start_ms 为 None，窗口静默变全量）。
    assert_eq!(local_millis(&tz, &gap_naive), None);

    let window = window_at(UsageRange::Last24Hours, at, &tz);
    // 新起点 = 本地整点（03-30 01:00+01:00 = UTC 03-30 00:00）− 23h。
    assert_eq!(window.start_ms, Some(ms("2026-03-29T01:00:00Z")));
    assert_eq!(window.end_ms, Some(at.timestamp_millis()));
    let start = window.start_ms.unwrap();
    let span = at.timestamp_millis() - start;
    assert!((23 * 3600 * 1000..24 * 3600 * 1000).contains(&span));
    // 桶 keys 仍按本地 naive 小时生成（含缺口小时，由 clamp_key 兜住）。
    assert_eq!(window.keys.len(), 24);
    assert_eq!(window.keys[0], "2026-03-29 02");
    assert_eq!(window.keys[23], "2026-03-30 01");
    // 远早于窗口的时间戳必须被挡掉（防静默全量的关键断言）。
    assert!(!in_window(&window, Some(0)));
    assert!(!in_window(&window, Some(ms("2020-01-01T00:00:00Z"))));
    assert!(in_window(&window, Some(start)));
    assert!(!in_window(&window, None));
}

#[test]
fn dst_gap_swallowing_midnight_keeps_windows_bounded() {
    // 缺口：2026-03-29 本地 00:00–01:00 不存在（午夜跳变），偏移 +00:00 → +01:00。
    let gap_day = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
    let tz = GapTz {
        gap_day,
        gap_hour: 0,
    };
    let midnight = gap_day.and_hms_opt(0, 0, 0).unwrap();
    assert_eq!(local_millis(&tz, &midnight), None);

    // （范围，now（UTC），窗口长度）：today 当天、7d/30d 以缺口日为首日。
    let cases = [
        (UsageRange::Today, "2026-03-29T11:00:00Z", Duration::days(1)),
        (
            UsageRange::Last7Days,
            "2026-04-04T11:00:00Z",
            Duration::days(7),
        ),
        (
            UsageRange::Last30Days,
            "2026-04-27T11:00:00Z",
            Duration::days(30),
        ),
    ];
    for (range, now_str, length) in cases {
        let at = now(now_str);
        let window = window_at(range, at, &tz);
        // 起点 = 缺口后第一个存在的时刻（本地 01:00+01:00 = UTC 00:00）。
        assert_eq!(
            window.start_ms,
            Some(ms("2026-03-29T00:00:00Z")),
            "{range:?}"
        );
        assert_eq!(window.end_ms, Some(at.timestamp_millis()), "{range:?}");
        let start = window.start_ms.unwrap();
        assert!(start <= at.timestamp_millis(), "{range:?}");
        assert!(
            at.timestamp_millis() - start <= length.num_milliseconds() + 3600 * 1000,
            "{range:?}"
        );
        assert!(!in_window(&window, Some(0)), "{range:?}");
        assert!(
            !in_window(&window, Some(ms("2020-01-01T00:00:00Z"))),
            "{range:?}"
        );
    }
}

/// 最小“秋季回拨”测试时区：`fold_day` 当天本地 01:00–02:00 出现两次；
/// 回拨瞬间 T = fold_day 01:00 UTC：T 之前偏移 +01:00，之后 +00:00。
#[derive(Clone, Copy)]
struct FoldTz {
    fold_day: NaiveDate,
}

impl FoldTz {
    fn before() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }

    fn after() -> FixedOffset {
        FixedOffset::east_opt(0).unwrap()
    }

    fn transition_utc(&self) -> NaiveDateTime {
        self.fold_day.and_hms_opt(1, 0, 0).unwrap()
    }
}

impl TimeZone for FoldTz {
    type Offset = FixedOffset;

    fn from_offset(_offset: &Self::Offset) -> Self {
        unreachable!("测试路径不经 offset 反查时区");
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
        use std::cmp::Ordering::*;
        match local.cmp(&self.fold_day) {
            Less => MappedLocalTime::Single(Self::before()),
            Greater => MappedLocalTime::Single(Self::after()),
            Equal => MappedLocalTime::Ambiguous(Self::before(), Self::after()),
        }
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> MappedLocalTime<FixedOffset> {
        use std::cmp::Ordering::*;
        match local.date().cmp(&self.fold_day) {
            Less => MappedLocalTime::Single(Self::before()),
            Greater => MappedLocalTime::Single(Self::after()),
            Equal if local.hour() < 1 => MappedLocalTime::Single(Self::before()),
            Equal if local.hour() > 1 => MappedLocalTime::Single(Self::after()),
            // 回拨的重复小时：本地 01:xx 出现两次。
            _ => MappedLocalTime::Ambiguous(Self::before(), Self::after()),
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
        if *utc < self.fold_day {
            Self::before()
        } else {
            Self::after()
        }
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
        if *utc < self.transition_utc() {
            Self::before()
        } else {
            Self::after()
        }
    }
}

#[test]
fn dst_fold_second_occurrence_keeps_24h_start_exact() {
    // 回拨：2026-10-25 本地 01:00–02:00 出现两次，偏移 +01:00 → +00:00。
    let fold_day = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();
    let tz = FoldTz { fold_day };
    // now 取在第二次出现：UTC 10-25 01:30 = 本地 01:30（+00:00）。
    let at = now("2026-10-25T01:30:00Z");
    // 前提：整点 naive 经 earliest() 取到第一次出现（UTC 00:00），比 now 所在整点早 1 小时。
    let hour_naive = fold_day.and_hms_opt(1, 0, 0).unwrap();
    assert_eq!(
        local_millis(&tz, &hour_naive),
        Some(ms("2026-10-25T00:00:00Z"))
    );

    let window = window_at(UsageRange::Last24Hours, at, &tz);
    // 起点 = now 所在本地整点绝对值（UTC 01:00）− 23h。
    assert_eq!(window.start_ms, Some(ms("2026-10-24T02:00:00Z")));
    assert_eq!(window.end_ms, Some(at.timestamp_millis()));
    let start = window.start_ms.unwrap();
    let span = at.timestamp_millis() - start;
    assert!((23 * 3600 * 1000..24 * 3600 * 1000).contains(&span));
    assert_eq!(window.keys.len(), 24);
    assert_eq!(window.keys[0], "2026-10-24 02");
    assert_eq!(window.keys[23], "2026-10-25 01");
    assert!(in_window(&window, Some(start)));
    assert!(!in_window(&window, Some(start - 1)));
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
    let stats = usage_stats(&cfg, &cache, UsageRange::All).unwrap();
    assert_eq!(stats.total.tokens.input, u64::MAX);
    assert_eq!(stats.total.tokens.total, u64::MAX);
    close(stats.total.cost.total, 2.0);
    // 趋势走同一累加路径，不变量依然成立。
    let sum: u64 = stats.trend.points.iter().map(|p| p.tokens.total).sum();
    assert_eq!(sum, stats.total.tokens.total);
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
    // 健康 recent 路径同样按字符处理并折叠换行。
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[assistant_err(
            "e",
            ms("2026-10-16T00:30:00Z"),
            "error",
            "第一行失败原因\n第二行 中文详情 😀",
        )],
    );
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    assert_eq!(health.errors.recent.len(), 1);
    assert_eq!(
        health.errors.recent[0].message,
        "第一行失败原因 第二行 中文详情 😀"
    );
}

#[test]
fn redaction_covers_secret_shapes_without_swallowing_normal_text() {
    // （原文，绝不能泄露的片段）：各类密钥形态。
    let hex64 = "0123456789abcdef".repeat(4);
    let b64 = "YWJjZGVmZ2hpams=".repeat(4);
    let jwt_std = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
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
        ("key xoxb-1234567890-abcdefghij end", "xoxb-1234"),
        ("key xoxs-abcdefghij1234567890 end", "xoxs-abcd"),
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
fn normal_402_text_survives_redaction_and_still_classifies_quota() {
    let raw = r#"402 {"error":{"message":"usage limit exceeded, quota reached"}}"#;
    assert_eq!(classify_error(raw), ErrorKind::Quota);
    let clean = sanitize_message(raw);
    assert!(!clean.contains("[已脱敏]"), "{clean}");
    assert!(clean.contains("402"), "{clean}");
    assert!(clean.contains("usage limit exceeded"), "{clean}");
    assert!(clean.contains("quota"), "{clean}");
}

#[test]
fn corrupt_lines_and_extreme_timestamps_neither_panic_nor_fail_stats() {
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
    let stats = usage_stats(&cfg, &cache, UsageRange::All).unwrap();
    close(stats.total.cost.total, 6.0);
    // huge 无时间：进总计不进趋势；neg（1969）与 ok 各占一天桶。
    assert_eq!(stats.trend.points.len(), 2);
    let health = usage_health(&cfg, &cache, UsageRange::All).unwrap();
    assert_eq!(health.requests, 4);
    assert_eq!(health.errors.total, 0);
}

#[test]
fn health_requests_equal_sum_of_by_model_messages() {
    let (_tmp, cfg, cache) = setup();
    let path = cfg.sessions_dir.join("project/main.jsonl");
    file(
        &path,
        "main",
        None,
        &[
            assistant_at("a1", 1.0, ms("2026-10-16T01:00:00Z")),
            assistant_at("a2", 1.0, ms("2026-10-16T02:00:00Z")),
            background("bg", 0.5),
            json!({"type":"message","id":"u1","parentId":null,"timestamp":DATE,
                "message":{"role":"user"}}),
            model_change("fb", "2026-10-16T03:00:00Z", "p/m", Some("fallback"), true),
        ],
    );
    let east = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
    let at = now("2026-10-16T12:00:00Z");
    // user 消息与 model_change 不计请求；assistant×2 + 后台×1 = 3。
    for range in [UsageRange::Today, UsageRange::All] {
        let stats = stats_at(&cfg, &cache, range, at, &east).unwrap();
        let health = health_at(&cfg, &cache, range, at, &east).unwrap();
        let sum: u64 = stats.total.models.iter().map(|m| m.messages).sum();
        assert_eq!(health.requests, sum);
        assert_eq!(health.requests, 3);
    }
}
