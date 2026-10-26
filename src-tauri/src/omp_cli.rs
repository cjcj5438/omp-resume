//! omp CLI：固定入口、可注入二进制、安全超时与逐行输出。
use std::io::{BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::model::{AppError, ErrorCode, OmpUpdateCheck, OmpUpdateResult, OmpVersion};

pub const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
pub const UPDATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 仅串行化假 CLI 的进程测试，避免 macOS 并发冷启动挤占短超时。
#[cfg(test)]
pub(crate) fn subprocess_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn resolve_omp_with(
    env: impl Fn(&str) -> Option<String>,
    home: &Path,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    env("OMP_RESUME_OMP_BIN")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .chain([
            home.join(".local/bin/omp"),
            PathBuf::from("/opt/homebrew/bin/omp"),
            PathBuf::from("/usr/local/bin/omp"),
            home.join(".bun/bin/omp"),
        ])
        .find(|p| exists(p))
}

pub fn resolve_omp() -> Option<PathBuf> {
    let home = crate::util::home_dir();
    let bin = resolve_omp_with(|key| std::env::var(key).ok(), &home, Path::exists)?;
    if bin.is_absolute() {
        Some(bin)
    } else {
        std::env::current_dir().ok().map(|cwd| cwd.join(bin))
    }
}

/// 去除 CSI 颜色、OSC 链接与其他 ANSI 转义，保留正文和换行。
pub fn strip_ansi(input: &str) -> String {
    let mut chars = input.chars().peekable();
    let mut output = String::with_capacity(input.len());
    while let Some(c) = chars.next() {
        if c != '\x1b' && c != '\u{9b}' && c != '\u{9d}' {
            output.push(c);
            continue;
        }
        let kind = if c == '\x1b' {
            chars.next()
        } else if c == '\u{9b}' {
            Some('[')
        } else {
            Some(']')
        };
        match kind {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']' | 'P' | 'X' | '^' | '_') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || c == '\u{9c}' {
                        break;
                    }
                    if c == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            Some(c) if (' '..='/').contains(&c) => {
                for c in chars.by_ref() {
                    if ('0'..='~').contains(&c) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    output
}

#[derive(Default)]
pub struct OmpBusy(AtomicBool);

pub struct BusyGuard<'a>(&'a AtomicBool);

impl OmpBusy {
    pub fn try_acquire(&self) -> Result<BusyGuard<'_>, AppError> {
        self.0
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| BusyGuard(&self.0))
            .map_err(|_| AppError::new(ErrorCode::Busy, "另一个 omp 操作正在进行"))
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug)]
pub struct RunOutput {
    pub code: i32,
    pub output: String,
}

struct Process {
    child: Child,
    readers: Vec<JoinHandle<()>>,
    finished: bool,
    stop_readers: Arc<AtomicBool>,
}

impl Process {
    fn stop(&mut self) {
        if !self.finished {
            // 独立进程组：连同继承管道的子进程一起结束。wait 之后不再补杀，
            // 此时 pid 已释放，数值可能被重用，补杀会误伤无辜进程组；
            // reader 靠 stop 标志 + 非阻塞读退出，不依赖第二次 kill。
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.stop_readers.store(true, Ordering::Release);
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        self.finished = true;
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Line {
    text: String,
    newline: bool,
}

enum PipeMsg {
    Line(Line),
    Capped,
    Failed(std::io::Error),
}

fn read_lines(
    pipe: impl Read + AsRawFd,
    sender: mpsc::Sender<PipeMsg>,
    stop: Arc<AtomicBool>,
    cap: Option<usize>,
) {
    // 继承管道的后代即使脱离进程组，也不能让 reader 无限等待 EOF。
    let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
    if flags == -1
        || unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        let _ = sender.send(PipeMsg::Failed(std::io::Error::last_os_error()));
        return;
    }
    let send = |bytes: &[u8]| {
        let newline = bytes.last() == Some(&b'\n');
        let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
        sender
            .send(PipeMsg::Line(Line {
                text: strip_ansi(&String::from_utf8_lossy(bytes)),
                newline,
            }))
            .is_ok()
    };
    // 已发送字节与未换行缓冲都计入上限。
    let over_cap =
        |sent: usize, buffered: usize| cap.is_some_and(|cap| sent.saturating_add(buffered) > cap);
    let mut reader = BufReader::new(pipe);
    let mut bytes = Vec::new();
    let mut sent: usize = 0;
    loop {
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => break,
            Ok(_) => {
                if over_cap(sent, bytes.len()) {
                    let _ = sender.send(PipeMsg::Capped);
                    return;
                }
                if !send(&bytes) {
                    return;
                }
                sent += bytes.len();
                bytes.clear();
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if over_cap(sent, bytes.len()) {
                    let _ = sender.send(PipeMsg::Capped);
                    return;
                }
                if stop.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                let _ = sender.send(PipeMsg::Failed(e));
                return;
            }
        }
    }
    if !bytes.is_empty() {
        if over_cap(sent, bytes.len()) {
            let _ = sender.send(PipeMsg::Capped);
            return;
        }
        send(&bytes);
    }
}

pub(crate) fn output_tail(output: &str) -> &str {
    let start = output.char_indices().rev().nth(499).map_or(0, |(i, _)| i);
    output[start..].trim()
}

/// 不经 shell；非零退出交给调用方判断。所有退出路径均回收进程和 reader。
pub fn run_omp(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
    on_line: &mut dyn FnMut(&str),
) -> Result<RunOutput, AppError> {
    run_omp_with(bin, args, timeout, on_line, RunOpts::default())
}

#[derive(Default, Clone, Copy)]
pub struct RunOpts<'a> {
    /// 额外环境变量（覆盖继承值），设置在 PATH 之后。
    pub extra_env: Option<(&'a str, &'a Path)>,
    /// 单路（stdout/stderr 各自）累计字节上限；None = 不限（现行为）。
    pub pipe_cap: Option<usize>,
}

/// `run_omp` 的可配版：见 `RunOpts`。
pub fn run_omp_with(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
    on_line: &mut dyn FnMut(&str),
    opts: RunOpts<'_>,
) -> Result<RunOutput, AppError> {
    let mut path = std::ffi::OsString::from("/opt/homebrew/bin:/usr/local/bin:");
    if let Some(home) = std::env::var_os("HOME") {
        path.push(PathBuf::from(home).join(".local/bin"));
    }
    path.push(":");
    path.push(std::env::var_os("PATH").unwrap_or_default());
    path.push(":/usr/bin:/bin:/usr/sbin:/sbin");
    let mut command = if bin.is_absolute() {
        Command::new(bin)
    } else {
        // 即使测试或覆盖值只给文件名，也绝不转去 PATH 查找同名程序。
        Command::new(Path::new(".").join(bin))
    };
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .env("PATH", path);
    if let Some((k, v)) = opts.extra_env {
        command.env(k, v);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command
        .spawn()
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法启动 omp：{e}")))?;
    let mut process = Process {
        child,
        readers: Vec::new(),
        finished: false,
        stop_readers: Arc::new(AtomicBool::new(false)),
    };
    let (sender, receiver) = mpsc::channel();
    let stdout = process.child.stdout.take().expect("已配置 stdout 管道");
    let stderr = process.child.stderr.take().expect("已配置 stderr 管道");
    let err_sender = sender.clone();
    let out_stop = Arc::clone(&process.stop_readers);
    let err_stop = Arc::clone(&process.stop_readers);
    let out_cap = opts.pipe_cap;
    let err_cap = opts.pipe_cap;
    process.readers.push(thread::spawn(move || {
        read_lines(stdout, sender, out_stop, out_cap)
    }));
    process.readers.push(thread::spawn(move || {
        read_lines(stderr, err_sender, err_stop, err_cap)
    }));
    let started = Instant::now();
    let mut output = String::new();
    let mut status = None;
    let mut disconnected = false;
    loop {
        let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
            process.stop();
            // 杀进程后管道关闭，收下最后未换行的部分输出再生成错误。
            for msg in receiver.try_iter() {
                let PipeMsg::Line(line) = msg else { continue };
                on_line(&line.text);
                output.push_str(&line.text);
                if line.newline {
                    output.push('\n');
                }
            }
            return Err(AppError::new(
                ErrorCode::Timeout,
                format!("omp 操作超时：{}", output_tail(&output)),
            ));
        };
        let pause = remaining.min(Duration::from_millis(20));
        if disconnected {
            thread::sleep(pause);
        } else {
            match receiver.recv_timeout(pause) {
                Ok(PipeMsg::Line(line)) => {
                    on_line(&line.text);
                    output.push_str(&line.text);
                    if line.newline {
                        output.push('\n');
                    }
                }
                Ok(PipeMsg::Capped) => {
                    process.stop();
                    return Err(AppError::new(
                        ErrorCode::OmpFailed,
                        "omp 输出超过上限，已终止",
                    ));
                }
                Ok(PipeMsg::Failed(e)) => {
                    return Err(AppError::new(
                        ErrorCode::Io,
                        format!("读取 omp 输出失败：{e}"),
                    ))
                }
                Err(RecvTimeoutError::Disconnected) => disconnected = true,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        if status.is_none() {
            status = process
                .child
                .try_wait()
                .map_err(|e| AppError::new(ErrorCode::Io, format!("等待 omp 失败：{e}")))?;
        }
        if disconnected {
            if let Some(status) = status {
                process.finished = true;
                return Ok(RunOutput {
                    code: status.code().unwrap_or(-1),
                    output,
                });
            }
        }
    }
}

fn version_token(value: &str) -> Option<String> {
    let value = value.trim();
    let core = value.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    if !(0..3).all(|_| {
        parts
            .next()
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
    }) || parts.next().is_some()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'+'))
    {
        return None;
    }
    Some(value.to_owned())
}

pub fn parse_version_output(output: &str) -> Option<String> {
    strip_ansi(output)
        .lines()
        .find_map(|line| line.trim().strip_prefix("omp/").and_then(version_token))
}

#[derive(Debug, PartialEq, Eq)]
pub struct UpdateCheck {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub up_to_date: bool,
}

pub fn parse_update_check(output: &str) -> UpdateCheck {
    let output = strip_ansi(output);
    let current = output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Current version:")
            .and_then(version_token)
    });
    let latest = output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("New version available:")
            .and_then(version_token)
    });
    let lower = output.to_ascii_lowercase();
    UpdateCheck {
        current,
        latest,
        up_to_date: lower.contains("already up to date")
            && !lower.contains("new version available"),
    }
}

