//! 会话 jsonl 尾部增量读取（T2）：只读，不写会话文件。
//!
//! 每个 `inUse` 顶层会话维护一个 [`TailState`]：首次见到时**全文件单遍**解析
//! （标题行 + session header + 工具配对 + 子代理 lifecycle，一次性的成本），
//! 后续每轮 seek 到已消费偏移只读新增字节。文件被截断/替换（长度回退）时
//! 丢弃旧状态重建。
//!
//! 只提取判定需要的最小字段：
//! - 有意义记录（`message` user/assistant/toolResult/bashExecution、
//!   `tool_execution_start/end`）的时间与种类；
//! - assistant `toolCall` id 与 `toolResult.toolCallId` 的配对（未配对数）；
//! - `vibe-session-lifecycle` 的子代理运行态；
//! - `title_change`（只更新标题缓存，不算进展）。
//!   `model_usage`（cache-warm 心跳）、`custom_message`、`todo_hud_state` 等
//!   一律忽略——**绝不能用它们或文件 mtime 判断活跃**。

use std::collections::HashMap;
use std::path::Path;

use super::classify::{LastKind, LastMeaningful};

/// 首次建状态时前读的头部窗口（标题行 + header 在前几行，32KB 富余）。
pub const HEAD_WINDOW_BYTES: u64 = 32 * 1024;
/// 单行上限：超出则整行跳过（计数），防止病态大行拖慢轮询。
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// 未配对工具调用的最长保留（秒）：结果永远不来的孤儿 id 不能永久污染判定。
pub const PENDING_EXPIRE_SECS: i64 = 24 * 3600;
/// 保留的 `title_change` 历史条数（只需“最后一个非空”，留余量）。
const TITLE_HISTORY: usize = 16;

/// 子代理运行态（按 `data.id` 分组，取最后动作）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubState {
    Running,
    Settled,
}

/// 单个会话的尾部增量状态。
#[derive(Debug, Default)]
pub struct TailState {
    /// 已消费偏移（下一轮从此处读起）。
    offset: u64,
    /// 是否已做过头部 + 尾部种子读取。
    seeded: bool,
    /// 未配对的 assistant toolCall id → 首次见到时间（epoch 秒）。
    pending_tools: HashMap<String, i64>,
    /// 子代理 id → 运行态。
    subagents: HashMap<String, SubState>,
    /// 最后一条有意义记录。
    last: Option<LastMeaningful>,
    /// 标题候选：首行 title 记录。
    title_row: Option<String>,
    /// 标题候选：header.title。
    header_title: Option<String>,
    /// 标题候选：按文件顺序的 title_change（只保留末尾若干）。
    title_changes: Vec<String>,
    /// header.id（校验用）、header.cwd、header.timestamp（epoch 秒）。
    header_id: Option<String>,
    header_cwd: Option<String>,
    header_created: Option<i64>,
    /// 跳过的超大行数（可观测，不报错）。
    pub skipped_huge_lines: u64,
    /// 跳过的坏行数（非 JSON 等，可观测）。
    pub skipped_bad_lines: u64,
}

impl TailState {
    pub fn last(&self) -> Option<LastMeaningful> {
        self.last
    }

    pub fn unpaired_tool_calls(&self) -> u32 {
        self.pending_tools.len().min(u32::MAX as usize) as u32
    }

    pub fn running_subagents(&self) -> u32 {
        self.subagents
            .values()
            .filter(|s| **s == SubState::Running)
            .count()
            .min(u32::MAX as usize) as u32
    }

    pub fn header_id(&self) -> Option<&str> {
        self.header_id.as_deref()
    }

    pub fn header_cwd(&self) -> Option<&str> {
        self.header_cwd.as_deref()
    }

    pub fn header_created(&self) -> Option<i64> {
        self.header_created
    }

    /// 标题：最后一个非空（title 行 → header → title_change 顺序）。
    /// 与列表 §4.2.1 的差异：无首用户消息回退（那需要全文件扫描），
    /// 全空时返回 `(无标题)`。
    pub fn title(&self) -> String {
        let mut best = "";
        for cand in self
            .title_row
            .as_deref()
            .into_iter()
            .chain(self.header_title.as_deref())
            .chain(self.title_changes.iter().map(|s| s.as_str()))
        {
            if !cand.trim().is_empty() {
                best = cand;
            }
        }
        if best.is_empty() {
            "(无标题)".to_string()
        } else {
            best.to_string()
        }
    }
}

