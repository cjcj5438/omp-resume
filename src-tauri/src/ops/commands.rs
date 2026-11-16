//! OPS 三个 Tauri 命令的纯逻辑层（CONTRACT §4.6/§4.7/§4.8）。
//!
//! - 无 Tauri 依赖：输入为 `&Config` 与显式参数，可在集成测试中直接调用。
//! - 薄 `#[tauri::command]` 包装在 `crate` 根（`lib.rs`），只做
//!   `State` 取值 + `spawn_blocking`。
//! - `open_in_iterm_impl` 的终端 opener 可注入（`&dyn Fn`），生产传
//!   `super::iterm::open_tab_tracked`（返回本次新标签页的 `id`/`tty`），
//!   测试注入桩断言精确命令串而不启动 iTerm；成功判定见
//!   [`open_tracked_and_confirm`]（必须有绑定本次 tty 的启动证据）。

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

/// `CWD_MISSING` 文案：路径首尾若有空白字符（空格可为目录名一部分，用户却看不见），
/// 追加去歧义提示。只调文案，不改错误码与拒绝语义。
fn cwd_missing_message(prefix: &str, cwd: &str) -> String {
    let mut message = format!("{prefix}：{cwd}");
    if cwd != cwd.trim() {
        message.push_str("（注意：路径首尾含空格，请确认目录名是否以空格开头或结尾）");
    }
    message
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
            cwd_missing_message("记录的工作目录不存在", &cwd),
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

/// 在 iTerm 开新 tab 续聊，并确认**这个标签页里真的启动了 omp**。
///
/// `opener` 为带身份的打开器（生产用 [`super::iterm::open_tab_tracked`]）：
/// 返回本次新建标签页的 `(session id, tty)`。门禁顺序：路径/cwd/控制字符校验
/// → 租约 `IN_USE` 拒绝（`PROBE_FAILED` 放行，§4.8）→ `ps` 快照（不可用即
/// `ITERM_FAILED`，此时尚未产生任何副作用）→ 开标签页 → 等待启动证据
/// （见 [`started_evidence`]）。没有任何证据不报成功。
///
/// 10 秒上限 + 100ms 轮询：每轮只做一次廉价 flock 探测，只有探测到占用
/// 才 `lsof` 解析持有者、只有 `ps` 有候选才查该进程 tty。
pub fn open_in_iterm_impl(
    cfg: &Config,
    path: &str,
    opener: &dyn Fn(&str) -> Result<(String, String), AppError>,
) -> Result<(), AppError> {
    open_in_iterm_impl_observed(
        cfg,
        path,
        opener,
        super::iterm::RESUME_CONFIRM_TIMEOUT,
        &|session_path: &str| super::iterm::matching_pids(session_path),
        &|session_id, session_path, tty, before| {
            started_evidence(&cfg.owners_dir, session_id, session_path, tty, before)
        },
        &super::iterm::diagnostic_tail_for_session,
    )
}

/// [`open_in_iterm_impl`] 的测试缝：可注入确认超时、启动证据、失败诊断与
/// `ps` 快照。所有参数默认由 [`open_in_iterm_impl`] 传生产实现。
///
/// `snapshot(session_path)` 为开标签页前的进程快照（生产
/// `matching_pids`；返回 `Err` 即 `ITERM_FAILED` 且不开标签页）；
/// `evidence(session_id, session_path, tracked_tty, before)` 判断本次标签页
/// 是否已有启动证据（`before` 为该快照）；`diagnostic(tab_id)` 取该标签页
/// 尾部输出（生产 `diagnostic_tail_for_session`）。
pub fn open_in_iterm_impl_observed(
    cfg: &Config,
    path: &str,
    opener: &dyn Fn(&str) -> Result<(String, String), AppError>,
    timeout: std::time::Duration,
    snapshot: &dyn Fn(&str) -> Result<std::collections::HashSet<u32>, String>,
    evidence: &dyn Fn(
        &str,
        &str,
        &str,
        &std::collections::HashSet<u32>,
    ) -> bool,
    diagnostic: &dyn Fn(&str) -> String,
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
    let session_path = target.path.to_string_lossy().into_owned();
    // 启动前的 `omp --resume <该路径>` 进程快照：ps 不可用时在此失败，
    // 早于开标签页/写键等一切副作用。
    let before = snapshot(&session_path).map_err(|e| {
        AppError::new(
            ErrorCode::ItermFailed,
            format!("无法校验 omp 是否启动（ps 不可用）：{e}"),
        )
    })?;
    let command = super::iterm::resume_command(&target.cwd, &session_path);
    open_tracked_and_confirm(
        &command,
        timeout,
        opener,
        &|tty: &str| evidence(&target.session_id, &session_path, tty, &before),
        diagnostic,
    )
}

/// 开标签页 + 轮询启动证据；成功只在证据成立时返回。
///
/// 也作为测试缝：`evidence` 收到本次新建标签页的 `tty`（返回是否有绑定该
/// tty 的启动证据），`diagnostic` 收到该标签页 session `id`。生产由
/// [`open_in_iterm_impl`] 传真实实现。
///
/// 超时**保留**标签页、不重发任何按键、不猜根因：错误里给出确切命令与该
/// 标签页尾部输出（只取本次 session，不合并其他标签页）。
pub fn open_tracked_and_confirm(
    command: &str,
    timeout: std::time::Duration,
    opener: &dyn Fn(&str) -> Result<(String, String), AppError>,
    evidence: &dyn Fn(&str) -> bool,
    diagnostic: &dyn Fn(&str) -> String,
) -> Result<(), AppError> {
    let (tab_id, tty) = opener(command)?;
    if tty.is_empty() {
        return Err(AppError::new(
            ErrorCode::ItermFailed,
            format!(
                "已创建 iTerm2 标签页，但未能读回其终端 tty，无法确认 omp 是否启动。\n\
                 执行的命令：{command}"
            ),
        ));
    }
    let started = super::iterm::wait_until_started(
        timeout,
        super::iterm::RESUME_CONFIRM_INTERVAL,
        || evidence(&tty),
    );
    if started {
        return Ok(());
    }
    let mut message = format!(
        "已创建 iTerm2 标签页，但 {} 秒内未检测到 omp 启动该会话。\n执行的命令：{command}",
        timeout.as_secs()
    );
    let tail = diagnostic(&tab_id);
    if !tail.is_empty() {
        message.push_str(&format!("\n标签页当前输出：\n{tail}"));
    }
    message.push_str("\n可再次点击「打开标签页」重试，或先在该标签页里手动执行上面显示的命令。");
    Err(AppError::new(ErrorCode::ItermFailed, message))
}

/// 本次新建标签页的启动证据（保守，必须能归属到**这一个 tab**）：
///
/// 1. 租约：先做一次廉价 flock 探测；被占用才 `lsof` 解析持有者，持有者
///    是启动前不存在的新进程且控制终端就是本次 tty → 成功；
/// 2. 进程：一次 `ps` 快照，过滤启动前已有/已查过的 pid，逐个查控制终端，
///    有命中即成功。
///
/// 只看「有锁」「有 omp 进程」「app 名是 iTerm2」都不算证据：别的窗口/终端
/// 抢占同一会话时 tty 不同，必须判否（否则会假成功）。轮询期间任何观测
/// 失败都按「未确认」处理，继续重试。
fn started_evidence(
    owners_dir: &Path,
    session_id: &str,
    session_path: &str,
    tracked_tty: &str,
    before: &std::collections::HashSet<u32>,
) -> bool {
    use crate::menubar::iterm::{tty_of_pid, SystemRunner};

    // 至多一个租约持有者 pid 需要去重，用 Option 而不是 HashMap/Set。
    let mut lease_pid: Option<u32> = None;
    if crate::lock::probe(owners_dir, session_id).in_use {
        let ids = [session_id.to_owned()];
        if let Some(occ) = crate::occupant::resolve_occupants(owners_dir, &ids).remove(session_id) {
            lease_pid = Some(occ.pid);
            if !before.contains(&occ.pid)
                && super::iterm::tty_matches_start(
                    tracked_tty,
                    tty_of_pid(occ.pid, &SystemRunner).as_deref(),
                )
            {
                return true;
            }
        }
    }
    match super::iterm::matching_pids(session_path) {
        Ok(now) => now.iter().any(|pid| {
            !before.contains(pid)
                && lease_pid != Some(*pid)
                && super::iterm::tty_matches_start(
                    tracked_tty,
                    tty_of_pid(*pid, &SystemRunner).as_deref(),
                )
        }),
        Err(_) => false,
    }
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

/// 通用「在 Finder 中显示文件」（`open -R <path>`，CONTRACT §4.72）：绝对路径 +
/// 存在 + 是文件 + 无控制字符才执行；`run` 可注入，便于测试。
pub fn reveal_file_impl(
    path: &str,
    run: &dyn crate::menubar::iterm::Runner,
) -> Result<(), AppError> {
    let file = Path::new(path);
    if !file.is_absolute() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "只能在 Finder 中显示绝对路径",
        ));
    }
    if path.chars().any(char::is_control) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "路径含控制字符，拒绝在 Finder 中显示",
        ));
    }
    if !file.is_file() {
        return Err(AppError::new(
            ErrorCode::NotFound,
            format!("文件不存在：{path}"),
        ));
    }
    run.run("/usr/bin/open", &["-R", path])
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
            cwd_missing_message("目录不存在或不是目录", cwd),
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
// new_session_in_iterm（新开会话；除可选 --model 外不带参数、不带 prompt）
// ---------------------------------------------------------------------------