pub fn omp_not_found() -> AppError {
    AppError::new(
        ErrorCode::OmpNotFound,
        "未找到 omp，请安装 omp 或设置 OMP_RESUME_OMP_BIN",
    )
}

pub(crate) fn require_success(result: RunOutput, summary: &str) -> Result<String, AppError> {
    if result.code != 0 {
        return Err(AppError::new(
            ErrorCode::OmpFailed,
            format!(
                "{summary}（退出码 {}）：{}",
                result.code,
                output_tail(&result.output)
            ),
        ));
    }
    Ok(result.output)
}

pub fn omp_version_impl(bin: Option<&Path>) -> Result<OmpVersion, AppError> {
    let Some(bin) = bin else {
        return Ok(OmpVersion {
            version: None,
            path: None,
        });
    };
    let output = require_success(
        run_omp(bin, &["--version"], VERSION_TIMEOUT, &mut |_| {})?,
        "读取 omp 版本失败",
    )?;
    Ok(OmpVersion {
        version: parse_version_output(&output),
        path: Some(bin.to_string_lossy().into_owned()),
    })
}

pub fn omp_update_check_impl(bin: Option<&Path>) -> Result<OmpUpdateCheck, AppError> {
    let bin = bin.ok_or_else(omp_not_found)?;
    let raw = require_success(
        run_omp(bin, &["update", "--check"], CHECK_TIMEOUT, &mut |_| {})?,
        "检查 omp 更新失败",
    )?;
    let parsed = parse_update_check(&raw);
    Ok(OmpUpdateCheck {
        current: parsed.current,
        latest: parsed.latest,
        up_to_date: parsed.up_to_date,
        raw,
    })
}