/// 读一轮：推进 `state` 到文件末尾（只读）。`now` 为当前 epoch 秒。
///
/// - 首次（或截断重建）：全量单遍解析（见下）；
/// - 之后：seek 到已消费偏移，只读新增字节；
/// - 文件消失/不可读 → 返回 `Err`（调用方保留旧状态、跳过本轮该会话）；
/// - 长度回退（截断/替换）→ 重置状态后按首次处理；
/// - 末行不完整（文件不以 `\n` 结尾）→ 末行留到下轮。
pub fn poll_file(path: &Path, state: &mut TailState, now: i64) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    if !state.seeded || len < state.offset {
        // 首次 / 截断重建：读全量。
        *state = TailState::default();
        let mut bytes = Vec::with_capacity(len as usize);
        f.read_to_end(&mut bytes)?;
        poll_bytes(&bytes, state, now);
        return Ok(());
    }
    if len == state.offset {
        expire_pending(state, now);
        return Ok(());
    }
    f.seek(SeekFrom::Start(state.offset))?;
    let mut chunk = Vec::with_capacity((len - state.offset) as usize);
    f.read_to_end(&mut chunk)?;
    consume(&chunk, len, state, now);
    Ok(())
}

/// [`poll_file`] 的全量分支（字节已读入，便于单测）。
fn poll_bytes(bytes: &[u8], state: &mut TailState, now: i64) {
    let len = bytes.len() as u64;
    seed_head(bytes, state);
    // 种子：从文件头单遍解析全部行。真实数据（2026-10-16 实测）表明
    // cache-warm 心跳与大 toolResult 会把 `vibe-session-lifecycle` 配对行
    // 挤出固定尾窗，导致子代理漏检、误判「疑似卡住」；因此种子必须看全文件
    // （仅首次见到该会话时一次），之后仍是增量读取。
    consume(bytes, len, state, now);
    state.seeded = true;
}

/// 处理一段新增字节：按行解析；末行若不完整则回退偏移留待下轮。
fn consume(chunk: &[u8], abs_end: u64, state: &mut TailState, now: i64) {
    let ends_complete = chunk.is_empty() || chunk.ends_with(b"\n");
    let mut start = 0usize;
    for (i, b) in chunk.iter().enumerate() {
        if *b == b'\n' {
            let line = &chunk[start..i];
            // 去 `\r`（omp 不写 `\r`，防御性处理）。
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            process_line_bytes(line, state, now);
            start = i + 1;
        }
    }
    if ends_complete {
        state.offset = abs_end;
    } else {
        // 末行不完整：偏移停在该行行首。
        state.offset = abs_end - (chunk.len() - start) as u64;
    }
    expire_pending(state, now);
}

fn expire_pending(state: &mut TailState, now: i64) {
    state
        .pending_tools
        .retain(|_, seen| now.saturating_sub(*seen) < PENDING_EXPIRE_SECS);
}

/// 解析文件头窗口：首个 `title` 行与 `session` header。
fn seed_head(bytes: &[u8], state: &mut TailState) {
    let head_len = (bytes.len() as u64).min(HEAD_WINDOW_BYTES) as usize;
    for line in bytes[..head_len].split(|b| *b == b'\n').take(16) {
        if line.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("title") => {
                if state.title_row.is_none() {
                    state.title_row = v
                        .get("title")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string());
                }
            }
            Some("session") if state.header_id.is_none() => {
                state.header_id = v.get("id").and_then(|x| x.as_str()).map(str::to_string);
                state.header_cwd = v.get("cwd").and_then(|x| x.as_str()).map(str::to_string);
                state.header_title = v.get("title").and_then(|x| x.as_str()).map(str::to_string);
                state.header_created = v
                    .get("timestamp")
                    .and_then(|x| x.as_str())
                    .and_then(parse_time);
            }
            _ => {}
        }
        if state.title_row.is_some() && state.header_id.is_some() {
            break;
        }
    }
}

fn process_line_bytes(line: &[u8], state: &mut TailState, now: i64) {
    if line.len() > MAX_LINE_BYTES {
        state.skipped_huge_lines += 1;
        return;
    }
    let Ok(text) = std::str::from_utf8(line) else {
        state.skipped_bad_lines += 1;
        return;
    };
    if text.trim().is_empty() {
        return;
    }
    process_line(text, state, now);
}

