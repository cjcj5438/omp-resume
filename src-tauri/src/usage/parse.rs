//! 用量 jsonl 流式解析。
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;

use crate::model::{AppResult, UsageTokens};

use super::io_error;

#[derive(Default)]
pub(super) struct ParsedFile {
    pub(super) id: String,
    pub(super) cwd: String,
    pub(super) parent: Option<String>,
    pub(super) version: Option<u32>,
    pub(super) entries: Vec<Entry>,
    pub(super) by_id: HashMap<String, Vec<usize>>,
    pub(super) flows: Vec<Flow>,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    User,
    Assistant,
    Background,
    /// model_change 行：只用于兜底统计与 from 推断，不产生花费/消息数。
    ModelChange,
}

#[derive(PartialEq)]
pub(super) struct Entry {
    pub(super) id: Option<String>,
    pub(super) parent: Option<String>,
    pub(super) timestamp: Option<i64>,
    pub(super) kind: Kind,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) tokens: UsageTokens,
    pub(super) cost: f64,
    /// assistant：message.stopReason（缺省空）。
    pub(super) stop_reason: String,
    /// assistant：message.errorMessage 原文（缺省空；输出时截断脱敏）。
    pub(super) error_message: String,
    /// model_change：role（缺省空；缺 role 与空字符串同义）。
    pub(super) change_role: String,
    /// model_change：resolvedModelIsFallback。
    pub(super) is_fallback: bool,
    /// assistant 自报耗时（duration/ttft 均有效时）。
    pub(super) timing: Option<Timing>,
}

/// 工具间隔超过 10 分钟视为会话闲置，不计工具耗时。
pub(super) const IDLE_CAP_MS: i64 = 10 * 60 * 1000;
/// 上游自报耗时；仅 duration、ttft 均有效且 duration ≥ ttft ≥ 0 时存在。
#[derive(Clone, Copy, PartialEq)]
pub(super) struct Timing {
    pub(super) wait_ms: u64,
    pub(super) gen_ms: u64,
}
/// 随 entries 下标并行存放，**不进入 Entry 的相等比较**：fork 复制的同一条助手消息，
/// 在父/子文件里后续行不同，工具次数/间隔可能不同；放进 Entry 会让副本判定失败而重复计费。
#[derive(Default, Clone, Copy)]
pub(super) struct Flow {
    pub(super) tool_results: u32,
    pub(super) tool_ms: u64,
}
/// 非有限/负数/duration<ttft → None。
pub(super) fn timing_of(duration: Option<f64>, ttft: Option<f64>) -> Option<Timing> {
    let (duration, ttft) = (duration?, ttft?);
    if !duration.is_finite() || !ttft.is_finite() || duration < 0.0 || ttft < 0.0 || duration < ttft
    {
        return None;
    }
    Some(Timing {
        wait_ms: ttft.round() as u64,
        gen_ms: (duration - ttft).round() as u64,
    })
}
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Line {
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) id: Option<String>,
    pub(super) parent_id: Option<String>,
    pub(super) timestamp: Option<Timestamp>,
    pub(super) version: Option<u32>,
    pub(super) cwd: String,
    pub(super) parent_session: Option<String>,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) role: Option<String>,
    pub(super) resolved_model_is_fallback: bool,
    pub(super) usage: Option<RawUsage>,
    pub(super) message: Option<Message>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Message {
    pub(super) role: String,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) usage: Option<RawUsage>,
    pub(super) timestamp: Option<Timestamp>,
    pub(super) stop_reason: String,
    pub(super) error_message: String,
    pub(super) duration: Option<f64>,
    pub(super) ttft: Option<f64>,
    pub(super) completed_at: Option<f64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Timestamp {
    Text(String),
    Millis(i64),
}

