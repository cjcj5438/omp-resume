//! Superagent 守护进程托管：启动、就绪探测、退出回收、崩溃退避重启。
//!
//! - `Supervisor` 经 Tauri `.manage()` 注册为全局单例，内部 `Arc<Mutex<Inner>>`；
//! - 同一时刻最多一个守护进程：`start` 前先确认没有存活子进程（单实例守卫）；
//! - 就绪线程轮询 `GET state`，60 秒未就绪则杀掉并置 `Crashed`；
//! - 等待线程回收子进程：非预期退出按退避表自动重启，退出码 3（另一个守护
//!   进程占用）不重启；
//! - `stop` 走 SIGTERM（15 秒）→ SIGKILL（5 秒）的两段关闭。

use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::model::{AppError, AppResult, ErrorCode, SuperagentState, SuperagentStatus};

/// 就绪探测轮询间隔。
const READY_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// 就绪探测总时限。
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// 停止等待 SIGTERM 的时限。
const STOP_TERM_TIMEOUT: Duration = Duration::from_secs(15);
/// SIGKILL 后的回收时限。
const STOP_KILL_TIMEOUT: Duration = Duration::from_secs(5);
/// 运行超过此时长即视为稳定，本轮崩溃计数重置。
const STABLE_RUN: Duration = Duration::from_secs(600);
/// 日志轮转阈值 5 MiB。
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// 守护进程的“已被占用”退出码：另一个实例持有状态目录或 socket。
const EXIT_ALREADY_RUNNING: i32 = 3;
/// 崩溃退避表（秒），按 `crashes` 下标取值，超界取末项。
const BACKOFF_SECS: [u64; 6] = [1, 2, 5, 10, 30, 60];
/// 退出码 3 停摆后的复查节奏（秒，按已复查次数取，超界取末项）。
/// 前几档短、后几档长：被 SIGKILL 的前任留下 `<state>.lock`（`proper-lockfile`
/// `stale` 30 秒）时，累积约 32 秒即能抢到锁；真被活着的守护进程持有时，
/// 每档只做一次廉价的 socket 探测，绝不争抢。上限 = 表长（10 次，约 5 分钟），
/// 之后停摆等用户手动重启。
const CONFLICT_BACKOFF_SECS: [u64; 10] = [2, 5, 10, 15, 30, 60, 60, 60, 60, 60];
/// 接管孤儿守护进程时等待 SIGTERM 的时限。
const RECLAIM_TERM_TIMEOUT: Duration = Duration::from_secs(20);
/// 接管孤儿守护进程时等待 SIGKILL 的时限。
const RECLAIM_KILL_TIMEOUT: Duration = Duration::from_secs(5);
/// `ps` 查询绝对路径（GUI 应用 PATH 极简，必须写死）。
const PS_BIN: &str = "/bin/ps";
/// `ps` 查询硬超时：超时则视为核验失败。
const PS_TIMEOUT: Duration = Duration::from_secs(5);
/// 守护进程入口在命令行中的标记（新旧启动方式都包含它）。
const DAEMON_ENTRY_MARKER: &str = "dist/daemon.js";
/// 内部可变状态（持锁时间只覆盖字段读写，绝不覆盖阻塞等待）。
struct Inner {
    enabled: bool,
    state: SuperagentState,
    pid: Option<u32>,
    started_at: Option<String>,
    restarts: u32,
    crashes: u32,
    last_error: Option<String>,
    /// schema 失配明细：只在预检拦停（`Incompatible`）时为 `Some`，
    /// 手动 `restart`/`set_enabled(true)` 重跑预检前清掉。
    schema: Option<crate::model::SuperagentSchema>,
    /// 最近一次一键恢复的归档目录绝对路径：`reset_state` 写入，
    /// 下次成功 spawn 后清掉（`last_error` 不掺这个路径：服务页把它渲染成「最近错误」）。
    archived_to: Option<String>,
    /// 代际：每次 `start`/`stop` 递增，旧线程凭此自杀。
    generation: u64,
    /// 退出码 3 停摆后的已复查次数：跨轮累计（每轮停摆都算一次），
    /// 到 `CONFLICT_BACKOFF_SECS` 的表长即停止自愈；`restart()`/`set_enabled(true)`
    /// 复位，让用户手点的重启重新获得完整的复查预算。
    conflict_retries: u32,
    /// 存活的子进程句柄（等待线程接管后为 None）。
    child: Option<Child>,
    /// 子进程启动时刻（稳定运行判定用）。
    started_instant: Option<Instant>,
}

/// 守护进程监管器（Tauri 全局单例）。
#[derive(Clone)]
pub struct Supervisor {
    app: Option<tauri::AppHandle>,
    data_dir: PathBuf,
    inner: Arc<Mutex<Inner>>,
    /// `--print-schema` 探测缓存：一次 spawn 开销只付一次，进程内有效。
    /// 守护进程版本随应用版本固定，运行中不会变化。
    daemon_schema: Arc<Mutex<Option<(u32, u32)>>>,
}

impl Supervisor {
    pub fn new(app: tauri::AppHandle, data_dir: PathBuf) -> Self {
        Self::with_app(Some(app), data_dir)
    }

    /// 测试构造器：无 AppHandle，`assets_dir` 只走环境变量覆盖路径。
    #[cfg(test)]
    fn for_test(data_dir: PathBuf) -> Self {
        Self::with_app(None, data_dir)
    }

    fn with_app(app: Option<tauri::AppHandle>, data_dir: PathBuf) -> Self {
        let enabled = super::settings::load(&data_dir).enabled;
        Self {
            app,
            data_dir,
            inner: Arc::new(Mutex::new(Inner {
                enabled,
                state: if enabled {
                    SuperagentState::Stopped
                } else {
                    SuperagentState::Disabled
                },
                pid: None,
                started_at: None,
                restarts: 0,
                crashes: 0,
                last_error: None,
                schema: None,
                archived_to: None,
                generation: 0,
                conflict_retries: 0,
                child: None,
                started_instant: None,
            })),
            daemon_schema: Arc::new(Mutex::new(None)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn state_dir(&self) -> PathBuf {
        super::paths::state_dir(&self.data_dir)
    }

    /// 资源目录：有 AppHandle 走完整顺序，无（测试）只走环境变量覆盖。
    fn assets_dir(&self) -> Option<PathBuf> {
        match &self.app {
            Some(app) => super::paths::assets_dir(app),
            None => super::paths::env_assets_dir(),
        }
    }

    /// 守护进程 schema 范围（带进程内缓存）：`--print-schema` 的 spawn 开销
    /// 只付一次。探测与 spawn 环境一致，失败 ⇒ `None`（预检按 `Unknown` 放行）。
    fn daemon_schema_cached(
        &self,
        assets: &std::path::Path,
        omp: &std::path::Path,
    ) -> Option<(u32, u32)> {
        if let Some(cached) = *self
            .daemon_schema
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            return Some(cached);
        }
        let probed = super::schema::daemon_schema(assets, omp);
        if let Some(range) = probed {
            *self
                .daemon_schema
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(range);
        }
        probed
    }

    /// 当前状态快照（供命令层与前端轮询）。
    ///
    /// 只持锁做字段拷贝：`resolve_omp`/`assets_dir` 的文件探测在锁外执行，
    /// 避免 3 秒一次的轮询与启停路径互相拖慢。
    pub fn status(&self) -> SuperagentStatus {
        let (state, enabled, pid, started_at, restarts, last_error, schema, archived_to) = {
            let inner = self.lock();
            (
                inner.state,
                inner.enabled,
                inner.pid,
                inner.started_at.clone(),
                inner.restarts,
                inner.last_error.clone(),
                inner.schema.clone(),
                inner.archived_to.clone(),
            )
        };
        let state_dir = self.state_dir();
        let omp_bin = crate::omp_cli::resolve_omp().map(|p| p.display().to_string());
        SuperagentStatus {
            state,
            enabled,
            pid,
            started_at,
            restarts,
            last_error,
            state_dir: state_dir.display().to_string(),
            socket_path: super::paths::socket_path(&state_dir).display().to_string(),
            log_path: super::paths::log_path(&state_dir).display().to_string(),
            assets_dir: self.assets_dir().map(|p| p.display().to_string()),
            omp_bin,
            schema,
            archived_to,
        }
    }

    /// 启用/停用：先落盘，再按需启停。落盘失败时不碰进程。
    pub fn set_enabled(&self, enabled: bool) -> AppResult<SuperagentStatus> {
        super::settings::save(
            &self.data_dir,
            &super::settings::SuperagentSettings { enabled },
        )?;
        {
            let mut inner = self.lock();
            inner.enabled = enabled;
            // 重跑预检前清掉旧的失配明细（stop() 不碰它）。
            inner.schema = None;
            // 用户显式启用：退出码 3 的自愈复查预算重新给满。
            inner.conflict_retries = 0;
        }
        if enabled {
            // start() 失败（找不到 omp/资源目录）时返回 Err，但 enabled
            // 已落盘为 true：状态置 Crashed，前端显示错误而非静默禁用。
            self.start()?;
        } else {
            self.stop();
        }
        Ok(self.status())
    }

    /// 重启：未启用时拒绝；否则先停再起。
    pub fn restart(&self) -> AppResult<SuperagentStatus> {
        if !self.lock().enabled {
            return Err(AppError::new(ErrorCode::InvalidInput, "Superagent 未启用"));
        }
        self.stop();
        // 重跑预检前清掉旧的失配明细（stop() 不碰它）。
        {
            let mut inner = self.lock();
            inner.schema = None;
            // 用户显式重启：退出码 3 的自愈复查预算重新给满。
            inner.conflict_retries = 0;
        }
        self.start()?;
        Ok(self.status())
    }

    /// 一键恢复：仅在 `Incompatible` 时可用。把整个状态目录改名归档
    /// （`<state_dir>.schema-<n>-<YYYYMMDD-HHMMSS>`，永不删除），重建空目录
    /// 后重启守护进程，返回新状态。归档名冲突时追加 `-2`、`-3`…。
    /// 归档路径进 `archived_to`（服务页单独展示）；`last_error` 留给新目录的
    /// 启动结果，不掺归档路径。
    pub fn reset_state(&self) -> AppResult<SuperagentStatus> {
        let schema = {
            let inner = self.lock();
            if !matches!(inner.state, SuperagentState::Incompatible) || inner.schema.is_none() {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "当前状态无需重置：仅 schema 不兼容时可用",
                ));
            }
            inner.schema.clone().expect("checked above")
        };
        self.stop();
        let state_dir = self.state_dir();
        let archived = archive_state_dir(&state_dir, schema.state)?;
        append_log_line(
            &super::paths::log_path(&state_dir),
            &format!(
                "[supervisor] archived incompatible state dir (schema {}) to {}",
                schema.state,
                archived.display()
            ),
        );
        // 重跑预检前清掉旧的失配明细（stop() 不碰它）。
        self.lock().schema = None;
        self.start()?;
        // start() 的预占已清掉旧 archived_to：这里记下本轮的新归档。
        self.lock().archived_to = Some(archived.display().to_string());
        Ok(self.status())
    }

    /// 启动时调用：仅当开关启用时拉起守护进程。
    /// `setup` 中调用：失败只记 `last_error`，不阻断应用启动。
    ///
    /// spawn 本身很快（fork+exec，不等就绪）：就绪探测在后台线程，
    /// 不阻塞应用启动。
    pub fn start_if_enabled(&self) {
        if !self.lock().enabled {
            return;
        }
        if let Err(e) = self.start() {
            self.lock().last_error = Some(e.message);
        }
    }

    /// 退出时调用：阻塞式停止守护进程（幂等）。
    ///
    /// 从未启动时（无 pid、无 child 句柄）直接返回，不发任何信号、
    /// 不改状态机（保持 Disabled），最多 20 秒（SIGTERM 15s + SIGKILL 5s）。
    pub fn stop_blocking(&self) {
        self.stop();
    }

