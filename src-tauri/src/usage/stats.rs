//! 用量统计聚合。
use std::collections::HashMap;

use crate::config::{validate_session_path, Config};
use crate::model::{AppError, AppResult, ErrorCode, SessionUsage, UsageModel, UsageTokens};

use super::{
    cache::{scan, UsageCache},
    parse::{Entry, Kind},
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
        Kind::Background => {}
    }
    add_tokens(&mut usage.tokens, &entry.tokens);
    match entry.kind {
        Kind::Background => usage.cost.background += entry.cost,
        Kind::Assistant if nested => usage.cost.subagent += entry.cost,
        Kind::Assistant => usage.cost.main += entry.cost,
        Kind::User => {}
    }
    usage.cost.total = usage.cost.main + usage.cost.background + usage.cost.subagent;
}

pub(super) fn add_model(models: &mut HashMap<(String, String), UsageModel>, entry: &Entry) {
    if entry.kind == Kind::User {
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