impl Timestamp {
    fn millis(&self) -> Option<i64> {
        match self {
            Self::Text(text) => DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|t| t.timestamp_millis()),
            Self::Millis(ms) => Utc
                .timestamp_millis_opt(*ms)
                .single()
                .map(|t| t.timestamp_millis()),
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct RawUsage {
    pub(super) input: u64,
    pub(super) output: u64,
    pub(super) cache_read: u64,
    pub(super) cache_write: u64,
    pub(super) total_tokens: Option<u64>,
    pub(super) cost: Option<RawCost>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct RawCost {
    pub(super) input: f64,
    pub(super) output: f64,
    pub(super) cache_read: f64,
    pub(super) cache_write: f64,
    pub(super) total: Option<f64>,
}

/// 拆 model_change 的 "provider/model"（按首个 '/'；model 名本身可含 '/'）。
/// 无 '/' 时 provider 为空、整体为 model。
pub(super) fn split_model(combined: &str) -> (String, String) {
    match combined.split_once('/') {
        Some((provider, model)) => (provider.to_owned(), model.to_owned()),
        None => (String::new(), combined.to_owned()),
    }
}

pub(super) fn parse_file(path: &Path) -> AppResult<ParsedFile> {
    let mut parsed = ParsedFile::default();
    let mut reader = BufReader::new(File::open(path).map_err(io_error)?);
    let mut line = Vec::new();
    let mut last_assistant: Option<usize> = None;
    let mut pending: Option<(usize, i64)> = None;
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).map_err(io_error)? == 0 {
            break;
        }
        let Ok(raw) = serde_json::from_slice::<Line>(&line) else {
            continue;
        };
        if raw.kind == "session" {
            parsed.id = raw.id.unwrap_or_default();
            parsed.cwd = raw.cwd;
            parsed.parent = raw.parent_session;
            parsed.version = raw.version;
            continue;
        }
        // toolResult 不产生 Entry：只给上一条助手记工具次数。
        if raw.kind == "message" && raw.message.as_ref().is_some_and(|m| m.role == "toolResult") {
            if let Some(i) = last_assistant {
                parsed.flows[i].tool_results += 1;
            }
            continue;
        }
        let timing_src = raw
            .message
            .as_ref()
            .filter(|m| m.role == "assistant")
            .map(|m| (m.duration, m.ttft, m.completed_at));
        // kind、provider、model、usage、内层时间、stop、错误原文、切换角色、兜底标记。
        let parsed_entry = match (raw.kind.as_str(), raw.message) {
            ("model_usage", _) => (
                Kind::Background,
                raw.provider,
                raw.model,
                raw.usage,
                None,
                String::new(),
                String::new(),
                String::new(),
                false,
            ),
            ("message", Some(m)) if m.role == "user" || m.role == "assistant" => {
                let assistant = m.role == "assistant";
                (
                    if assistant {
                        Kind::Assistant
                    } else {
                        Kind::User
                    },
                    m.provider,
                    m.model,
                    if assistant { m.usage } else { None },
                    m.timestamp,
                    if assistant {
                        m.stop_reason
                    } else {
                        String::new()
                    },
                    if assistant {
                        m.error_message
                    } else {
                        String::new()
                    },
                    String::new(),
                    false,
                )
            }
            ("model_change", _) => {
                let (provider, model) = split_model(&raw.model);
                (
                    Kind::ModelChange,
                    provider,
                    model,
                    None,
                    None,
                    String::new(),
                    String::new(),
                    raw.role.unwrap_or_default(),
                    raw.resolved_model_is_fallback,
                )
            }
            _ => continue,
        };
        let (
            kind,
            provider,
            model,
            usage,
            timestamp,
            stop_reason,
            error_message,
            change_role,
            is_fallback,
        ) = parsed_entry;
        let usage = usage.unwrap_or_default();
        let total = usage.total_tokens.unwrap_or_else(|| {
            usage
                .input
                .saturating_add(usage.output)
                .saturating_add(usage.cache_read)
                .saturating_add(usage.cache_write)
        });
        let cost = usage.cost.unwrap_or_default();
        let cost = cost
            .total
            .unwrap_or(cost.input + cost.output + cost.cache_read + cost.cache_write);
        let index = parsed.entries.len();
        let entry = Entry {
            id: raw.id,
            parent: raw.parent_id,
            timestamp: timestamp
                .as_ref()
                .and_then(Timestamp::millis)
                .or_else(|| raw.timestamp.as_ref().and_then(Timestamp::millis)),
            kind,
            provider,
            model,
            tokens: UsageTokens {
                input: usage.input,
                output: usage.output,
                cache_read: usage.cache_read,
                cache_write: usage.cache_write,
                total,
            },
            cost: if cost.is_finite() && cost >= 0.0 {
                cost
            } else {
                0.0
            },
            stop_reason,
            error_message,
            change_role,
            is_fallback,
            timing: timing_src.and_then(|(d, t, _)| timing_of(d, t)),
        };
        let ts = entry.timestamp;
        let stop_reason_tool_use = kind == Kind::Assistant && entry.stop_reason == "toolUse";
        parsed.entries.push(entry);
        parsed.flows.push(Flow::default());
        match kind {
            Kind::User => pending = None,
            Kind::Assistant => {
                if let (Some((prev, done)), Some(ts)) = (pending.take(), ts) {
                    let gap = ts - done;
                    if (0..=IDLE_CAP_MS).contains(&gap) {
                        parsed.flows[prev].tool_ms = gap as u64;
                    }
                }
                last_assistant = Some(index);
                pending = if stop_reason_tool_use {
                    timing_src
                        .and_then(|(_, _, c)| c)
                        .filter(|c| c.is_finite())
                        .map(|c| (index, c as i64))
                } else {
                    None
                };
            }
            Kind::Background | Kind::ModelChange => {}
        }
    }
    if parsed.version == Some(3) {
        for (i, entry) in parsed.entries.iter().enumerate() {
            if let Some(id) = &entry.id {
                parsed.by_id.entry(id.clone()).or_default().push(i);
            }
        }
    }
    Ok(parsed)
}