    /// 启动守护进程。已有存活进程时直接返回（单实例守卫）。
    ///
    /// 并发 `start()`（退避重启与手动 restart 同时触发）只允许一个 spawn：
    /// 以「预占 Starting 状态」为互斥：守卫段内若已是 Starting/Running/
    /// Stopping，直接返回；否则先置 Starting 再释放锁去做 spawn，spawn
    /// 失败时回滚状态（见 spawn 失败分支）。
    ///
    /// 崩溃残留的孤儿守护进程（force-quit 后 ppid=1 的旧实例）若仍占着状态
    /// 目录，新 spawn 会秒退（退出码 3）：`start` 在 spawn 前先按 pid 文件
    /// 尝试接管（`reclaim_orphan`，至多一次），接管成功后正常 spawn。
    fn start(&self) -> AppResult<()> {
        // 单实例守卫：先确认没有存活子进程，并预占 Starting。
        {
            let mut inner = self.lock();
            if let Some(child) = inner.child.as_mut() {
                match child.try_wait() {
                    Ok(None) => return Ok(()),
                    // 已退出或 try_wait 出错：清掉僵尸句柄，继续启动。
                    // try_wait 出错只可能是 OS 级异常（句柄有效时不会发生），
                    // 保守清掉并继续 spawn，而不是卡死在旧句柄上。
                    _ => {
                        inner.child = None;
                        inner.pid = None;
                    }
                }
            }
            if matches!(
                inner.state,
                SuperagentState::Starting | SuperagentState::Running | SuperagentState::Stopping
            ) {
                return Ok(());
            }
            // 预占：阻止并发 start() 重复 spawn。
            inner.state = SuperagentState::Starting;
            inner.pid = None;
            inner.last_error = None;
            // 旧的归档路径不留到下一轮：reset 的新值由 reset_state 在 start 之后写。
            inner.archived_to = None;
            inner.generation += 1;
        }
        let generation = self.lock().generation;
        // 此时锁已释放：接管（SIGTERM 20s + SIGKILL 5s）与 spawn 慢路径全在锁外，
        // `status()` 轮询永不排队；代际在预占时已递增，接管中途的 stop/disable
        // 会再次递增代际，接管循环凭此中断。
        self.start_after_guard(generation, true)
    }

