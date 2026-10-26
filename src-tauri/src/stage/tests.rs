//! 舞台模块单测：游标、行解析、状态机、整表组装。
//!
//! 夹具一律现场在安全临时目录里造（不落盘固定夹具），避免与真实会话格式漂移。

use std::fs;

use chrono::{TimeZone, Utc};

use super::actor_tail::{iso_ms, parse_iso_ms, ActorTail};
use super::cursor::{JsonlCursor, LineSink};
use super::derive::{derive_state, DeriveInput, ORPHAN_DONE_SECS};
use super::*;
use crate::config::Config;
use crate::lock::Probe;
use crate::model::{RunningSession, StageActorKind, StageActorState};

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

struct Sink {
    lines: Vec<String>,
    resets: u32,
}

impl LineSink for Sink {
    fn reset(&mut self) {
        self.resets += 1;
        self.lines.clear();
    }
    fn line(&mut self, line: &[u8]) {
        self.lines.push(String::from_utf8_lossy(line).to_string());
    }
}

fn cfg_for(root: &std::path::Path) -> Config {
    Config {
        sessions_dir: root.to_path_buf(),
        owners_dir: root.join("owners"),
    }
}

fn tempdir() -> std::path::PathBuf {
    crate::util::mk_secure_tempdir("omp-resume-stage").unwrap()
}

const HEADER: &str = r#"{"type":"session","version":3,"id":"deadbeef-0000-4000-8000-000000000001","timestamp":"2026-10-21T01:34:38.305Z","cwd":"/tmp/proj"}"#;

fn header_with(id: &str, ts: &str) -> String {
    format!(r#"{{"type":"session","version":3,"id":"{id}","timestamp":"{ts}","cwd":"/tmp/proj"}}"#)
}

fn assistant(ts: &str, stop: &str, extra_blocks: &str) -> String {
    format!(
        r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"assistant","provider":"p","model":"m","stopReason":"{stop}","usage":{{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}}}},"content":[{extra_blocks}]}}}}"#
    )
}

fn tool_start(ts: &str, id: &str, tool: &str, intent: &str) -> String {
    format!(
        r#"{{"type":"custom","customType":"tool_execution_start","timestamp":"{ts}","data":{{"toolCallId":"{id}","toolName":"{tool}","intent":"{intent}","args":{{"path":"/tmp/x"}}}}}}"#
    )
}

fn tool_result(ts: &str, id: &str) -> String {
    format!(
        r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"toolResult","toolCallId":"{id}","toolName":"read","content":[{{"type":"text","text":"ok"}}]}}}}"#
    )
}

fn session_exit(ts: &str, kind: &str, reason: &str) -> String {
    format!(
        r#"{{"type":"custom","customType":"session_exit","timestamp":"{ts}","data":{{"recordedAt":"{ts}","kind":"{kind}","reason":"{reason}"}}}}"#
    )
}

fn feed(tail: &mut ActorTail, lines: &[String]) {
    let now = 0;
    for line in lines {
        tail.feed_line(line.as_bytes(), now);
    }
}

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

#[test]
fn cursor_reads_appended_lines_and_holds_partial_tail() {
    let dir = tempdir();
    let path = dir.join("a.jsonl");
    fs::write(&path, "one\ntwo\n").unwrap();
    let mut cursor = JsonlCursor::default();
    let mut sink = Sink {
        lines: Vec::new(),
        resets: 0,
    };
    cursor.advance(&path, &mut sink).unwrap();
    assert_eq!(sink.lines, ["one", "two"]);
    assert_eq!(sink.resets, 1);

    // 追加半行：本轮不消费，下轮补齐后一次读出。
    fs::write(&path, "one\ntwo\nthr").unwrap();
    cursor.advance(&path, &mut sink).unwrap();
    assert_eq!(sink.lines, ["one", "two"]);
    fs::write(&path, "one\ntwo\nthree\n").unwrap();
    cursor.advance(&path, &mut sink).unwrap();
    assert_eq!(sink.lines, ["one", "two", "three"]);
    assert_eq!(sink.resets, 1, "只有首次重置");
}

#[test]
fn cursor_resets_on_truncation() {
    let dir = tempdir();
    let path = dir.join("a.jsonl");
    fs::write(&path, "one\ntwo\n").unwrap();
    let mut cursor = JsonlCursor::default();
    let mut sink = Sink {
        lines: Vec::new(),
        resets: 0,
    };
    cursor.advance(&path, &mut sink).unwrap();
    fs::write(&path, "z\n").unwrap();
    cursor.advance(&path, &mut sink).unwrap();
    assert_eq!(sink.resets, 2);
    assert_eq!(sink.lines, ["z"]);
}