/// 模型名上限（字符数，见 CONTRACT §9 `MODEL_ARG_MAX`）。
pub const MODEL_ARG_MAX_CHARS: usize = 256;

/// 在 iTerm 于 `cwd` 新开 omp 会话（`cd '<cwd>' && omp [--model '<model>']`）。
/// `cwd` 须为存在的绝对目录（否则 `CWD_MISSING`）；含控制字符则拒绝
/// （AppleScript 转义会静默剥离它们，可能改变实际 cd 目标）。
/// `model` 为空/全空白时等同 None（裸 `omp`）；否则须 ≤256 字、无控制字符、
/// 不以 `-` 开头（否则 `INVALID_INPUT`，防 `--model` 后跟出任意 flag）。
pub fn new_session_in_iterm_impl(
    cwd: &str,
    model: Option<&str>,
    opener: &dyn Fn(&str) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_absolute() || !cwd_path.is_dir() {
        return Err(AppError::new(
            ErrorCode::CwdMissing,
            cwd_missing_message("目录不存在或不是目录", cwd),
        ));
    }
    if cwd.chars().any(char::is_control) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "目录路径含控制字符，拒绝在 iTerm 中打开",
        ));
    }
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = model {
        if m.chars().count() > MODEL_ARG_MAX_CHARS || m.chars().any(char::is_control) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "模型名不合法（≤256 字、无控制字符）",
            ));
        }
        if m.starts_with('-') {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "模型名不能以 `-` 开头",
            ));
        }
    }
    opener(&super::iterm::new_session_command(cwd, model))
}

