//! 单个 jsonl 的舞台状态提取（增量、只读、最小字段）。
//!
//! 与 `menubar/tail.rs` 的分工：那边只判定「会话是否活跃」，这里要拼出
//! 每个角色的活动流、工具配对、spawn 关系与花费。两者共享同一份读取语义
//! （[`super::cursor`]），但状态结构独立，互不影响。
//!
//! 忽略与 CONTRACT §17.1 一致：`model_usage`（cache-warm 心跳）、`custom_message`、
//! `todo_hud_state` 等一律不看，**绝不用 mtime 或心跳判活**。

use std::collections::{HashMap, VecDeque};

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;

use crate::model::{StageActivity, StageActivityKind};
use crate::usage::redact;

/// 活动流保留条数（旧→新）。
pub const RECENT_CAP: usize = 30;
/// 活动/块文本截断长度。
const TEXT_CHARS: usize = 80;
/// 派发说明（父会话 toolCall intent）截断长度。
const BRIEF_CHARS: usize = 60;
/// 标题行历史保留条数（只需最后一个非空）。
const TITLE_HISTORY: usize = 16;
/// `args` 里取「可当描述用」的字符串字段顺序。
const ARG_KEYS: &[&str] = &[
    "path",
    "file_path",
    "file",
    "command",
    "pattern",
    "query",
    "url",
    "name",
];

/// 未配对的工具调用（`tool_execution_start` 已到、`toolResult` 未到）。
#[derive(Debug, Clone)]
pub struct Pending {
    pub tool: String,
    pub text: String,
    pub at_ms: i64,
}

/// 父会话派发该子代理时记录的信息（`task.tasks[]` / `vibe_spawn`）。
#[derive(Debug, Clone, Default)]
pub struct SpawnInfo {
    pub agent: Option<String>,
    pub brief: Option<String>,
}

/// `vibe-session-lifecycle` 的当前动作（按 `data.id` 取最后一次）。
///
/// `tombstone` 不删除条目：worker 的 `childSessionFile` 是**种类归属**的唯一依据，
/// 删掉就再也分不清「task 子代理」和「vibe_spawn 工作者」。墓碑只表示「已退役」。
#[derive(Debug, Clone)]
pub struct Life {
    pub action: String,
    pub agent: Option<String>,
    pub child_file: Option<String>,
    pub last_at_ms: i64,
    /// 见过 `tombstone`（已退役，不再补「排队中」角色）。
    pub tombstoned: bool,
}

/// `session_exit`（按最后一次覆盖）。
#[derive(Debug, Clone)]
pub struct ExitInfo {
    pub at_ms: i64,
    pub kind: String,
    pub reason: String,
}

/// 最后一条 assistant 的收尾信息。
#[derive(Debug, Clone)]
pub struct LastAssistant {
    pub at_ms: i64,
    /// `stopReason`；缺失时按 `"stop"`（与 `menubar/tail.rs` 同口径）。
    pub stop_reason: String,
}

/// 活动流条目：毫秒时间（排序用）+ 契约形状。
#[derive(Debug, Clone)]
pub struct RecentItem {
    #[allow(dead_code)] // 保留毫秒时间，供后续按时间窗筛选。
    pub at_ms: i64,
    pub activity: StageActivity,
}

/// 单个 jsonl 的累积状态。
#[derive(Debug, Clone, Default)]
pub struct ActorTail {
    pub header_id: Option<String>,
    pub header_version: Option<u32>,
    pub header_ts_ms: Option<i64>,
    pub header_cwd: Option<String>,
    title_row: Option<String>,
    title_changes: VecDeque<String>,
    /// `"provider/model"`（最后一条 assistant，其次 model_change）。
    pub model: Option<String>,
    pub context_tokens: u64,
    pub cost: f64,
    pub tool_calls: u64,
    pub pending: HashMap<String, Pending>,
    pub last_at_ms: Option<i64>,
    pub last_assistant: Option<LastAssistant>,
    pub exit: Option<ExitInfo>,
    pub recent: VecDeque<RecentItem>,
    pub lifecycle: HashMap<String, Life>,
    pub spawn_info: HashMap<String, SpawnInfo>,
}

impl ActorTail {
    /// 标题：title 行 → `title_change` 最后一个非空。全空返回空串。
    pub fn title(&self) -> String {
        let mut best = self.title_row.as_deref().unwrap_or("");
        for cand in &self.title_changes {
            if !cand.trim().is_empty() {
                best = cand;
            }
        }
        best.to_string()
    }

    /// 最久未配对的工具调用（`at` 最新者优先用于「当前活动」）。
    pub fn current_pending(&self) -> Option<&Pending> {
        self.pending.values().max_by_key(|p| p.at_ms)
    }