#[test]
fn cursor_skips_oversized_line_and_empty_lines() {
    let dir = tempdir();
    let path = dir.join("a.jsonl");
    let huge = "x".repeat(cursor::MAX_LINE_BYTES + 1);
    fs::write(&path, format!("ok\n\n{huge}\nafter\n")).unwrap();
    let mut cursor = JsonlCursor::default();
    let mut sink = Sink {
        lines: Vec::new(),
        resets: 0,
    };
    cursor.advance(&path, &mut sink).unwrap();
    assert_eq!(sink.lines, ["ok", "after"]);
}

// ---------------------------------------------------------------------------
// actor_tail
// ---------------------------------------------------------------------------

#[test]
fn actor_tail_pairs_tools_and_tracks_cost() {
    let mut tail = ActorTail::default();
    feed(
        &mut tail,
        &[
            header_with("id-1", "2026-10-21T01:00:00.000Z"),
            assistant(
                "2026-10-21T01:00:01.000Z",
                "toolUse",
                r#"{"type":"text","text":"开始读"}"#,
            ),
            tool_start("2026-10-21T01:00:02.000Z", "c1", "read", "Reading config"),
        ],
    );
    assert_eq!(tail.tool_calls, 1);
    assert_eq!(tail.pending.len(), 1);
    assert_eq!(tail.current_pending().unwrap().tool, "read");
    assert_eq!(tail.current_pending().unwrap().text, "Reading config");
    assert_eq!(tail.context_tokens, 15);
    assert!((tail.cost - 0.3).abs() < 1e-9);
    assert_eq!(tail.model.as_deref(), Some("p/m"));
    assert_eq!(tail.header_version, Some(3));

    feed(&mut tail, &[tool_result("2026-10-21T01:00:03.000Z", "c1")]);
    assert!(tail.pending.is_empty());
}

#[test]
fn actor_tail_derives_brief_from_task_and_vibe_spawn() {
    let mut tail = ActorTail::default();
    let block = r#"{"type":"toolCall","id":"t1","name":"task","arguments":{"i":"派两个子代理","tasks":[{"name":"Scout","agent":"scout","task":"x"},{"name":"Docs","agent":"explorer"}]}}"#;
    let spawn = r#"{"type":"toolCall","id":"t2","name":"vibe_spawn","arguments":{"i":"起 worker","name":"skel","cli":"fast"}}"#;
    feed(
        &mut tail,
        &[assistant(
            "2026-10-21T01:00:00.000Z",
            "toolUse",
            &format!("{block},{spawn}"),
        )],
    );
    assert_eq!(tail.spawn_info["Scout"].agent.as_deref(), Some("scout"));
    assert_eq!(
        tail.spawn_info["Scout"].brief.as_deref(),
        Some("派两个子代理")
    );
    assert_eq!(tail.spawn_info["Docs"].agent.as_deref(), Some("explorer"));
    assert_eq!(tail.spawn_info["skel"].brief.as_deref(), Some("起 worker"));
    assert_eq!(tail.spawn_info["skel"].agent, None);
}

#[test]
fn actor_tail_keeps_context_tokens_on_zero_usage_error_turn() {
    let mut tail = ActorTail::default();
    feed(
        &mut tail,
        &[
            assistant("2026-10-21T01:00:00.000Z", "stop", ""),
            // 出错轮次：usage 全 0（真实数据的形态）。
            r#"{"type":"message","timestamp":"2026-10-21T01:00:05.000Z","message":{"role":"assistant","provider":"p","model":"m","stopReason":"error","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"content":[]}}"#.to_string(),
        ],
    );
    assert_eq!(tail.context_tokens, 15, "出错轮次不能把上下文清零");
    assert_eq!(tail.last_assistant.unwrap().stop_reason, "error");
}

#[test]
fn actor_tail_brief_falls_back_to_task_body() {
    let mut tail = ActorTail::default();
    // 没有块级 intent、也没有 arguments.i：用条目自己的任务正文第一行有内容的文字。
    let block = r##"{"type":"toolCall","id":"t1","name":"task","arguments":{"tasks":[{"name":"A","task":"# Target\nBackend only: x"},{"name":"B","task":"# Target: src/a, src/b"}]}}"##;
    let block_intent = r##"{"type":"toolCall","id":"t2","name":"task","intent":"块级说明","arguments":{"tasks":[{"name":"C","task":"# Target\nignored"}]}}"##;
    feed(
        &mut tail,
        &[assistant(
            "2026-10-21T01:00:00.000Z",
            "toolUse",
            &format!("{block},{block_intent}"),
        )],
    );
    assert_eq!(
        tail.spawn_info["A"].brief.as_deref(),
        Some("Backend only: x")
    );
    assert_eq!(tail.spawn_info["A"].agent.as_deref(), Some("task"));
    assert_eq!(
        tail.spawn_info["B"].brief.as_deref(),
        Some("Target: src/a, src/b")
    );
    assert_eq!(tail.spawn_info["C"].brief.as_deref(), Some("块级说明"));
}

