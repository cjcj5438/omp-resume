//! 健康度分析。
use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Local, TimeZone, Utc};

use crate::config::Config;
use crate::model::{
    AppResult, CacheByModel, ErrorKind, ErrorKindCount, ErrorRecent, FallbackRecent,
    FallbackTarget, ModelRef, TimelinePoint, UsageCacheStats, UsageHealth, UsageRange,
    UsageTimeline,
};

use super::{
    cache::{scan, UsageCache},
    parse::Kind,
    redact::sanitize_message,
    window::{bucketed_key, in_window, window_at},
};

pub(super) fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| text.contains(n))
}

/// 错误分类（大小写不敏感，先命中先赢）：
/// quota → rate_limit → timeout → auth → network → server → other。
/// 按本机真实 errorMessage 形态制定：
/// "402 ...usage limit" 系 quota；"timed out/stalled" 系 timeout；
/// "ECONNRESET/Connection" 系 network；"server_error/502/503" 系 server。
/// 注意 "Retry budget exhausted" 是重试预算耗尽而非额度用尽，不归 quota。
pub(super) fn classify_error(message: &str) -> ErrorKind {
    let lower = message.to_lowercase();
    let text = lower.as_str();
    // 行首 HTTP 状态码（如 "402 {...}"）。
    let status: Option<u16> = {
        let head: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
        if head.len() == 3
            && text
                .as_bytes()
                .get(3)
                .is_some_and(|b| *b == b' ' || *b == b'{')
        {
            head.parse().ok()
        } else {
            None
        }
    };
    if status == Some(402)
        || contains_any(
            text,
            &[
                "usage limit",
                "usage_limit",
                "usage-limit",
                "quota",
                "payment",
                "subscription",
                "billing",
                "insufficient",
                "out of credit",
            ],
        )
    {
        return ErrorKind::Quota;
    }
    if status == Some(429)
        || contains_any(
            text,
            &["rate limit", "rate_limit", "ratelimit", "too many requests"],
        )
    {
        return ErrorKind::RateLimit;
    }
    if contains_any(
        text,
        &[
            "timed out",
            "timeout",
            "time-out",
            "stalled",
            "deadline exceeded",
            "stream_timeout",
            "etimedout",
        ],
    ) {
        return ErrorKind::Timeout;
    }
    if matches!(status, Some(401 | 403))
        || contains_any(
            text,
            &[
                "unauthorized",
                "unauthenticated",
                "invalid api key",
                "invalid_api_key",
                "invalid key",
                "authentication failed",
                "authentication error",
                "forbidden",
                "api key not valid",
                "incorrect api key",
                "invalid credentials",
            ],
        )
    {
        return ErrorKind::Auth;
    }
    if contains_any(
        text,
        &[
            "econnreset",
            "econnrefused",
            "econnaborted",
            "enotfound",
            "eai_again",
            "epipe",
            "ehostunreach",
            "enetunreach",
            "connection",
            "socket",
            "network",
            "fetch failed",
            "fetching",
            "tls",
            "certificate",
            "cert_",
            "broken pipe",
            "reset by peer",
            "stream was interrupted",
            "stream_interrupted",
            "closed before",
            "ended before completion",
            "eof",
        ],
    ) {
        return ErrorKind::Network;
    }
    if matches!(status, Some(500..=599))
        || contains_any(
            text,
            &[
                "server_error",
                "server error",
                "upstream",
                "unavailable",
                "internal error",
                "internal server",
                "bad gateway",
                "service unavailable",
                "overloaded",
                "capacity",
                "try again later",
                "failed to generate",
            ],
        )
    {
        return ErrorKind::Server;
    }
    ErrorKind::Other
}

/// 缓存命中率：分母为 0，或范围内 cacheRead + cacheWrite 全为 0（上游不报缓存）时为 null。
pub(super) fn hit_rate(read: u64, input: u64, write: u64) -> Option<f64> {
    let denom = input as f64 + read as f64 + write as f64;
    if denom == 0.0 || (read == 0 && write == 0) {
        return None;
    }
    Some(read as f64 / denom)
}

#[derive(Default)]
pub(super) struct TimelineAcc {
    requests: u64,
    errors: u64,
    fallbacks: u64,
    cache_read: u64,
    prompt: u64,
}

pub fn usage_health(cfg: &Config, cache: &UsageCache, range: UsageRange) -> AppResult<UsageHealth> {
    health_at(cfg, cache, range, Utc::now(), &Local)
}