    /// 预占（Starting + 代际）之后的启动慢路径：接管孤儿 → spawn。
    ///
    /// `allow_reclaim` 只在用户/退避触发的 `start()` 入口为 true；spawn 失败
    /// 后的二次接管直接再调一次 `spawn_daemon`，不再递归接管（至多一次）。
    fn start_after_guard(&self, generation: u64, allow_reclaim: bool) -> AppResult<()> {
        if self.is_stale_generation(generation) {
            return Ok(());
        }
        let Some(omp) = crate::omp_cli::resolve_omp() else {
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.state = SuperagentState::Crashed;
                inner.last_error =
                    Some("未找到 omp，请安装 omp 或设置 OMP_RESUME_OMP_BIN".to_string());
            }
            return Err(crate::omp_cli::omp_not_found());
        };
        let Some(assets) = self.assets_dir() else {
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.state = SuperagentState::Crashed;
                inner.last_error = Some("找不到 Superagent 资源目录".to_string());
            }
            return Err(AppError::new(ErrorCode::Io, "找不到 Superagent 资源目录"));
        };
        let state_dir = self.state_dir();
        let log_path = super::paths::log_path(&state_dir);
        let socket_path = super::paths::socket_path(&state_dir);
        let daemon_js = assets.join("dist/daemon.js");
        // debug 首次运行：把生产库拷进 `superagent-dev/`（幂等，见 `paths`）。
        if super::paths::seed_dev_state_dir(&self.data_dir) {
            let _ = std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(log_path.parent().unwrap_or(&state_dir));
            append_log_line(
                &log_path,
                "[supervisor] seeded superagent-dev from production superagent state",
            );
            eprintln!("superagent: 已从生产状态目录拷入 superagent-dev（仅 debug 首次运行）");
        }
        // schema 预检：拦住必定秒退的启动（低版本守护进程打不开高版本库），
        // 置 `Incompatible` 并停住——不定退避、不 spawn、不碰生产库。
        // 探测（`--print-schema` 子进程）在锁外跑，最长 10 秒。
        {
            let daemon = self.daemon_schema_cached(&assets, &omp);
            let state_db = super::schema::read_state_schema(&super::schema::db_path(&state_dir));
            match (super::schema::check(state_db, daemon), daemon) {
                (super::schema::Check::Compatible | super::schema::Check::Unknown, _) => {}
                (mismatch, Some((oldest, newest))) => {
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        let (schema, last_error) = mismatch_status(mismatch, oldest, newest);
                        inner.state = SuperagentState::Incompatible;
                        inner.schema = Some(schema);
                        inner.last_error = Some(last_error);
                    }
                    return Ok(());
                }
                // 失配结论必然带着守护进程范围：此分支不可达，保守放行。
                (_, None) => {}
            }
            if self.is_stale_generation(generation) {
                return Ok(());
            }
        }
        // 接管日志先于目录创建：`append_log_line` 不建父目录，spawn 前接管
        // 时 logs/ 可能尚不存在——这里预建目录（0700），失败则跳过接管日志
        // （接管本身不受影响，spawn 慢路径会再建一次并报错）。
        if allow_reclaim {
            let _ = std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(log_path.parent().unwrap_or(&state_dir));
        }
        // 崩溃残留的孤儿守护进程仍占着状态目录时，新 spawn 会秒退（退出码 3）：
        // spawn 前先按 pid 文件尝试接管，至多一次（接管内部不再递归）。
        // 接管中途的 stop()/disable 会递增代际：发现代际变化即放弃启动，
        // 不在此处改状态（stop 侧已定）。
        // 退出码 3 的二次接管在等待线程（`on_already_running_exit`）：spawn 是
        // 异步的，秒退发生在 `child.wait()` 返回时，不在 `spawn_daemon` 的错
        // 误里——这里只做 spawn 前接管。
        if allow_reclaim {
            match self.reclaim_orphan(&state_dir, generation) {
                ReclaimOutcome::Reclaimed { pid } => {
                    append_log_line(
                        &log_path,
                        &format!("[supervisor] reclaimed orphaned daemon pid {pid}"),
                    );
                }
                ReclaimOutcome::Interrupted => return Ok(()),
                // 残留 pid 文件指向已死进程：已就地清掉，等价于无孤儿，继续 spawn。
                ReclaimOutcome::NoPidFile | ReclaimOutcome::StaleCleaned => {}
                ReclaimOutcome::Refused { reason } => {
                    append_log_line(
                        &log_path,
                        &format!("[supervisor] reclaim refused: {reason}"),
                    );
                }
            }
            // 退避重启线程调 start 时的代际检查与上面 reclaim 内部的中断检查
            // 语义一致：stop/disable/restart 任一都会递增代际。
            if self.is_stale_generation(generation) {
                return Ok(());
            }
        }
        self.spawn_daemon(
            &state_dir,
            &log_path,
            &socket_path,
            &daemon_js,
            &omp,
            generation,
        )
    }

    /// spawn 前的慢路径：建目录 → 开日志 → spawn → 起就绪/等待线程。
    ///
    /// 只有同代际才写状态：接管/建目录/spawn 任一步中途的 stop/disable 会
    /// 递增代际，此时放弃启动、不碰 stop 侧已定的状态。
    fn spawn_daemon(
        &self,
        state_dir: &std::path::Path,
        log_path: &std::path::Path,
        socket: &std::path::Path,
        daemon: &std::path::Path,
        omp: &std::path::Path,
        generation: u64,
    ) -> AppResult<()> {
        if self.is_stale_generation(generation) {
            return Ok(());
        }
        if let Err(message) = (|| -> Result<(), String> {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(state_dir)
                .map_err(|e| format!("无法创建 Superagent 状态目录：{e}"))?;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(state_dir.join("logs"))
                .map_err(|e| format!("无法创建 Superagent 日志目录：{e}"))?;
            Ok(())
        })() {
            // 预占回滚：目录建不出来时不能卡在 Starting。
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.state = SuperagentState::Crashed;
                inner.last_error = Some(message.clone());
            }
            return Err(AppError::new(ErrorCode::Io, message));
        }
        if self.is_stale_generation(generation) {
            return Ok(());
        }
        let log_file = match open_log(log_path) {
            Ok(f) => f,
            Err(e) => {
                let mut inner = self.lock();
                if inner.generation == generation {
                    inner.state = SuperagentState::Crashed;
                    inner.last_error = Some(e.message.clone());
                }
                return Err(e);
            }
        };
        let mut command = Command::new(omp);
        command
            .arg("run")
            .arg(daemon)
            .args([
                "--state-dir",
                &state_dir.display().to_string(),
                "--socket",
                &socket.display().to_string(),
                "--omp",
                &omp.display().to_string(),
            ])
            .env("BUN_BE_BUN", "1")
            .env("NO_COLOR", "1")
            .env("PATH", crate::omp_cli::augmented_path())
            .current_dir(state_dir)
            .stdin(Stdio::null())
            .stdout(match log_file.try_clone() {
                Ok(f) => f,
                Err(e) => {
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        inner.state = SuperagentState::Crashed;
                        inner.last_error = Some(format!("无法重定向守护进程日志：{e}"));
                    }
                    return Err(AppError::new(
                        ErrorCode::Io,
                        format!("无法重定向守护进程日志：{e}"),
                    ));
                }
            })
            .stderr(log_file);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                let mut inner = self.lock();
                if inner.generation == generation {
                    inner.state = SuperagentState::Crashed;
                    inner.last_error = Some(format!("无法启动 Superagent 守护进程：{e}"));
                }
                return Err(AppError::new(
                    ErrorCode::Io,
                    format!("无法启动 Superagent 守护进程：{e}"),
                ));
            }
        };
        let pid = child.id();
        {
            let mut inner = self.lock();
            if inner.generation != generation {
                // spawn 间隙被 stop/disable 抢占：刚出生的子进程归我们管，
                // 就地杀掉回收，不留孤儿；状态由 stop 侧定。
                drop(inner);
                kill_newborn(child, pid);
                return Ok(());
            }
            inner.child = Some(child);
            inner.state = SuperagentState::Starting;
            inner.pid = Some(pid);
            inner.started_at = Some(now_iso());
            inner.started_instant = Some(Instant::now());
            inner.last_error = None;
        }
        self.spawn_ready_thread(generation, pid, socket.to_path_buf());
        self.spawn_wait_thread(generation);
        Ok(())
    }

    /// 当前代际是否已过期（stop/disable/restart 接管过）。
    fn is_stale_generation(&self, generation: u64) -> bool {
        self.lock().generation != generation
    }

    /// 接管崩溃残留的孤儿守护进程（至多一次，不递归）。
    ///
    /// 触发条件：`<state_dir>/daemon.pid` 存在。spawn 前接管核验该 pid 的命令行
    /// （`/bin/ps -p <pid> -o command=`）同时包含 `dist/daemon.js` 与精确的
    /// `--state-dir <state_dir>` 参数才动手；否则拒绝（pid 已被回收复用）。
    /// `ps` 查不到且 pid 已死视为残留 pid 文件，删掉后按无孤儿处理；
    /// `ps` 失败但 pid 存活则拒绝并保留 pid 文件（不发信号）。
    /// 只给该 pid 自身发 SIGTERM（不是进程组：它不是我们的子进程），
    /// 20 秒未退则 SIGKILL 再等 5 秒；成功后删掉 pid 文件。
    /// 全程在锁外等待，每 100ms 检查代际，可被 stop()/disable 中断。
    ///
    /// spawn 前接管用严格命令行核验（见 `reclaim_orphan_inner(direct=false)`）；
    /// 退出码 3 的二次接管走 `reclaim_orphan_direct`，只做弱核验。
    fn reclaim_orphan(&self, state_dir: &std::path::Path, generation: u64) -> ReclaimOutcome {
        self.reclaim_orphan_inner(state_dir, generation, false)
    }

    /// 退出码 3 的二次接管：持锁者身份主要由“锁挡回新进程”这一事实确立——
    /// 我们的新进程刚被 `proper-lockfile` 挡回来，说明持锁者必然存在、必然
    /// 不是我们自己（我们还没拿到锁）。但 pid 文件在锁建立后才写入，存在
    /// 一个窗口：持锁者尚未写入 pid 文件时，pid 文件是崩溃残留的旧 pid，
    /// 可能已被回收复用给无关进程——因此仍需一道弱核验：`ps` 看到的命令行
    /// 必须含有 `dist/daemon.js` 标记，否则拒绝（绝不发信号）。
    /// 不核验 `--state-dir`：空格目录/`ps` 截断/omp 自我更新改名都可能让
    /// 严格匹配误拒真正的持锁者（0.7.0 线上故障），而标记检查不受这些影响。
    /// `ps` 自身失败（超时/spawn 失败）但 pid 存活时放行：`ps` 不可用不能
    /// 让接管瘫痪，此时锁挡回的事实仍是身份依据（死亡竞态下对已死 pid 的
    /// SIGTERM 无害，wait 会立即返回）。
    fn reclaim_orphan_direct(
        &self,
        state_dir: &std::path::Path,
        generation: u64,
    ) -> ReclaimOutcome {
        self.reclaim_orphan_inner(state_dir, generation, true)
    }

    fn reclaim_orphan_inner(
        &self,
        state_dir: &std::path::Path,
        generation: u64,
        direct: bool,
    ) -> ReclaimOutcome {
        let pid_path = super::paths::pid_path(state_dir);
        let text = match std::fs::read_to_string(&pid_path) {
            Ok(text) => text,
            Err(_) => return ReclaimOutcome::NoPidFile,
        };
        let Some(pid) = parse_pid_file(&text) else {
            return ReclaimOutcome::Refused {
                reason: format!("pid 文件无法解析：{}", pid_path.display()),
            };
        };
        if pid == std::process::id() {
            return ReclaimOutcome::Refused {
                reason: "pid 文件指向本进程，拒绝接管".to_string(),
            };
        }
        // 中断检查点：读文件与核验之间也可能被 stop/disable 抢占。
        if self.is_stale_generation(generation) {
            return ReclaimOutcome::Interrupted;
        }
        {
            let mut inner = self.lock();
            if inner.generation != generation {
                return ReclaimOutcome::Interrupted;
            }
            inner.last_error = Some(format!("正在接管残留的守护进程（pid {pid}）…"));
        }
        if direct {
            // 弱核验：pid 死了就清掉残留 pid 文件；`ps` 看到命令行但不含
            // 入口标记 → pid 已被复用给无关进程，拒绝且绝不发信号；zombie
            // 按已死处理。只有 `ps` 自身失败但 pid 存活时才放行（见
            // `reclaim_orphan_direct` 文档）。
            match ps_command_line(pid) {
                None if !pid_alive(pid) => {
                    let _ = std::fs::remove_file(&pid_path);
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        inner.last_error = None;
                    }
                    return ReclaimOutcome::StaleCleaned;
                }
                None => {}
                Some(command) if command.trim_start().starts_with("<defunct>") => {
                    let _ = std::fs::remove_file(&pid_path);
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        inner.last_error = None;
                    }
                    return ReclaimOutcome::StaleCleaned;
                }
                Some(command) if !command.contains(DAEMON_ENTRY_MARKER) => {
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        inner.last_error = None;
                    }
                    return ReclaimOutcome::Refused {
                        reason: format!("pid {pid} 的命令行不含守护进程标记，拒绝接管"),
                    };
                }
                Some(_) => {}
            }
        } else {
            let command = match ps_command_line(pid) {
                Some(command) => command,
                // `ps` 返回 None 覆盖三种情况：进程已死、查询超时、`ps` 自身
                // spawn 失败——只有确认 pid 已死才能删 pid 文件；pid 存活时必须
                // 保留文件并拒绝，否则会毁掉退出码 3 二次接管唯一的 pid 指针。
                None if !pid_alive(pid) => {
                    let _ = std::fs::remove_file(&pid_path);
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        inner.last_error = None;
                    }
                    return ReclaimOutcome::StaleCleaned;
                }
                None => {
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        inner.last_error = None;
                    }
                    return ReclaimOutcome::Refused {
                        reason: format!("ps 查询 pid {pid} 的命令行失败但进程存活，拒绝接管"),
                    };
                }
            };
            if !is_our_daemon_command(&command, &state_dir.display().to_string()) {
                let mut inner = self.lock();
                if inner.generation == generation {
                    inner.last_error = None;
                }
                return ReclaimOutcome::Refused {
                    reason: format!("pid {pid} 不是本状态目录的守护进程，拒绝接管"),
                };
            }
        }
        self.kill_reclaimed_pid(pid, &pid_path, generation)
    }

    /// 给已核验的孤儿 pid 发 SIGTERM（20 秒）→ SIGKILL（5 秒），确认退出后
    /// 删掉 pid 文件。只杀该 pid 自身：孤儿不是我们的子进程，没有可用的
    /// 进程组语义；SIGKILL 兜底时它的 `omp --mode rpc` 子进程可能残留
    /// （见 CONTRACT §26.3 注释与 stop 文档），而 SIGTERM 路径下守护进程
    /// 自己负责向它们传播（15 秒内部关闭宽限），25 秒足够走完。
    fn kill_reclaimed_pid(
        &self,
        pid: u32,
        pid_path: &std::path::Path,
        generation: u64,
    ) -> ReclaimOutcome {
        // SAFETY：kill(2) 只发信号，不解引用指针。
        let _ = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        // `is_exited` 把 zombie 也算退出：孤儿可能是我们的子进程
        // （测试里亲手 spawn 的假孤儿），SIGTERM 后它变 zombie，kill(pid,0)
        // 仍报存活——此时 ps 显示 `<defunct>`，按已退出处理。
        let is_exited = |pid: u32| {
            if !pid_alive(pid) {
                return true;
            }
            ps_command_line(pid)
                .as_deref()
                .is_some_and(|cmd| cmd.trim_start().starts_with("<defunct>"))
        };
        if wait_pid_exit_interruptible(pid, RECLAIM_TERM_TIMEOUT, || {
            self.is_stale_generation(generation)
        }) || is_exited(pid)
        {
            let _ = std::fs::remove_file(pid_path);
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.last_error = None;
            }
            return ReclaimOutcome::Reclaimed { pid };
        }
        if self.is_stale_generation(generation) {
            return ReclaimOutcome::Interrupted;
        }
        let _ = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        if wait_pid_exit_interruptible(pid, RECLAIM_KILL_TIMEOUT, || {
            self.is_stale_generation(generation)
        }) || is_exited(pid)
        {
            let _ = std::fs::remove_file(pid_path);
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.last_error = None;
            }
            return ReclaimOutcome::Reclaimed { pid };
        }
        if self.is_stale_generation(generation) {
            return ReclaimOutcome::Interrupted;
        }
        {
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.last_error = None;
            }
        }
        ReclaimOutcome::Refused {
            reason: format!("pid {pid} 未能在 25 秒内退出，未接管"),
        }
    }

    /// 停止守护进程：置 `Stopping`，SIGTERM（15 秒）→ SIGKILL（5 秒）。
    /// 无存活进程时只更新状态。阻塞调用方直到进程退出或超时。
    ///
    /// 说明：
    /// - 锁只覆盖字段读写：发信号与 `wait_pid_exit` 轮询全在锁外，
    ///   `status()` 轮询永不排队等 20 秒的停止；
    /// - 通过「代际」与等待线程/退避重启互斥：`stop` 递增代际后，
    ///   等待线程 `wait()` 返回时看到代际变化而不碰状态，不会误判为崩溃重启；
    /// - 子进程已退出（`try_wait` 有结果）时不发信号，直接回收；
    /// - `child` 句柄若还在 `Inner` 里（等待线程尚未接管），`stop` 接管后
    ///   在锁外亲自 `wait()` 回收，不留僵尸；等待线程稍后取不到句柄，
    ///   直接返回。
    fn stop(&self) {
        enum StopPlan {
            /// 无需动作（从未启动或已停止）。
            Idle,
            /// 需发信号并等待退出的 pid；`owned` 为接管的句柄（有则亲自回收）。
            Signal { pid: u32, owned: Option<Child> },
        }
        let (plan, generation) = {
            let mut inner = self.lock();
            inner.generation += 1;
            let generation = inner.generation;
            // `child` 句柄还在：子进程归我们管。先 `try_wait` 看它是否已退出。
            if let Some(child) = inner.child.as_mut() {
                match child.try_wait() {
                    // 已退出：就地回收，不发信号。
                    Ok(Some(_)) => {
                        inner.child = None;
                        inner.pid = None;
                        inner.state = if inner.enabled {
                            SuperagentState::Stopped
                        } else {
                            SuperagentState::Disabled
                        };
                        return;
                    }
                    // 仍存活或 try_wait 出错：接管句柄（等待线程尚未接管，
                    // 取走即阻止它接管：spawn_wait_thread 只在取到句柄时
                    // 建线程），置 Stopping，锁外发信号+亲自 wait 回收。
                    Ok(None) | Err(_) => {
                        let pid = inner.pid;
                        inner.state = SuperagentState::Stopping;
                        match pid {
                            Some(pid) => {
                                let owned = inner.child.take();
                                (StopPlan::Signal { pid, owned }, generation)
                            }
                            // `pid: None` 但有句柄：不动句柄，等待线程会接管
                            // （该分支理论不可达：pid 与 child 总是同时写入，
                            // 同时清除）。
                            None => (StopPlan::Idle, generation),
                        }
                    }
                }
            } else if inner.pid.is_some() {
                // 句柄在等待线程手里（已启动）：同样走信号路径。
                // 等待线程的 `wait()` 返回后会看到代际变化而不碰状态，
                // 僵尸由它的 `wait()` 回收。
                inner.state = SuperagentState::Stopping;
                let pid = inner.pid.expect("pid checked above");
                (StopPlan::Signal { pid, owned: None }, generation)
            } else {
                if inner.enabled {
                    inner.state = SuperagentState::Stopped;
                } else {
                    inner.state = SuperagentState::Disabled;
                }
                (StopPlan::Idle, generation)
            }
        };
        let StopPlan::Signal { pid, mut owned } = plan else {
            return;
        };
        // 负 pid 表示整个进程组。子进程 spawn 时设置了 `process_group(0)`，
        // 因此 pgid == child pid；守护进程自身的 `omp --mode rpc` 子进程
        // 由它自己再建独立进程组（detached），不在此组内——SIGTERM 由守护
        // 进程负责向它们传播（15 秒宽限），SIGKILL 兜底时它们可能残留
        // （见 CONTRACT §26.3 注释与 stop 文档）。
        let pgid = -(pid as i32);
        // 子进程可能在发信号前自然退出：kill 返回 ESRCH 即视为已退出。
        signal_process_group(pgid, libc::SIGTERM);
        if wait_owned_or_pid(&mut owned, pid, STOP_TERM_TIMEOUT) {
            self.on_stopped(generation);
            return;
        }
        signal_process_group(pgid, libc::SIGKILL);
        wait_owned_or_pid(&mut owned, pid, STOP_KILL_TIMEOUT);
        self.on_stopped(generation);
    }

    /// 主动停止完成后的收尾：置 `Stopped`/`Disabled`。
    ///
    /// 只有同代际才写状态（restart 的新 start 会递增代际，避免旧 stop
    /// 覆盖新 Starting）。等待线程稍后 `wait()` 返回时看到代际变化，
    /// 直接返回而不碰状态；僵尸回收由等待线程的 `wait()` 完成。
    fn on_stopped(&self, generation: u64) {
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        if let Some(child) = inner.child.as_mut() {
            let _ = child.try_wait();
        }
        inner.child = None;
        inner.pid = None;
        if inner.enabled {
            inner.state = SuperagentState::Stopped;
        } else {
            inner.state = SuperagentState::Disabled;
        }
    }

    /// 就绪线程：轮询 `GET state`，200 即置 `Running`；60 秒未就绪则杀掉置 `Crashed`。
    ///
    /// 只在代际与 `Starting` 状态都吻合时改状态：`stop()`/`set_enabled(false)`
    /// 会递增代际，线程随后自杀，绝不复活已停止的实例。
    fn spawn_ready_thread(&self, generation: u64, pid: u32, socket: PathBuf) {
        let inner = Arc::clone(&self.inner);
        let _ = std::thread::Builder::new()
            .name("superagent-ready".to_string())
            .spawn(move || {
                let deadline = Instant::now() + READY_TIMEOUT;
                loop {
                    {
                        let guard = inner
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if guard.generation != generation {
                            return;
                        }
                        // 启动后若已被外部置为非 Starting（stop/Crashed），直接退出：
                        // 60 秒杀进程的兜底只属于 Starting 阶段。
                        if !matches!(guard.state, SuperagentState::Starting) {
                            return;
                        }
                    }
                    match super::proxy::request(
                        &socket,
                        "GET",
                        "state",
                        None,
                        super::proxy::READY_PROBE_TIMEOUT,
                    ) {
                        Ok((200, _)) => {
                            let mut guard = inner
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if guard.generation == generation
                                && matches!(guard.state, SuperagentState::Starting)
                            {
                                guard.state = SuperagentState::Running;
                            }
                            return;
                        }
                        _ => {
                            if Instant::now() >= deadline {
                                // 杀进程与置状态必须在同一代际下：先杀，再持锁
                                // 确认代际未变才置 Crashed；stop() 若已接管，
                                // 这里只补一刀 SIGKILL，不碰它的状态。
                                signal_process_group(-(pid as i32), libc::SIGKILL);
                                let mut guard = inner
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                                if guard.generation == generation
                                    && matches!(guard.state, SuperagentState::Starting)
                                {
                                    guard.state = SuperagentState::Crashed;
                                    guard.last_error =
                                        Some("守护进程 60 秒内未就绪，详见日志".to_string());
                                }
                                return;
                            }
                            std::thread::sleep(READY_POLL_INTERVAL);
                        }
                    }
                }
            });
    }

    /// 等待线程：`child.wait()` 返回后定状态；非预期退出按退避表自动重启。
    fn spawn_wait_thread(&self, generation: u64) {
        // 把子进程句柄移到等待线程，`stop` 侧只凭 pid 发信号。
        let mut child = {
            let mut inner = self.lock();
            if inner.generation != generation {
                return;
            }
            match inner.child.take() {
                Some(c) => c,
                None => return,
            }
        };
        let this = SelfHandle {
            app: self.app.clone(),
            data_dir: self.data_dir.clone(),
            inner: Arc::clone(&self.inner),
            daemon_schema: Arc::clone(&self.daemon_schema),
        };
        let _ = std::thread::Builder::new()
            .name("superagent-wait".to_string())
            .spawn(move || {
                let status = child.wait();
                this.on_child_exit(generation, status);
            });
    }

    /// 等待线程的退出处理（`SelfHandle` 委托到此）。
    fn on_child_exit(&self, generation: u64, status: std::io::Result<std::process::ExitStatus>) {
        let state_dir = self.state_dir();
        let log_tail = last_log_line(&super::paths::log_path(&state_dir));
        // 退出码 3（另一个守护进程占用状态目录）：spawn 前的接管可能错过
        // （pid 文件在启动间隙写入），这里补一次接管，接管成功则直接重启。
        // 接管至多一次：重启走 `start()`（其内部的 spawn 前接管会看到 pid
        // 文件已删而不动作），不递归。
        if matches!(&status, Ok(s) if s.code() == Some(EXIT_ALREADY_RUNNING)) {
            self.on_already_running_exit(generation, &state_dir);
            return;
        }
        let should_restart = {
            let mut inner = self.lock();
            if inner.generation != generation {
                // 代际已变：主动停止或新一轮启动接管，不碰状态。
                return;
            }
            let stopping = matches!(inner.state, SuperagentState::Stopping);
            inner.pid = None;
            inner.child = None;
            if stopping {
                // stop() 的 on_stopped 稍后也会定状态；这里先定下来，
                // 两者幂等（同代际下 Stopped/Disabled 只写一次有效值）。
                if inner.enabled {
                    inner.state = SuperagentState::Stopped;
                } else {
                    inner.state = SuperagentState::Disabled;
                }
                return;
            }
            let status_text = match &status {
                Ok(s) => {
                    if let Some(code) = s.code() {
                        format!("退出码 {code}")
                    } else if let Some(sig) = s.signal() {
                        format!("信号 {sig}")
                    } else {
                        "未知状态".to_string()
                    }
                }
                Err(e) => format!("等待失败：{e}"),
            };
            inner.state = SuperagentState::Crashed;
            inner.last_error = Some(match log_tail {
                Some(line) => format!("守护进程退出（{status_text}）：{line}"),
                None => format!("守护进程退出（{status_text}）"),
            });
            // 稳定运行超 600 秒则复位计数，否则累加。
            let stable = inner
                .started_instant
                .is_some_and(|t| t.elapsed() >= STABLE_RUN);
            if stable {
                inner.crashes = 1;
            } else {
                inner.crashes += 1;
            }
            inner.restarts += 1;
            let backoff = BACKOFF_SECS[usize::try_from(inner.crashes.saturating_sub(1))
                .unwrap_or(usize::MAX)
                .min(BACKOFF_SECS.len() - 1)];
            (inner.enabled, backoff)
        };
        let (enabled, backoff) = should_restart;
        if !enabled {
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.state = SuperagentState::Disabled;
            }
            return;
        }
        // 退避等待必须可中断：`stop()`/`set_enabled(false)`/`restart()`
        // 都会递增代际；每 100ms 检查一次，代际变化或开关关闭即放弃重启，
        // 绝不在 disable/stop 之后复活进程。
        let deadline = Instant::now() + backoff_duration(backoff);
        loop {
            {
                let inner = self.lock();
                if inner.generation != generation || !inner.enabled {
                    return;
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            std::thread::sleep(Duration::from_millis(100).min(remaining));
        }
        {
            let inner = self.lock();
            if inner.generation != generation || !inner.enabled {
                return;
            }
            // 前一轮是 Stopping/Stopped/Disabled（stop 与退出竞争时）：
            // 不重启，由 stop 的 on_stopped 定状态。
            if !matches!(inner.state, SuperagentState::Crashed) {
                return;
            }
        }
        if let Err(e) = self.start() {
            let mut inner = self.lock();
            // start() 内部已按失败原因置了 Crashed/last_error；这里只在
            // 代际仍吻合时补 last_error，避免覆盖新一轮启动的状态。
            if inner.generation == generation {
                inner.last_error = Some(e.message);
            }
        }
    }

    /// 退出码 3 的退出处理：补一次孤儿接管，成功则直接重启。
    ///
    /// 运行在等待线程（非 UI 线程）：接管的 SIGTERM 20s + SIGKILL 5s 全在
    /// 锁外等待，可被 stop()/disable 中断（代际检查）。
    ///
    /// 这里用 `reclaim_orphan_direct`（弱核验：只要求命令行含入口标记，
    /// 不要求 `--state-dir` 严格匹配）：新进程刚被锁挡回，持锁者身份已定；
    /// spawn 前接管若已因严格核验拒绝而放过它，这里是最后的兜底——但 pid
    /// 复用给无关进程时仍拒绝，绝不误杀。
    fn on_already_running_exit(&self, generation: u64, state_dir: &std::path::Path) {
        {
            let inner = self.lock();
            if inner.generation != generation {
                return;
            }
            if matches!(inner.state, SuperagentState::Stopping) {
                // stop 与秒退竞争：按主动停止定状态，不接管不重启。
                drop(inner);
                let mut inner = self.lock();
                if inner.generation == generation {
                    inner.pid = None;
                    inner.child = None;
                    if inner.enabled {
                        inner.state = SuperagentState::Stopped;
                    } else {
                        inner.state = SuperagentState::Disabled;
                    }
                }
                return;
            }
        }
        match self.reclaim_orphan_direct(state_dir, generation) {
            ReclaimOutcome::Reclaimed { pid } => {
                append_log_line(
                    &super::paths::log_path(state_dir),
                    &format!("[supervisor] reclaimed orphaned daemon pid {pid}"),
                );
                self.restart_after_reclaim(generation);
            }
            ReclaimOutcome::StaleCleaned => {
                append_log_line(
                    &super::paths::log_path(state_dir),
                    "[supervisor] cleared a stale pid file left by a killed daemon; restarting",
                );
                self.restart_after_reclaim(generation);
            }
            ReclaimOutcome::Interrupted => {}
            ReclaimOutcome::NoPidFile => {
                self.set_already_running_crashed(generation, state_dir);
            }
            ReclaimOutcome::Refused { reason } => {
                append_log_line(
                    &super::paths::log_path(state_dir),
                    &format!("[supervisor] reclaim refused: {reason}"),
                );
                self.set_already_running_crashed(generation, state_dir);
            }
        }
    }

    /// 接管成功后重启：清掉已退出的旧句柄、推进代际，直调 `start_after_guard`
    /// （不再接管，至多一次）。
    ///
    /// 这是退出码 3 路径唯一的自愈出口：`kill -9` 掉的守护进程来不及删
    /// `daemon.pid`，下一次 spawn 会被残留文件挡回 3；清掉文件后必须真的
    /// 重启，否则服务停摆到用户手点为止（0.8.0 线上故障）。
    fn restart_after_reclaim(&self, generation: u64) {
        let mut inner = self.lock();
        if inner.generation != generation || !inner.enabled {
            return;
        }
        inner.pid = None;
        inner.child = None;
        inner.state = SuperagentState::Starting;
        inner.last_error = None;
        inner.generation += 1;
        let next = inner.generation;
        drop(inner);
        if let Err(e) = self.start_after_guard(next, false) {
            let mut inner = self.lock();
            if inner.generation == next {
                inner.last_error = Some(e.message);
            }
        }
    }

    /// 退出码 3 且接管无果：置 `Crashed` + 指引文案，并安排有限次自愈复查。
    /// pid 文件能解析出 holder pid 时带上它和可复制的 kill 命令：用户按指引
    /// 手动杀时不再需要翻日志找 pid（服务页的错误行允许换行显示全文）。
    fn set_already_running_crashed(&self, generation: u64, state_dir: &std::path::Path) {
        let enabled = {
            let mut inner = self.lock();
            if inner.generation != generation {
                return;
            }
            inner.pid = None;
            inner.child = None;
            inner.state = SuperagentState::Crashed;
            let holder = std::fs::read_to_string(super::paths::pid_path(state_dir))
                .ok()
                .and_then(|text| parse_pid_file(&text));
            inner.last_error = Some(match holder {
                Some(pid) => format!(
                    "另一个 Superagent 守护进程（pid {pid}）正在使用状态目录{}（未能自动接管，可手动结束该进程后重试：kill {pid}，仍在则 kill -9 {pid}）",
                    state_dir.display(),
                ),
                None => format!(
                    "另一个 Superagent 守护进程正在使用状态目录{}（未能自动接管，可手动结束该进程后重试）",
                    state_dir.display(),
                ),
            });
            inner.enabled
        };
        if enabled {
            self.schedule_conflict_retry(generation, false);
        }
    }

    /// 停摆后的有限次自愈：按 `CONFLICT_BACKOFF_SECS` 的节奏复查，socket 上已无人
    /// 应答（占位者退出/被杀）就自行重启。真有人应答时只做一次 connect 探测并按
    /// 最长档（60 秒）重排，**不消耗**预算——那是在观测别人的守护进程，绝不争抢；
    /// 真正尝试启动才消耗预算，用完表长即停（重启/启用时复位）。
    fn schedule_conflict_retry(&self, generation: u64, slow: bool) {
        let used = {
            let inner = self.lock();
            if inner.generation != generation || !inner.enabled {
                return;
            }
            inner.conflict_retries as usize
        };
        let last = CONFLICT_BACKOFF_SECS.len() - 1;
        let index = if slow { last } else { used.min(last) };
        let supervisor = self.clone();
        let state_dir = self.state_dir();
        let _ = std::thread::Builder::new()
            .name("superagent-conflict-retry".to_string())
            .spawn(move || {
                std::thread::sleep(conflict_retry_duration(u32::try_from(index).unwrap_or(u32::MAX)));
                {
                    let inner = supervisor.lock();
                    if inner.generation != generation
                        || !inner.enabled
                        || !matches!(inner.state, SuperagentState::Crashed)
                    {
                        return;
                    }
                }
                if socket_has_listener(&state_dir) {
                    // 有人在应答：不争抢、不消耗预算，按最长档继续观测。
                    supervisor.schedule_conflict_retry(generation, true);
                    return;
                }
                let allowed = {
                    let mut inner = supervisor.lock();
                    if inner.conflict_retries as usize >= CONFLICT_BACKOFF_SECS.len() {
                        false
                    } else {
                        inner.conflict_retries += 1;
                        true
                    }
                };
                if !allowed {
                    return;
                }
                let _ = supervisor.start();
            });
    }
}

