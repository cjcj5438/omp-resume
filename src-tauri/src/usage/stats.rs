//! 用量统计聚合。
use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Local, TimeZone, Utc};

use crate::config::{validate_session_path, Config};
use crate::model::{
    AppError, AppResult, ErrorCode, SessionUsage, UsageModel, UsageProject, UsageRange,
    UsageSession, UsageStats, UsageTiming, UsageTokens, UsageTrend, UsageTrendPoint,
};

use super::{
    cache::{scan, UsageCache},
    parse::{Entry, Kind},
    window::{bucketed_key, in_window, trailing_days, window_at},
};

/// token 累加：损坏数据可能带极大单值，饱和加避免 debug panic / release 回绕。
pub(super) fn add_tokens(to: &mut UsageTokens, from: &UsageTokens) {
    to.input = to.input.saturating_add(from.input);
    to.output = to.output.saturating_add(from.output);
    to.cache_read = to.cache_read.saturating_add(from.cache_read);
    to.cache_write = to.cache_write.saturating_add(from.cache_write);
    to.total = to.total.saturating_add(from.total);
}

pub(super) fn add_usage(usage: &mut SessionUsage, entry: &Entry, nested: bool) {
    match entry.kind {
        Kind::User => usage.messages.user += 1,
        Kind::Assistant => usage.messages.assistant += 1,
        Kind::Background | Kind::ModelChange => {}
    }
    if entry.kind == Kind::ModelChange {
        return;
    }
    add_tokens(&mut usage.tokens, &entry.tokens);
    match entry.kind {
        Kind::Background => usage.cost.background += entry.cost,
        Kind::Assistant if nested => usage.cost.subagent += entry.cost,
        Kind::Assistant => usage.cost.main += entry.cost,
        Kind::User | Kind::ModelChange => {}
    }
    usage.cost.total = usage.cost.main + usage.cost.background + usage.cost.subagent;
}

pub(super) fn add_model(models: &mut HashMap<(String, String), UsageModel>, entry: &Entry) {
    if entry.kind == Kind::User || entry.kind == Kind::ModelChange {
        return;
    }
    let model = models
        .entry((entry.provider.clone(), entry.model.clone()))
        .or_insert_with(|| UsageModel {
            provider: entry.provider.clone(),
            model: entry.model.clone(),
            ..UsageModel::default()
        });
    model.messages += 1;
    model.cost += entry.cost;
    add_tokens(&mut model.tokens, &entry.tokens);
}

pub(super) fn sorted_models(models: HashMap<(String, String), UsageModel>) -> Vec<UsageModel> {
    let mut models: Vec<_> = models.into_values().collect();
    models.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then_with(|| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)))
    });
    models
}

pub(super) const ACTIVITY_DAYS: i64 = 182;
pub(super) const TOP_SESSIONS: usize = 8;
pub(super) const SPEED_MIN_GEN_MS: u64 = 500;
pub(super) const SPEED_MIN_OUTPUT: u64 = 16;

#[derive(Default)]
pub(super) struct SpeedAcc {
    out: u64,
    gen_ms: u64,
    ttft_ms: u64,
    ttft_n: u64,
}

impl SpeedAcc {
    fn add(&mut self, entry: &Entry) {
        let Some(timing) = entry.timing else {
            return;
        };
        if entry.stop_reason == "error" || entry.stop_reason == "aborted" {
            return;
        }
        self.ttft_ms = self.ttft_ms.saturating_add(timing.wait_ms);
        self.ttft_n = self.ttft_n.saturating_add(1);
        if timing.gen_ms >= SPEED_MIN_GEN_MS && entry.tokens.output >= SPEED_MIN_OUTPUT {
            self.out = self.out.saturating_add(entry.tokens.output);
            self.gen_ms = self.gen_ms.saturating_add(timing.gen_ms);
        }
    }