pub(super) fn health_at<Tz: TimeZone>(
    cfg: &Config,
    cache: &UsageCache,
    range: UsageRange,
    now: DateTime<Utc>,
    timezone: &Tz,
) -> AppResult<UsageHealth>
where
    Tz::Offset: std::fmt::Display,
{
    let window = window_at(range, now, timezone);
    let library = scan(cfg, cache)?;
    // 每文件兜底 from 预查：文件内此前最近 model_change（任何 role）/ assistant 的模型，
    // 不过滤窗口与去重（只描述切换瞬间此前生效的模型）；找不到为 None。
    let froms: Vec<Vec<Option<(String, String)>>> = library
        .files
        .iter()
        .map(|file| {
            let mut last: Option<(String, String)> = None;
            file.data
                .entries
                .iter()
                .map(|entry| {
                    let from = last.clone();
                    match entry.kind {
                        Kind::Assistant | Kind::ModelChange if !entry.model.is_empty() => {
                            last = Some((entry.provider.clone(), entry.model.clone()));
                        }
                        _ => {}
                    }
                    from
                })
                .collect()
        })
        .collect();
    let mut health = UsageHealth::default();
    let mut by_kind: HashMap<ErrorKind, u64> = HashMap::new();
    let mut errors_recent: Vec<ErrorRecent> = Vec::new();
    let mut by_target: HashMap<(String, String), u64> = HashMap::new();
    let mut fallbacks_recent: Vec<FallbackRecent> = Vec::new();
    let mut cache_input = 0u64;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    // (provider, model) → (requests, input, read, write)。
    let mut cache_models: HashMap<(String, String), (u64, u64, u64, u64)> = HashMap::new();
    let mut timeline: BTreeMap<String, TimelineAcc> = BTreeMap::new();
    for (i, file) in library.files.iter().enumerate() {
        if file.data.version != Some(3) || library.files[file.owner].data.version != Some(3) {
            continue;
        }
        for (j, entry) in file.data.entries.iter().enumerate() {
            if !in_window(&window, entry.timestamp) || library.inherited(i, entry) {
                continue;
            }
            // 请求口径：assistant 消息 + model_usage 后台调用；与 stats 同窗口同 scan 下
            // by_model.messages 之和同集合（add_model 恰计这两类），故恒等于该和。
            let is_request = matches!(entry.kind, Kind::Assistant | Kind::Background);
            if is_request {
                health.requests = health.requests.saturating_add(1);
                cache_input = cache_input.saturating_add(entry.tokens.input);
                cache_read = cache_read.saturating_add(entry.tokens.cache_read);
                cache_write = cache_write.saturating_add(entry.tokens.cache_write);
                let slot = cache_models
                    .entry((entry.provider.clone(), entry.model.clone()))
                    .or_insert((0, 0, 0, 0));
                slot.0 = slot.0.saturating_add(1);
                slot.1 = slot.1.saturating_add(entry.tokens.input);
                slot.2 = slot.2.saturating_add(entry.tokens.cache_read);
                slot.3 = slot.3.saturating_add(entry.tokens.cache_write);
            }
            // 错误只认 assistant 消息；model_usage 的 stopReason/errorMessage 不计错误。
            let is_error = entry.kind == Kind::Assistant && entry.stop_reason == "error";
            if is_error {
                health.errors.total = health.errors.total.saturating_add(1);
                let kind = classify_error(&entry.error_message);
                *by_kind.entry(kind).or_default() += 1;
                if let Some(ms) = entry.timestamp {
                    errors_recent.push(ErrorRecent {
                        time: ms,
                        provider: entry.provider.clone(),
                        model: entry.model.clone(),
                        kind,
                        message: sanitize_message(&entry.error_message),
                    });
                }
            }
            if entry.kind == Kind::Assistant && entry.stop_reason == "aborted" {
                health.errors.aborted = health.errors.aborted.saturating_add(1);
            }
            let is_fallback = entry.kind == Kind::ModelChange
                && entry.change_role == "fallback"
                && entry.is_fallback;
            if is_fallback {
                health.fallbacks.total = health.fallbacks.total.saturating_add(1);
                *by_target
                    .entry((entry.provider.clone(), entry.model.clone()))
                    .or_default() += 1;
                if let Some(ms) = entry.timestamp {
                    fallbacks_recent.push(FallbackRecent {
                        time: ms,
                        from: froms[i][j]
                            .clone()
                            .map(|(provider, model)| ModelRef { provider, model }),
                        to: ModelRef {
                            provider: entry.provider.clone(),
                            model: entry.model.clone(),
                        },
                    });
                }
            }
            // 时间线：所有带合法时间的归属条目都可建桶；只有用量条目贡献 token。
            if let Some(ms) = entry.timestamp {
                let Some(key) = bucketed_key(&window, ms, timezone) else {
                    continue;
                };
                let slot = timeline.entry(key).or_default();
                if is_request {
                    slot.requests = slot.requests.saturating_add(1);
                    slot.cache_read = slot.cache_read.saturating_add(entry.tokens.cache_read);
                    slot.prompt = slot
                        .prompt
                        .saturating_add(entry.tokens.input)
                        .saturating_add(entry.tokens.cache_read)
                        .saturating_add(entry.tokens.cache_write);
                }
                if is_error {
                    slot.errors = slot.errors.saturating_add(1);
                }
                if is_fallback {
                    slot.fallbacks = slot.fallbacks.saturating_add(1);
                }
            }
        }
    }
    fn kind_name(kind: ErrorKind) -> &'static str {
        match kind {
            ErrorKind::Quota => "quota",
            ErrorKind::RateLimit => "rate_limit",
            ErrorKind::Auth => "auth",
            ErrorKind::Timeout => "timeout",
            ErrorKind::Network => "network",
            ErrorKind::Server => "server",
            ErrorKind::Other => "other",
        }
    }
    let mut by_kind: Vec<ErrorKindCount> = by_kind
        .into_iter()
        .map(|(kind, count)| ErrorKindCount { kind, count })
        .collect();
    by_kind.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| kind_name(a.kind).cmp(kind_name(b.kind)))
    });
    health.errors.by_kind = by_kind;
    // 稳定排序：同毫秒保持文件扫描顺序。
    errors_recent.sort_by_key(|a| std::cmp::Reverse(a.time));
    errors_recent.truncate(20);
    health.errors.recent = errors_recent;
    let mut by_target: Vec<FallbackTarget> = by_target
        .into_iter()
        .map(|((provider, model), count)| FallbackTarget {
            provider,
            model,
            count,
        })
        .collect();
    by_target.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)))
    });
    health.fallbacks.by_target = by_target;
    fallbacks_recent.sort_by_key(|a| std::cmp::Reverse(a.time));
    fallbacks_recent.truncate(20);
    health.fallbacks.recent = fallbacks_recent;
    let mut cache_by_model: Vec<CacheByModel> = cache_models
        .into_iter()
        .map(
            |((provider, model), (requests, input, read, write))| CacheByModel {
                provider,
                model,
                requests,
                hit_rate: hit_rate(read, input, write),
            },
        )
        .collect();
    cache_by_model.sort_by(|a, b| {
        b.requests
            .cmp(&a.requests)
            .then_with(|| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)))
    });
    health.cache = UsageCacheStats {
        hit_rate: hit_rate(cache_read, cache_input, cache_write),
        read: cache_read,
        write: cache_write,
        input: cache_input,
        by_model: cache_by_model,
    };
    health.timeline = UsageTimeline {
        unit: window.unit,
        points: if window.keys.is_empty() {
            timeline
                .into_iter()
                .map(
                    |(
                        key,
                        TimelineAcc {
                            requests,
                            errors,
                            fallbacks,
                            cache_read,
                            prompt,
                        },
                    )| TimelinePoint {
                        key,
                        requests,
                        errors,
                        fallbacks,
                        cache_read,
                        prompt_tokens: prompt,
                    },
                )
                .collect()
        } else {
            window
                .keys
                .iter()
                .map(|key| {
                    let acc = timeline.get(key);
                    TimelinePoint {
                        key: key.clone(),
                        requests: acc.map(|a| a.requests).unwrap_or(0),
                        errors: acc.map(|a| a.errors).unwrap_or(0),
                        fallbacks: acc.map(|a| a.fallbacks).unwrap_or(0),
                        cache_read: acc.map(|a| a.cache_read).unwrap_or(0),
                        prompt_tokens: acc.map(|a| a.prompt).unwrap_or(0),
                    }
                })
                .collect()
        },
    };
    Ok(health)
}
