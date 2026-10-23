//! 后端集成测试：fixture 会话树（tempdir），覆盖 CONTRACT §4.2–§4.5、§5、§6。

mod common;

use std::path::{Path, PathBuf};

use common::{cfg, header, msg, write_lines};
use omp_resume_lib::config::{self, Config};
use omp_resume_lib::model::ErrorCode;
use omp_resume_lib::sessions;
use serde_json::{json, Value};

fn set_mtime(p: &Path, secs: u64) {
    let t = filetime::FileTime::from_unix_time(secs as i64, 0);
    filetime::set_file_mtime(p, t).unwrap();
}

fn title_line(title: &str) -> String {
    json!({"type":"title","v":1,"title":title,"source":"auto","updatedAt":"2026-10-14T00:00:00.000Z","pad":"   "}).to_string()
}

const TS_U: i64 = 1_791_790_685_211;
const TS_A: i64 = 1_791_790_687_031;

fn user_msg(text: &str) -> Value {
    json!({"role":"user","content":[{"type":"text","text":text}],"attribution":"user","timestamp":TS_U})
}

fn assistant_msg(blocks: Value) -> Value {
    json!({"role":"assistant","content":blocks,"stopReason":"stop","timestamp":TS_A})
}

/// 综合 fixture：覆盖 relink / 分支 / label / compaction / 坏行 / 无 id 行。
/// 树：
/// mc1 ─ tc1 ─ u1 ─ c1(custom,跳过) ─ a1 ─ t1 ─ b1 ─ d1 ─ cp1
///                          │          ├─ u2 ─ x1(跳过) ─ a2 ─ l1,l2(label,跳过)
///                          │          └─ bs1(branch_summary)
///                          └─ cm1(跳过) ─ u3(leaf)
#[allow(clippy::too_many_lines)]
fn kitchen_sink(proj_cwd: &str) -> Vec<String> {
    vec![
        title_line("旧标题"),
        header("sess-01", proj_cwd),
        json!({"type":"model_change","id":"mc1","parentId":null,"timestamp":"2026-10-14T00:00:00.100Z","model":"m","resolvedModelIsFallback":false}).to_string(),
        json!({"type":"thinking_level_change","id":"tc1","parentId":"mc1","timestamp":"2026-10-14T00:00:00.200Z","thinkingLevel":"high","configured":null}).to_string(),
        msg("u1", Some("tc1"), user_msg("第一条用户消息内容")),
        json!({"type":"custom","customType":"tool_execution_start","data":{"toolCallId":"call_1","toolName":"read","startedAt":"2026-10-14T00:00:01.000Z"},"id":"c1","parentId":"u1","timestamp":"2026-10-14T00:00:01.100Z"}).to_string(),
        msg("a1", Some("c1"), assistant_msg(json!([
            {"type":"thinking","thinking":"先想一下","thinkingSignature":"s","summary":false},
            {"type":"text","text":"你好世界"},
            {"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"/tmp/x","i":"读"},"partialArgs":"{}"},
            {"type":"weird","x":1}
        ]))),
        msg("t1", Some("a1"), json!({"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"文件内容第一行\n第二行"}],"isError":false,"timestamp":1})),
        msg("b1", Some("t1"), json!({"role":"bashExecution","command":"ls /tmp","output":"a\nb","exitCode":0,"cancelled":false,"truncated":false,"timestamp":2,"excludeFromContext":false})),
        msg("d1", Some("b1"), json!({"role":"developer","content":[{"type":"text","text":"系统提醒"}],"attribution":"agent","timestamp":3})),
        json!({"type":"compaction","id":"cp1","parentId":"d1","timestamp":"2026-10-14T00:00:02.000Z","summary":"压缩摘要内容","shortSummary":"短","firstKeptEntryId":"u1"}).to_string(),
        msg("u2", Some("a1"), user_msg("分支上的问题")),
        json!({"type":"custom","customType":"session_exit","data":{"reason":"dispose","kind":"normal","recordedAt":"2026-10-14T00:00:03.000Z"},"id":"x1","parentId":"u2","timestamp":"2026-10-14T00:00:03.000Z"}).to_string(),
        msg("a2", Some("x1"), assistant_msg(json!([{"type":"text","text":"分支回答"}]))),
        json!({"type":"label","id":"l1","parentId":"a2","timestamp":"2026-10-14T00:00:04.000Z","targetId":"a1","label":"重要"}).to_string(),
        json!({"type":"label","id":"l2","parentId":"l1","timestamp":"2026-10-14T00:00:05.000Z","targetId":"u1","label":"待办"}).to_string(),
        json!({"type":"label","id":"l3","parentId":"l2","timestamp":"2026-10-14T00:00:06.000Z","targetId":"a1"}).to_string(),
        json!({"type":"branch_summary","id":"bs1","parentId":"t1","timestamp":"2026-10-14T00:00:07.000Z","fromId":"u2","summary":"废弃分支摘要"}).to_string(),
        "{这不是 json".to_string(),
        json!({"no-type":true}).to_string(),
        json!({"type":"custom_message","customType":"tool-roster-notice","content":"通知","display":false,"attribution":"agent","id":"cm1","parentId":"bs1","timestamp":"2026-10-14T00:00:08.000Z"}).to_string(),
        msg("u3", Some("cm1"), user_msg("末尾消息")),
    ]
}

fn fixture_root() -> (tempfile::TempDir, PathBuf, Config) {
    let t = tempfile::tempdir().unwrap();
    let proj = t.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let c = cfg(t.path());
    (t, proj, c)
}

#[test]
fn list_tree_conversation_kitchen_sink() {
    let (_t, proj, _) = fixture_root();
    let mil = _t.path().join("sessions");
    let dir = mil.join("-proj");
    let p = write_lines(&dir, "s.jsonl", &kitchen_sink(proj.to_str().unwrap()));
    set_mtime(&p, 1_791_900_000);
    let c = Config {
        sessions_dir: mil,
        owners_dir: _t.path().join("owners"),
    };

    let listed = sessions::list::list_sessions(&c).unwrap();
    assert_eq!(listed.groups.len(), 1);
    let g = &listed.groups[0];
    assert_eq!(g.dir_name, "-proj");
    assert_eq!(g.cwd, proj.to_str().unwrap());
    assert_eq!(g.sessions.len(), 1);
    let s = &g.sessions[0];
    assert_eq!(s.id, "sess-01");
    assert_eq!(s.title, "旧标题");
    assert!(s.cwd_exists);
    assert!(s.format_supported);
    assert_eq!(s.version, Some(3));
    assert_eq!(s.bad_lines, 2);
    assert!(s.size_bytes > 1000);
    assert!(!s.created_at.is_empty() && !s.modified_at.is_empty());
    assert!(!s.in_use && s.probe_ok);
    assert!(s.fork.is_none());
    // active 路径 u3→cm1(跳过)→bs1→t1→a1→c1(跳过)→u1→tc1(跳过)→mc1(跳过)：
    // user(u1,u3) + assistant(a1) = 3
    assert_eq!(s.message_count, 3);
    // 叶子：cp1, a2, u3 → 3 个分支
    assert_eq!(s.branch_count, 3);
    assert_eq!(s.first_user_message.as_deref(), Some("第一条用户消息内容"));

    // ---- tree ----
    let tree = sessions::tree::get_tree(&p).unwrap();
    assert_eq!(tree.leaf_id.as_deref(), Some("u3"));
    assert_eq!(tree.root_ids, vec!["u1".to_string()]);
    // activePath leaf 在前：u3 → bs1 → t1 → a1 → u1
    assert_eq!(tree.active_path_ids, vec!["u3", "bs1", "t1", "a1", "u1"]);
    let by_id: std::collections::HashMap<&str, _> =
        tree.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    // 重链接穿过 custom
    assert_eq!(by_id["a1"].parent_id.as_deref(), Some("u1"));
    assert_eq!(by_id["t1"].parent_id.as_deref(), Some("a1"));
    assert_eq!(by_id["a2"].parent_id.as_deref(), Some("u2"));
    assert_eq!(by_id["u2"].parent_id.as_deref(), Some("a1"));
    assert_eq!(by_id["u3"].parent_id.as_deref(), Some("bs1"));
    assert_eq!(by_id["bs1"].parent_id.as_deref(), Some("t1"));
    // label：a1 被 l3 清除 → null；u1 取 l2
    assert_eq!(by_id["a1"].label, None);
    assert_eq!(by_id["u1"].label.as_deref(), Some("待办"));
    // compaction / branch_summary 节点
    assert!(by_id["cp1"].is_compaction);
    assert_eq!(by_id["cp1"].role, None);
    assert!(by_id["bs1"].is_branch_summary);
    // preview
    assert_eq!(by_id["u1"].preview, "第一条用户消息内容");
    assert_eq!(by_id["a1"].preview, "你好世界");
    assert_eq!(by_id["t1"].preview, "文件内容第一行\n第二行");
    assert_eq!(by_id["b1"].preview, "ls /tmp a\nb");
    assert_eq!(by_id["cp1"].preview, "压缩摘要内容");
    assert_eq!(by_id["bs1"].preview, "废弃分支摘要");
    assert!(by_id["u1"].preview.chars().count() <= 80);

    // ---- conversation（默认 leaf=u3）----
    let conv = sessions::conversation::get_conversation(&p, None).unwrap();
    assert_eq!(conv.leaf_id.as_deref(), Some("u3"));
    assert_eq!(conv.target_id, "u3");
    assert_eq!(conv.items.len(), 5); // u1 a1 t1 bs1 u3
    let kinds: Vec<&str> = conv
        .items
        .iter()
        .map(|i| match i {
            omp_resume_lib::model::ConversationItem::User(_) => "user",
            omp_resume_lib::model::ConversationItem::Assistant(_) => "assistant",
            omp_resume_lib::model::ConversationItem::ToolResult(_) => "toolResult",
            omp_resume_lib::model::ConversationItem::BashExecution(_) => "bash",
            omp_resume_lib::model::ConversationItem::Compaction(_) => "compaction",
            omp_resume_lib::model::ConversationItem::BranchSummary(_) => "branchSummary",
            omp_resume_lib::model::ConversationItem::Other(_) => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        vec!["user", "assistant", "toolResult", "branchSummary", "user"]
    );

    // assistant 块：thinking/text/toolCall，未知块跳过
    if let omp_resume_lib::model::ConversationItem::Assistant(a) = &conv.items[1] {
        assert_eq!(a.blocks.len(), 3);
    } else {
        panic!("items[1] 应为 assistant");
    }
    // toolResult 字段
    if let omp_resume_lib::model::ConversationItem::ToolResult(t) = &conv.items[2] {
        assert_eq!(t.tool_call_id, "call_1");
        assert_eq!(t.tool_name, "read");
        assert!(!t.is_error && !t.truncated);
        assert_eq!(t.text, "文件内容第一行\n第二行");
    } else {
        panic!("items[2] 应为 toolResult");
    }

    // ---- conversation 非 active 分支节点 ----
    let conv2 = sessions::conversation::get_conversation(&p, Some("a2")).unwrap();
    assert_eq!(conv2.target_id, "a2");
    assert_eq!(conv2.items.len(), 4); // u1 a1 u2 a2
                                      // INVALID_NODE：未知 id 与跳过类型 id
    for bad in [Some("nope"), Some("c1"), Some("l1")] {
        let e = sessions::conversation::get_conversation(&p, bad).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidNode);
    }
}

#[test]
fn conversation_other_kinds() {
    let (_t, proj, _) = fixture_root();
    let dir = _t.path().join("sessions").join("-p");
    let p = write_lines(&dir, "o.jsonl", &kitchen_sink(proj.to_str().unwrap()));
    // 路径 d1(developer) → 需以 d1 为目标
    let conv = sessions::conversation::get_conversation(&p, Some("d1")).unwrap();
    let last = conv.items.last().unwrap();
    if let omp_resume_lib::model::ConversationItem::Other(o) = last {
        assert_eq!(o.role, "developer");
        assert_eq!(o.text, "系统提醒");
    } else {
        panic!("应为 other/developer");
    }
    // bashExecution 字段
    let conv = sessions::conversation::get_conversation(&p, Some("b1")).unwrap();
    if let omp_resume_lib::model::ConversationItem::BashExecution(b) = conv.items.last().unwrap() {
        assert_eq!(b.command, "ls /tmp");
        assert_eq!(b.text, "a\nb");
        assert_eq!(b.exit_code, Some(0));
        assert!(!b.cancelled && !b.truncated);
    } else {
        panic!("应为 bashExecution");
    }
    // compaction 条目
    let conv = sessions::conversation::get_conversation(&p, Some("cp1")).unwrap();
    if let omp_resume_lib::model::ConversationItem::Compaction(c) = conv.items.last().unwrap() {
        assert_eq!(c.summary, "压缩摘要内容");
    } else {
        panic!("应为 compaction");
    }
}

#[test]
fn branching_three_leaves() {
    let (_t, proj, _) = fixture_root();
    let dir = _t.path().join("sessions").join("-b");
    let lines = vec![
        title_line("分支测试"),
        header("sess-b", proj.to_str().unwrap()),
        msg("r1", None, user_msg("根")),
        msg("a", Some("r1"), assistant_msg(json!([{"type":"text","text":"A"}]))),
        msg("b", Some("r1"), assistant_msg(json!([{"type":"text","text":"B"}]))),
        msg("c", Some("r1"), assistant_msg(json!([{"type":"text","text":"C"}]))),
        // 文件末为跳过类型：leaf 仍应为 c
        json!({"type":"custom","customType":"session_exit","data":{},"id":"x9","parentId":"c","timestamp":"2026-10-14T00:00:09.000Z"}).to_string(),
    ];
    let p = write_lines(&dir, "b.jsonl", &lines);
    let tree = sessions::tree::get_tree(&p).unwrap();
    assert_eq!(tree.leaf_id.as_deref(), Some("c"));
    assert_eq!(tree.root_ids, vec!["r1".to_string()]);
    assert_eq!(
        tree.active_path_ids,
        vec!["c".to_string(), "r1".to_string()]
    );
    let listed = sessions::list::list_sessions(&Config {
        sessions_dir: _t.path().join("sessions"),
        owners_dir: _t.path().join("owners"),
    })
    .unwrap();
    assert_eq!(listed.groups[0].sessions[0].branch_count, 3);
    assert_eq!(listed.groups[0].sessions[0].message_count, 2); // r1 + c
}

#[test]
fn cycle_and_dangling_and_label_last_wins() {
    let (_t, proj, _) = fixture_root();
    let dir = _t.path().join("sessions").join("-y");
    let lines = vec![
        title_line("环测试"),
        header("sess-y", proj.to_str().unwrap()),
        msg("d", Some("missing"), user_msg("悬空父")),
        msg("x", Some("y"), user_msg("环x")),
        msg("y", Some("x"), assistant_msg(json!([{"type":"text","text":"环y"}]))),
        msg("s", Some("s"), user_msg("自环")),
        json!({"type":"label","id":"g1","parentId":"s","timestamp":"2026-10-14T00:00:01.000Z","targetId":"x","label":"一"}).to_string(),
        json!({"type":"label","id":"g2","parentId":"g1","timestamp":"2026-10-14T00:00:02.000Z","targetId":"x","label":"二"}).to_string(),
    ];
    let p = write_lines(&dir, "y.jsonl", &lines);
    let tree = sessions::tree::get_tree(&p).unwrap();
    let by_id: std::collections::HashMap<&str, _> =
        tree.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    assert_eq!(by_id["d"].parent_id, None);
    assert_eq!(by_id["s"].parent_id, None);
    // kept 环原样保留（与 omp 一致），走访时截断
    assert_eq!(by_id["x"].parent_id.as_deref(), Some("y"));
    assert_eq!(by_id["y"].parent_id.as_deref(), Some("x"));
    assert_eq!(by_id["x"].label.as_deref(), Some("二"));
    // walk_up 不死循环
    assert!(tree.active_path_ids.len() <= tree.nodes.len());
    let conv = sessions::conversation::get_conversation(&p, None).unwrap();
    assert!(!conv.items.is_empty());
}

#[test]
fn non_v3_degrades() {
    let (_t, proj, _) = fixture_root();
    let dir = _t.path().join("sessions").join("-o");
    let old = vec![
        title_line("老会话"),
        json!({"type":"session","version":2,"id":"old-1","timestamp":"2026-10-14T00:00:00.000Z","cwd":proj.to_str().unwrap()}).to_string(),
        msg("o1", None, user_msg("hi")),
    ];
    let p = write_lines(&dir, "o.jsonl", &old);
    let listed = sessions::list::list_sessions(&Config {
        sessions_dir: _t.path().join("sessions"),
        owners_dir: _t.path().join("owners"),
    })
    .unwrap();
    let s = &listed.groups[0].sessions[0];
    assert!(!s.format_supported);
    assert_eq!(s.version, Some(2));
    assert_eq!(s.title, "老会话");
    assert_eq!(s.message_count, 0);
    assert_eq!(
        sessions::conversation::get_conversation(&p, None)
            .unwrap_err()
            .code,
        ErrorCode::UnsupportedFormat
    );
    assert_eq!(
        sessions::tree::get_tree(&p).unwrap_err().code,
        ErrorCode::UnsupportedFormat
    );
    assert_eq!(
        sessions::marker_context(&p).unwrap_err().code,
        ErrorCode::UnsupportedFormat
    );
}

#[test]
fn hidden_empty_title_rules_and_fork() {
    let (_t, proj, _) = fixture_root();
    let mil = _t.path().join("sessions");
    // 空标题 + 零用户消息 → 隐藏
    write_lines(
        &mil.join("-h"),
        "e.jsonl",
        &[
            title_line(""),
            header("empty-1", proj.to_str().unwrap()),
            json!({"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-10-14T00:00:00.100Z","model":"m"}).to_string(),
        ],
    );
    // 有用户消息无标题 → 显示，标题取首用户消息 60 字
    let long_user = "用".repeat(100);
    write_lines(
        &mil.join("-h"),
        "u.jsonl",
        &[
            title_line(""),
            header("user-1", proj.to_str().unwrap()),
            msg("u1", None, user_msg(&long_user)),
        ],
    );
    // title_change 最后非空获胜
    write_lines(
        &mil.join("-h"),
        "t.jsonl",
        &[
            title_line("槽位旧"),
            header("t-1", proj.to_str().unwrap()),
            msg("u1", None, user_msg("hi")),
            json!({"type":"title_change","id":"tc1","parentId":"u1","timestamp":"2026-10-14T00:00:01.000Z","title":"新标题","source":"user"}).to_string(),
            json!({"type":"title_change","id":"tc2","parentId":"tc1","timestamp":"2026-10-14T00:00:02.000Z","title":"","source":"auto"}).to_string(),
        ],
    );
    // fork：parent 为 id
    let parent_lines = vec![
        title_line("父会话"),
        header("parent-1", proj.to_str().unwrap()),
        msg("u1", None, user_msg("hi")),
    ];
    write_lines(&mil.join("-h"), "p.jsonl", &parent_lines);
    let mut child_h =
        serde_json::from_str::<Value>(&header("child-1", proj.to_str().unwrap())).unwrap();
    child_h["parentSession"] = json!("parent-1");
    write_lines(
        &mil.join("-h"),
        "c.jsonl",
        &[
            title_line("子会话"),
            child_h.to_string(),
            msg("u1", None, user_msg("hi")),
        ],
    );
    // fork：parent 为路径
    let parent_path = mil.join("-h").join("p.jsonl");
    let mut child2_h =
        serde_json::from_str::<Value>(&header("child-2", proj.to_str().unwrap())).unwrap();
    child2_h["parentSession"] = json!(parent_path.to_str().unwrap());
    write_lines(
        &mil.join("-h"),
        "c2.jsonl",
        &[
            title_line("子2"),
            child2_h.to_string(),
            msg("u1", None, user_msg("hi")),
        ],
    );
    // fork：parent 不存在
    let mut child3_h =
        serde_json::from_str::<Value>(&header("child-3", proj.to_str().unwrap())).unwrap();
    child3_h["parentSession"] = json!("ghost-9");
    write_lines(
        &mil.join("-h"),
        "c3.jsonl",
        &[
            title_line("子3"),
            child3_h.to_string(),
            msg("u1", None, user_msg("hi")),
        ],
    );

    let listed = sessions::list::list_sessions(&Config {
        sessions_dir: mil.clone(),
        owners_dir: _t.path().join("owners"),
    })
    .unwrap();
    assert_eq!(listed.hidden_empty, 1);
    let by_id: std::collections::HashMap<&str, _> = listed.groups[0]
        .sessions
        .iter()
        .map(|s| (s.id.as_str(), s))
        .collect();
    assert!(!by_id.contains_key("empty-1"));
    assert_eq!(by_id["user-1"].title.chars().count(), 60);
    assert_eq!(by_id["t-1"].title, "新标题");
    let f1 = by_id["child-1"].fork.as_ref().unwrap();
    assert_eq!(f1.parent_raw, "parent-1");
    assert_eq!(f1.parent_title.as_deref(), Some("父会话"));
    assert!(f1.parent_path.as_ref().unwrap().ends_with("p.jsonl"));
    let f2 = by_id["child-2"].fork.as_ref().unwrap();
    assert_eq!(f2.parent_title.as_deref(), Some("父会话"));
    let f3 = by_id["child-3"].fork.as_ref().unwrap();
    assert_eq!(f3.parent_title, None);
    assert_eq!(f3.parent_path, None);
}

#[test]
fn truncation_on_char_boundary() {
    let (_t, proj, _) = fixture_root();
    let dir = _t.path().join("sessions").join("-tr");
    // 8000 字节边界恰落在一个 3 字节中文字符中间
    let big = "a".repeat(7999) + "中文尾巴";
    let lines = vec![
        title_line("截断"),
        header("tr-1", proj.to_str().unwrap()),
        msg("u1", None, user_msg("q")),
        msg(
            "a1",
            Some("u1"),
            assistant_msg(json!([{"type":"text","text":"r"}])),
        ),
        msg(
            "t1",
            Some("a1"),
            json!({"role":"toolResult","toolCallId":"c","toolName":"bash","content":[{"type":"text","text":big}],"timestamp":1}),
        ),
    ];
    let p = write_lines(&dir, "tr.jsonl", &lines);
    let conv = sessions::conversation::get_conversation(&p, None).unwrap();
    if let omp_resume_lib::model::ConversationItem::ToolResult(t) = conv.items.last().unwrap() {
        assert!(t.truncated);
        assert!(t.text.ends_with("…[已截断]"));
        assert!(t.text.len() <= 8000 + "…[已截断]".len());
        // 去掉后缀后仍是合法 UTF-8（is_char_boundary 保证）
        let body = t.text.strip_suffix("…[已截断]").unwrap();
        assert!(body.is_char_boundary(body.len()));
        assert!(body.len() <= 8000);
    } else {
        panic!("应为 toolResult");
    }
}

#[test]
fn header_and_marker_interfaces() {
    let (_t, proj, _) = fixture_root();
    let dir = _t.path().join("sessions").join("-m");
    let p = write_lines(&dir, "m.jsonl", &kitchen_sink(proj.to_str().unwrap()));
    let h = sessions::header_info(&p).unwrap();
    assert_eq!(h.id, "sess-01");
    assert_eq!(h.cwd.as_deref(), Some(proj.to_str().unwrap()));
    assert_eq!(h.version, Some(3));
    assert_eq!(h.parent_session, None);

    let m = sessions::marker_context(&p).unwrap();
    assert_eq!(m.session_id, "sess-01");
    assert_eq!(m.leaf_id.as_deref(), Some("u3"));
    for id in ["u1", "a1", "t1", "bs1", "u3", "cp1"] {
        assert!(m.kept_ids.contains(id), "kept 缺 {id}");
    }
    assert!(!m.kept_ids.contains("c1")); // custom 非 kept
    for id in ["c1", "x1", "l1", "cm1"] {
        assert!(m.all_ids.contains(id), "all 缺 {id}");
    }
    assert!(m.all_ids.contains("u3"));

    // marker 常量与换行检测（ops worker 用）
    assert_eq!(
        omp_resume_lib::ops::marker::MARKER_CUSTOM_TYPE,
        "omp-resume-branch"
    );
    let parsed = sessions::parse::parse_file(&p).unwrap();
    assert!(parsed.ends_with_newline);
    let p2 = dir.join("noeol.jsonl");
    std::fs::write(&p2, title_line("x") + "\n" + &header("n-1", "/tmp")).unwrap();
    let parsed2 = sessions::parse::parse_file(&p2).unwrap();
    assert!(!parsed2.ends_with_newline);
}

#[test]
fn check_session_free_and_missing() {
    let (_t, proj, _) = fixture_root();
    let c = Config {
        sessions_dir: _t.path().join("sessions"),
        owners_dir: _t.path().join("owners"),
    };
    let dir = _t.path().join("sessions").join("-k");
    let p = write_lines(
        &dir,
        "k.jsonl",
        &[title_line("k"), header("sess-k", proj.to_str().unwrap())],
    );
    let r = sessions::check_session(&p, &c).unwrap();
    assert!(!r.in_use && r.probe_ok);
    // 校验层：相对路径拒绝
    let e = config::validate_session_path(&c, "sessions/-k/k.jsonl").unwrap_err();
    assert_eq!(e.code, ErrorCode::OutsideRoot);
    // 校验层：合法路径通过
    let ok = config::validate_session_path(&c, p.to_str().unwrap()).unwrap();
    assert_eq!(ok, std::fs::canonicalize(&p).unwrap());
    // 校验层：不存在 → NOT_FOUND
    let e =
        config::validate_session_path(&c, _t.path().join("sessions/-k/no.jsonl").to_str().unwrap())
            .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[test]
fn list_sorts_and_cwd_flags() {
    let _t = tempfile::tempdir().unwrap();
    let mil = _t.path().join("sessions");
    let proj = _t.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let mk = |dir: &str, name: &str, id: &str, cwd: &str, secs: u64| {
        let p = write_lines(
            &mil.join(dir),
            name,
            &[
                title_line(id),
                header(id, cwd),
                msg("u1", None, user_msg("hi")),
            ],
        );
        set_mtime(&p, secs);
        p
    };
    mk("-aaa", "old.jsonl", "s-old", proj.to_str().unwrap(), 1_000);
    mk("-aaa", "new.jsonl", "s-new", "/nonexistent-cwd-xyz", 2_000);
    mk("-bbb", "mid.jsonl", "s-mid", proj.to_str().unwrap(), 1_500);
    // 非目录顶层文件 + 点目录忽略
    std::fs::write(mil.join("top.jsonl"), "x").unwrap();
    std::fs::create_dir_all(mil.join(".hidden")).unwrap();
    write_lines(
        &mil.join(".hidden"),
        "h.jsonl",
        &[title_line("h"), header("h", "/x")],
    );

    let listed = sessions::list::list_sessions(&Config {
        sessions_dir: mil,
        owners_dir: _t.path().join("owners"),
    })
    .unwrap();
    assert_eq!(listed.hidden_empty, 0);
    assert_eq!(listed.groups.len(), 2);
    assert_eq!(listed.groups[0].dir_name, "-aaa"); // 最新会话 2000
    assert_eq!(listed.groups[1].dir_name, "-bbb");
    assert_eq!(listed.groups[0].sessions[0].id, "s-new");
    assert_eq!(listed.groups[0].sessions[1].id, "s-old");
    assert!(!listed.groups[0].sessions[0].cwd_exists);
    assert!(listed.groups[0].sessions[1].cwd_exists);
    // 组 cwd 取最新会话
    assert_eq!(listed.groups[0].cwd, "/nonexistent-cwd-xyz");
}

#[test]
fn entry_kinds_from_appendix_shapes() {
    // CONTRACT 附录 A 真实形状回归：bashExecution 无 content、developer 有 attribution。
    let (_t, proj, _) = fixture_root();
    let dir = _t.path().join("sessions").join("-ax");
    let lines = vec![
        title_line("形状"),
        header("ax-1", proj.to_str().unwrap()),
        msg(
            "u1",
            None,
            json!({"role":"user","content":[{"type":"text","text":"hi"}],"attribution":"user","timestamp":TS_U}),
        ),
        msg(
            "b1",
            Some("u1"),
            json!({"role":"bashExecution","command":"railway login","output":"ok","exitCode":null,"cancelled":false}),
        ),
        msg(
            "d1",
            Some("b1"),
            json!({"role":"developer","content":[{"type":"text","text":"<reminder/>"}],"attribution":"agent","timestamp":TS_A}),
        ),
        msg(
            "e1",
            Some("d1"),
            json!({"role":"toolResult","toolCallId":"x","toolName":"eval","content":[{"type":"text","text":"shot"},{"type":"image","data":"blob:sha256:abc","mimeType":"image/png","detail":"original"}],"isError":true}),
        ),
    ];
    let p = write_lines(&dir, "ax.jsonl", &lines);
    let conv = sessions::conversation::get_conversation(&p, None).unwrap();
    assert_eq!(conv.items.len(), 4);
    if let omp_resume_lib::model::ConversationItem::BashExecution(b) = &conv.items[1] {
        assert_eq!(b.exit_code, None);
    } else {
        panic!("bash");
    }
    if let omp_resume_lib::model::ConversationItem::Other(o) = &conv.items[2] {
        assert_eq!(o.role, "developer");
    } else {
        panic!("other");
    }
    if let omp_resume_lib::model::ConversationItem::ToolResult(t) = &conv.items[3] {
        assert!(t.is_error);
        assert_eq!(t.text, "shot\n[图片]");
    } else {
        panic!("toolResult");
    }
}

/// 真实数据只读验证（`cargo test -- --ignored` 手动跑）：list + tree +
/// conversation 全量过一遍，打印统计与耗时。永不写 `~/.omp`。
#[test]
#[ignore]
fn real_data_validation() {
    use std::time::Instant;
    let home = std::env::var("HOME").unwrap();
    let root = PathBuf::from(format!("{home}/.omp/agent/sessions"));
    if !root.is_dir() {
        println!("无真实 sessions 目录，跳过");
        return;
    }
    let c = Config {
        sessions_dir: root,
        owners_dir: PathBuf::from(format!("{home}/.omp/run/session-owners")),
    };
    let t0 = Instant::now();
    let listed = sessions::list::list_sessions(&c).unwrap();
    let list_ms = t0.elapsed().as_millis();
    let n: usize = listed.groups.iter().map(|g| g.sessions.len()).sum();
    let mut bad = 0u64;
    let mut branches: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    let mut forks = 0;
    let mut in_use = 0;
    let mut paths = Vec::new();
    for g in &listed.groups {
        for s in &g.sessions {
            bad += s.bad_lines;
            *branches.entry(s.branch_count).or_insert(0) += 1;
            if s.fork.is_some() {
                forks += 1;
            }
            if s.in_use {
                in_use += 1;
                match &s.occupant {
                    Some(o) => println!(
                        "inUse: {} pid={} app={} version={}",
                        s.id,
                        o.pid,
                        o.app.as_deref().unwrap_or("-"),
                        o.app_version.as_deref().unwrap_or("-"),
                    ),
                    None => println!("inUse: {} occupant=None", s.id),
                }
            }
            paths.push(s.path.clone());
        }
    }
    println!(
        "sessions={n} hiddenEmpty={} list_ms={list_ms} badLines={bad} forks={forks} inUse={in_use}",
        listed.hidden_empty
    );
    println!("branchCount 分布: {branches:?}");
    let t1 = Instant::now();
    let mut conv_items = 0usize;
    let mut nodes = 0usize;
    for p in &paths {
        let t = sessions::tree::get_tree(Path::new(p)).unwrap();
        nodes += t.nodes.len();
        let cv = sessions::conversation::get_conversation(Path::new(p), None).unwrap();
        conv_items += cv.items.len();
    }
    println!(
        "tree+conversation_ms={} nodes={nodes} items={conv_items}",
        t1.elapsed().as_millis()
    );
    assert!(list_ms < 10_000, "list 太慢：{list_ms}ms");
}
