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
pub mod mcp_config;
pub mod occupant;
pub mod omp_cli;
pub mod omp_plugins;
/// OPS 纯原语：删除 / iTerm / 分支标记（命令装配见 `ops::commands`）。
pub mod ops;
pub mod sessions;
pub mod usage;

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

/// CONTRACT §4.6：批量删除（逐路径独立结果，阻塞 IO 在后台线程）。
#[tauri::command]
async fn delete_sessions(
    cfg: tauri::State<'_, config::Config>,
    paths: Vec<String>,
) -> Result<Vec<model::DeleteResult>, model::AppError> {
    let cfg = cfg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ops::commands::delete_sessions_impl(&cfg, &paths))
        .await
        .map_err(io_join_error)
}

/// CONTRACT §4.7：从树节点续聊（追加 marker 行）。
#[tauri::command]
async fn append_branch_marker(
    cfg: tauri::State<'_, config::Config>,
    path: String,
    node_id: String,
) -> Result<model::AppendBranchMarkerResult, model::AppError> {
    let cfg = cfg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ops::commands::append_branch_marker_impl(&cfg, &path, &node_id)
    })
    .await
    .map_err(io_join_error)?
}

/// CONTRACT §4.8：在 iTerm 开新 tab 续聊。
#[tauri::command]
async fn open_in_iterm(
    cfg: tauri::State<'_, config::Config>,
    path: String,
) -> Result<(), model::AppError> {
    let cfg = cfg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ops::commands::open_in_iterm_impl(&cfg, &path, &ops::iterm::open_tab)
    })
    .await
    .map_err(io_join_error)?
}

/// CONTRACT §4.9：本地 omp 版本，不占写操作门禁。
#[tauri::command]
async fn omp_version() -> Result<model::OmpVersion, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        omp_cli::omp_version_impl(omp_cli::resolve_omp().as_deref())
    })
    .await
    .map_err(io_join_error)?
}

/// CONTRACT §4.10：只检查 omp 更新，不安装。
#[tauri::command]
async fn omp_update_check() -> Result<model::OmpUpdateCheck, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        omp_cli::omp_update_check_impl(omp_cli::resolve_omp().as_deref())
    })
    .await
    .map_err(io_join_error)?
}

/// CONTRACT §4.11：持有全局门禁，逐行推送实际更新日志。
#[tauri::command]
async fn omp_update_run(
    app: tauri::AppHandle,
    on_line: tauri::ipc::Channel<String>,
) -> Result<model::OmpUpdateResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let busy = app.state::<omp_cli::OmpBusy>();
        // 门禁留在阻塞任务内，调用方离开也不会提前释放。
        let _guard = busy.try_acquire()?;
        let bin = omp_cli::resolve_omp().ok_or_else(omp_cli::omp_not_found)?;
        omp_cli::omp_update_run_impl(&bin, omp_cli::UPDATE_TIMEOUT, &mut |line| {
            let _ = on_line.send(line.to_owned());
        })
    })
    .await
    .map_err(io_join_error)?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::resolve(sessions_dir_arg());
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 自动更新：updater 负责检查/下载/安装，process 负责安装后重启。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(cfg)
        .manage(omp_cli::OmpBusy::default())
        .manage(mcp_config::McpWriteState::default())
        .manage(std::sync::Arc::new(usage::UsageCache::default()))
        .invoke_handler(tauri::generate_handler![
            get_config,
            list_sessions,
            usage::get_session_usage,
            usage::get_usage_stats,
            get_conversation,
            get_tree,
            check_session,
            delete_sessions,
            append_branch_marker,
            open_in_iterm,
            omp_version,
            omp_update_check,
            omp_update_run,
            mcp_config::mcp_list,
            mcp_config::mcp_get_server,
            mcp_config::mcp_save_server,
            mcp_config::mcp_set_enabled,
            mcp_config::mcp_delete_server,
            omp_plugins::omp_plugins_list,
            omp_plugins::omp_plugin_discover,
            omp_plugins::omp_plugin_install,
            omp_plugins::omp_plugin_uninstall,
            omp_plugins::omp_plugin_set_enabled,
            omp_plugins::omp_plugin_upgrade,
            omp_plugins::omp_marketplace_update,
            omp_plugins::omp_marketplace_add,
            omp_plugins::omp_marketplace_remove,
            omp_plugins::omp_skills_list,
            omp_plugins::omp_skills_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
