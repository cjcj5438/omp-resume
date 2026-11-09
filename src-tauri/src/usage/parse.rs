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
    pub(super) parent: Option<String>,
    pub(super) version: Option<u32>,
    pub(super) entries: Vec<Entry>,
    pub(super) by_id: HashMap<String, Vec<usize>>,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    User,
    Assistant,
    Background,
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
    pub(super) parent_session: Option<String>,
    pub(super) provider: String,
    pub(super) model: String,
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

pub(super) fn parse_file(path: &Path) -> AppResult<ParsedFile> {
    let mut parsed = ParsedFile::default();
    let mut reader = BufReader::new(File::open(path).map_err(io_error)?);
    let mut line = Vec::new();
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
            parsed.parent = raw.parent_session;
            parsed.version = raw.version;
            continue;
        }
        // toolResult 不产生 Entry。
        if raw.kind == "message" && raw.message.as_ref().is_some_and(|m| m.role == "toolResult") {
            continue;
        }
        let parsed_entry = match (raw.kind.as_str(), raw.message) {
            ("model_usage", _) => (Kind::Background, raw.provider, raw.model, raw.usage, None),
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
                )
            }
            _ => continue,
        };
        let (kind, provider, model, usage, timestamp) = parsed_entry;
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
        };
        parsed.entries.push(entry);
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
