//! OPS 三个 Tauri 命令的纯逻辑层（CONTRACT §4.6/§4.7/§4.8）。
//!
//! - 无 Tauri 依赖：输入为 `&Config` 与显式参数，可在集成测试中直接调用。
//! - 薄 `#[tauri::command]` 包装在 `crate` 根（`lib.rs`），只做
//!   `State` 取值 + `spawn_blocking`。
//! - `open_in_iterm_impl` 的终端 opener 可注入（`&dyn Fn`），
//!   生产传 `super::iterm::open_tab`，测试断言精确命令串而不启动 iTerm。

use std::path::Path;

use crate::config::{self, Config};
use crate::model::{AppError, AppendBranchMarkerResult, DeleteResult, ErrorCode};
use crate::sessions;

// ---------------------------------------------------------------------------
// delete_sessions（CONTRACT §4.6）
// ---------------------------------------------------------------------------

/// 逐路径独立删除，单个失败不中断批量。
pub fn delete_sessions_impl(cfg: &Config, paths: &[String]) -> Vec<DeleteResult> {
    paths.iter().map(|p| delete_one(cfg, p)).collect()
}

fn delete_one(cfg: &Config, path: &str) -> DeleteResult {
    let fail = |e: AppError| DeleteResult {
        path: path.to_owned(),
        ok: false,
        error: Some(e),
    };
    let valid = match config::validate_session_path(cfg, path) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    // header 决定会话 id → 锁文件名。header 不可读（损坏）时 id 未知，
    // 不敢删：NOT_FOUND 透出，其余一律 PROBE_FAILED（见 CONTRACT §4.6）。
    let info = match sessions::header_info(&valid) {
        Ok(info) => info,
        Err(e) => {
            return fail(if e.code == ErrorCode::NotFound {
                e
            } else {
                AppError::new(
                    ErrorCode::ProbeFailed,
                    format!(
                        "header 不可读，无法确定会话占用状态，不敢删除：{}",
                        e.message
                    ),
                )
            });
        }
    };
    refuse_if_locked(cfg, &info.id).map_or_else(
        || match super::delete::delete_session_files(&valid) {
            Ok(_) => {
                // 本应用删除成功才联动清应用侧条目（best-effort：失败静默，不影响删除结果）。
                crate::meta::prune_session_after_delete(&info.id);
                DeleteResult {
                    path: path.to_owned(),
                    ok: true,
                    error: None,
                }
            }
            Err(e) => fail(e),
        },
        fail,
    )
}

/// 占用门禁：`Some(err)` = 拒绝；`None` = 放行。
/// `open_in_iterm` 不用它（PROBE_FAILED 允许继续，见 §4.8）。
fn refuse_if_locked(cfg: &Config, session_id: &str) -> Option<AppError> {
    let p = crate::lock::probe(&cfg.owners_dir, session_id);
    if p.in_use {
        Some(AppError::new(
            ErrorCode::InUse,
            "会话正被 omp 进程占用，拒绝操作",
        ))
    } else if !p.probe_ok {
        Some(AppError::new(
            ErrorCode::ProbeFailed,
            "占用探测失败，不敢断言空闲，拒绝操作",
        ))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// append_branch_marker（CONTRACT §4.7）
// ---------------------------------------------------------------------------

/// 从树中部节点续聊：校验 → 上下文 → 探测 → 写 marker。
pub fn append_branch_marker_impl(
    cfg: &Config,
    path: &str,
    node_id: &str,
) -> Result<AppendBranchMarkerResult, AppError> {
    let valid = config::validate_session_path(cfg, path)?;
    // 非 v3 → UNSUPPORTED_FORMAT（marker_context 内）。
    let ctx = sessions::marker_context(&valid)?;
    if let Some(e) = refuse_if_locked(cfg, &ctx.session_id) {
        return Err(e);
    }
    // omp 从不校验 parentId（错 id 静默给出空分支），这道检查是唯一保护。
    if !ctx.kept_ids.contains(node_id) {
        return Err(AppError::new(
            ErrorCode::InvalidNode,
            format!("未知或非保留节点：{node_id}"),
        ));
    }
    if ctx.leaf_id.as_deref() == Some(node_id) {
        return Ok(AppendBranchMarkerResult { marker_id: None });
    }
    let marker_id = super::marker::new_marker_id(&ctx.all_ids);
    let line =
        super::marker::build_marker_line(&marker_id, node_id, &super::marker::now_iso_utc_ms());
    // 写前复探，把"探测→写"竞态窗口缩到最小。
    // 残余竞态（复探后 omp 恰好开始写）无法用 flock 完全消除：
    // O_APPEND 保证单次 write_all 行级原子，文件不会出现坏行，
    // 最坏是 marker 之后又多了别人的行（marker 不再是末行，分支被覆盖），
    // 调用方续聊前重查 leaf 即可发现。
    if let Some(e) = refuse_if_locked(cfg, &ctx.session_id) {
        return Err(e);
    }
    super::marker::append_marker_line(&valid, &line)?;
    Ok(AppendBranchMarkerResult {
        marker_id: Some(marker_id),
    })
}

// ---------------------------------------------------------------------------
// open_in_iterm（CONTRACT §4.8）
// ---------------------------------------------------------------------------

/// `open_in_iterm` / `resume_command_for` 共用的目标解析：校验会话路径 →
/// 读 header 的 cwd → 校验 cwd 为存在的绝对目录、无控制字符 → 会话路径无控制字符。
///
/// 抽出来的理由：右键菜单「复制续聊命令」必须用**同一套**校验，
/// 否则会出现「按钮能开、菜单不能复制」的不一致。
struct ResumeTarget {
    /// 规范化后的会话绝对路径。
    path: std::path::PathBuf,
    cwd: String,
    session_id: String,
}

fn resume_target(cfg: &Config, path: &str) -> Result<ResumeTarget, AppError> {
    let valid = config::validate_session_path(cfg, path)?;
    let info = sessions::header_info(&valid)?;
    let cwd = info.cwd.ok_or_else(|| {
        AppError::new(
            ErrorCode::CwdMissing,
            "会话未记录工作目录，无法打开".to_string(),
        )
    })?;
    let cwd_path = Path::new(&cwd);
    if !cwd_path.is_absolute() || !cwd_path.is_dir() {
        return Err(AppError::new(
            ErrorCode::CwdMissing,
            format!("记录的工作目录不存在：{cwd}"),
        ));
    }
    if cwd.chars().any(char::is_control) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "目录路径含控制字符，拒绝在 iTerm 中打开",
        ));
    }
    if valid.to_string_lossy().chars().any(char::is_control) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "会话路径含控制字符，拒绝在 iTerm 中打开",
        ));
    }
    Ok(ResumeTarget {
        path: valid,
        cwd,
        session_id: info.id,
    })
}