#[test]
fn actor_tail_records_exit_and_lifecycle() {
    let mut tail = ActorTail::default();
    let life = |action: &str| {
        format!(
            r#"{{"type":"custom","customType":"vibe-session-lifecycle","timestamp":"2026-10-21T01:00:05.000Z","data":{{"id":"skel","action":"{action}","agent":"sonic","childSessionFile":"skel.jsonl"}}}}"#
        )
    };
    feed(&mut tail, &[life("spawn")]);
    assert_eq!(tail.lifecycle["skel"].action, "spawn");
    assert_eq!(tail.lifecycle["skel"].agent.as_deref(), Some("sonic"));
    assert_eq!(
        tail.lifecycle["skel"].child_file.as_deref(),
        Some("skel.jsonl")
    );
    feed(&mut tail, &[life("turn-settled")]);
    assert_eq!(tail.lifecycle["skel"].action, "turn-settled");
    feed(&mut tail, &[life("tombstone")]);
    // 墓碑只标记退役：种类归属仍靠 childSessionFile。
    let retired = &tail.lifecycle["skel"];
    assert!(retired.tombstoned);
    assert_eq!(retired.action, "turn-settled");
    assert_eq!(retired.child_file.as_deref(), Some("skel.jsonl"));

    feed(
        &mut tail,
        &[session_exit(
            "2026-10-21T02:00:00.000Z",
            "normal",
            "dispose",
        )],
    );
    let exit = tail.exit.as_ref().unwrap();
    assert_eq!(exit.kind, "normal");
    assert_eq!(exit.reason, "dispose");
    assert_eq!(iso_ms(exit.at_ms), "2026-10-21T02:00:00.000Z");
}

/// 退出后又被恢复（真实样本 `app-icon.jsonl`：exit(normal) → session_init → 新对话）：
/// 陈旧 exit 必须作废，否则恢复中的角色被显示成已完成。
#[test]
fn actor_tail_stale_exit_is_cleared_by_resumed_activity() {
    let mut tail = ActorTail::default();
    feed(
        &mut tail,
        &[
            header_with("child-1", "2026-10-19T05:00:00.000Z"),
            assistant("2026-10-19T05:18:39.000Z", "toolUse", ""),
            session_exit("2026-10-19T05:25:49.440Z", "normal", "dispose"),
        ],
    );
    assert!(tail.exit.is_some());

    // 恢复：session_init → 新用户消息 → 新工具调用。
    feed(
        &mut tail,
        &[
            r#"{"type":"session_init","timestamp":"2026-10-19T05:43:29.466Z","systemPrompt":["x"]}"#.to_string(),
            r#"{"type":"message","timestamp":"2026-10-19T05:43:29.468Z","message":{"role":"user","content":[{"type":"text","text":"继续"}]}}"#.to_string(),
            tool_start("2026-10-19T05:44:40.000Z", "c9", "bash", "继续跑"),
        ],
    );
    assert!(tail.exit.is_none(), "恢复活动后陈旧 exit 必须清掉");
    assert_eq!(tail.pending.len(), 1);

    // 心跳/标题这类非活动行不清 exit。
    let mut quiet = ActorTail::default();
    feed(
        &mut quiet,
        &[
            header_with("child-2", "2026-10-19T05:00:00.000Z"),
            session_exit("2026-10-19T05:10:00.000Z", "normal", "dispose"),
            r#"{"type":"custom","customType":"session_exit","timestamp":"2026-10-19T05:10:00.000Z","data":{"kind":"normal","reason":"dispose"}}"#.to_string(),
        ],
    );
    assert!(quiet.exit.is_some());
}

#[test]
fn actor_tail_caps_recent_and_redacts() {
    let mut tail = ActorTail::default();
    let block = r#"{"type":"text","text":"token=sk-abcdefghijklmnop"}"#;
    for i in 0..40 {
        feed(
            &mut tail,
            &[assistant(
                &format!("2026-10-21T01:00:{i:02}.000Z"),
                "stop",
                block,
            )],
        );
    }
    assert_eq!(tail.recent.len(), super::actor_tail::RECENT_CAP);
    let last = tail.recent.back().unwrap();
    assert_eq!(last.activity.kind, crate::model::StageActivityKind::Reply);
    assert!(!last.activity.text.contains("sk-abcdefghijklmnop"));
}

