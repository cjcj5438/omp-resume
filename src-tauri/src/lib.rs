//! Tauri 应用入口。
//!
//! 后端模块布局：
//! - `config`：配置解析 + 会话路径校验
//! - `lock`（顶层）：flock 占用探测
//! - `sessions`：扫描 / 解析 / 列表 / 会话内容 / 树
//! - `ops`：删除 / 分支标记 / iTerm 打开（另一 worker）
//!
//! 每个新命令必须同时注册到下面 `generate_handler!` 列表中，
//! 并在 `docs/CONTRACT.md`、`model.rs`、`src/types.ts`、`src/api.ts`
//! 四处保持一致（见 CONTRACT.md「一致性规则」）。

/// 全局共享的数据模型：命令参数、返回值与错误类型。
pub mod model;

pub mod config;
pub mod lock;
pub mod sessions;

use crate::model::{AppError, ErrorCode};

/// 取 `--sessions-dir <path>` 启动参数（无则 None，走环境/默认）。
fn sessions_dir_arg() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--sessions-dir" {
            return args.next();
        }
        if let Some(p) = a.strip_prefix("--sessions-dir=") {
            return Some(p.to_string());
        }
    }
    None
}

fn io_join_error(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("后台任务失败：{e}"))
}

/// CONTRACT §4.1：返回解析后的实际目录。
#[tauri::command]
async fn get_config(
    cfg: tauri::State<'_, config::Config>,
) -> Result<model::GetConfigResult, model::AppError> {
    Ok(model::GetConfigResult {
        sessions_dir: cfg.sessions_dir.to_string_lossy().into_owned(),
        owners_dir: cfg.owners_dir.to_string_lossy().into_owned(),
    })
}

/// CONTRACT §4.2：会话列表（阻塞 IO 在后台线程）。
#[tauri::command]
async fn list_sessions(
    cfg: tauri::State<'_, config::Config>,
) -> Result<model::ListSessionsResult, model::AppError> {
    let cfg = cfg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sessions::list::list_sessions(&cfg))
        .await
        .map_err(io_join_error)?
}

/// CONTRACT §4.3：只读会话预览。
#[tauri::command]
async fn get_conversation(
    cfg: tauri::State<'_, config::Config>,
    path: String,
    node_id: Option<String>,
) -> Result<model::Conversation, model::AppError> {
    let cfg = cfg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let valid = config::validate_session_path(&cfg, &path)?;
        sessions::conversation::get_conversation(&valid, node_id.as_deref())
    })
    .await
    .map_err(io_join_error)?
}

/// CONTRACT §4.4：树数据。
#[tauri::command]
async fn get_tree(
    cfg: tauri::State<'_, config::Config>,
    path: String,
) -> Result<model::TreeData, model::AppError> {
    let cfg = cfg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let valid = config::validate_session_path(&cfg, &path)?;
        sessions::tree::get_tree(&valid)
    })
    .await
    .map_err(io_join_error)?
}

/// CONTRACT §4.5：占用探测。
#[tauri::command]
async fn check_session(
    cfg: tauri::State<'_, config::Config>,
    path: String,
) -> Result<model::CheckSessionResult, model::AppError> {
    let cfg = cfg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let valid = config::validate_session_path(&cfg, &path)?;
        sessions::check_session(&valid, &cfg)
    })
    .await
    .map_err(io_join_error)?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::resolve(sessions_dir_arg());
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(cfg)
        .invoke_handler(tauri::generate_handler![
            get_config,
            list_sessions,
            get_conversation,
            get_tree,
            check_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