    fn tps(&self) -> Option<f64> {
        (self.gen_ms > 0).then(|| self.out as f64 / (self.gen_ms as f64 / 1000.0))
    }

    fn ttft(&self) -> Option<f64> {
        (self.ttft_n > 0).then(|| self.ttft_ms as f64 / self.ttft_n as f64)
    }
}

pub fn session_usage(cfg: &Config, cache: &UsageCache, path: &str) -> AppResult<SessionUsage> {
    let path = validate_session_path(cfg, path)?;
    let library = scan(cfg, cache)?;
    let owner = library
        .files
        .iter()
        .take(library.top_count)
        .position(|f| f.path == path)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "会话文件不存在"))?;
    if library.files[owner].data.version != Some(3) {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            "该会话格式暂不支持用量统计",
        ));
    }
    let mut usage = SessionUsage::default();
    let mut models = HashMap::new();
    for (i, file) in library
        .files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.owner == owner && f.data.version == Some(3))
    {
        for entry in &file.data.entries {
            if library.inherited(i, entry) {
                continue;
            }
            add_usage(&mut usage, entry, i >= library.top_count);
            add_model(&mut models, entry);
        }
    }
    usage.models = sorted_models(models);
    Ok(usage)
}

pub fn usage_stats(cfg: &Config, cache: &UsageCache, range: UsageRange) -> AppResult<UsageStats> {
    stats_at(cfg, cache, range, Utc::now(), &Local)
}