/// 向进程组发信号。返回 false 表示目标已不存在（ESRCH），调用方可视为已退出。
fn signal_process_group(pgid: i32, sig: libc::c_int) -> bool {
    // SAFETY：kill(2) 只发信号，不解引用指针；pgid/sig 均为合法整数。
    let ret = unsafe { libc::kill(pgid, sig) };
    if ret == 0 {
        return true;
    }
    // ESRCH = 无此进程/进程组 → 已退出；其他错误（EPERM 等）保守按存活处理。
    // SAFETY：__error() 返回当前线程 errno 地址，读一次。
    let errno = unsafe { *libc::__error() };
    errno != libc::ESRCH
}

/// 退避等待时长：生产用秒级退避；测试编译下经 `OMP_RESUME_SUPERAGENT_BACKOFF_MS`
/// 环境变量覆盖（毫秒），未设置时与生产一致。
fn backoff_duration(secs: u64) -> Duration {
    #[cfg(test)]
    if let Some(ms) = std::env::var("OMP_RESUME_SUPERAGENT_BACKOFF_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return Duration::from_millis(ms);
    }
    Duration::from_secs(secs)
}

/// 退出码 3 停摆后的复查间隔：生产按 `CONFLICT_BACKOFF_SECS` 取第 `attempt` 档；
/// 测试编译下经 `OMP_RESUME_SUPERAGENT_CONFLICT_RETRY_MS` 覆盖（毫秒，各档同值）。
fn conflict_retry_duration(attempt: u32) -> Duration {
    #[cfg(test)]
    if let Some(ms) = std::env::var("OMP_RESUME_SUPERAGENT_CONFLICT_RETRY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return Duration::from_millis(ms);
    }
    let index = usize::try_from(attempt)
        .unwrap_or(usize::MAX)
        .min(CONFLICT_BACKOFF_SECS.len() - 1);
    Duration::from_secs(CONFLICT_BACKOFF_SECS[index])
}

/// socket 上是否有活着的监听者：能 `connect` 上即有人应答。
/// 残留 socket 文件（进程已死）在 connect 时得到 ECONNREFUSED → `false`，
/// 这正是“占位者已经消失、可以安全重启”的判据。
fn socket_has_listener(state_dir: &std::path::Path) -> bool {
    match std::os::unix::net::UnixStream::connect(super::paths::socket_path(state_dir)) {
        Ok(stream) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            true
        }
        Err(_) => false,
    }
}

/// 等待线程持有的弱引用式句柄：只带重建 `&Supervisor` 所需的字段，
/// 避免把 `Supervisor`（含 `!Send` 风险）直接移进线程。
struct SelfHandle {
    app: Option<tauri::AppHandle>,
    data_dir: PathBuf,
    inner: Arc<Mutex<Inner>>,
    daemon_schema: Arc<Mutex<Option<(u32, u32)>>>,
}