    fn push_recent(
        &mut self,
        at_ms: i64,
        kind: StageActivityKind,
        tool: Option<String>,
        text: String,
    ) {
        self.recent.push_back(RecentItem {
            at_ms,
            activity: StageActivity {
                at: iso_ms(at_ms),
                kind,
                tool,
                text,
            },
        });
        while self.recent.len() > RECENT_CAP {
            self.recent.pop_front();
        }
    }
}

/// 该行是否表示「会话又活了」：出现更晚的这类行即作废前一次 `session_exit`。
///
/// `title` / `title_change` / `model_usage`（cache-warm 心跳）等不算活动，
/// 与 CONTRACT §17.1 的「有意义记录」口径一致。
fn revives(kind: &str, custom_type: Option<&str>, message: Option<&Message>) -> bool {
    match kind {
        "session_init" | "model_change" => true,
        "message" => message.is_some(),
        "custom" => matches!(
            custom_type,
            Some("tool_execution_start") | Some("vibe-session-lifecycle") | Some("session_exit")
        ),
        _ => false,
    }
}

/// 毫秒 → ISO-8601 UTC 毫秒（CONTRACT §0）。
pub fn iso_ms(ms: i64) -> String {
    match Utc.timestamp_millis_opt(ms).single() {
        Some(t) => t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        None => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

/// ISO-8601 → 毫秒。
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// 截断到 `n` 个字符（按字符边界，不省略号）。
fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 派发说明统一加工：脱敏 + 截断到 [`BRIEF_CHARS`]。
fn brief_text(s: &str) -> String {
    take_chars(&redact::sanitize_message(s), BRIEF_CHARS)
}

/// 任务正文里第一行「有内容」的文字。
///
/// 真实数据里 `tasks[].task` 常以 `# Target`、`# 仓库` 这类纯标题词开头，
/// 光看标题没有信息量，所以标题词跳过、取下一行；`# Target: src/a` 这种带正文的保留。
fn first_meaningful_line(s: &str) -> Option<&str> {
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let body = line.trim_start_matches('#').trim();
        if body.is_empty() {
            continue;
        }
        let bare_heading = line.starts_with('#')
            && !body.contains(char::is_whitespace)
            && body.chars().count() <= 16;
        if bare_heading {
            continue;
        }
        return Some(body);
    }
    None
}

/// `usage.totalTokens` 缺失时按四项相加（CONTRACT §12.1）。
fn usage_total(u: &Usage) -> u64 {
    u.total_tokens.unwrap_or_else(|| {
        u.input
            .saturating_add(u.output)
            .saturating_add(u.cache_read)
            .saturating_add(u.cache_write)
    })
}

fn usage_cost(u: &Usage) -> f64 {
    let Some(c) = &u.cost else { return 0.0 };
    let v = c
        .total
        .unwrap_or(c.input + c.output + c.cache_read + c.cache_write);
    if v.is_finite() && v >= 0.0 {
        v
    } else {
        0.0
    }
}

// ---------------------------------------------------------------------------
// 行解析（最小字段反序列化）
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(untagged)]
enum Ts {
    Text(String),
    Millis(i64),
}