/// 解析一行并更新状态（纯函数，可直接单测）。
pub fn process_line(text: &str, state: &mut TailState, now: i64) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        state.skipped_bad_lines += 1;
        return;
    };
    let at = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_time)
        .unwrap_or(now);
    match v.get("type").and_then(|t| t.as_str()) {
        Some("message") => process_message(&v, state, at),
        Some("custom") => process_custom(&v, state, at),
        Some("title_change") => {
            if let Some(title) = v.get("title").and_then(|t| t.as_str()) {
                state.title_changes.push(title.to_string());
                if state.title_changes.len() > TITLE_HISTORY {
                    let overflow = state.title_changes.len() - TITLE_HISTORY;
                    state.title_changes.drain(..overflow);
                }
            }
        }
        // title/session 行只在头部种子里处理；其余类型（model_usage、
        // model_change、custom_message、todo_hud_state 等）一律忽略。
        _ => {}
    }
}

fn process_message(v: &serde_json::Value, state: &mut TailState, at: i64) {
    let Some(msg) = v.get("message") else {
        return;
    };
    match msg.get("role").and_then(|r| r.as_str()) {
        Some("user") => {
            state.last = Some(LastMeaningful {
                kind: LastKind::User,
                at,
            });
        }
        Some("assistant") => {
            if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                        if let Some(id) = block.get("id").and_then(|x| x.as_str()) {
                            state.pending_tools.entry(id.to_string()).or_insert(at);
                        }
                    }
                }
            }
            // stopReason 缺失视为回合已结束（见 classify 注释）：
            // 陈旧会话不能因此被永久判为工作中。
            let stopped = msg.get("stopReason").is_none_or(|s| s == "stop");
            state.last = Some(LastMeaningful {
                kind: LastKind::Assistant { stopped },
                at,
            });
        }
        Some("toolResult") => {
            if let Some(id) = msg.get("toolCallId").and_then(|x| x.as_str()) {
                state.pending_tools.remove(id);
            }
            state.last = Some(LastMeaningful {
                kind: LastKind::ToolResult,
                at,
            });
        }
        Some("bashExecution") => {
            state.last = Some(LastMeaningful {
                kind: LastKind::BashExecution,
                at,
            });
        }
        // developer / hookMessage / 其他 role：不是有意义记录。
        _ => {}
    }
}

