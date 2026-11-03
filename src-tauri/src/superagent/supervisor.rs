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
    /// 代际：每次 `start`/`stop` 递增，旧线程凭此自杀。
    generation: u64,
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
                generation: 0,
                child: None,
                started_instant: None,
            })),
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

    /// 当前状态快照（供命令层与前端轮询）。
    ///
    /// 只持锁做字段拷贝：`resolve_omp`/`assets_dir` 的文件探测在锁外执行，
    /// 避免 3 秒一次的轮询与启停路径互相拖慢。
    pub fn status(&self) -> SuperagentStatus {
        let (state, enabled, pid, started_at, restarts, last_error) = {
            let inner = self.lock();
            (
                inner.state,
                inner.enabled,
                inner.pid,
                inner.started_at.clone(),
                inner.restarts,
                inner.last_error.clone(),
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
        self.start()?;
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
                ReclaimOutcome::NoPidFile => {}
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
    /// 触发条件：`<state_dir>/daemon.pid` 存在。核验该 pid 的命令行
    /// （`/bin/ps -p <pid> -o command=`）同时包含 `dist/daemon.js` 与精确的
    /// `--state-dir <state_dir>` 参数才动手；否则拒绝（pid 已被回收复用）。
    /// 只给该 pid 自身发 SIGTERM（不是进程组：它不是我们的子进程），
    /// 20 秒未退则 SIGKILL 再等 5 秒；成功后删掉 pid 文件。
    /// 全程在锁外等待，每 100ms 检查代际，可被 stop()/disable 中断。
    fn reclaim_orphan(&self, state_dir: &std::path::Path, generation: u64) -> ReclaimOutcome {
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
        // 中断检查点：读文件与 ps 之间也可能被 stop/disable 抢占。
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
        let command = match ps_command_line(pid) {
            Some(command) => command,
            None => {
                // ps 查不到该 pid：进程已死，删掉残留 pid 文件后视为无孤儿。
                let _ = std::fs::remove_file(&pid_path);
                let mut inner = self.lock();
                if inner.generation == generation {
                    inner.last_error = None;
                }
                return ReclaimOutcome::NoPidFile;
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
        // 只杀该 pid 自身：孤儿不是我们的子进程，没有可用的进程组语义。
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
            let _ = std::fs::remove_file(&pid_path);
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
            let _ = std::fs::remove_file(&pid_path);
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
        match self.reclaim_orphan(state_dir, generation) {
            ReclaimOutcome::Reclaimed { pid } => {
                append_log_line(
                    &super::paths::log_path(state_dir),
                    &format!("[supervisor] reclaimed orphaned daemon pid {pid}"),
                );
                let mut inner = self.lock();
                if inner.generation != generation || !inner.enabled {
                    return;
                }
                // 新 spawn 需要干净的预占位：清掉已退出的旧句柄。
                inner.pid = None;
                inner.child = None;
                inner.state = SuperagentState::Starting;
                inner.last_error = None;
                inner.generation += 1;
                let next = inner.generation;
                drop(inner);
                // spawn 前接管已删掉 pid 文件：这里直调 `start_after_guard`
                // 但不再接管（至多一次）。
                if let Err(e) = self.start_after_guard(next, false) {
                    let mut inner = self.lock();
                    if inner.generation == next {
                        inner.last_error = Some(e.message);
                    }
                }
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

    /// 退出码 3 且接管无果：置 `Crashed` + 指引文案（不重启）。
    fn set_already_running_crashed(&self, generation: u64, state_dir: &std::path::Path) {
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        inner.pid = None;
        inner.child = None;
        inner.state = SuperagentState::Crashed;
        inner.last_error = Some(format!(
            "另一个 Superagent 守护进程正在使用状态目录{}（未能自动接管，可手动结束该进程后重试）",
            state_dir.display(),
        ));
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

/// 等待线程持有的弱引用式句柄：只带重建 `&Supervisor` 所需的字段，
/// 避免把 `Supervisor`（含 `!Send` 风险）直接移进线程。
struct SelfHandle {
    app: Option<tauri::AppHandle>,
    data_dir: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl SelfHandle {
    fn on_child_exit(&self, generation: u64, status: std::io::Result<std::process::ExitStatus>) {
        // 复用 Supervisor 的退出处理：临时借出等价引用。
        let supervisor = Supervisor {
            app: self.app.clone(),
            data_dir: self.data_dir.clone(),
            inner: Arc::clone(&self.inner),
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

/// 孤儿接管结果。
enum ReclaimOutcome {
    /// 无 pid 文件：无孤儿，直接启动。
    NoPidFile,
    /// 接管成功：旧进程已退出，pid 文件已删。
    Reclaimed { pid: u32 },
    /// 拒绝接管：pid 文件坏了、pid 不是我们的守护进程、或超时未退。
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
///
/// 必须同时满足：包含 `dist/daemon.js`，且以空白切分后的 argv 中出现
/// 精确的 `--state-dir <state_dir>` 相邻二元组（防 `--state-dir-evil`、
/// 前缀目录、子串误配）。`ps -o command=` 在 macOS 上对超长命令行会
/// 截断：截断只会导致拒绝接管（保守），不会误杀。
fn is_our_daemon_command(command: &str, state_dir: &str) -> bool {
    if !command.contains(DAEMON_ENTRY_MARKER) {
        return false;
    }
    let args: Vec<&str> = command.split_whitespace().collect();
    args.windows(2)
        .any(|w| w[0] == "--state-dir" && w[1] == state_dir)
}

/// 经 `/bin/ps -p <pid> -o command=` 取该进程的完整命令行。
/// 查不到（已退出）、超时、spawn 失败一律 None（调用方按“无孤儿”处理）。
fn ps_command_line(pid: u32) -> Option<String> {
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
}