#[test]
fn actor_tail_reset_clears_everything() {
    let mut tail = ActorTail::default();
    feed(
        &mut tail,
        &[header_with("id-1", "2026-10-21T01:00:00.000Z")],
    );
    tail.reset();
    assert!(tail.header_id.is_none());
    assert!(tail.recent.is_empty());
}

// ---------------------------------------------------------------------------
// derive
// ---------------------------------------------------------------------------

fn base(kind: StageActorKind) -> DeriveInput {
    DeriveInput {
        kind,
        file_exists: true,
        parent_in_use: true,
        ..DeriveInput::default()
    }
}

#[test]
fn derive_main_states() {
    let mut i = base(StageActorKind::Main);
    assert_eq!(derive_state(&i).0, StageActorState::Running);
    for (status, expect, text) in [
        ("working", StageActorState::Running, None),
        ("waiting", StageActorState::Idle, Some("等待输入")),
        ("idle", StageActorState::Idle, Some("空闲")),
        ("stuck", StageActorState::Failed, Some("疑似卡住")),
    ] {
        i.main_status = Some(status.to_string());
        let (state, note) = derive_state(&i);
        assert_eq!(state, expect, "status={status}");
        assert_eq!(note.as_deref(), text, "status={status}");
    }
    i.parent_in_use = false;
    assert_eq!(
        derive_state(&i),
        (StageActorState::Done, Some("已结束".into()))
    );
}

#[test]
fn derive_worker_lifecycle_states() {
    let mut i = base(StageActorKind::Worker);
    i.lifecycle_action = Some("spawn".into());
    assert_eq!(derive_state(&i).0, StageActorState::Queued);
    i.lifecycle_action = Some("turn-started".into());
    assert_eq!(derive_state(&i).0, StageActorState::Running);
    i.parent_in_use = false;
    assert_eq!(
        derive_state(&i),
        (StageActorState::Lost, Some("会话已退出".into()))
    );
    i.parent_in_use = true;
    i.lifecycle_action = Some("turn-settled".into());
    assert_eq!(
        derive_state(&i),
        (StageActorState::Idle, Some("待命".into()))
    );
    // 异常退出优先于 lifecycle。
    i.exit_kind = Some("signal".into());
    i.exit_reason = Some("sighup".into());
    assert_eq!(
        derive_state(&i),
        (StageActorState::Failed, Some("sighup".into()))
    );
}

#[test]
fn derive_subagent_states() {
    let mut i = base(StageActorKind::Subagent);
    i.file_exists = false;
    assert_eq!(derive_state(&i).0, StageActorState::Queued);
    i.file_exists = true;
    assert_eq!(derive_state(&i).0, StageActorState::Running);

    i.exit_kind = Some("normal".into());
    assert_eq!(
        derive_state(&i),
        (StageActorState::Done, Some("已结束".into()))
    );
    i.exit_kind = Some("crash".into());
    i.exit_reason = Some("panic".into());
    assert_eq!(
        derive_state(&i),
        (StageActorState::Failed, Some("panic".into()))
    );

    // 无 exit + 父会话已退出：未收尾（有未配对工具）→ Lost。
    let mut j = base(StageActorKind::Subagent);
    j.parent_in_use = false;
    j.pending_tools = 1;
    assert_eq!(
        derive_state(&j),
        (StageActorState::Lost, Some("会话已退出".into()))
    );
    // 已干净收尾（无未配对工具、最后 stop）→ Done（真实 advisor 常缺 session_exit）。
    let mut clean = base(StageActorKind::Subagent);
    clean.parent_in_use = false;
    clean.last_assistant_stop = Some("stop".into());
    assert_eq!(
        derive_state(&clean),
        (StageActorState::Done, Some("已结束".into()))
    );

    // 无 exit，已收尾且静默超阈值 → Done。
    let mut k = base(StageActorKind::Subagent);
    k.last_assistant_stop = Some("stop".into());
    k.last_at_secs = Some(1_000);
    k.now_secs = 1_000 + ORPHAN_DONE_SECS;
    assert_eq!(derive_state(&k).0, StageActorState::Running, "未超阈值");
    k.now_secs = 1_000 + ORPHAN_DONE_SECS + 1;
    assert_eq!(derive_state(&k).0, StageActorState::Done);

    // 无 exit，最后一条 assistant 报错且无未配对工具 → Failed。
    let mut m = base(StageActorKind::Subagent);
    m.last_assistant_stop = Some("error".into());
    assert_eq!(
        derive_state(&m),
        (StageActorState::Failed, Some("error".into()))
    );
    // 父会话不在用也照样是失败（终态不随父会话变化）。
    m.parent_in_use = false;
    assert_eq!(
        derive_state(&m),
        (StageActorState::Failed, Some("error".into()))
    );
    // 子代理被中止：失败。
    let mut aborted = base(StageActorKind::Subagent);
    aborted.parent_in_use = false;
    aborted.last_assistant_stop = Some("aborted".into());
    assert_eq!(
        derive_state(&aborted),
        (StageActorState::Failed, Some("aborted".into()))
    );
    // advisor 被重置（aborted）是正常机制：无论父会话在不在用都算完成。
    let mut advisor = base(StageActorKind::Advisor);
    advisor.last_assistant_stop = Some("aborted".into());
    assert_eq!(
        derive_state(&advisor),
        (StageActorState::Done, Some("已结束".into()))
    );
    advisor.parent_in_use = false;
    assert_eq!(
        derive_state(&advisor),
        (StageActorState::Done, Some("已结束".into()))
    );
    m.pending_tools = 1;
    m.parent_in_use = true;
    assert_eq!(derive_state(&m).0, StageActorState::Running);

    // advisor 与子代理同规则。
    let mut a = base(StageActorKind::Advisor);
    a.exit_kind = Some("normal".into());
    assert_eq!(derive_state(&a).0, StageActorState::Done);
}

