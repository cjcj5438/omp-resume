//! 只读用量统计：流式最小字段解析、fork 链归属与进程内逐文件缓存。
use std::sync::Arc;

use crate::config::Config;
use crate::model::{
    AppError, AppResult, ErrorCode, SessionUsage, UsageHealth, UsageRange, UsageStats,
};

pub(crate) mod cache;
mod health;
mod parse;
pub(crate) mod redact;
mod stats;
mod window;

#[cfg(test)]
mod tests;

pub use cache::UsageCache;
pub use health::usage_health;
pub use stats::{session_usage, usage_stats};

fn io_error(err: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("读取用量失败：{err}"))
}

#[tauri::command]
pub async fn get_session_usage(
    cfg: tauri::State<'_, Config>,
    cache: tauri::State<'_, Arc<UsageCache>>,
    path: String,
) -> AppResult<SessionUsage> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    tauri::async_runtime::spawn_blocking(move || session_usage(&cfg, &cache, &path))
        .await
        .map_err(io_error)?
}

#[tauri::command]
pub async fn get_usage_stats(
    cfg: tauri::State<'_, Config>,
    cache: tauri::State<'_, Arc<UsageCache>>,
    range: UsageRange,
) -> AppResult<UsageStats> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    tauri::async_runtime::spawn_blocking(move || usage_stats(&cfg, &cache, range))
        .await
        .map_err(io_error)?
}

#[tauri::command]
pub async fn get_usage_health(
    cfg: tauri::State<'_, Config>,
    cache: tauri::State<'_, Arc<UsageCache>>,
    range: UsageRange,
) -> AppResult<UsageHealth> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    tauri::async_runtime::spawn_blocking(move || usage_health(&cfg, &cache, range))
        .await
        .map_err(io_error)?
}