impl SelfHandle {
    fn on_child_exit(&self, generation: u64, status: std::io::Result<std::process::ExitStatus>) {
        // 复用 Supervisor 的退出处理：临时借出等价引用。
        let supervisor = Supervisor {
            app: self.app.clone(),
            data_dir: self.data_dir.clone(),
            inner: Arc::clone(&self.inner),
            daemon_schema: Arc::clone(&self.daemon_schema),
        };
        supervisor.on_child_exit(generation, status);
    }
}

/// 等待 pid 退出（轮询 kill(pid, 0)），超时返回 false。
///
/// 说明：
/// - kill(pid, 0) 返回 EPERM 表示进程存在但无权发信号 → 仍视为存活；
///   只有 ESRCH（无此进程）才视为已退出；
/// - 子进程退出后、等待线程 `wait()` 回收前，pid 以 zombie 形态存在，
///   kill 仍返回 0：stop 路径对此有 15s+5s 上限兜底，等待线程的 `wait()`
///   会随后回收，不影响正确性；
/// - pid 复用窗口内可能误判，但停止路径刚给该 pid 发过信号，复用概率极低。
fn wait_pid_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let pid = pid as i32;
    loop {
        // SAFETY：kill(pid, 0) 只做存在性探测，不发信号、不解引用指针。
        let ret = unsafe { libc::kill(pid, 0) };
        if ret == 0 {
            // 存活（含 zombie）：继续等。
        } else {
            // SAFETY：__error() 返回当前线程 errno 地址，读一次。
            let errno = unsafe { *libc::__error() };
            if errno == libc::ESRCH {
                return true;
            }
            // EPERM 等其他错误 → 进程存在，继续等。
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 等待停止目标退出：有接管句柄时用 `try_wait` 轮询（顺手回收僵尸），
/// 否则退化为 `wait_pid_exit`（僵尸由等待线程的 `wait()` 回收）。
fn wait_owned_or_pid(owned: &mut Option<Child>, pid: u32, timeout: Duration) -> bool {
    let Some(child) = owned else {
        return wait_pid_exit(pid, timeout);
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            // try_wait 出错：回退到 pid 探测，避免误报已退出。
            Err(_) => {
                return wait_pid_exit(pid, deadline.saturating_duration_since(Instant::now()));
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 打开日志文件（追加写）：超过 5 MiB 就先改名为 `.1`；新文件 0600。
///
/// 注意 `Path::with_extension("log.1")` 会把 `daemon.log` 变成
/// `daemon.log.1`（Rust 的 with_extension 只替换最后一个点后缀），
/// 与 CONTRACT §26.1 的 `.1` 口径一致。
fn open_log(path: &std::path::Path) -> AppResult<std::fs::File> {
    if std::fs::metadata(path).is_ok_and(|md| md.len() > LOG_ROTATE_BYTES) {
        let rotated = path.with_extension("log.1");
        let _ = std::fs::rename(path, rotated);
    }
    // 0600 只对新建文件生效；已存在文件的权限保持不变（与 settings 同口径）。
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法打开 Superagent 日志：{e}")))
}

/// 读日志最后一行（供崩溃文案；失败则 None）。
///
/// 只读文件尾部 8 KiB 而非整个文件：日志可达 5 MiB+，崩溃路径不应
/// 一次性读入内存。若尾部无换行，返回截断后的最后一行（尽力而为）。
fn last_log_line(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let take = size.min(8192);
    file.seek(SeekFrom::End(-(take as i64))).ok()?;
    let mut buf = vec![0u8; usize::try_from(take).ok()?];
    file.read_exact(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    // 去掉末尾换行，再取最后一行；若 8 KiB 截断了行首，得到的是半行，
    // 作为崩溃文案仍可接受。
    let trimmed = text.trim_end_matches(['\r', '\n']);
    trimmed
        .rsplit('\n')
        .next()
        .map(|l| l.strip_suffix('\r').unwrap_or(l).trim().to_string())
        .filter(|l| !l.is_empty())
}

/// 当前 UTC 时间（ISO-8601 毫秒，与 CONTRACT §0 一致）。
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 失配结论 →（状态明细，前端展示的中文文案）。调用方保证只传失配变体。
fn mismatch_status(
    mismatch: super::schema::Check,
    oldest: u32,
    newest: u32,
) -> (crate::model::SuperagentSchema, String) {
    let state = match mismatch {
        super::schema::Check::TooNew { state, .. } | super::schema::Check::TooOld { state, .. } => {
            state
        }
        super::schema::Check::Compatible | super::schema::Check::Unknown => {
            unreachable!("mismatch_status 只接受失配结论")
        }
    };
    let schema = crate::model::SuperagentSchema {
        state,
        oldest,
        newest,
    };
    let message = match mismatch {
        super::schema::Check::TooNew { .. } => format!(
            "状态库 schema {state} 高于本版本守护进程支持的 {newest}：请安装与状态库匹配的版本，或点「改用新状态目录」以保留旧目录并重新开始（旧目录会改名保留）"
        ),
        super::schema::Check::TooOld { .. } => format!(
            "状态库 schema {state} 低于本版本守护进程可迁移的 {oldest}：请点「改用新状态目录」以保留旧目录并重新开始（旧目录会改名保留）"
        ),
        super::schema::Check::Compatible | super::schema::Check::Unknown => {
            unreachable!("mismatch_status 只接受失配结论")
        }
    };
    (schema, message)
}

/// 把状态目录改名归档并重建空目录，返回归档路径。
///
/// 归档名 `<state_dir>.schema-<n>-<YYYYMMDD-HHMMSS>`（本地时间），冲突时追加
/// `-2`、`-3`…。归档目录永不删除；重建失败时尝试把改名还原（`rename` 回去），
/// 还原失败也如实报错，不静默丢状态。
fn archive_state_dir(state_dir: &std::path::Path, state_schema: u32) -> AppResult<PathBuf> {
    use std::os::unix::fs::DirBuilderExt;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut target = {
        let mut name = state_dir.as_os_str().to_os_string();
        name.push(format!(".schema-{state_schema}-{stamp}"));
        PathBuf::from(name)
    };
    for suffix in 2u32.. {
        if !target.exists() {
            break;
        }
        let mut name = state_dir.as_os_str().to_os_string();
        name.push(format!(".schema-{state_schema}-{stamp}-{suffix}"));
        target = PathBuf::from(name);
    }
    std::fs::rename(state_dir, &target)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("归档状态目录失败：{e}")))?;
    if let Err(e) = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state_dir)
    {
        let _ = std::fs::rename(&target, state_dir);
        return Err(AppError::new(
            ErrorCode::Io,
            format!("重建状态目录失败：{e}"),
        ));
    }
    Ok(target)
}

/// 孤儿接管结果。
enum ReclaimOutcome {
    /// 无 pid 文件：无孤儿，但不清楚是谁把退出码 3 挡回来的，按冲突停摆。
    NoPidFile,
    /// 残留 pid 文件指向已退出的进程（守护进程被 `kill -9` 时来不及删 pid
    /// 文件）：文件已在本轮清掉，状态目录无人占用，直接重启。
    StaleCleaned,
    /// 接管成功：旧进程已退出，pid 文件已删。
    Reclaimed { pid: u32 },
    /// 拒绝接管：pid 文件坏了、命令行核验未通过（不匹配或 `ps` 失败但 pid 存活）、或超时未退。
    /// `reason` 记入守护进程日志（审计），不进 `last_error`（用户看到的
    /// 仍是退出码 3 的统一指引文案）。
    Refused { reason: String },
    /// 中途被 stop()/disable 中断（代际变化）。
    Interrupted,
}

/// 解析 pid 文件内容（十进制 pid + 换行）。空/多余行/0/超界一律 None。
fn parse_pid_file(text: &str) -> Option<u32> {
    let line = text.lines().next()?.trim();
    if line.is_empty() || !line.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // 前导零允许（`echo $$` 不产生，但无害）；空串/负号已被上行拒绝。
    let pid: u32 = line.parse().ok()?;
    (pid > 0).then_some(pid)
}

/// 该命令行是否属于本状态目录的守护进程（纯函数，供 `ps` 输出核验）。
/// 必须同时满足：包含 `dist/daemon.js`，且出现精确的
/// `--state-dir <state_dir>`（前后都是空白/串边界）。
/// 注意不能按空白切分 argv：`ps` 把参数按空格拼成一行，而 macOS 默认
/// 状态目录含空格（`…/Application Support/…`），切分会把目录拆碎导致
/// 永远匹配不上。`ps -o command=` 在 macOS 上对超长命令行会
/// 截断：截断只会导致拒绝接管（保守），不会误杀。
fn is_our_daemon_command(command: &str, state_dir: &str) -> bool {
    if !command.contains(DAEMON_ENTRY_MARKER) {
        return false;
    }
    let flag = "--state-dir";
    let bytes = command.as_bytes();
    let mut from = 0;
    while let Some(rel) = command[from..].find(flag) {
        let at = from + rel;
        let before_ok = at == 0 || bytes[at - 1].is_ascii_whitespace();
        let mut after = at + flag.len();
        let flag_boundary_ok = after < bytes.len() && bytes[after].is_ascii_whitespace();
        if before_ok && flag_boundary_ok {
            while after < bytes.len() && bytes[after].is_ascii_whitespace() {
                after += 1;
            }
            if command[after..].starts_with(state_dir) {
                let end = after + state_dir.len();
                if end == bytes.len() || bytes[end].is_ascii_whitespace() {
                    return true;
                }
            }
        }
        from = at + flag.len();
    }
    false
}

/// 经 `/bin/ps -p <pid> -o command=` 取该进程的完整命令行。
/// 查不到（已退出）、超时、spawn 失败一律 None：调用方须结合
/// `pid_alive` 区分“进程已死”（可清残留 pid 文件）与“`ps` 自身失败”
///（pid 存活时必须保留 pid 文件并拒绝，绝不能删）。
fn ps_command_line(pid: u32) -> Option<String> {
    // 测试注入：接管路径直调本函数，`OMP_RESUME_TEST_PS_BIN` 指向不存在的
    // 二进制即可模拟 `ps` 自身失败（线上永远走 `/bin/ps`）。
    #[cfg(test)]
    let ps_bin = std::env::var("OMP_RESUME_TEST_PS_BIN").unwrap_or_else(|_| PS_BIN.to_string());
    #[cfg(test)]
    return ps_command_line_with(&ps_bin, pid, PS_TIMEOUT);
    #[cfg(not(test))]
    ps_command_line_with(PS_BIN, pid, PS_TIMEOUT)
}

/// `ps_command_line` 的可注入版本（测试用假 ps）。
fn ps_command_line_with(ps_bin: &str, pid: u32, timeout: Duration) -> Option<String> {
    let mut child = std::process::Command::new(ps_bin)
        .args(["-p", &pid.to_string(), "-o", "command="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // 硬超时等待（与 `occupant::run_lsof` 同模式）：轮询 try_wait，
    // 超时则 kill。`command=` 去掉表头，首行即命令行。
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

/// pid 是否存活（kill(pid, 0) 语义：ESRCH 以外都算存活，含 zombie）。
fn pid_alive(pid: u32) -> bool {
    // SAFETY：kill(pid, 0) 只做存在性探测，不发信号、不解引用指针。
    let ret = unsafe { libc::kill(pid as i32, 0) };
    if ret == 0 {
        return true;
    }
    // SAFETY：__error() 返回当前线程 errno 地址，读一次。
    let errno = unsafe { *libc::__error() };
    errno != libc::ESRCH
}

/// 等待 pid 退出（轮询 kill(pid, 0)），可被 `is_stale` 中断。
///
/// 返回 true 仅表示 pid 已消失（ESRCH）；超时或中断返回 false，
/// 调用方再以 `is_stale()` 区分“超时”（继续 SIGKILL）与“中断”（放弃）。
fn wait_pid_exit_interruptible(pid: u32, timeout: Duration, is_stale: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    let raw = pid as i32;
    loop {
        // SAFETY：kill(pid, 0) 只做存在性探测，不发信号、不解引用指针。
        let ret = unsafe { libc::kill(raw, 0) };
        if ret != 0 {
            // SAFETY：__error() 返回当前线程 errno 地址，读一次。
            let errno = unsafe { *libc::__error() };
            if errno == libc::ESRCH {
                return true;
            }
            // EPERM 等其他错误 → 进程存在，继续等。
        }
        if is_stale() || Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// spawn 间隙被 stop/disable 抢占时，就地杀掉刚出生的子进程并回收。
/// 发进程组信号（它是我们 spawn 的，`process_group(0)` 已生效），
/// SIGTERM 5 秒 + SIGKILL 5 秒；超时也返回（等待线程不会接管，
/// 句柄随 `child` drop 关闭，最坏残留一个由 launchd 回收的孤儿）。
fn kill_newborn(child: Child, pid: u32) {
    let pgid = -(pid as i32);
    signal_process_group(pgid, libc::SIGTERM);
    if wait_owned_or_pid(&mut Some(child), pid, Duration::from_secs(5)) {
        return;
    }
    // try_wait 轮询已把句柄消费掉：剩下的只能按 pid 发 SIGKILL。
    signal_process_group(pgid, libc::SIGKILL);
    wait_pid_exit(pid, STOP_KILL_TIMEOUT);
}

/// 向守护进程日志追加一行（接管审计；失败静默，绝不阻断启动）。
fn append_log_line(path: &std::path::Path, line: &str) {
    use std::io::Write;
    // 0600 只对新建文件生效；已存在文件的权限保持不变（与 open_log 同口径）。
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
    {
        Ok(f) => f,
        Err(_) => return,
    };
    let _ = writeln!(file, "{line}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ErrorCode;
    use std::os::unix::fs::PermissionsExt;

    /// 测试串行锁：本模块测试改进程级环境变量（OMP_RESUME_OMP_BIN 等），
    /// 必须串行，借用 omp_cli 的子进程测试锁。
    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::omp_cli::subprocess_test_guard()
    }

    /// RAII 环境变量覆盖：drop 时恢复旧值（无旧值则删除）。
    struct EnvOverride {
        key: &'static str,
        old: Option<String>,
    }
    impl EnvOverride {
        fn set(key: &'static str, value: &str) -> Self {
            let old = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, old }
        }
    }
    impl Drop for EnvOverride {
        fn drop(&mut self) {
            match &self.old {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// 测试脚手架：在 tempdir 下放假 omp + 假资源目录，返回 Supervisor。
    /// 假 omp 是一个 sh 脚本：`run <daemon.js> --state-dir S --socket K --omp O`
    /// 时按行为文件行事（见各用例），并把调用参数记入 `argv.log`。
    struct Fixture {
        _dir: tempfile::TempDir,
        _assets: tempfile::TempDir,
        _omp_bin: EnvOverride,
        _assets_dir: EnvOverride,
        _backoff: EnvOverride,
        supervisor: Supervisor,
    }
    impl Fixture {
        fn dir(&self) -> &std::path::Path {
            self._dir.path()
        }

        fn new(behavior: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let assets = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(assets.path().join("dist")).unwrap();
            std::fs::write(assets.path().join("dist/daemon.js"), "// fake\n").unwrap();
            let behavior_file = dir.path().join("behavior");
            std::fs::write(&behavior_file, behavior).unwrap();
            let bin = dir.path().join("omp");
            let script = format!(
                r#"#!/bin/sh
echo "$*" >> "{argv}"
for a in "$@"; do
  if [ "$a" = "--print-schema" ]; then
    if [ -f "{schema_range}" ]; then cat "{schema_range}"; else echo "no schema here"; fi
    exit 0
  fi
done
BEHAVIOR=$(cat "{behavior}")
case "$BEHAVIOR" in
  serve)
    SOCK=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--socket" ]; then SOCK="$a"; fi
      prev="$a"
    done
    rm -f "$SOCK"
    export SA_SOCK="$SOCK"
    exec node -e '
      const http = require("node:http");
      const fs = require("node:fs");
      const sock = process.env.SA_SOCK;
      const server = http.createServer((req, res) => {{
        const body = JSON.stringify({{ ok: true }});
        res.writeHead(200, {{ "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "connection": "close" }});
        res.end(body);
      }});
      server.listen(sock, () => {{ try {{ fs.chmodSync(sock, 0o600); }} catch (_) {{}} }});
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
      setTimeout(() => server.close(() => process.exit(0)), 25000);
    '
    ;;
  exit1) echo "boom line" >&2; exit 1;;
  exit3) exit 3;;
  sleep) exec sleep 30;;
esac
echo "unknown behavior: $BEHAVIOR" >&2
exit 99
"#,
                argv = dir.path().join("argv.log").display(),
                behavior = behavior_file.display(),
                schema_range = dir.path().join("schema-range").display(),
            );
            std::fs::write(&bin, script).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            let data_dir = dir.path().join("data");
            let omp_bin = EnvOverride::set("OMP_RESUME_OMP_BIN", bin.to_str().unwrap());
            let assets_dir = EnvOverride::set(
                crate::superagent::paths::ASSETS_DIR_ENV,
                assets.path().to_str().unwrap(),
            );
            let backoff = EnvOverride::set("OMP_RESUME_SUPERAGENT_BACKOFF_MS", "50");
            let supervisor = Supervisor::for_test(data_dir.clone());
            Self {
                _dir: dir,
                _assets: assets,
                _omp_bin: omp_bin,
                _assets_dir: assets_dir,
                _backoff: backoff,
                supervisor,
            }
        }

        /// 等待状态变为 `want`（最多 `timeout`），超时 panic 并附当前状态。
        fn wait_state(&self, want: SuperagentState, timeout: Duration) {
            let deadline = Instant::now() + timeout;
            loop {
                let got = self.supervisor.status().state;
                if got == want {
                    return;
                }
                if Instant::now() >= deadline {
                    panic!("等待 {want:?} 超时，当前 {got:?}");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        /// 假守护进程的 `--print-schema` 应答范围（不调则无 schema 行 ⇒ `Unknown`）。
        fn set_daemon_schema(&self, oldest: u32, newest: u32) {
            std::fs::write(
                self.dir().join("schema-range"),
                format!("schema {{\"schema\":{newest},\"oldest\":{oldest}}}\n"),
            )
            .unwrap();
        }

        /// 假 omp 收到的调用参数（每行一次调用），供「未 spawn」断言。
        fn argv_lines(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir().join("argv.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // 测试结束兜底：确保假子进程被杀掉（正常路径已 stop）。
            self.supervisor.stop();
        }
    }

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn start_stop_lifecycle_with_real_child() {
        let _guard = env_guard();
        if !node_available() {
            eprintln!("skip: node 未安装，无法起假守护进程");
            return;
        }
        let fx = Fixture::new("serve");
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Running, Duration::from_secs(15));
        let st = fx.supervisor.status();
        assert!(st.pid.is_some());
        assert!(st.started_at.is_some());
        fx.supervisor.set_enabled(false).unwrap();
        fx.wait_state(SuperagentState::Disabled, Duration::from_secs(20));
        assert_eq!(fx.supervisor.status().pid, None);
    }

    #[test]
    fn crash_backoff_restarts_and_stop_cancels() {
        let _guard = env_guard();
        let fx = Fixture::new("exit1");
        fx.supervisor.set_enabled(true).unwrap();
        // 假进程秒退 → Crashed → 50ms 退避后重启 → 反复崩溃，
        // restarts 计数增长即证明重启发生。
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if fx.supervisor.status().restarts >= 2 {
                break;
            }
            if Instant::now() >= deadline {
                panic!("退避重启未发生：{:?}", fx.supervisor.status());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // stop 必须取消退避中的重启：停后 restarts 不再增长。
        fx.supervisor.set_enabled(false).unwrap();
        fx.wait_state(SuperagentState::Disabled, Duration::from_secs(20));
        let restarts = fx.supervisor.status().restarts;
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(fx.supervisor.status().restarts, restarts);
        assert_eq!(fx.supervisor.status().state, SuperagentState::Disabled);
    }

    #[test]
    fn exit_code_3_does_not_restart() {
        let _guard = env_guard();
        let fx = Fixture::new("exit3");
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Crashed, Duration::from_secs(10));
        let st = fx.supervisor.status();
        assert_eq!(st.restarts, 0);
        // 无 pid 文件 → 接管无果 → 新文案（带状态目录与手动指引），不重启。
        let want = format!(
            "另一个 Superagent 守护进程正在使用状态目录{}（未能自动接管，可手动结束该进程后重试）",
            st.state_dir,
        );
        assert_eq!(st.last_error.as_deref(), Some(want.as_str()));
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(fx.supervisor.status().restarts, 0);
        assert_eq!(fx.supervisor.status().state, SuperagentState::Crashed);
    }

    /// `kill -9` 掉的守护进程来不及删 `daemon.pid`：下一次 spawn 被残留文件
    /// 挡回退出码 3。清掉残留文件后必须真的重启——否则服务一直停在
    /// 「异常退出」，日志里每 60 秒一条 exit 3（0.8.0 线上故障形态）。
    #[test]
    fn exit3_with_stale_pid_file_cleans_and_restarts() {
        let _guard = env_guard();
        if !node_available() {
            eprintln!("skip: node 未安装，无法起假守护进程");
            return;
        }
        let fx = Fixture::new("serve");
        let state_dir = fx.supervisor.state_dir();
        std::fs::create_dir_all(state_dir.join("logs")).unwrap();
        // 一个已回收进程的 pid：等价于被 SIGKILL 的守护进程留下的 pid 文件。
        let mut dead = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let dead_pid = dead.id();
        dead.wait().unwrap();
        std::fs::write(
            super::super::paths::pid_path(&state_dir),
            format!("{dead_pid}\n"),
        )
        .unwrap();
        // 代际/状态摆成「刚 spawn 就被挡回 3」。
        let generation = {
            let mut inner = fx.supervisor.lock();
            inner.enabled = true;
            inner.state = SuperagentState::Starting;
            inner.generation += 1;
            inner.generation
        };
        fx.supervisor
            .on_already_running_exit(generation, &state_dir);
        // 修复前：清掉 pid 文件后停在 Crashed，永远不会 Running。
        fx.wait_state(SuperagentState::Running, Duration::from_secs(15));
        assert!(
            !super::super::paths::pid_path(&state_dir).exists(),
            "残留 pid 文件应在本轮清掉",
        );
    }

    /// 退出码 3 的停摆不是终点：无人占 socket 时按复查间隔自行重启，
    /// 次数有上限（复用到头就停，不等用户手点，也不会无限重试）。
    #[test]
    fn parked_conflict_retries_are_bounded() {
        let _guard = env_guard();
        let _retry = EnvOverride::set("OMP_RESUME_SUPERAGENT_CONFLICT_RETRY_MS", "30");
        let fx = Fixture::new("exit3");
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Crashed, Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(600));
        let spawns = std::fs::read_to_string(fx.dir().join("argv.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains(DAEMON_ENTRY_MARKER) && !line.contains("--print-schema"))
            .count();
        assert!(spawns >= 2, "停摆后应自行复查重启，实际 spawn {spawns} 次");
        assert!(
            spawns <= 1 + CONFLICT_BACKOFF_SECS.len(),
            "复查次数必须有上限，实际 spawn {spawns} 次",
        );
    }

    #[test]
    fn stop_is_idempotent_and_never_started_is_noop() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        fx.supervisor.stop_blocking();
        assert_eq!(fx.supervisor.status().state, SuperagentState::Disabled);
        assert_eq!(fx.supervisor.status().pid, None);
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(10));
        fx.supervisor.set_enabled(false).unwrap();
        fx.wait_state(SuperagentState::Disabled, Duration::from_secs(20));
        fx.supervisor.stop_blocking();
        assert_eq!(fx.supervisor.status().state, SuperagentState::Disabled);
    }

    #[test]
    fn double_start_keeps_single_instance() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(10));
        let pid1 = fx.supervisor.status().pid;
        let s2 = fx.supervisor.clone();
        let h = std::thread::spawn(move || s2.start());
        fx.supervisor.start().unwrap();
        h.join().unwrap().unwrap();
        assert_eq!(fx.supervisor.status().pid, pid1);
        assert!(matches!(
            fx.supervisor.status().state,
            SuperagentState::Starting | SuperagentState::Running
        ));
    }

    #[test]
    fn pid_file_parsing_accepts_decimal_with_newline() {
        assert_eq!(parse_pid_file("4242\n"), Some(4242));
        assert_eq!(parse_pid_file("4242"), Some(4242));
        assert_eq!(parse_pid_file("  4242\n"), Some(4242));
        assert_eq!(parse_pid_file("007\n"), Some(7));
        assert_eq!(parse_pid_file(""), None);
        assert_eq!(parse_pid_file("\n"), None);
        assert_eq!(parse_pid_file("0\n"), None);
        assert_eq!(parse_pid_file("-1\n"), None);
        assert_eq!(parse_pid_file("12a\n"), None);
        assert_eq!(parse_pid_file("4294967296\n"), None);
        // 多行：只看首行（守护进程只写一行，多余行视为损坏但首行可用）。
        assert_eq!(parse_pid_file("4242\n9999\n"), Some(4242));
    }

    #[test]
    fn daemon_command_verification_requires_marker_and_exact_state_dir() {
        let dir = "/tmp/sa-state";
        // 标准命令：omp run …/dist/daemon.js --state-dir <dir> --socket … --omp …
        let good = format!(
            "/Users/x/.local/bin/omp run /Applications/omp-resume.app/Contents/Resources/superagent/dist/daemon.js --state-dir {dir} --socket {dir}/daemon.sock --omp /Users/x/.local/bin/omp"
        );
        assert!(is_our_daemon_command(&good, dir));
        // 用 `node` 直跑的守护进程（BUN_BE_BUN 失效回退）：同样放行。
        assert!(is_our_daemon_command(
            &format!("node /repo/superagent/dist/daemon.js --state-dir {dir}"),
            dir
        ));
        // 缺入口标记 → 拒绝。
        assert!(!is_our_daemon_command(
            &format!("omp run /repo/other.js --state-dir {dir}"),
            dir
        ));
        // 状态目录不对 → 拒绝（另一个实例的孤儿不动）。
        assert!(!is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir {dir}-other"),
            dir
        ));
        // 前缀目录误配 → 拒绝（`--state-dir` 必须精确相等）。
        assert!(!is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir {dir}/evil --socket x"),
            dir
        ));
        // 标志名子串误配 → 拒绝。
        assert!(!is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir-evil {dir}"),
            dir
        ));
        // 值粘在等号后（守护进程从不用这种写法）→ 拒绝。
        assert!(!is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir={dir}"),
            dir
        ));
        // 回收复用的 pid 跑着别的程序 → 拒绝。
        assert!(!is_our_daemon_command("vim /tmp/notes.txt", dir));
        assert!(!is_our_daemon_command("", dir));
        // macOS 默认状态目录含空格：ps 把参数按空格拼成一行，切分 argv 会
        // 把目录拆碎——必须整体匹配。串尾无后续参数同样放行。
        let spaced = "/Users/x/Library/Application Support/omp-resume/superagent";
        assert!(is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir {spaced} --socket {spaced}/daemon.sock --omp /x/omp"),
            spaced
        ));
        assert!(is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir {spaced}"),
            spaced
        ));
        // 含空格目录的前缀误配 → 拒绝。
        assert!(!is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir {spaced}/evil --socket x"),
            spaced
        ));
        // 另一个含空格目录的孤儿 → 拒绝。
        assert!(!is_our_daemon_command(
            &format!("omp run /repo/dist/daemon.js --state-dir {spaced}-other"),
            spaced
        ));
    }

    #[test]
    fn last_log_line_reads_tail_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        std::fs::write(&path, "first\nsecond\nthird\n").unwrap();
        assert_eq!(last_log_line(&path).as_deref(), Some("third"));
        std::fs::write(&path, "no-trailing").unwrap();
        assert_eq!(last_log_line(&path).as_deref(), Some("no-trailing"));
        assert_eq!(last_log_line(&dir.path().join("missing")), None);
    }

    #[test]
    fn open_log_rotates_over_5mib() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let big = vec![b'x'; (LOG_ROTATE_BYTES + 1) as usize];
        std::fs::write(&path, &big).unwrap();
        let _f = open_log(&path).unwrap();
        assert!(path.with_extension("log.1").exists());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
    }

    #[test]
    fn missing_omp_sets_crashed_with_not_found() {
        let _guard = env_guard();
        // resolve_omp 顺序：OMP_RESUME_OMP_BIN（不存在则跳过）→ ~/.local/bin/omp
        // → homebrew → /usr/local → ~/.bun。把 HOME 指向空目录，才能确保
        // “找不到 omp”。（本机真实装有 omp 时尤其必要。）
        let dir = tempfile::tempdir().unwrap();
        let empty_home = tempfile::tempdir().unwrap();
        let _omp = EnvOverride::set("OMP_RESUME_OMP_BIN", "/nonexistent/omp-xyz");
        let _home = EnvOverride::set("HOME", empty_home.path().to_str().unwrap());
        let assets = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(assets.path().join("dist")).unwrap();
        std::fs::write(assets.path().join("dist/daemon.js"), "// fake\n").unwrap();
        let _assets_env = EnvOverride::set(
            crate::superagent::paths::ASSETS_DIR_ENV,
            assets.path().to_str().unwrap(),
        );
        // 若本机 /opt/homebrew/bin/omp 或 /usr/local/bin/omp 存在，resolve 仍会
        // 命中：此时跳过（CI 干净环境会跑到断言）。
        if crate::omp_cli::resolve_omp().is_some() {
            eprintln!("skip: 本机存在系统级 omp，无法模拟缺失");
            return;
        }
        let sv = Supervisor::for_test(dir.path().join("data"));
        let err = sv.set_enabled(true).unwrap_err();
        assert_eq!(err.code, ErrorCode::OmpNotFound);
        assert_eq!(sv.status().state, SuperagentState::Crashed);
    }

    #[test]
    fn reclaim_orphan_kills_verified_pid_and_starts() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        let state_dir = fx.supervisor.state_dir();
        std::fs::create_dir_all(&state_dir).unwrap();
        // 假孤儿：只发信号给本测试亲手 spawn 的 pid，绝不碰其他进程。
        // 用 `sh` 跑一个死循环脚本：脚本路径含 `dist/daemon.js` 标记，
        // 参数带 `--state-dir <dir>`，`ps -o command=` 可见且可被 SIGTERM
        // 杀掉（`sleep` 不接受多余参数，做不了 argv 载体）。
        let orphan_script = fx.dir().join("dist-daemon.js.sh");
        std::fs::write(&orphan_script, "#!/bin/sh\nwhile :; do sleep 1; done\n").unwrap();
        std::fs::set_permissions(&orphan_script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut orphan = std::process::Command::new("/bin/sh")
            .arg(&orphan_script)
            .arg("--state-dir")
            .arg(&state_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let orphan_pid = orphan.id();
        // 确认 ps 能看到完整命令行（macOS `ps -o command=` 无截断问题，
        // 短命令行必完整）；看不到则杀掉孤儿后跳过。
        let probe = ps_command_line(orphan_pid);
        let verified = probe
            .as_deref()
            .is_some_and(|cmd| is_our_daemon_command(cmd, &state_dir.display().to_string()));
        if !verified {
            let _ = orphan.kill();
            let _ = orphan.wait();
            eprintln!("skip: ps 看不到假孤儿的命令行（{probe:?}）");
            return;
        }
        std::fs::write(
            super::super::paths::pid_path(&state_dir),
            format!("{orphan_pid}\n"),
        )
        .unwrap();
        fx.supervisor.set_enabled(true).unwrap();
        // 新守护进程（sleep 行为）进入 Starting，且孤儿被 SIGTERM 回收。
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(30));
        let new_pid = fx.supervisor.status().pid.expect("新进程已 spawn");
        assert_ne!(new_pid, orphan_pid);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            // SAFETY：kill(pid, 0) 只做存在性探测。
            let alive = unsafe { libc::kill(orphan_pid as i32, 0) } == 0;
            // sleep 收到 SIGTERM 即退；若它变成 zombie（我们是父进程），
            // try_wait 会回收并返回退出状态，同样算接管成功。
            let reaped = orphan.try_wait().ok().flatten().is_some();
            if reaped || !alive {
                break;
            }
            if Instant::now() >= deadline {
                let _ = orphan.kill();
                let _ = orphan.wait();
                panic!("假孤儿 pid {orphan_pid} 未被接管杀掉");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = orphan.wait();
        // pid 文件已删（接管成功），日志里有审计行。
        assert!(!super::super::paths::pid_path(&state_dir).exists());
        let log = std::fs::read_to_string(super::super::paths::log_path(&state_dir)).unwrap();
        assert!(
            log.contains(&format!(
                "[supervisor] reclaimed orphaned daemon pid {orphan_pid}"
            )),
            "日志缺接管行：{log:?}",
        );
        fx.supervisor.set_enabled(false).unwrap();
        fx.wait_state(SuperagentState::Disabled, Duration::from_secs(20));
    }

    #[test]
    fn reclaim_refuses_recycled_pid() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        let state_dir = fx.supervisor.state_dir();
        std::fs::create_dir_all(&state_dir).unwrap();
        // 回收复用场景：pid 文件指向一个存在、但命令行不是守护进程的进程。
        // 用亲手 spawn 的 sleep 模拟：绝不给它发信号，只验证拒绝逻辑。
        let mut other = std::process::Command::new("/bin/sleep")
            .arg("120")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let other_pid = other.id();
        std::fs::write(
            super::super::paths::pid_path(&state_dir),
            format!("{other_pid}\n"),
        )
        .unwrap();
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(30));
        // 拒绝接管：sleep 存活（没收到信号），pid 文件保留，新进程照常起。
        // SAFETY：kill(pid, 0) 只做存在性探测，不发信号。
        assert_eq!(unsafe { libc::kill(other_pid as i32, 0) }, 0);
        assert!(other.try_wait().unwrap().is_none());
        assert!(super::super::paths::pid_path(&state_dir).exists());
        assert!(fx.supervisor.status().pid.is_some());
        let log = std::fs::read_to_string(super::super::paths::log_path(&state_dir)).unwrap();
        assert!(
            log.contains("[supervisor] reclaim refused:"),
            "日志缺拒绝行：{log:?}",
        );
        let _ = other.kill();
        let _ = other.wait();
        fx.supervisor.set_enabled(false).unwrap();
        fx.wait_state(SuperagentState::Disabled, Duration::from_secs(20));
    }

    /// 严格接管在 `ps` 自身失败但 pid 存活时必须保留 pid 文件并拒绝：
    /// `ps` 返回 None 覆盖“进程已死”与“查询超时/spawn 失败”两种情况，
    /// 不加区分就删文件会毁掉退出码 3 二次接管唯一的 pid 指针。
    #[test]
    fn reclaim_strict_keeps_pid_file_when_ps_fails_but_pid_alive() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        let state_dir = fx.supervisor.state_dir();
        std::fs::create_dir_all(&state_dir).unwrap();
        // 亲手 spawn 的 sleep：绝不给它发信号，只验证拒绝逻辑。
        let mut other = std::process::Command::new("/bin/sleep")
            .arg("120")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let other_pid = other.id();
        std::fs::write(
            super::super::paths::pid_path(&state_dir),
            format!("{other_pid}\n"),
        )
        .unwrap();
        // 劫持 `ps` 为不存在的二进制：`ps_command_line` 必回 None，
        // 而 sleep 存活——严格接管必须拒绝且保留 pid 文件。
        let _ps = EnvOverride::set("OMP_RESUME_TEST_PS_BIN", "/nonexistent-ps-for-test");
        // SAFETY：kill(pid, 0) 只做存在性探测，不发信号；先确认前置条件成立。
        assert_eq!(unsafe { libc::kill(other_pid as i32, 0) }, 0);
        assert_eq!(ps_command_line(other_pid), None);
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(30));
        // 拒绝接管：sleep 存活（没收到信号），pid 文件保留，新进程照常起。
        assert_eq!(unsafe { libc::kill(other_pid as i32, 0) }, 0);
        assert!(other.try_wait().unwrap().is_none());
        assert!(super::super::paths::pid_path(&state_dir).exists());
        assert!(fx.supervisor.status().pid.is_some());
        let log = std::fs::read_to_string(super::super::paths::log_path(&state_dir)).unwrap();
        assert!(
            log.contains(&format!("ps 查询 pid {other_pid} 的命令行失败")),
            "日志缺 ps 失败拒绝行：{log:?}",
        );
        drop(_ps);
        let _ = other.kill();
        let _ = other.wait();
        fx.supervisor.set_enabled(false).unwrap();
        fx.wait_state(SuperagentState::Disabled, Duration::from_secs(20));
    }

    /// 退出码 3 的二次接管必须杀掉持锁者，哪怕它的命令行通不过严格核验：
    /// 回归 0.7.0 发布后的线上故障——旧版 `is_our_daemon_command` 按空白切分
    /// argv，macOS 默认状态目录含空格（`…/Application Support/…`），真正的
    /// 守护进程永远匹配不上，spawn 前接管与二次接管都以“不是本状态目录的
    /// 守护进程”拒绝，服务页卡死在「异常退出」且重启次数为 0。
    ///
    /// 二次接管只做弱核验（命令行含 `dist/daemon.js` 标记即可，不要求
    /// `--state-dir` 严格匹配）：假持锁者的命令行带标记但指着另一个状态
    /// 目录——spawn 前接管会拒绝它，而退出码 3 的二次接管必须杀掉它并重启成功。
    #[test]
    fn exit3_reclaims_holder_despite_strict_mismatch() {
        let _guard = env_guard();
        // `serve` 行为的假守护进程需要 node；重启成功以进入 Running 为准。
        if !node_available() {
            eprintln!("skip: node 未安装，无法起假守护进程");
            return;
        }
        let fx = Fixture::new("serve");
        let state_dir = fx.supervisor.state_dir();
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::create_dir_all(state_dir.join("logs")).unwrap();
        // 假持锁者：脚本路径含 `dist/daemon.js` 标记（弱核验通过），但
        // `--state-dir` 指向另一个目录（严格核验拒绝，模拟空格/截断/改名
        // 导致的误拒）。只发信号给本测试亲手 spawn 的 pid。
        let holder_dir = fx.dir().join("dist");
        std::fs::create_dir_all(&holder_dir).unwrap();
        let holder_script = holder_dir.join("daemon.js.sh");
        std::fs::write(&holder_script, "#!/bin/sh\nwhile :; do sleep 1; done\n").unwrap();
        std::fs::set_permissions(&holder_script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut holder = std::process::Command::new("/bin/sh")
            .arg(&holder_script)
            .arg("--state-dir")
            .arg(fx.dir().join("other-state"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let holder_pid = holder.id();
        // 确认它卡在“弱过、严拒”的位置上：含标记但严格匹配不上。
        let probe = ps_command_line(holder_pid);
        let Some(cmd) = probe.as_deref() else {
            let _ = holder.kill();
            let _ = holder.wait();
            eprintln!("skip: ps 看不到假持锁者的命令行");
            return;
        };
        assert!(
            cmd.contains(DAEMON_ENTRY_MARKER),
            "假持锁者应含入口标记：{cmd:?}",
        );
        assert!(
            !is_our_daemon_command(cmd, &state_dir.display().to_string()),
            "假持锁者应通不过严格核验：{cmd:?}",
        );
        std::fs::write(
            super::super::paths::pid_path(&state_dir),
            format!("{holder_pid}\n"),
        )
        .unwrap();
        // 直接调退出码 3 的处理路径：代际与状态先摆成“刚 spawn、秒退”的样子。
        let generation = {
            let mut inner = fx.supervisor.lock();
            inner.enabled = true;
            inner.state = SuperagentState::Starting;
            inner.generation += 1;
            inner.generation
        };
        fx.supervisor
            .on_already_running_exit(generation, &state_dir);
        // 持锁者必须被杀掉（SIGTERM 即退；zombie 由 try_wait 回收同样算数）。
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            // SAFETY：kill(pid, 0) 只做存在性探测。
            let alive = unsafe { libc::kill(holder_pid as i32, 0) } == 0;
            let reaped = holder.try_wait().ok().flatten().is_some();
            if reaped || !alive {
                break;
            }
            if Instant::now() >= deadline {
                let _ = holder.kill();
                let _ = holder.wait();
                panic!("假持锁者 pid {holder_pid} 未被二次接管杀掉");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = holder.wait();
        assert!(!super::super::paths::pid_path(&state_dir).exists());
        // 接管成功后直接重启：serve 行为的假守护进程应进入 Running。
        fx.wait_state(SuperagentState::Running, Duration::from_secs(30));
        // 审计行在轮转前或当前日志里（二者必居其一）。
        let log_path = super::super::paths::log_path(&state_dir);
        let rotated = log_path.with_extension("log.1");
        let log = std::fs::read_to_string(&log_path).unwrap();
        let old = std::fs::read_to_string(&rotated).unwrap_or_default();
        assert!(
            log.contains(&format!(
                "[supervisor] reclaimed orphaned daemon pid {holder_pid}"
            )) || old.contains(&format!(
                "[supervisor] reclaimed orphaned daemon pid {holder_pid}"
            )),
            "日志缺接管行：当前{log:?} 轮转{old:?}",
        );
        fx.supervisor.set_enabled(false).unwrap();
        fx.wait_state(SuperagentState::Disabled, Duration::from_secs(20));
    }

    /// 退出码 3 的二次接管遇到 pid 复用必须拒绝：pid 文件指向存活但命令行
    /// 不含入口标记的进程时（崩溃残留 pid 被无关进程复用），绝不发信号，
    /// 置 `Crashed` 且错误文案带 pid 与 kill 指引。
    #[test]
    fn exit3_refuses_recycled_pid_without_marker() {
        let _guard = env_guard();
        let fx = Fixture::new("exit3");
        let state_dir = fx.supervisor.state_dir();
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::create_dir_all(state_dir.join("logs")).unwrap();
        // 亲手 spawn 的 sleep：绝不给它发信号，只验证拒绝逻辑。
        let mut other = std::process::Command::new("/bin/sleep")
            .arg("300")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let other_pid = other.id();
        // 确认它确实不含标记（否则测不到弱核验的拒绝分支）。
        let probe = ps_command_line(other_pid);
        assert!(
            !probe
                .as_deref()
                .is_some_and(|cmd| cmd.contains(DAEMON_ENTRY_MARKER)),
            "假复用进程意外含有入口标记：{probe:?}",
        );
        std::fs::write(
            super::super::paths::pid_path(&state_dir),
            format!("{other_pid}\n"),
        )
        .unwrap();
        // 直接调退出码 3 的处理路径：代际与状态先摆成“刚 spawn、秒退”的样子。
        let generation = {
            let mut inner = fx.supervisor.lock();
            inner.enabled = true;
            inner.state = SuperagentState::Starting;
            inner.generation += 1;
            inner.generation
        };
        fx.supervisor
            .on_already_running_exit(generation, &state_dir);
        // 拒绝：sleep 存活（没收到信号），pid 文件保留，状态 Crashed。
        // SAFETY：kill(pid, 0) 只做存在性探测，不发信号。
        assert_eq!(unsafe { libc::kill(other_pid as i32, 0) }, 0);
        assert!(other.try_wait().unwrap().is_none());
        assert!(super::super::paths::pid_path(&state_dir).exists());
        let st = fx.supervisor.status();
        assert_eq!(st.state, SuperagentState::Crashed);
        assert_eq!(st.restarts, 0);
        let want = format!(
            "另一个 Superagent 守护进程（pid {other_pid}）正在使用状态目录{}（未能自动接管，可手动结束该进程后重试：kill {other_pid}，仍在则 kill -9 {other_pid}）",
            st.state_dir,
        );
        assert_eq!(st.last_error.as_deref(), Some(want.as_str()));
        let log = std::fs::read_to_string(super::super::paths::log_path(&state_dir)).unwrap();
        assert!(
            log.contains(&format!("pid {other_pid} 的命令行不含守护进程标记")),
            "日志缺拒绝行：{log:?}",
        );
        let _ = other.kill();
        let _ = other.wait();
    }

    /// 在状态目录里写一个 `kv('schema', v)` 的库（`store.ts` 同款写入口径）。
    fn write_state_db(state_dir: &std::path::Path, schema: u32) {
        std::fs::create_dir_all(state_dir).unwrap();
        let conn = rusqlite::Connection::open(state_dir.join("superagent.sqlite")).unwrap();
        conn.execute(
            "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO kv VALUES ('schema', ?1)", [schema.to_string()])
            .unwrap();
    }

    #[test]
    fn schema_too_new_parks_incompatible_without_spawn_or_retry() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        fx.set_daemon_schema(10, 11);
        write_state_db(&fx.supervisor.state_dir(), 13);
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Incompatible, Duration::from_secs(15));
        let st = fx.supervisor.status();
        assert_eq!(st.pid, None);
        assert_eq!(st.restarts, 0);
        let schema = st.schema.clone().expect("失配明细缺失");
        assert_eq!((schema.state, schema.oldest, schema.newest), (13, 10, 11));
        let err = st.last_error.as_deref().expect("last_error 缺失");
        assert!(err.contains("13"), "{err:?}");
        assert!(err.contains("11"), "{err:?}");
        assert!(err.contains("改用新状态目录"), "{err:?}");
        // 只跑过 `--print-schema` 探测：真正的 daemon spawn（带 `--state-dir`）一次没有。
        // 假子进程落 argv.log 与父进程置 Incompatible 有竞态：轮询等探测行出现。
        let deadline = Instant::now() + Duration::from_secs(10);
        let argv = loop {
            let argv = fx.argv_lines();
            if !argv.is_empty() {
                break argv;
            }
            assert!(Instant::now() < deadline, "探测都没跑？");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(
            argv.iter().all(|line| line.contains("--print-schema")),
            "拦停后仍有 spawn：{argv:?}"
        );
        // 无退避重试：50ms 退避下等 300ms，调用次数与状态都不变。
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(fx.supervisor.status().state, SuperagentState::Incompatible);
        assert_eq!(fx.supervisor.status().restarts, 0);
        assert_eq!(fx.argv_lines(), argv);
    }

    #[test]
    fn schema_too_old_parks_and_compatible_proceeds() {
        let _guard = env_guard();
        // 库 9 < 下限 10：拦停。
        let fx = Fixture::new("sleep");
        fx.set_daemon_schema(10, 13);
        write_state_db(&fx.supervisor.state_dir(), 9);
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Incompatible, Duration::from_secs(15));
        let st = fx.supervisor.status();
        let schema = st.schema.clone().expect("失配明细缺失");
        assert_eq!((schema.state, schema.oldest, schema.newest), (9, 10, 13));
        let err = st.last_error.as_deref().expect("last_error 缺失");
        assert!(err.contains('9') && err.contains("10"), "{err:?}");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let argv = fx.argv_lines();
            assert!(
                argv.iter().all(|l| l.contains("--print-schema")),
                "{argv:?}"
            );
            if !argv.is_empty() {
                break;
            }
            assert!(Instant::now() < deadline, "探测都没跑？");
            std::thread::sleep(Duration::from_millis(50));
        }
        // 库 12 在范围内：正常 spawn（sleep 行为 → Starting，有 pid）。
        let fx2 = Fixture::new("sleep");
        fx2.set_daemon_schema(10, 13);
        write_state_db(&fx2.supervisor.state_dir(), 12);
        fx2.supervisor.set_enabled(true).unwrap();
        fx2.wait_state(SuperagentState::Starting, Duration::from_secs(15));
        let st2 = fx2.supervisor.status();
        assert!(st2.pid.is_some());
        assert_eq!(st2.schema, None);
        // 假子进程落 argv.log 与父进程置 Starting 有竞态：轮询等一行 spawn 记录。
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if fx2.argv_lines().iter().any(|l| l.contains("--state-dir")) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "spawn 记录缺失：{:?}",
                fx2.argv_lines()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn reset_state_archives_and_restarts() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        fx.set_daemon_schema(10, 11);
        let state_dir = fx.supervisor.state_dir();
        write_state_db(&state_dir, 13);
        std::fs::write(state_dir.join("daemon.pid"), "4242\n").unwrap();
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Incompatible, Duration::from_secs(15));
        let st = fx.supervisor.reset_state().unwrap();
        // 新状态目录是干净的：旧库不在了，守护进程（sleep 行为）正常起。
        assert!(!state_dir.join("superagent.sqlite").exists());
        assert_eq!(st.schema, None);
        // 归档路径进 `archived_to`（绝对路径），`last_error` 留给新目录、不掺路径。
        let archived_to = st.archived_to.clone().expect("archived_to 缺失");
        assert!(
            std::path::Path::new(&archived_to).is_absolute(),
            "{archived_to:?}"
        );
        assert_eq!(st.last_error, None);
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(15));
        assert!(fx.supervisor.status().pid.is_some());
        // 归档目录：`<state>.schema-13-<stamp>`，旧库在里面，永不删除；
        // 且与 `archived_to` 是同一个目录。
        let prefix = format!(
            "{}.schema-13-",
            state_dir.file_name().unwrap().to_string_lossy()
        );
        let archived: Vec<_> = std::fs::read_dir(state_dir.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(&prefix))
            })
            .collect();
        assert_eq!(archived.len(), 1, "归档目录数量不对：{archived:?}");
        assert_eq!(archived[0].display().to_string(), archived_to);
        assert_eq!(
            super::super::schema::read_state_schema(&archived[0].join("superagent.sqlite")),
            Some(13)
        );
        assert!(archived[0].join("daemon.pid").exists());
        // 非 Incompatible 时拒绝。
        let err = fx.supervisor.reset_state().unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        // 下次成功启动后旧归档路径不再残留。
        fx.supervisor.restart().unwrap();
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(15));
        assert_eq!(fx.supervisor.status().archived_to, None);
    }

    #[test]
    fn reset_state_refused_when_not_incompatible() {
        let _guard = env_guard();
        let fx = Fixture::new("sleep");
        let err = fx.supervisor.reset_state().unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        // 正常启动后同样拒绝。
        fx.supervisor.set_enabled(true).unwrap();
        fx.wait_state(SuperagentState::Starting, Duration::from_secs(15));
        let err = fx.supervisor.reset_state().unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn archive_name_conflicts_get_numeric_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("superagent");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("superagent.sqlite"), b"db").unwrap();
        let first = archive_state_dir(&state_dir, 13).unwrap();
        assert!(first.join("superagent.sqlite").exists());
        assert!(state_dir.is_dir());
        assert_eq!(std::fs::read_dir(&state_dir).unwrap().count(), 0);
        // 同一秒内再归档一次：若时间戳相同则追加 `-2`，一定得到不同目录。
        std::fs::write(state_dir.join("superagent.sqlite"), b"db2").unwrap();
        let second = archive_state_dir(&state_dir, 13).unwrap();
        assert_ne!(first, second);
        assert!(second.join("superagent.sqlite").exists());
        for archived in [&first, &second] {
            let name = archived.file_name().unwrap().to_string_lossy();
            assert!(name.starts_with("superagent.schema-13-"), "{name:?}");
        }
    }
}