fn process_custom(v: &serde_json::Value, state: &mut TailState, at: i64) {
    match v.get("customType").and_then(|t| t.as_str()) {
        Some("tool_execution_start") | Some("tool_execution_end") => {
            state.last = Some(LastMeaningful {
                kind: LastKind::ToolEvent,
                at,
            });
        }
        Some("vibe-session-lifecycle") => {
            let data = v.get("data");
            let id = data.and_then(|d| d.get("id")).and_then(|x| x.as_str());
            let action = data.and_then(|d| d.get("action")).and_then(|x| x.as_str());
            let (Some(id), Some(action)) = (id, action) else {
                return;
            };
            match action {
                // spawn 后 turn-started 前同样视为运行中。
                "spawn" | "turn-started" => {
                    state.subagents.insert(id.to_string(), SubState::Running);
                }
                "turn-settled" => {
                    state.subagents.insert(id.to_string(), SubState::Settled);
                }
                "tombstone" => {
                    state.subagents.remove(id);
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn parse_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp())
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const NOW: i64 = 1_790_000_000;

    fn state() -> TailState {
        TailState::default()
    }

    fn msg(role: &str, extra: &str, ts: &str) -> String {
        format!(
            r#"{{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"{ts}","message":{{"role":"{role}"{extra}}}}}"#
        )
    }

    fn assistant(calls: &[&str], stop: &str, ts: &str) -> String {
        let blocks: Vec<String> = calls
            .iter()
            .map(|id| {
                format!(r#"{{"type":"toolCall","id":"{id}","name":"read","arguments":{{}}}}"#)
            })
            .collect();
        msg(
            "assistant",
            &format!(
                r#","content":[{blocks}],"stopReason":"{stop}""#,
                blocks = blocks.join(",")
            ),
            ts,
        )
    }

    fn tool_result(id: &str, ts: &str) -> String {
        msg(
            "toolResult",
            &format!(
                r#","toolCallId":"{id}","toolName":"read","content":[{{"type":"text","text":"ok"}}]"#
            ),
            ts,
        )
    }

    fn custom(ct: &str, data: &str, ts: &str) -> String {
        format!(
            r#"{{"type":"custom","customType":"{ct}","data":{data},"id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"{ts}"}}"#
        )
    }

    #[test]
    fn tool_call_pairing() {
        let mut s = state();
        process_line(
            &assistant(&["t1", "t2"], "toolUse", "2026-10-16T12:00:00.000Z"),
            &mut s,
            NOW,
        );
        assert_eq!(s.unpaired_tool_calls(), 2);
        process_line(&tool_result("t1", "2026-10-16T12:00:01.000Z"), &mut s, NOW);
        assert_eq!(s.unpaired_tool_calls(), 1);
        // 未知的 toolCallId 不影响计数。
        process_line(
            &tool_result("nope", "2026-10-16T12:00:02.000Z"),
            &mut s,
            NOW,
        );
        assert_eq!(s.unpaired_tool_calls(), 1);
        process_line(&tool_result("t2", "2026-10-16T12:00:03.000Z"), &mut s, NOW);
        assert_eq!(s.unpaired_tool_calls(), 0);
    }

    #[test]
    fn heartbeat_and_noise_ignored() {
        let mut s = state();
        process_line(
            &assistant(&[], "stop", "2026-10-16T12:00:00.000Z"),
            &mut s,
            NOW,
        );
        let before = s.last;
        // cache-warm 心跳、todo_hud_state、custom_message、title_change 都不算进展。
        for line in [
            r#"{"type":"model_usage","id":"x","parentId":"y","timestamp":"2026-10-16T12:36:35.104Z","purpose":"cache-warm","role":"memory"}"#,
            &custom("todo_hud_state", "{}", "2026-10-16T12:37:00.000Z"),
            r#"{"type":"custom_message","customType":"skill-prompt","content":"hi","id":"x","parentId":"y","timestamp":"2026-10-16T12:38:00.000Z"}"#,
            r#"{"type":"model_change","id":"x","parentId":"y","timestamp":"2026-10-16T12:39:00.000Z"}"#,
            r#"{"type":"credential_pin","id":"x","parentId":"y","timestamp":"2026-10-16T12:40:00.000Z"}"#,
        ] {
            process_line(line, &mut s, NOW);
        }
        assert_eq!(s.last, before);
        // title_change 只更新标题，不算进展。
        process_line(
            r#"{"type":"title_change","id":"x","parentId":"y","timestamp":"2026-10-16T12:41:00.000Z","title":"新标题"}"#,
            &mut s,
            NOW,
        );
        assert_eq!(s.last, before);
        assert_eq!(s.title(), "新标题");
    }

    #[test]
    fn lifecycle_pairing_and_tombstone() {
        let mut s = state();
        let lc = |id: &str, action: &str| {
            custom(
                "vibe-session-lifecycle",
                &format!(r#"{{"id":"{id}","action":"{action}","parentSessionId":"p"}}"#),
                "2026-10-16T12:00:00.000Z",
            )
        };
        process_line(&lc("a", "spawn"), &mut s, NOW);
        assert_eq!(s.running_subagents(), 1);
        process_line(&lc("a", "turn-started"), &mut s, NOW);
        assert_eq!(s.running_subagents(), 1);
        process_line(&lc("b", "spawn"), &mut s, NOW);
        assert_eq!(s.running_subagents(), 2);
        // settled 后不再运行；tombstone 移除。
        process_line(&lc("a", "turn-settled"), &mut s, NOW);
        assert_eq!(s.running_subagents(), 1);
        process_line(&lc("b", "tombstone"), &mut s, NOW);
        assert_eq!(s.running_subagents(), 0);
        // 多回合：settled 后再次 turn-started 重新算运行。
        process_line(&lc("a", "turn-started"), &mut s, NOW);
        assert_eq!(s.running_subagents(), 1);
    }

    #[test]
    fn title_resolution_order() {
        let mut s = state();
        assert_eq!(s.title(), "(无标题)");
        s.title_row = Some("行标题".into());
        assert_eq!(s.title(), "行标题");
        s.header_title = Some("头标题".into());
        assert_eq!(s.title(), "头标题");
        // 空串不覆盖。
        s.title_changes.push("".into());
        assert_eq!(s.title(), "头标题");
        s.title_changes.push("改后标题".into());
        assert_eq!(s.title(), "改后标题");
    }

    #[test]
    fn incremental_and_incomplete_last_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let head = concat!(
            "{\"type\":\"title\",\"v\":1,\"title\":\"行标题\",\"source\":\"auto\",\"updatedAt\":\"2026-10-16T12:00:00.000Z\"}\n",
            "{\"type\":\"session\",\"version\":3,\"id\":\"sid\",\"timestamp\":\"2026-10-16T11:59:00.000Z\",\"cwd\":\"/tmp/x\"}\n",
        );
        std::fs::write(&path, head).unwrap();
        let mut s = state();
        poll_file(&path, &mut s, NOW).unwrap();
        assert_eq!(s.title(), "行标题");
        assert_eq!(s.header_id(), Some("sid"));
        assert_eq!(s.header_cwd(), Some("/tmp/x"));
        assert!(s.header_created().is_some());
        assert_eq!(s.last, None);

        // 追加一行完整 + 一行不完整：不完整行留到下轮。
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let line1 = msg(
            "user",
            r#","content":[{"type":"text","text":"hi"}]"#,
            "2026-10-16T12:01:00.000Z",
        );
        write!(f, "{line1}\n{{\"type\":\"message\",\"id\":\"half").unwrap();
        drop(f);
        poll_file(&path, &mut s, NOW).unwrap();
        assert!(matches!(s.last.map(|l| l.kind), Some(LastKind::User)));
        let off_after_partial = s.offset;

        // 补全半行：下轮读到。
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let rest = concat!(
            r#"","parentId":null,"timestamp":"2026-10-16T12:02:00.000Z","#,
            r#""message":{"role":"user","content":[{"type":"text","text":"yo"}]}}"#,
        );
        write!(f, "{rest}").unwrap();
        writeln!(f).unwrap();
        drop(f);
        poll_file(&path, &mut s, NOW).unwrap();
        assert!(s.offset > off_after_partial);
        assert!(matches!(s.last.map(|l| l.kind), Some(LastKind::User)));
    }

    #[test]
    fn truncation_resets_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let line = assistant(&["t9"], "toolUse", "2026-10-16T12:00:00.000Z");
        std::fs::write(&path, format!("{line}\n")).unwrap();
        let mut s = state();
        poll_file(&path, &mut s, NOW).unwrap();
        assert_eq!(s.unpaired_tool_calls(), 1);
        // 文件被截断/替换（变短）：旧状态丢弃。
        std::fs::write(&path, "{}\n").unwrap();
        poll_file(&path, &mut s, NOW).unwrap();
        assert_eq!(s.unpaired_tool_calls(), 0);
        assert_eq!(s.last, None);
    }

    #[test]
    fn huge_line_skipped() {
        let mut s = state();
        let big = "x".repeat(MAX_LINE_BYTES + 1);
        process_line_bytes(big.as_bytes(), &mut s, NOW);
        assert_eq!(s.skipped_huge_lines, 1);
        assert_eq!(s.last, None);
        // 后续正常行不受影响。
        process_line(
            &msg(
                "user",
                r#","content":[{"type":"text","text":"hi"}]"#,
                "2026-10-16T12:00:00.000Z",
            ),
            &mut s,
            NOW,
        );
        assert!(matches!(s.last.map(|l| l.kind), Some(LastKind::User)));
    }

    #[test]
    fn empty_file_ok() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, "").unwrap();
        let mut s = state();
        poll_file(&path, &mut s, NOW).unwrap();
        assert_eq!(s.last, None);
        assert_eq!(s.title(), "(无标题)");
    }

    #[test]
    fn missing_timestamp_falls_back_to_now() {
        let mut s = state();
        process_line(
            r#"{"type":"message","id":"x","parentId":null,"message":{"role":"user","content":[]}}"#,
            &mut s,
            NOW,
        );
        assert_eq!(s.last.map(|l| l.at), Some(NOW));
    }

    #[test]
    fn pending_expires_after_a_day() {
        let mut s = state();
        // 条目时间（2020）距 now（NOW）远超 24 小时 → 过期清除。
        process_line(
            &assistant(&["old"], "toolUse", "2020-01-01T00:00:00.000Z"),
            &mut s,
            NOW,
        );
        assert_eq!(s.unpaired_tool_calls(), 1);
        expire_pending(&mut s, NOW);
        assert_eq!(s.unpaired_tool_calls(), 0);
    }

    #[test]
    fn assistant_missing_stop_reason_counts_stopped() {
        let mut s = state();
        process_line(
            &msg("assistant", r#","content":[]"#, "2026-10-16T12:00:00.000Z"),
            &mut s,
            NOW,
        );
        assert!(matches!(
            s.last.map(|l| l.kind),
            Some(LastKind::Assistant { stopped: true })
        ));
    }
}