// ---------------------------------------------------------------------------
// build_stage
// ---------------------------------------------------------------------------

/// 造一个带附件目录的会话：顶层 + Scout(normal exit) + Work(未配对工具) + Bad(crash)。
fn fixture() -> (std::path::PathBuf, Config, std::path::PathBuf) {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("2026-10-21T01-34-38-305Z_deadbeef-0000-4000-8000-000000000001.jsonl");
    let main_lines = [
        HEADER.to_string(),
        assistant(
            "2026-10-21T01:35:00.000Z",
            "toolUse",
            r#"{"type":"text","text":"派活"}"#,
        ),
        tool_start("2026-10-21T01:35:01.000Z", "c1", "task", "派三个子代理"),
        assistant(
            "2026-10-21T01:35:02.000Z",
            "toolUse",
            r#"{"type":"toolCall","id":"t1","name":"task","arguments":{"i":"派三个子代理","tasks":[{"name":"Scout","agent":"scout"},{"name":"Work","agent":"task"},{"name":"Bad","agent":"task"}]}}"#,
        ),
        tool_result("2026-10-21T01:35:03.000Z", "c1"),
    ];
    fs::write(&top, main_lines.join("\n") + "\n").unwrap();

    let attach = top.with_extension("");
    fs::create_dir_all(&attach).unwrap();
    fs::write(
        attach.join("Scout.jsonl"),
        [
            header_with("child-scout", "2026-10-21T01:36:00.000Z"),
            assistant(
                "2026-10-21T01:37:00.000Z",
                "stop",
                r#"{"type":"text","text":"读完"}"#,
            ),
            session_exit("2026-10-21T01:38:00.000Z", "normal", "dispose"),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    fs::write(
        attach.join("Work.jsonl"),
        [
            header_with("child-work", "2026-10-21T01:36:10.000Z"),
            assistant("2026-10-21T01:36:20.000Z", "toolUse", ""),
            tool_start("2026-10-21T01:36:21.000Z", "w1", "bash", "Running tests"),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    fs::write(
        attach.join("Bad.jsonl"),
        [
            header_with("child-bad", "2026-10-21T01:36:20.000Z"),
            assistant("2026-10-21T01:36:30.000Z", "toolUse", ""),
            session_exit("2026-10-21T01:36:40.000Z", "crash", "panic"),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    let cfg = cfg_for(&root);
    (root, cfg, top)
}

fn states(stage: &crate::model::AgentStage) -> Vec<(String, StageActorState)> {
    stage
        .actors
        .iter()
        .map(|a| (a.name.clone(), a.state))
        .collect()
}

#[test]
fn build_stage_in_use_marks_running_and_done() {
    let (_root, cfg, top) = fixture();
    let cache = StageCache::default();
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let stage = build_stage(&cfg, &cache, &top, None, &probe, now).unwrap();
    assert!(stage.in_use);
    assert!(stage.probe_ok);
    assert_eq!(
        stage.session_id.as_deref(),
        Some("deadbeef-0000-4000-8000-000000000001")
    );
    assert_eq!(
        states(&stage),
        vec![
            ("管理员".to_string(), StageActorState::Running),
            ("Scout".to_string(), StageActorState::Done),
            ("Work".to_string(), StageActorState::Running),
            ("Bad".to_string(), StageActorState::Failed),
        ]
    );
    // Scout：normal exit → 有结束时间；Work：camelCase 未配对 → current 是工具。
    let scout = &stage.actors[1];
    assert!(scout.ended_at.is_some());
    assert_eq!(scout.agent.as_deref(), Some("scout"));
    assert_eq!(scout.brief.as_deref(), Some("派三个子代理"));
    let work = &stage.actors[2];
    let current = work.current.as_ref().unwrap();
    assert_eq!(current.kind, crate::model::StageActivityKind::Tool);
    assert_eq!(current.tool.as_deref(), Some("bash"));
    assert_eq!(current.text, "Running tests");
    let bad = &stage.actors[3];
    assert_eq!(bad.status_text.as_deref(), Some("panic"));
}

#[test]
fn build_stage_not_in_use_marks_lost_and_done() {
    let (_root, cfg, top) = fixture();
    let cache = StageCache::default();
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: false,
        probe_ok: true,
    };
    let stage = build_stage(&cfg, &cache, &top, None, &probe, now).unwrap();
    assert!(!stage.in_use);
    assert_eq!(
        states(&stage),
        vec![
            ("管理员".to_string(), StageActorState::Done),
            ("Scout".to_string(), StageActorState::Done),
            ("Work".to_string(), StageActorState::Lost),
            ("Bad".to_string(), StageActorState::Failed),
        ]
    );
    // 失联角色不显示过期的「当前活动」（它挂着一条永远等不到结果的工具）。
    let work = stage.actors.iter().find(|a| a.name == "Work").unwrap();
    assert!(work.current.is_none());
}

#[test]
fn build_stage_falls_back_to_poller_snapshot_when_probe_fails() {
    let (_root, cfg, top) = fixture();
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: false,
        probe_ok: false,
    };
    let running = RunningSession {
        id: "deadbeef-0000-4000-8000-000000000001".into(),
        path: top.to_string_lossy().to_string(),
        title: "轮询器标题".into(),
        status: "waiting".into(),
        status_text: "等待输入".into(),
        subagents: 2,
        duration_secs: 100,
        app: Some("iTerm2".into()),
    };
    // 探测失败 + 轮询器见过 → 视为在用。
    let stage = build_stage(
        &cfg,
        &StageCache::default(),
        &top,
        Some(&running),
        &probe,
        now,
    )
    .unwrap();
    assert!(!stage.probe_ok);
    assert_eq!(stage.title, "轮询器标题");
    assert_eq!(stage.actors[0].state, StageActorState::Idle);
    assert_eq!(stage.actors[0].status_text.as_deref(), Some("等待输入"));

    // 探测失败 + 轮询器没见过 → 按不在用处理。
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    assert_eq!(stage.actors[0].state, StageActorState::Done);
}

#[test]
fn build_stage_without_attachment_dir_has_only_main() {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("s.jsonl");
    fs::write(&top, format!("{HEADER}\n")).unwrap();
    let cfg = cfg_for(&root);
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    assert_eq!(stage.actors.len(), 1);
    assert_eq!(stage.actors[0].kind, StageActorKind::Main);
    assert_eq!(stage.omitted, 0);
}

#[test]
fn build_stage_rejects_non_v3_header() {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("s.jsonl");
    fs::write(
        &top,
        "{\"type\":\"session\",\"version\":2,\"id\":\"x\",\"cwd\":\"/tmp\"}\n",
    )
    .unwrap();
    let cfg = cfg_for(&root);
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let err = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap_err();
    assert_eq!(err.code, crate::model::ErrorCode::UnsupportedFormat);
}

#[test]
fn build_stage_adds_queued_worker_from_lifecycle_without_file() {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("s.jsonl");
    let life = r#"{"type":"custom","customType":"vibe-session-lifecycle","timestamp":"2026-10-21T01:40:00.000Z","data":{"id":"skel","action":"spawn","agent":"sonic","childSessionFile":"skel.jsonl"}}"#;
    fs::write(&top, format!("{HEADER}\n{life}\n")).unwrap();
    let cfg = cfg_for(&root);
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    assert_eq!(stage.actors.len(), 2);
    let worker = &stage.actors[1];
    assert_eq!(worker.id, "skel");
    assert_eq!(worker.kind, StageActorKind::Worker);
    assert_eq!(worker.agent.as_deref(), Some("sonic"));
    assert_eq!(worker.state, StageActorState::Queued);
}

/// worker 文件存在时的状态必须由 lifecycle 决定（而不是子代理规则）。
#[test]
fn build_stage_worker_file_follows_lifecycle_action() {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("s.jsonl");
    let life = |action: &str| {
        format!(
            r#"{{"type":"custom","customType":"vibe-session-lifecycle","timestamp":"2026-10-21T01:40:00.000Z","data":{{"id":"skel","action":"{action}","agent":"sonic","childSessionFile":"skel.jsonl"}}}}"#
        )
    };
    fs::write(&top, format!("{HEADER}\n",)).unwrap();
    let attach = top.with_extension("");
    fs::create_dir_all(&attach).unwrap();
    // worker 文件只有一条已收尾的 assistant（子代理规则会判 Running 或 Done）。
    fs::write(
        attach.join("skel.jsonl"),
        [
            header_with("child-skel", "2026-10-21T01:41:00.000Z"),
            assistant(
                "2026-10-21T01:41:10.000Z",
                "stop",
                r#"{"type":"text","text":"干完了"}"#,
            ),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    let cfg = cfg_for(&root);
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };

    for (action, expected) in [
        ("turn-settled", StageActorState::Idle),
        ("turn-started", StageActorState::Running),
    ] {
        fs::write(&top, format!("{HEADER}\n{}\n", life(action))).unwrap();
        let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
        let worker = stage
            .actors
            .iter()
            .find(|a| a.name == "skel")
            .unwrap_or_else(|| panic!("缺少 worker 角色：{action}"));
        assert_eq!(worker.kind, StageActorKind::Worker, "{action}");
        assert_eq!(worker.state, expected, "action={action}");
        if action == "turn-settled" {
            assert_eq!(worker.status_text.as_deref(), Some("待命"));
        }
    }

    // worker 文件里有正常退出记录：即便 lifecycle 仍停在 turn-started，也算完成。
    fs::write(
        attach.join("skel.jsonl"),
        [
            header_with("child-skel", "2026-10-21T01:41:00.000Z"),
            assistant("2026-10-21T01:41:10.000Z", "stop", ""),
            session_exit("2026-10-21T01:42:00.000Z", "normal", "dispose"),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    fs::write(&top, format!("{HEADER}\n{}\n", life("turn-started"))).unwrap();
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    let worker = stage.actors.iter().find(|a| a.name == "skel").unwrap();
    assert_eq!(worker.state, StageActorState::Done);
    assert!(worker.ended_at.is_some());

    // 复原成「未收尾」，继续测 spawn。
    fs::write(
        attach.join("skel.jsonl"),
        [
            header_with("child-skel", "2026-10-21T01:41:00.000Z"),
            assistant(
                "2026-10-21T01:41:10.000Z",
                "stop",
                r#"{"type":"text","text":"干完了"}"#,
            ),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();

    // spawn（尚未开跑）同样是 Queued，即便文件已存在。
    fs::write(&top, format!("{HEADER}\n{}\n", life("spawn"))).unwrap();
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    let worker = stage.actors.iter().find(|a| a.name == "skel").unwrap();
    assert_eq!(worker.state, StageActorState::Queued);
}

#[test]
fn build_stage_worker_file_abnormal_exit_beats_lifecycle() {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("s.jsonl");
    let life = r#"{"type":"custom","customType":"vibe-session-lifecycle","timestamp":"2026-10-21T01:40:00.000Z","data":{"id":"skel","action":"turn-started","agent":"sonic","childSessionFile":"skel.jsonl"}}"#;
    fs::write(&top, format!("{HEADER}\n{life}\n")).unwrap();
    let attach = top.with_extension("");
    fs::create_dir_all(&attach).unwrap();
    fs::write(
        attach.join("skel.jsonl"),
        [
            header_with("child-skel", "2026-10-21T01:41:00.000Z"),
            session_exit("2026-10-21T01:42:00.000Z", "signal", "sighup"),
        ]
        .join(
            "
",
        ) + "
",
    )
    .unwrap();
    let cfg = cfg_for(&root);
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    let worker = stage.actors.iter().find(|a| a.name == "skel").unwrap();
    assert_eq!(worker.kind, StageActorKind::Worker);
    assert_eq!(worker.state, StageActorState::Failed);
    assert_eq!(worker.status_text.as_deref(), Some("sighup"));
}

/// 恢复运行的 worker 不能再因为陈旧 exit 被判成已完成。
#[test]
fn build_stage_resumed_worker_is_running_not_done() {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("s.jsonl");
    let life = |action: &str| {
        format!(
            r#"{{"type":"custom","customType":"vibe-session-lifecycle","timestamp":"2026-10-19T05:43:30.000Z","data":{{"id":"skel","action":"{action}","turn":2,"agent":"sonic","childSessionFile":"skel.jsonl"}}}}"#
        )
    };
    fs::write(&top, format!("{HEADER}\n{}\n", life("turn-started"))).unwrap();
    let attach = top.with_extension("");
    fs::create_dir_all(&attach).unwrap();
    // 先正常退出，随后被恢复并继续跑（尚未写新的 exit）。
    fs::write(
        attach.join("skel.jsonl"),
        [
            header_with("child-skel", "2026-10-19T05:00:00.000Z"),
            assistant("2026-10-19T05:18:39.000Z", "toolUse", ""),
            session_exit("2026-10-19T05:25:49.440Z", "normal", "dispose"),
            r#"{"type":"session_init","timestamp":"2026-10-19T05:43:29.466Z","systemPrompt":["x"]}"#.to_string(),
            r#"{"type":"message","timestamp":"2026-10-19T05:43:29.468Z","message":{"role":"user","content":[{"type":"text","text":"继续"}]}}"#.to_string(),
            tool_start("2026-10-19T05:44:40.000Z", "c9", "bash", "继续跑"),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    let cfg = cfg_for(&root);
    let now = Utc.with_ymd_and_hms(2026, 10, 19, 6, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    let worker = stage.actors.iter().find(|a| a.name == "skel").unwrap();
    assert_eq!(worker.kind, StageActorKind::Worker);
    assert_eq!(
        worker.state,
        StageActorState::Running,
        "恢复中的 worker 不该是 Done"
    );
    assert_eq!(
        worker.agent.as_deref(),
        Some("sonic"),
        "worker 的 agent 来自 lifecycle"
    );
    assert!(worker.ended_at.is_none(), "运行中不该有结束时间");
    assert_eq!(
        worker.current.as_ref().and_then(|c| c.tool.as_deref()),
        Some("bash")
    );
}

#[test]
fn build_stage_increments_only_new_bytes_on_repeat() {
    let (_root, cfg, top) = fixture();
    let cache = StageCache::default();
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let first = build_stage(&cfg, &cache, &top, None, &probe, now).unwrap();
    let calls = first.actors[0].tool_calls;
    // 再跑一次不重复计数（游标没有回退）。
    let second = build_stage(&cfg, &cache, &top, None, &probe, now).unwrap();
    assert_eq!(second.actors[0].tool_calls, calls);
    // 追加一行后只多算一条。
    let mut text = fs::read_to_string(&top).unwrap();
    text.push_str(&tool_start(
        "2026-10-21T01:50:00.000Z",
        "c9",
        "grep",
        "搜索",
    ));
    text.push('\n');
    fs::write(&top, text).unwrap();
    let third = build_stage(&cfg, &cache, &top, None, &probe, now).unwrap();
    assert_eq!(third.actors[0].tool_calls, calls + 1);
}

#[test]
fn build_stage_grandchild_name_and_spawn_info() {
    let root = tempdir();
    let proj = root.join("-tmp-proj");
    fs::create_dir_all(&proj).unwrap();
    let top = proj.join("2026-10-21T01-34-38-305Z_deadbeef-0000-4000-8000-000000000001.jsonl");
    // 主会话派了 P。
    let spawn_p = r#"{"type":"toolCall","id":"t1","name":"task","arguments":{"i":"派父代理","tasks":[{"name":"P","agent":"task"}]}}"#;
    fs::write(
        &top,
        [
            HEADER.to_string(),
            assistant("2026-10-21T01:35:00.000Z", "toolUse", spawn_p),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    let attach = top.with_extension("");
    fs::create_dir_all(attach.join("P")).unwrap();
    // P 自己又派了孙代理 Child（说明写在 P 的 tail 里，主会话里没有）。
    let spawn_child = r#"{"type":"toolCall","id":"t2","name":"task","intent":"派孙代理","arguments":{"tasks":[{"name":"Child","agent":"scout"}]}}"#;
    fs::write(
        attach.join("P.jsonl"),
        [
            header_with("child-p", "2026-10-21T01:36:00.000Z"),
            assistant("2026-10-21T01:36:10.000Z", "toolUse", spawn_child),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    fs::write(
        attach.join("P").join("P.Child.jsonl"),
        [
            header_with("child-child", "2026-10-21T01:36:20.000Z"),
            assistant("2026-10-21T01:36:30.000Z", "stop", ""),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();

    let cfg = cfg_for(&root);
    let now = Utc.with_ymd_and_hms(2026, 10, 21, 2, 0, 0).unwrap();
    let probe = |_: &str| Probe {
        in_use: true,
        probe_ok: true,
    };
    let stage = build_stage(&cfg, &StageCache::default(), &top, None, &probe, now).unwrap();
    let child = stage
        .actors
        .iter()
        .find(|a| a.id == "P/P.Child")
        .expect("孙代理应出现在舞台");
    assert_eq!(child.name, "Child", "去掉重复的父名前缀");
    assert_eq!(child.parent_id.as_deref(), Some("P"));
    assert_eq!(child.kind, StageActorKind::Subagent);
    assert_eq!(child.agent.as_deref(), Some("scout"));
    assert_eq!(child.brief.as_deref(), Some("派孙代理"));
}

#[test]
fn iso_round_trip() {
    assert_eq!(
        iso_ms(parse_iso_ms("2026-10-21T01:34:38.305Z").unwrap()),
        "2026-10-21T01:34:38.305Z"
    );
}