impl Ts {
    fn ms(&self) -> Option<i64> {
        match self {
            Self::Text(t) => parse_iso_ms(t),
            Self::Millis(ms) => Some(*ms),
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<Ts>,
    version: Option<u32>,
    id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    custom_type: Option<String>,
    model: Option<String>,
    message: Option<Message>,
    data: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Message {
    role: String,
    content: Option<Vec<Block>>,
    usage: Option<Usage>,
    stop_reason: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    tool_call_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    name: Option<String>,
    id: Option<String>,
    text: Option<String>,
    thinking: Option<String>,
    /// 工具调用的一句话说明（`toolCall` 块级字段，当前 omp 版本与 `arguments.i` 同文）。
    intent: Option<String>,
    arguments: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total_tokens: Option<u64>,
    cost: Option<Cost>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Cost {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    total: Option<f64>,
}

impl ActorTail {
    /// 清空全部累积状态（文件被截断/替换时由游标回调）。
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// 解析一行（字节，已是完整行）。
    pub fn feed_line(&mut self, line: &[u8], now_ms: i64) {
        let Ok(v) = serde_json::from_slice::<Line>(line) else {
            return;
        };
        let at_ms = v.timestamp.as_ref().and_then(Ts::ms).unwrap_or(now_ms);
        if v.kind != "title" {
            self.last_at_ms = Some(at_ms);
        }
        // 会话退出后可能被恢复（`omp --resume`）：真实样本里 `session_exit(normal)` 之后
        // 会再出现 `session_init` 与新的对话/工具行。退出记录只对「最后一次」有效，
        // 出现任何更晚的活动行就作废，否则恢复中的 worker 会被判成已完成。
        if let Some(exit) = &self.exit {
            if at_ms >= exit.at_ms && revives(&v.kind, v.custom_type.as_deref(), v.message.as_ref())
            {
                self.exit = None;
            }
        }
        match v.kind.as_str() {
            "title" => {
                if self.title_row.is_none() {
                    self.title_row = v.title;
                }
            }
            "session" => {
                if self.header_id.is_none() {
                    self.header_id = v.id;
                    self.header_version = v.version;
                    self.header_ts_ms = v.timestamp.as_ref().and_then(Ts::ms);
                    self.header_cwd = v.cwd;
                }
            }
            "title_change" => {
                if let Some(title) = v.title {
                    self.title_changes.push_back(title);
                    while self.title_changes.len() > TITLE_HISTORY {
                        self.title_changes.pop_front();
                    }
                }
            }
            "model_change" => {
                if self.model.is_none() {
                    self.model = v.model;
                }
            }
            "message" => self.feed_message(v.message, at_ms),
            "custom" => self.feed_custom(v.custom_type.as_deref(), v.data, at_ms),
            _ => {}
        }
    }

    fn feed_message(&mut self, msg: Option<Message>, at_ms: i64) {
        let Some(msg) = msg else { return };
        match msg.role.as_str() {
            "toolResult" => {
                if let Some(id) = msg.tool_call_id {
                    self.pending.remove(&id);
                }
            }
            "assistant" => {
                if let Some(u) = &msg.usage {
                    // 出错/中止的那一轮 usage 常是全 0：不能把已知的上下文大小清零。
                    let total = usage_total(u);
                    if total > 0 {
                        self.context_tokens = total;
                    }
                    self.cost += usage_cost(u);
                }
                if let Some(model) = msg.model.clone() {
                    self.model = Some(match msg.provider.as_deref() {
                        Some(p) if !p.is_empty() => format!("{p}/{model}"),
                        _ => model,
                    });
                }
                let stop_reason = msg.stop_reason.unwrap_or_else(|| "stop".to_string());
                self.last_assistant = Some(LastAssistant {
                    at_ms,
                    stop_reason: stop_reason.clone(),
                });
                let blocks = msg.content.unwrap_or_default();
                let mut reply: Option<String> = None;
                let mut thinking = false;
                for block in &blocks {
                    match block.kind.as_str() {
                        "text" => {
                            if reply.is_none() {
                                if let Some(text) =
                                    block.text.as_deref().filter(|t| !t.trim().is_empty())
                                {
                                    reply = Some(take_chars(
                                        &redact::sanitize_message(text),
                                        TEXT_CHARS,
                                    ));
                                }
                            }
                        }
                        "thinking" => {
                            thinking |= block
                                .thinking
                                .as_deref()
                                .is_some_and(|t| !t.trim().is_empty());
                        }
                        "toolCall" => self.record_tool_call(block),
                        _ => {}
                    }
                }
                // 文本优先于思考（一次回复只留一条，避免刷屏）。
                if let Some(text) = reply {
                    self.push_recent(at_ms, StageActivityKind::Reply, None, text);
                } else if thinking {
                    self.push_recent(at_ms, StageActivityKind::Thinking, None, String::new());
                }
                // `stopReason` 不是 stop（如 error/aborted）时补一条状态活动。
                if stop_reason != "stop" && stop_reason != "toolUse" {
                    self.push_recent(
                        at_ms,
                        StageActivityKind::State,
                        None,
                        take_chars(&stop_reason, TEXT_CHARS),
                    );
                }
            }
            _ => {}
        }
    }

    /// 记录 assistant 的 `toolCall` 块：`task` 的 tasks[] 与 `vibe_spawn` 的 name。
    fn record_tool_call(&mut self, block: &Block) {
        let Some(name) = block.name.as_deref() else {
            return;
        };
        // 说明来源：块级 `intent` → `arguments.i`。都没有时按条目自己的任务正文兜底。
        let raw_brief = block
            .intent
            .as_deref()
            .into_iter()
            .chain(
                block
                    .arguments
                    .as_ref()
                    .and_then(|args| args.get("i"))
                    .and_then(|v| v.as_str()),
            )
            .find(|s| !s.trim().is_empty());
        let brief = raw_brief.map(brief_text);
        let Some(args) = block.arguments.as_ref() else {
            return;
        };
        match name {
            "task" => {
                let Some(list) = args.get("tasks").and_then(|v| v.as_array()) else {
                    return;
                };
                for item in list {
                    let Some(task_name) = item.get("name").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    // 省略 `agent` 时 omp 用 `task`（CONTRACT §4.37 同口径）。
                    let agent = Some(
                        item.get("agent")
                            .and_then(|v| v.as_str())
                            .unwrap_or("task")
                            .to_string(),
                    );
                    let item_brief = brief.clone().or_else(|| {
                        item.get("task")
                            .and_then(|v| v.as_str())
                            .and_then(first_meaningful_line)
                            .map(brief_text)
                    });
                    self.spawn_info
                        .entry(task_name.to_string())
                        .or_insert(SpawnInfo {
                            agent,
                            brief: item_brief,
                        });
                }
            }
            "vibe_spawn" => {
                let Some(spawn_name) = args.get("name").and_then(|v| v.as_str()) else {
                    return;
                };
                let spawn_brief = brief.clone().or_else(|| {
                    args.get("prompt")
                        .and_then(|v| v.as_str())
                        .and_then(first_meaningful_line)
                        .map(brief_text)
                });
                self.spawn_info
                    .entry(spawn_name.to_string())
                    .or_insert(SpawnInfo {
                        agent: None,
                        brief: spawn_brief,
                    });
            }
            _ => {}
        }
    }

    fn feed_custom(
        &mut self,
        custom_type: Option<&str>,
        data: Option<serde_json::Value>,
        at_ms: i64,
    ) {
        let Some(ct) = custom_type else { return };
        let data = data.unwrap_or(serde_json::Value::Null);
        match ct {
            "tool_execution_start" => {
                let tool = data
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let text = tool_text(&data);
                self.tool_calls += 1;
                self.push_recent(
                    at_ms,
                    StageActivityKind::Tool,
                    Some(tool.clone()),
                    text.clone(),
                );
                if let Some(id) = data.get("toolCallId").and_then(|v| v.as_str()) {
                    self.pending
                        .insert(id.to_string(), Pending { tool, text, at_ms });
                }
            }
            "vibe-session-lifecycle" => {
                let Some(id) = data.get("id").and_then(|v| v.as_str()) else {
                    return;
                };
                let Some(action) = data.get("action").and_then(|v| v.as_str()) else {
                    return;
                };
                let tombstone = action == "tombstone";
                let agent = data
                    .get("agent")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let child_file = data
                    .get("childSessionFile")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let entry = self
                    .lifecycle
                    .entry(id.to_string())
                    .or_insert_with(|| Life {
                        action: action.to_string(),
                        agent: None,
                        child_file: None,
                        last_at_ms: at_ms,
                        tombstoned: false,
                    });
                entry.last_at_ms = at_ms;
                if agent.is_some() {
                    entry.agent = agent;
                }
                if child_file.is_some() {
                    entry.child_file = child_file;
                }
                if tombstone {
                    entry.tombstoned = true;
                } else {
                    entry.action = action.to_string();
                }
                match action {
                    "spawn" => {
                        self.push_recent(at_ms, StageActivityKind::State, None, "启动".to_string())
                    }
                    "turn-settled" => {
                        self.push_recent(at_ms, StageActivityKind::State, None, "待命".to_string())
                    }
                    _ => {}
                }
            }
            "session_exit" => {
                let kind = data
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("normal")
                    .to_string();
                let reason = data
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let at = data
                    .get("recordedAt")
                    .and_then(|v| v.as_str())
                    .and_then(parse_iso_ms)
                    .unwrap_or(at_ms);
                let text = if kind == "normal" {
                    "完成".to_string()
                } else if reason.is_empty() {
                    kind.clone()
                } else {
                    take_chars(&crate::usage::redact::sanitize_message(&reason), TEXT_CHARS)
                };
                self.push_recent(at, StageActivityKind::State, None, text);
                self.exit = Some(ExitInfo {
                    at_ms: at,
                    kind,
                    reason,
                });
            }
            _ => {}
        }
    }
}

/// 工具描述：`intent` 优先，否则 `toolName` + 第一个存在的字符串参数。
fn tool_text(data: &serde_json::Value) -> String {
    if let Some(intent) = data.get("intent").and_then(|v| v.as_str()) {
        if !intent.trim().is_empty() {
            return take_chars(&crate::usage::redact::sanitize_message(intent), TEXT_CHARS);
        }
    }
    let tool = data.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
    let arg = data.get("args").and_then(|args| {
        ARG_KEYS
            .iter()
            .find_map(|k| args.get(*k).and_then(|v| v.as_str()))
    });
    let raw = match arg {
        Some(a) => format!("{tool} {a}"),
        None => tool.to_string(),
    };
    take_chars(&crate::usage::redact::sanitize_message(&raw), TEXT_CHARS)
}