pub(super) fn stats_at<Tz: TimeZone>(
    cfg: &Config,
    cache: &UsageCache,
    range: UsageRange,
    now: DateTime<Utc>,
    timezone: &Tz,
) -> AppResult<UsageStats>
where
    Tz::Offset: std::fmt::Display,
{
    let window = window_at(range, now, timezone);
    let activity_window = trailing_days(ACTIVITY_DAYS, now, timezone);
    let library = scan(cfg, cache)?;
    let mut stats = UsageStats::default();
    let mut models = HashMap::new();
    let mut projects: HashMap<String, UsageProject> = HashMap::new();
    let mut trend: BTreeMap<String, (f64, UsageTokens)> = BTreeMap::new();
    let mut activity: BTreeMap<String, (f64, UsageTokens)> = BTreeMap::new();
    let mut speeds: HashMap<(String, String), SpeedAcc> = HashMap::new();
    let mut main_speed = SpeedAcc::default();
    let mut timing = UsageTiming::default();
    let mut sessions: HashMap<usize, UsageSession> = HashMap::new();
    for (i, file) in library.files.iter().enumerate() {
        if file.data.version != Some(3) || library.files[file.owner].data.version != Some(3) {
            continue;
        }
        let cwd = &library.files[file.owner].data.cwd;
        for (j, entry) in file.data.entries.iter().enumerate() {
            let in_range = in_window(&window, entry.timestamp);
            let in_activity = entry.kind != Kind::ModelChange
                && entry.timestamp.is_some()
                && in_window(&activity_window, entry.timestamp);
            if !(in_range || in_activity) || library.inherited(i, entry) {
                continue;
            }
            if in_activity {
                if let Some(ms) = entry.timestamp {
                    if let Some(key) = bucketed_key(&activity_window, ms, timezone) {
                        let slot = activity
                            .entry(key)
                            .or_insert_with(|| (0.0, UsageTokens::default()));
                        slot.0 += entry.cost;
                        add_tokens(&mut slot.1, &entry.tokens);
                    }
                }
            }
            if !in_range {
                continue;
            }
            add_usage(&mut stats.total, entry, i >= library.top_count);
            add_model(&mut models, entry);
            let project = projects.entry(cwd.clone()).or_insert_with(|| UsageProject {
                cwd: cwd.clone(),
                ..UsageProject::default()
            });
            project.cost += entry.cost;
            add_tokens(&mut project.tokens, &entry.tokens);
            let is_new = !sessions.contains_key(&file.owner);
            if is_new {
                project.sessions += 1;
            }
            let s = sessions.entry(file.owner).or_insert_with(|| UsageSession {
                id: library.files[file.owner].data.id.clone(),
                path: library.files[file.owner]
                    .path
                    .to_string_lossy()
                    .into_owned(),
                cwd: cwd.clone(),
                ..Default::default()
            });
            s.cost += entry.cost;
            s.tokens = s.tokens.saturating_add(entry.tokens.total);
            if entry.kind == Kind::Assistant {
                s.calls += 1;
            }
            if let Some(t) = entry.timestamp {
                s.last_ms = s.last_ms.max(t);
            }
            // 趋势只收纳用量条目（model_change 恒零花费，不进趋势）。
            if entry.kind == Kind::ModelChange {
                continue;
            }
            if entry.kind == Kind::Assistant {
                speeds
                    .entry((entry.provider.clone(), entry.model.clone()))
                    .or_default()
                    .add(entry);
                if i < library.top_count {
                    main_speed.add(entry);
                    if entry.timing.is_some() {
                        timing.calls += 1;
                    }
                    if let Some(t) = &entry.timing {
                        timing.wait_ms = timing.wait_ms.saturating_add(t.wait_ms);
                        timing.gen_ms = timing.gen_ms.saturating_add(t.gen_ms);
                    }
                    let f = file.data.flows[j];
                    timing.tool_ms = timing.tool_ms.saturating_add(f.tool_ms);
                    timing.tool_calls += f.tool_results as u64;
                }
            }
            let Some(ms) = entry.timestamp else {
                continue;
            };
            let Some(key) = bucketed_key(&window, ms, timezone) else {
                continue;
            };
            let slot = trend
                .entry(key)
                .or_insert_with(|| (0.0, UsageTokens::default()));
            slot.0 += entry.cost;
            add_tokens(&mut slot.1, &entry.tokens);
        }
    }
    stats.by_project = projects.into_values().collect();
    stats
        .by_project
        .sort_by(|a, b| b.cost.total_cmp(&a.cost).then_with(|| a.cwd.cmp(&b.cwd)));
    stats.by_model = sorted_models(models);
    for m in &mut stats.by_model {
        if let Some(acc) = speeds.get(&(m.provider.clone(), m.model.clone())) {
            m.tps = acc.tps();
            m.ttft_ms = acc.ttft();
        }
    }
    stats.total.models = stats.by_model.clone();
    stats.sessions = sessions.len() as u64;
    timing.tps = main_speed.tps();
    stats.timing = timing;
    let mut top_sessions: Vec<UsageSession> =
        sessions.into_values().filter(|s| s.cost > 0.0).collect();
    top_sessions.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then_with(|| b.last_ms.cmp(&a.last_ms))
            .then_with(|| a.path.cmp(&b.path))
    });
    top_sessions.truncate(TOP_SESSIONS);
    stats.top_sessions = top_sessions;
    stats.activity = activity_window
        .keys
        .iter()
        .map(|key| {
            let (cost, tokens) = activity
                .get(key)
                .cloned()
                .unwrap_or((0.0, UsageTokens::default()));
            UsageTrendPoint {
                key: key.clone(),
                cost,
                tokens,
            }
        })
        .collect();
    stats.trend = UsageTrend {
        unit: window.unit,
        points: if window.keys.is_empty() {
            trend
                .into_iter()
                .map(|(key, (cost, tokens))| UsageTrendPoint { key, cost, tokens })
                .collect()
        } else {
            window
                .keys
                .iter()
                .map(|key| {
                    let (cost, tokens) = trend
                        .get(key)
                        .cloned()
                        .unwrap_or((0.0, UsageTokens::default()));
                    UsageTrendPoint {
                        key: key.clone(),
                        cost,
                        tokens,
                    }
                })
                .collect()
        },
    };
    Ok(stats)
}