// ---------------------------------------------------------------------------
// focus_iterm_tab（在用恢复确认框的「切到正在运行的标签页」）
// ---------------------------------------------------------------------------

/// 聚焦占用会话的 iTerm 标签：校验 → probe（须 inUse）→ occupant（须 iTerm2）→
/// tty → `focus_tty`（只 activate+select，绝不写键）。
/// `run` 为命令执行器（生产用 `menubar::iterm::SystemRunner`）。
pub fn focus_iterm_tab_impl(
    cfg: &Config,
    path: &str,
    run: &dyn crate::menubar::iterm::Runner,
) -> Result<(), AppError> {
    let valid = config::validate_session_path(cfg, path)?;
    let id = sessions::session_id_of(&sessions::parse::parse_file(&valid)?, &valid);
    let p = crate::lock::probe(&cfg.owners_dir, &id);
    if !p.probe_ok {
        return Err(AppError::new(
            ErrorCode::ProbeFailed,
            "占用探测失败，不敢聚焦",
        ));
    }
    if !p.in_use {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "该会话当前未被占用，无需聚焦",
        ));
    }
    let occ = crate::occupant::resolve_occupants(&cfg.owners_dir, std::slice::from_ref(&id))
        .remove(&id)
        .ok_or_else(|| AppError::new(ErrorCode::ItermFailed, "未找到占用进程，无法聚焦"))?;
    if occ.app.as_deref() != Some("iTerm2") {
        return Err(AppError::new(
            ErrorCode::ItermFailed,
            "仅 iTerm 中的会话可聚焦",
        ));
    }
    let tty = crate::menubar::iterm::tty_of_pid(occ.pid, run)
        .ok_or_else(|| AppError::new(ErrorCode::ItermFailed, "未找到占用进程的终端，无法聚焦"))?;
    crate::menubar::iterm::focus_tty(&tty, run)
        .map_err(|e| AppError::new(ErrorCode::ItermFailed, e.message()))
}