/// 在 iTerm 开新 tab 续聊。`opener` 为实际打开器（生产用
/// [`super::iterm::open_tab`]），测试注入桩以断言精确命令串。
pub fn open_in_iterm_impl(
    cfg: &Config,
    path: &str,
    opener: &dyn Fn(&str) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let target = resume_target(cfg, path)?;
    // 只读打开不占租约：IN_USE 拒绝，PROBE_FAILED 允许继续（CONTRACT §4.8）。
    let p = crate::lock::probe(&cfg.owners_dir, &target.session_id);
    if p.in_use {
        return Err(AppError::new(
            ErrorCode::InUse,
            "会话正被 omp 进程占用，拒绝在 iTerm 中打开",
        ));
    }
    opener(&super::iterm::resume_command(
        &target.cwd,
        &target.path.to_string_lossy(),
    ))?;
    Ok(())
}

/// 只生成续聊命令（右键菜单「复制 ▸ 续聊命令」用），不做占用探测：
/// 正在运行的会话也可能需要把命令粘到别处。
pub fn resume_command_impl(cfg: &Config, path: &str) -> Result<String, AppError> {
    let target = resume_target(cfg, path)?;
    Ok(super::iterm::resume_command(
        &target.cwd,
        &target.path.to_string_lossy(),
    ))
}

/// 在 Finder 中显示会话文件（`open -R <path>`）。`run` 可注入，便于测试。
pub fn reveal_session_file_impl(
    cfg: &Config,
    path: &str,
    run: &dyn crate::menubar::iterm::Runner,
) -> Result<(), AppError> {
    let valid = config::validate_session_path(cfg, path)?;
    let text = valid.to_string_lossy();
    if text.chars().any(char::is_control) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "会话路径含控制字符，拒绝在 Finder 中显示",
        ));
    }
    run.run("/usr/bin/open", &["-R", &text])
        .map(|_| ())
        .map_err(|s| AppError::new(ErrorCode::Io, format!("无法在 Finder 中显示：{s}")))
}

/// 在 Finder 中打开项目目录（`open <cwd>`）。校验规则与 `new_session_in_iterm_impl` 相同。
pub fn open_project_dir_impl(
    cwd: &str,
    run: &dyn crate::menubar::iterm::Runner,
) -> Result<(), AppError> {
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_absolute() || !cwd_path.is_dir() {
        return Err(AppError::new(
            ErrorCode::CwdMissing,
            format!("目录不存在或不是目录：{cwd}"),
        ));
    }
    if cwd.chars().any(char::is_control) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "目录路径含控制字符，拒绝在 Finder 中打开",
        ));
    }
    run.run("/usr/bin/open", &[cwd])
        .map(|_| ())
        .map_err(|s| AppError::new(ErrorCode::Io, format!("无法打开项目目录：{s}")))
}

// ---------------------------------------------------------------------------
// new_session_in_iterm（新开会话，无参数、不带 prompt）
// ---------------------------------------------------------------------------

/// 在 iTerm 于 `cwd` 新开 omp 会话（仅执行 `cd '<cwd>' && omp`）。
/// `cwd` 须为存在的绝对目录（否则 `CWD_MISSING`）；含控制字符则拒绝
/// （AppleScript 转义会静默剥离它们，可能改变实际 cd 目标）。
pub fn new_session_in_iterm_impl(
    cwd: &str,
    opener: &dyn Fn(&str) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_absolute() || !cwd_path.is_dir() {
        return Err(AppError::new(
            ErrorCode::CwdMissing,
            format!("目录不存在或不是目录：{cwd}"),
        ));
    }
    if cwd.chars().any(char::is_control) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "目录路径含控制字符，拒绝在 iTerm 中打开",
        ));
    }
    opener(&super::iterm::new_session_command(cwd))
}