pub fn omp_update_run_impl(
    bin: &Path,
    timeout: Duration,
    on_line: &mut dyn FnMut(&str),
) -> Result<OmpUpdateResult, AppError> {
    let before = omp_version_impl(Some(bin))?.version;
    let output = require_success(
        run_omp(bin, &["update"], timeout, on_line)?,
        "更新 omp 失败",
    )?;
    let after = omp_version_impl(Some(bin))?.version;
    let changed = before != after && after.is_some();
    Ok(OmpUpdateResult {
        before,
        after,
        changed,
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake(body: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, bin)
    }

    #[test]
    fn resolution_priority_and_missing_override() {
        let home = Path::new("/test/home");
        let paths = [
            "/override",
            "/test/home/.local/bin/omp",
            "/opt/homebrew/bin/omp",
            "/usr/local/bin/omp",
            "/test/home/.bun/bin/omp",
        ];
        for start in 0..paths.len() {
            let resolved = resolve_omp_with(
                |_| Some(paths[0].into()),
                home,
                |p| {
                    paths[start..]
                        .iter()
                        .any(|candidate| p == Path::new(candidate))
                },
            );
            assert_eq!(resolved, Some(PathBuf::from(paths[start])));
        }
        assert_eq!(resolve_omp_with(|_| None, home, |_| false), None);
        assert_eq!(
            resolve_omp_with(
                |_| Some(String::new()),
                home,
                |p| p == home.join(".local/bin/omp")
            ),
            Some(home.join(".local/bin/omp"))
        );
    }

    #[test]
    fn ansi_and_version_parsing() {
        assert_eq!(
            strip_ansi("\x1b[32m✔\x1b[0m \x1b]8;;https://example.com\x1b\\omp\x1b]8;;\x07\r\n"),
            "✔ omp\r\n"
        );
        for text in ["omp/18.11.1\n", "\x1b[32momp/18.11.1\x1b[0m\r\n"] {
            assert_eq!(parse_version_output(text).as_deref(), Some("18.11.1"));
        }
        assert_eq!(
            parse_version_output("omp/18.12.0-canary.3\n").as_deref(),
            Some("18.12.0-canary.3")
        );
        for text in [
            "",
            "unknown",
            "omp/",
            "omp/18.11",
            "omp/nope",
            "omp/18.11.1 extra",
        ] {
            assert_eq!(parse_version_output(text), None);
        }
    }

    #[test]
    fn check_parser_observed_and_unknown_text() {
        for text in [
            "Current version: 18.11.1\n✔ Already up to date\n",
            "\x1b[36mCurrent version: 18.11.1\x1b[0m\r\n✔ ALREADY UP TO DATE\r\n",
        ] {
            assert_eq!(
                parse_update_check(text),
                UpdateCheck {
                    current: Some("18.11.1".into()),
                    latest: None,
                    up_to_date: true
                }
            );
        }
        let new = parse_update_check("Current version: 18.11.1\r\n\x1b[32mNew version available: 18.12.0-canary.3\x1b[0m\r\nAlready up to date");
        assert_eq!(new.current.as_deref(), Some("18.11.1"));
        assert_eq!(new.latest.as_deref(), Some("18.12.0-canary.3"));
        assert!(!new.up_to_date);
        for text in ["", "/opt/homebrew/bin/omp is installed and kept up to date by Homebrew; update it from Homebrew.", "Failed to check for updates: network", "Update failed: network"] {
            assert_eq!(parse_update_check(text), UpdateCheck { current: None, latest: None, up_to_date: false });
        }
        assert!(
            !parse_update_check("Already up to date\nNew version available: unknown").up_to_date
        );
    }

    #[test]
    fn busy_guard_releases_on_drop_and_unwind() {
        let busy = OmpBusy::default();
        let guard = busy.try_acquire().unwrap();
        let error = busy.try_acquire().err().unwrap();
        assert_eq!(error.code, ErrorCode::Busy);
        assert_eq!(error.message, "另一个 omp 操作正在进行");
        drop(guard);
        assert!(busy.try_acquire().is_ok());
        let _ = std::panic::catch_unwind(|| {
            let _guard = busy.try_acquire().unwrap();
            panic!("测试异常释放");
        });
        assert!(busy.try_acquire().is_ok());
    }

    #[test]
    fn version_missing_and_unrecognized_are_optional() {
        let _processes = subprocess_test_guard();
        let missing = omp_version_impl(None).unwrap();
        assert!(missing.version.is_none() && missing.path.is_none());
        assert_eq!(
            omp_update_check_impl(None).unwrap_err().code,
            ErrorCode::OmpNotFound
        );
        let (_dir, bin) = fake("printf 'unknown\\n'");
        let value = omp_version_impl(Some(&bin)).unwrap();
        assert!(value.version.is_none());
        assert_eq!(value.path.as_deref(), bin.to_str());
    }

    #[test]
    fn fake_check_up_to_date_new_and_managed() {
        let _processes = subprocess_test_guard();
        for (body, latest, up_to_date) in [
            ("printf 'Current version: 18.11.1\\n✔ Already up to date\\n'", None, true),
            ("printf '\\033[32mCurrent version: 18.11.1\\033[0m\\r\\nNew version available: 18.12.0\\r\\n'", Some("18.12.0"), false),
            ("printf '/opt/homebrew/bin/omp is installed and kept up to date by Homebrew; update it from Homebrew.\\n'", None, false),
        ] {
            let (_dir, bin) = fake(&format!("[ \"$1 $2\" = 'update --check' ] || exit 9\n{body}"));
            let result = omp_update_check_impl(Some(&bin)).unwrap();
            assert_eq!(result.latest.as_deref(), latest);
            assert_eq!(result.up_to_date, up_to_date);
            assert!(!result.raw.contains('\x1b'));
        }
    }

    #[test]
    fn nonzero_is_runner_output_but_command_error_with_stderr_tail() {
        let _processes = subprocess_test_guard();
        let (_dir, bin) =
            fake("printf '\\033[31mFailed to check for updates: network\\033[0m\\n' >&2\nexit 1");
        let result = run_omp(
            &bin,
            &["update", "--check"],
            Duration::from_secs(2),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.code, 1);
        assert_eq!(result.output, "Failed to check for updates: network\n");
        let error = omp_update_check_impl(Some(&bin)).unwrap_err();
        assert_eq!(error.code, ErrorCode::OmpFailed);
        assert!(error
            .message
            .contains("Failed to check for updates: network"));
        let tail = output_tail(&"字".repeat(700)).chars().count();
        assert_eq!(tail, 500);
    }

    #[test]
    fn captures_both_streams_without_cross_stream_order_and_null_stdin() {
        let _processes = subprocess_test_guard();
        let (_dir, bin) = fake("read ignored && exit 8\n[ \"$NO_COLOR\" = 1 ] || exit 9\nprintf 'one\\n'\nsleep 0.05\nprintf '\\033[31mtwo\\033[0m\\r\\n' >&2\nsleep 0.05\nprintf 'three'");
        let mut lines = Vec::new();
        let result = run_omp(&bin, &[], Duration::from_secs(2), &mut |line| {
            lines.push(line.to_owned())
        })
        .unwrap();
        assert_eq!(result.code, 0);
        // stdout/stderr 各由一个独立 reader 线程读入同一 channel：同流保序，
        // 跨流到达顺序由 OS 调度决定，故不断言 two 与 one/three 的相对位置。
        assert_eq!(lines.len(), 3, "{lines:?}");
        for line in &lines {
            assert!(!line.contains('\x1b'), "{lines:?}");
        }
        let mut sorted = lines.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, ["one", "three", "two"]);
        let pos = |want: &str| lines.iter().position(|line| line == want).unwrap();
        assert!(pos("one") < pos("three"), "{lines:?}");
        let mut expected = String::new();
        for line in &lines {
            expected.push_str(line);
            if line.as_str() != "three" {
                expected.push('\n');
            }
        }
        assert_eq!(result.output, expected);
    }

    #[test]
    fn timeout_kills_reaps_and_preserves_partial_output() {
        let _processes = subprocess_test_guard();
        let (dir, bin) = fake("echo $$ > \"$0.pid\"\nprintf 'starting\\n'\nsleep 30");
        let started = Instant::now();
        // 并发测试时给 shell 启动留余量，仍远短于脚本的 30 秒运行时间。
        let error = run_omp(&bin, &[], Duration::from_secs(3), &mut |_| {}).unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(error.message.contains("starting"), "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid: i32 = std::fs::read_to_string(dir.path().join("omp.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[test]
    fn update_changed_and_package_manager_unchanged() {
        let _processes = subprocess_test_guard();
        for changed in [true, false] {
            let action = if changed {
                "echo 18.12.0 > \"$0.state\"\nprintf 'Downloading ...\\nVerified sha256:abc\\nInstalling update...\\n✔ Updated to 18.12.0 at fake\\nRestart omp to use the new version\\n'"
            } else {
                "printf '%s is installed and kept up to date by Homebrew; update it from Homebrew.\\n' \"$0\""
            };
            let (_dir, bin) = fake(&format!("if [ \"$1\" = --version ]; then\n  version=18.11.1\n  [ ! -f \"$0.state\" ] || version=$(cat \"$0.state\")\n  printf 'omp/%s\\n' \"$version\"\nelse\n  [ \"$1\" = update ] && [ \"$#\" = 1 ] || exit 8\n  {action}\nfi"));
            let mut lines = Vec::new();
            let result = omp_update_run_impl(&bin, Duration::from_secs(2), &mut |line| {
                lines.push(line.to_owned())
            })
            .unwrap();
            assert_eq!(result.before.as_deref(), Some("18.11.1"));
            assert_eq!(
                result.after.as_deref(),
                Some(if changed { "18.12.0" } else { "18.11.1" })
            );
            assert_eq!(result.changed, changed);
            assert!(!lines.is_empty());
            assert!(!result.output.contains("omp/"));
        }
    }

    #[test]
    fn failing_update_and_unparseable_after_do_not_claim_success() {
        let _processes = subprocess_test_guard();
        let (_dir, bin) = fake("if [ \"$1\" = --version ]; then printf 'omp/18.11.1\\n'; else printf 'Update failed: network\\n' >&2; exit 1; fi");
        let error = omp_update_run_impl(&bin, Duration::from_secs(2), &mut |_| {}).unwrap_err();
        assert_eq!(error.code, ErrorCode::OmpFailed);
        assert!(error.message.contains("Update failed: network"));
        let (_dir, bin) = fake("if [ \"$1\" = --version ]; then if [ -f \"$0.state\" ]; then echo unknown; else echo omp/18.11.1; fi; else touch \"$0.state\"; fi");
        let result = omp_update_run_impl(&bin, Duration::from_secs(2), &mut |_| {}).unwrap();
        assert!(result.after.is_none());
        assert!(!result.changed);
    }

    #[test]
    fn timeout_collects_unterminated_line_and_callback_panic_reaps() {
        let _processes = subprocess_test_guard();
        let (_dir, bin) = fake("printf 'partial'; sleep 30");
        let started = Instant::now();
        let error = run_omp(&bin, &[], Duration::from_secs(3), &mut |_| {}).unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(error.message.ends_with("partial"), "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
        let (dir, bin) = fake("echo $$ > \"$0.pid\"; echo line; sleep 30");
        let started = Instant::now();
        let panic = std::panic::catch_unwind(|| {
            let _ = run_omp(&bin, &[], Duration::from_secs(2), &mut |_| {
                panic!("callback")
            });
        });
        assert!(panic.is_err());
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid: i32 = std::fs::read_to_string(dir.path().join("omp.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }

    #[test]
    fn relative_binary_name_does_not_search_path() {
        let _processes = subprocess_test_guard();
        let file = tempfile::NamedTempFile::new_in(".").unwrap();
        std::fs::write(file.path(), "#!/bin/sh\nprintf 'local fake\\n'\n").unwrap();
        let path = file.into_temp_path();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let name = Path::new(path.file_name().unwrap());
        let result = run_omp(name, &[], Duration::from_secs(3), &mut |_| {}).unwrap();
        assert_eq!(result.output, "local fake\n");
    }
    #[test]
    fn pipe_cap_overflow_returns_omp_failed() {
        let _processes = subprocess_test_guard();
        let (dir, bin) = fake(
            "echo $$ > \"$0.pid\"\ni=0; while [ $i -lt 2000 ]; do echo '0123456789abcdef0123456789abcdef'; i=$((i+1)); done",
        );
        let started = Instant::now();
        let error = run_omp_with(
            &bin,
            &[],
            Duration::from_secs(10),
            &mut |_| {},
            RunOpts {
                extra_env: None,
                pipe_cap: Some(1024),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::OmpFailed);
        assert_eq!(error.message, "omp 输出超过上限，已终止");
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid: i32 = std::fs::read_to_string(dir.path().join("omp.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }

    #[test]
    fn extra_env_is_visible_to_child() {
        let _processes = subprocess_test_guard();
        let (_dir, bin) = fake("echo \"$PI_CODING_AGENT_DIR\"");
        let agent = tempfile::tempdir().unwrap();
        let result = run_omp_with(
            &bin,
            &[],
            Duration::from_secs(5),
            &mut |_| {},
            RunOpts {
                extra_env: Some(("PI_CODING_AGENT_DIR", agent.path())),
                pipe_cap: None,
            },
        )
        .unwrap();
        assert_eq!(result.code, 0);
        assert_eq!(result.output, format!("{}\n", agent.path().display()));
    }
}
