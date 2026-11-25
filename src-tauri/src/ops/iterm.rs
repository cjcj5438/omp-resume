//! iTerm 新 tab 打开原语。
//!
//! - 纯函数：`shell_quote` / `applescript_escape` / `resume_command` /
//!   `new_session_command` / `build_script` / `session_contents_script` /
//!   `is_omp_resume_args` / `resume_pids_from_ps` / `sanitize_tail`，均可单测。
//! - 副作用：`open_tab` 经 `osascript` 驱动 iTerm（`std::process::Command`
//!   直接传 argv，脚本走 `-e` 参数，**绝不经过 shell 字符串拼接**）。
//! - 启动确认原语：`matching_pids`（`ps` 快照）/ `wait_until_started`
//!   （轮询直到为真或超时）/ `diagnostic_tail_for_session`（**只**读本次新建
//!   标签页的可见尾部）。这些只是「有进程/有租约」的弱证据，见各函数文档。
//!
//! AppleScript 行为（`build_script` 生成，动词均已对
//! `/Applications/iTerm.app/Contents/Resources/iTerm2.sdef` 核对）：
//! - `activate` 把 iTerm 带到前台；
//! - 无窗口时先等 0.5s（刚启动可能正在建窗）再建一个
//!   `create window with default profile`；
//! - 在当前窗口 `create tab with default profile`，对新 tab 的
//!   `current session` 做 `write text "<command>"`（默认追加换行，
//!   命令执行后 shell 保留，不 `exit`）。

use std::process::{Command, Stdio};

use crate::model::{AppError, ErrorCode};

/// `osascript` 绝对路径（GUI 应用 PATH 极简）。
pub const OSASCRIPT: &str = "/usr/bin/osascript";

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// AppleScript 双引号字符串字面量转义。
///
/// - `\` → `\\`、`"` → `\"`；
/// - 其余控制字符（`char::is_control`，含换行/回车/制表符/DEL/C1 区）会被
///   **直接移除**：AppleScript 字符串字面量不能跨行，换行还会让 iTerm
///   `write text` 提前执行半截命令。调用方（`resume_command` 经 `shell_quote`
///   的输出）本就不应含控制字符，这里是 fail-safe 而非 fail-closed；
///   多行命令请调用方自行拒绝。
pub fn applescript_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// 组装续聊命令：`cd '<cwd>' && omp --resume '<abs path>'`。
pub fn resume_command(cwd: &str, session_path: &str) -> String {
    format!(
        "cd {} && omp --resume {}",
        shell_quote(cwd),
        shell_quote(session_path)
    )
}

/// 新开会话命令：`cd '<cwd>' && omp [--model '<model>']`。
/// `model` 为 Some(非空) 时追加 `--model`（经 shell 单引号转义）；
/// None/空 = 裸 `omp`。**除此之外不带 prompt、不自动发送任何内容**。
pub fn new_session_command(cwd: &str, model: Option<&str>) -> String {
    let base = format!("cd {} && omp", shell_quote(cwd));
    match model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => format!("{base} --model {}", shell_quote(m)),
        None => base,
    }
}

/// 生成驱动 iTerm 的完整 AppleScript（纯函数）：开 tab → 读回新 session 的
/// `id` / `tty` → `write text`，最后 `return id & TAB & tty`。
///
/// 只有**一套**建标签页的约定：不需要身份的调用方（[`open_tab`]）丢弃
/// stdout 即可，需要归属证据的调用方（[`open_tab_tracked`]）用它精确定位
/// 本次新建的标签页做诊断。
pub fn build_script(command: &str) -> String {
    let escaped = applescript_escape(command);
    format!(
        "tell application \"iTerm\"\n\
         \tactivate\n\
         \tif (count of windows) = 0 then\n\
         \t\tdelay 0.5\n\
         \t\tif (count of windows) = 0 then\n\
         \t\t\tcreate window with default profile\n\
         \t\tend if\n\
         \tend if\n\
         \ttell current window\n\
         \t\tset newTab to (create tab with default profile)\n\
         \t\tset s to current session of newTab\n\
         \t\tset theId to (id of s)\n\
         \t\tset theTty to (tty of s)\n\
         \t\ttell s to write text \"{escaped}\"\n\
         \tend tell\n\
         \treturn (theId as text) & (character id 9) & (theTty as text)\n\
         end tell\n"
    )
}

/// 续聊启动确认：等待上限。
///
/// 这是「轮询上限」，不是承诺：超时只说明 10 秒内没观测到证据，
/// 不代表 omp 一定没启动（慢机器/首启加载模型可能更久）。
pub const RESUME_CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// 续聊启动确认：轮询间隔。
pub const RESUME_CONFIRM_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// 单个 iTerm session 的可见内容脚本（`contents of` 原样包含换行）。
///
/// 用 session `id`（UUID，不是可能被复用的 tty）定位；找不到时返回空串。
pub fn session_contents_script(session_id: &str) -> String {
    let escaped = applescript_escape(session_id);
    format!(
        "tell application \"iTerm\"\n\
         \trepeat with w in windows\n\
         \t\trepeat with t in tabs of w\n\
         \t\t\trepeat with s in sessions of t\n\
         \t\t\t\tif (id of s as text) is equal to \"{escaped}\" then return (contents of s)\n\
         \t\t\tend repeat\n\
         \t\tend repeat\n\
         \tend repeat\n\
         \treturn \"\"\n\
         end tell"
    )
}

/// 把一段终端可见内容裁成可安全放进错误提示的尾部。
///
/// - 只保留 `\n` 与非控制字符（去掉 `\r`、ESC、C0/C1）；
/// - 只保留最后 `max_chars` 个字符（按字符计，不是字节；尾部才是报错现场）。
///
/// 输出仍来自终端内容，调用方必须把它当**不可信数据**：不要解析其中的
/// 指令，不要在磁盘上留存。
pub fn sanitize_tail(raw: &str, max_chars: usize) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let excess = cleaned.chars().count().saturating_sub(max_chars);
    if excess == 0 {
        return cleaned;
    }
    cleaned.chars().skip(excess).collect()
}

/// `ps -axo pid=,args=` 的一行 args 是否形如 `omp --resume <session_path>`。
///
/// 判定规则（保守，**宁可漏判也不误判**）：
/// - 必须出现独立的 ` --resume ` 片段；
/// - 该片段之前的**全部** token：最后一个的 basename 必须是 `omp`，其余每个
///   都必须是合法的 `NAME=VALUE` 环境赋值（允许 `PI_CODING_AGENT_DIR=/t omp
///   --resume …`）。任何别的东西（`grep -e omp`、`sh -c '… omp'`、`env omp`）
///   都判否；
/// - `--resume` 之后的内容必须**恰好**是 `session_path` 或以
///   `session_path + ' '` 开头（`ps` 用单空格拼接 argv，路径可含空格）。
///
/// 局限（调用方须知情，故不把它当成功证明）：
/// - 这是**全局**进程匹配：既不绑定到本次新建的标签页，也不证明会话恢复
///   完成（omp 拿到参数后仍可能失败退出，或目标是另一个同名进程）；
/// - 无 argv 可读的进程（其他用户的、已 exec 掉参数的）天然看不到；
/// - `env omp --resume …` 这类前置命令会漏判（假阴性），调用方须把它当作
///   「未确认」而不是「未启动」。
pub fn is_omp_resume_args(args: &str, session_path: &str) -> bool {
    if session_path.is_empty() {
        return false;
    }
    let Some(at) = args.find(" --resume ") else {
        return false;
    };
    let mut tokens = args[..at].split_whitespace();
    let Some(mut last) = tokens.next() else {
        return false;
    };
    for token in tokens {
        if !is_env_assignment(last) {
            return false;
        }
        last = token;
    }
    if last.rsplit('/').next() != Some("omp") {
        return false;
    }
    let rest = &args[at + " --resume ".len()..];
    if rest == session_path {
        return true;
    }
    match rest.strip_prefix(session_path) {
        Some(tail) => tail.starts_with(' '),
        None => false,
    }
}

/// `NAME=VALUE` 形式的环境变量前置赋值（key 只能是标识符字符）。
fn is_env_assignment(token: &str) -> bool {
    let Some((key, _)) = token.split_once('=') else {
        return false;
    };
    !key.is_empty()
        && !key.starts_with(|c: char| c.is_ascii_digit())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 逐行产出 `ps -axo pid=,args=` 中形如 `omp --resume <session_path>` 的 pid。
///
/// 惰性：坏行跳过，不建中间列表。证据强度（含误判/漏判）见
/// [`is_omp_resume_args`] 的局限——调用方不得把它当成功证明。
pub fn resume_pids_from_ps<'a>(
    output: &'a str,
    session_path: &'a str,
) -> impl Iterator<Item = u32> + 'a {
    output.lines().filter_map(move |line| {
        let line = line.trim_start();
        let split = line.find(char::is_whitespace)?;
        let (pid, rest) = line.split_at(split);
        let pid: u32 = pid.parse().ok()?;
        let args = rest.trim_start();
        if !is_omp_resume_args(args, session_path) {
            return None;
        }
        Some(pid)
    })
}

/// 当前形如 `omp --resume <session_path>` 的 pid 集合。
///
/// `ps` 无法 spawn 或退出码非 0 → `Err(摘要)`（调用方据此**在产生任何
/// 副作用之前**拒绝执行）。这里的证据强度见 [`is_omp_resume_args`] 的局限。
pub fn matching_pids(session_path: &str) -> Result<std::collections::HashSet<u32>, String> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,args="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("无法执行 ps：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ps 退出码 {:?}：{}",
            output.status.code(),
            stderr.trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(resume_pids_from_ps(&text, session_path).collect())
}

/// 反复调用 `tick` 直到为真或超时；**先 sleep 再调用**。
///
/// 返回 `true` 仅当 tick 在 deadline **之前**返回真：sleep 与 tick 之后各查
/// 一次 deadline，任何一个时刻越界都立刻返回 `false`（慢 tick 返回的真值
/// 也不算成功）。`interval` 应非零，零值等于忙等。
pub fn wait_until_started(
    timeout: std::time::Duration,
    interval: std::time::Duration,
    mut tick: impl FnMut() -> bool,
) -> bool {
    let start = std::time::Instant::now();
    loop {
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            return false;
        }
        let step = interval.min(timeout - elapsed);
        if !step.is_zero() {
            std::thread::sleep(step);
        }
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            return false;
        }
        if tick() && start.elapsed() < timeout {
            return true;
        }
    }
}

/// 把一次失败的 osascript 调用映射为 [`AppError`]（纯函数，便于单测）。
///
/// `stderr` 为 osascript 的标准错误输出；`status_code` 为其退出码（取不到时为 None）。
fn map_osascript_failure(stderr: &str, status_code: Option<i32>) -> AppError {
    let stderr = stderr.trim();
    let mut message = match status_code {
        Some(code) => format!("iTerm 打开失败（osascript 退出码 {code}）：{stderr}"),
        None => format!("iTerm 打开失败：{stderr}"),
    };
    // macOS Automation 授权被拒（error -1743）：给明确中文指引。
    if stderr.contains("-1743") || stderr.contains("Not authorized to send Apple events") {
        message.push_str(
            "。系统已拒绝自动化控制：请到“系统设置 → 隐私与安全性 → 自动化”中，\
             允许本应用控制 iTerm，然后重试。",
        );
    }
    AppError::new(ErrorCode::ItermFailed, message)
}

/// 在 iTerm 当前窗口开新 tab 并执行 `command`（执行后 shell 保留）。
///
/// **只代表 AppleScript 调用成功**：不确认 shell 真的执行了命令，也不确认
/// omp 进程启动。续聊路径必须由调用方再做启动确认（见
/// [`open_tab_tracked`] + [`wait_until_started`]），新建会话路径不要求。
pub fn open_tab(command: &str) -> Result<(), AppError> {
    run_osascript(&build_script(command))
}

/// 解析 [`build_script`] 的 stdout：`<session id>\t<tty>`。
///
/// `id` 为空或缺失 → `None`（调用方不得拿空身份去猜标签页）。
pub fn parse_tracked_output(out: &str) -> Option<(String, String)> {
    let trimmed = out.trim_end_matches(['\n', '\r']);
    let (id, tty) = trimmed.split_once('\t').unwrap_or((trimmed, ""));
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    Some((id.to_owned(), tty.trim().to_owned()))
}

/// 进程控制终端是否就是本次新建标签页的 tty。
///
/// 两侧都可能带或不带 `/dev/` 前缀（AppleScript 的 `tty` 与 `lsof` 输出
/// 实测均为 `/dev/ttys00N`，但不假设），比较前统一去掉前缀；
/// 空值/纯 `?` 一律判否——没有 tty 就不构成归属证据。
pub fn tty_matches_start(tracked_tty: &str, observed: Option<&str>) -> bool {
    fn norm(tty: &str) -> &str {
        let tty = tty.trim();
        tty.strip_prefix("/dev/").unwrap_or(tty)
    }
    let tracked = norm(tracked_tty);
    match observed.map(norm) {
        Some(seen) => !tracked.is_empty() && !seen.is_empty() && seen != "?" && seen == tracked,
        None => false,
    }
}

/// 同 [`open_tab`]，但把新建 session 的身份读回来：`Ok((session_id, tty))`。
///
/// 脚本在 `write text` **之前**就取 `id`/`tty` 并 `return`，所以身份来自
/// 本次新建的那个标签页。返回值只用于「之后诊断只读这一个标签页」，
/// **不是**启动成功证明。
pub fn open_tab_tracked(command: &str) -> Result<(String, String), AppError> {
    let out = run_osascript_capture(&build_script(command))?;
    parse_tracked_output(&out).ok_or_else(|| {
        AppError::new(
            ErrorCode::ItermFailed,
            format!("iTerm 打开失败：未能读回新标签页身份（输出：{out:?}）"),
        )
    })
}

fn run_osascript(script: &str) -> Result<(), AppError> {
    run_osascript_capture(script).map(|_| ())
}

/// 执行 osascript 脚本并返回 stdout（不为空时保留原样）。
///
/// 失败映射与 [`run_osascript`] 完全一致（同一 [`map_osascript_failure`]）。
fn run_osascript_capture(script: &str) -> Result<String, AppError> {
    let child = Command::new(OSASCRIPT)
        .arg("-e")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppError::new(
                ErrorCode::ItermFailed,
                format!("iTerm 打开失败：无法启动 osascript：{e}"),
            )
        })?;
    let output = child.wait_with_output().map_err(|e| {
        AppError::new(
            ErrorCode::ItermFailed,
            format!("iTerm 打开失败：等待 osascript 时出错：{e}"),
        )
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(map_osascript_failure(
            &String::from_utf8_lossy(&output.stderr),
            output.status.code(),
        ))
    }
}

/// 读取**指定 iTerm session** 的可见尾部，用于失败诊断。
///
/// 关键约束（与「遍历所有标签页再合并」的做法相反）：
/// - 只按 session `id` 精确读取本次新建的那一个标签页，**不合并**其他
///   标签页内容，避免把别的对话/密钥塞进错误提示；
/// - 拿不到内容（osascript 失败、标签页已消失）→ 返回空串，调用方不得
///   把「没读到」当成别的信号；
/// - 返回内容已由 [`sanitize_tail`] 处理，仍是**不可信数据**。
///
/// `session_id` 为空（未拿到身份）时直接返回空串：不做任何猜测式采集。
///
/// `tell application "iTerm"` 会把没在跑的 iTerm 拉起来（与
/// [`crate::menubar::iterm`] 的硬约束一致），所以本函数在发任何 AppleScript
/// 之前先过 [`crate::menubar::iterm::iterm_running`] 门禁：iTerm 未运行 →
/// 空串，**不**发事件、**不**启动 iTerm。
pub fn diagnostic_tail_for_session(session_id: &str) -> String {
    diagnostic_tail_for_session_with(
        session_id,
        || crate::menubar::iterm::iterm_running(&crate::menubar::iterm::SystemRunner),
        |id| run_osascript_capture(&session_contents_script(id)),
    )
}

/// [`diagnostic_tail_for_session`] 的门禁测试缝：`is_running` 与 `capture`
/// 由调用方注入（生产传真实 `iterm_running` 与 osascript 采集）。
///
/// 顺序固定，且**全部**在发 AppleScript 之前判定：
/// 1. 空 `session_id` → 空串，两个闭包都不调用；
/// 2. iTerm 未运行 → 空串，`capture` **绝不**调用（避免拉起 iTerm）；
/// 3. 运行中才采集，输出经 [`sanitize_tail`] 裁剪；采集失败 → 空串。
fn diagnostic_tail_for_session_with(
    session_id: &str,
    is_running: impl FnOnce() -> bool,
    capture: impl FnOnce(&str) -> Result<String, AppError>,
) -> String {
    if session_id.is_empty() {
        return String::new();
    }
    if !is_running() {
        return String::new();
    }
    match capture(session_id) {
        Ok(out) => sanitize_tail(&out, 600),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_basics() {
        assert_eq!(shell_quote("/tmp"), "'/tmp'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\"'\"'s'");
        assert_eq!(shell_quote("a'b'c"), "'a'\"'\"'b'\"'\"'c'");
        // shell 元字符保持字面（由单引号保护）。
        assert_eq!(shell_quote("a$HOME`id`;rm"), "'a$HOME`id`;rm'");
        // unicode 原样保留。
        assert_eq!(
            shell_quote("/Users/x/未命名文件夹"),
            "'/Users/x/未命名文件夹'"
        );
    }

    #[test]
    fn applescript_escape_basics() {
        assert_eq!(applescript_escape("abc"), "abc");
        assert_eq!(applescript_escape("a\\b"), "a\\\\b");
        assert_eq!(applescript_escape("say \"hi\""), "say \\\"hi\\\"");
        // 控制字符移除策略（文档化决策）：换行/回车/制表/DEL/C1。
        assert_eq!(applescript_escape("a\nb\rc\td"), "abcd");
        assert_eq!(applescript_escape("a\x7fb"), "ab");
        assert_eq!(applescript_escape("a\u{0085}b"), "ab");
        assert_eq!(applescript_escape(""), "");
        // 非控制 unicode 保留。
        assert_eq!(applescript_escape("未命名\"文件\\"), "未命名\\\"文件\\\\");
    }

    #[test]
    fn resume_command_quoting() {
        assert_eq!(
            resume_command("/tmp", "/s/a.jsonl"),
            "cd '/tmp' && omp --resume '/s/a.jsonl'"
        );
        assert_eq!(
            resume_command("/Users/x/未命名文件夹", "/s/a b's.jsonl"),
            "cd '/Users/x/未命名文件夹' && omp --resume '/s/a b'\"'\"'s.jsonl'"
        );
        // `$`、反引号、`;` 必须被单引号保护，不可被 shell 展开。
        let cmd = resume_command("/tmp/$HOME", "/s/a`id`;x.jsonl");
        assert!(cmd.starts_with("cd '/tmp/$HOME' && omp --resume '/s/a`id`;x.jsonl'"));
    }

    #[test]
    fn new_session_command_has_no_args() {
        assert_eq!(new_session_command("/tmp", None), "cd '/tmp' && omp");
        assert_eq!(
            new_session_command("/Users/x/My Project", None),
            "cd '/Users/x/My Project' && omp"
        );
        assert_eq!(
            new_session_command("/Users/x/it's 中文", Some("  ")),
            "cd '/Users/x/it'\"'\"'s 中文' && omp"
        );
        // 无模型时末尾只能是裸 `omp`：不带 --resume、prompt 或其他参数。
        assert!(new_session_command("/tmp/a b", None).ends_with("&& omp"));
    }

    #[test]
    fn new_session_command_with_model() {
        assert_eq!(
            new_session_command("/tmp", Some("5438/deepseek-v4.1-flash")),
            "cd '/tmp' && omp --model '5438/deepseek-v4.1-flash'"
        );
        // 模型名单引号同样 shell 转义。
        assert_eq!(
            new_session_command("/tmp", Some("it's")),
            "cd '/tmp' && omp --model 'it'\"'\"'s'"
        );
    }

    #[test]
    fn osascript_failure_mapping() {
        let err = map_osascript_failure("boom", Some(1));
        assert_eq!(err.code, ErrorCode::ItermFailed);
        assert!(err.message.contains("1"));
        assert!(err.message.contains("boom"));
        // Automation 被拒 → 中文指引。
        let denied = map_osascript_failure(
            "execution error: Not authorized to send Apple events to iTerm. (-1743)",
            Some(1),
        );
        assert_eq!(denied.code, ErrorCode::ItermFailed);
        assert!(denied.message.contains("自动化"), "{denied:?}");
        assert!(denied.message.contains("-1743") || denied.message.contains("Not authorized"));
        let no_code = map_osascript_failure("x", None);
        assert_eq!(no_code.code, ErrorCode::ItermFailed);
    }

    #[test]
    fn is_omp_resume_args_matches() {
        let p = "/s/a.jsonl";
        assert!(is_omp_resume_args(
            "/Users/x/.local/bin/omp --resume /s/a.jsonl",
            p
        ));
        assert!(is_omp_resume_args("omp --resume /s/a.jsonl", p));
        // 前缀环境变量赋值不影响 basename 判定。
        assert!(is_omp_resume_args(
            "PI_CODING_AGENT_DIR=/t omp --resume /s/a.jsonl",
            p
        ));
        // 路径含空格。
        assert!(is_omp_resume_args(
            "omp --resume /s/a b.jsonl",
            "/s/a b.jsonl"
        ));
        // 后续还有 argv（ps 以单空格拼接）。
        assert!(is_omp_resume_args("omp --resume /s/a.jsonl --verbose", p));
    }

    #[test]
    fn is_omp_resume_args_rejects() {
        let p = "/s/a.jsonl";
        // 只差后缀的文件名不能被当成同一会话。
        assert!(!is_omp_resume_args("omp --resume /s/a.jsonl.bak", p));
        // 前缀相同但不是空格分隔的后缀。
        assert!(!is_omp_resume_args("omp --resume /s/a.jsonl2", p));
        // 没有 --resume。
        assert!(!is_omp_resume_args("omp", p));
        assert!(!is_omp_resume_args("omp --continue /s/a.jsonl", p));
        // --resume 前面的 token 不是 omp。
        assert!(!is_omp_resume_args("grep --resume /s/a.jsonl", p));
        assert!(!is_omp_resume_args(
            "/usr/bin/grep -e omp --resume /s/a.jsonl",
            p
        ));
        // 空 session_path 永不匹配。
        assert!(!is_omp_resume_args("omp --resume /s/a.jsonl", ""));
        // `--resume` 出现在行首/无前置 token。
        assert!(!is_omp_resume_args("--resume /s/a.jsonl", p));
    }

    #[test]
    fn resume_pids_from_ps_filters_and_skips_junk() {
        let out = "  731 omp\n\
                   \n\
                   1428 omp --resume /s/a.jsonl\n\
                   1429 omp --resume /s/a.jsonl.bak\n\
                   notapid omp --resume /s/a.jsonl\n\
                   12 \n\
                   1704 /Users/x/.local/bin/omp __omp_worker_daemon_broker\n";
        let got: Vec<u32> = resume_pids_from_ps(out, "/s/a.jsonl").collect();
        assert_eq!(got, vec![1428]);
        // 空输出 / 无匹配 → 空集合。
        assert_eq!(resume_pids_from_ps("", "/s/a.jsonl").count(), 0);
        assert_eq!(resume_pids_from_ps("731 omp", "/s/a.jsonl").count(), 0);
    }

    #[test]
    fn wait_until_started_succeeds_on_third_tick() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        let ok = wait_until_started(
            std::time::Duration::from_secs(5),
            std::time::Duration::ZERO,
            || {
                calls.set(calls.get() + 1);
                calls.get() == 3
            },
        );
        assert!(ok);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn wait_until_started_times_out_before_deadline_tick() {
        let timeout = std::time::Duration::from_millis(30);
        let mut calls = 0;
        // 首次等待已用完预算；不应在 deadline 后再轮询。
        let ok = wait_until_started(timeout, timeout * 2, || {
            calls += 1;
            false
        });
        assert!(!ok);
        assert_eq!(calls, 0, "deadline 之后不得再调用 tick");
    }

    #[test]
    fn wait_until_started_true_after_deadline_is_not_success() {
        // tick 睡眠越过 deadline 后才返回真：必须按超时处理。
        let ok = wait_until_started(
            std::time::Duration::from_millis(30),
            std::time::Duration::from_millis(200),
            || {
                std::thread::sleep(std::time::Duration::from_millis(1));
                true
            },
        );
        assert!(!ok);
    }

    #[test]
    fn wait_until_started_zero_timeout_never_ticks() {
        let mut calls = 0;
        let ok = wait_until_started(
            std::time::Duration::ZERO,
            std::time::Duration::from_millis(10),
            || {
                calls += 1;
                true
            },
        );
        assert!(!ok);
        assert_eq!(calls, 0);
    }

    #[test]
    fn sanitize_tail_strips_control_and_keeps_tail() {
        // ESC 序列残留、回车、C1 控制字符被去掉，换行保留。
        let raw = "old\n\u{1b}[31mred\u{1b}[0m\r\nline3\u{0085}x";
        assert_eq!(sanitize_tail(raw, 600), "old\n[31mred[0m\nline3x");
        // 字符级截断：保留尾部（尾部才是报错现场）。
        assert_eq!(sanitize_tail("abcdefghij", 4), "ghij");
        assert_eq!(sanitize_tail("abc", 10), "abc");
        assert_eq!(sanitize_tail("", 10), "");
        assert_eq!(sanitize_tail("\n\n\n", 2), "\n\n");
    }

    #[test]
    fn diagnostic_tail_gate_does_not_touch_iterm_when_not_running() {
        use std::cell::Cell;
        // iTerm 未运行：capture 必须 0 次（绝不发 AppleScript 把 iTerm 拉起来）。
        let captured = Cell::new(0);
        let tail = diagnostic_tail_for_session_with(
            "A1B2",
            || false,
            |_| {
                captured.set(captured.get() + 1);
                Ok("should-not-be-read".to_owned())
            },
        );
        assert_eq!(tail, "");
        assert_eq!(captured.get(), 0, "未运行 iTerm 时不得发起任何查询");
    }

    #[test]
    fn diagnostic_tail_gate_empty_id_skips_both_closures() {
        use std::cell::Cell;
        let probed = Cell::new(0);
        let captured = Cell::new(0);
        let tail = diagnostic_tail_for_session_with(
            "",
            || {
                probed.set(probed.get() + 1);
                true
            },
            |_| {
                captured.set(captured.get() + 1);
                Ok("x".to_owned())
            },
        );
        assert_eq!(tail, "");
        assert_eq!(probed.get(), 0, "空 session id 时连运行状态都不必查");
        assert_eq!(captured.get(), 0);
    }

    #[test]
    fn diagnostic_tail_reads_that_session_only_when_running() {
        use std::cell::RefCell;
        // 运行中：只按传入的 session id 采集，并保留尾部裁剪。
        let asked: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let tail = diagnostic_tail_for_session_with(
            "TAB-9",
            || true,
            |id| {
                asked.borrow_mut().push(id.to_owned());
                Ok("line1\n\u{1b}[31mboom".to_owned())
            },
        );
        assert_eq!(asked.borrow().as_slice(), ["TAB-9".to_owned()]);
        assert_eq!(tail, "line1\n[31mboom");
        // 采集失败 → 空串（不把「没读到」当成别的信号）。
        assert_eq!(
            diagnostic_tail_for_session_with(
                "TAB-9",
                || true,
                |_| Err(AppError::new(ErrorCode::ItermFailed, "osascript 失败"))
            ),
            ""
        );
    }

    #[test]
    fn tty_matches_start_normalizes_prefix_and_rejects_missing() {
        // AppleScript 与 lsof 都常带 /dev/，但也兼容不带。
        assert!(tty_matches_start("/dev/ttys003", Some("/dev/ttys003")));
        assert!(tty_matches_start("ttys003", Some("/dev/ttys003")));
        assert!(tty_matches_start("/dev/ttys003", Some("ttys003")));
        // 别的标签页/终端不构成归属证据。
        assert!(!tty_matches_start("/dev/ttys003", Some("/dev/ttys007")));
        // 任一侧缺失/未知 → 判否，不猜。
        assert!(!tty_matches_start("/dev/ttys003", None));
        assert!(!tty_matches_start("", Some("/dev/ttys003")));
        assert!(!tty_matches_start("/dev/ttys003", Some("")));
        assert!(!tty_matches_start("/dev/ttys003", Some("?")));
    }

    #[test]
    fn parse_tracked_output_requires_id() {
        assert_eq!(
            parse_tracked_output("A1B2\t/dev/ttys003\n"),
            Some(("A1B2".to_owned(), "/dev/ttys003".to_owned()))
        );
        // 没有 tty 也接受（tty 只是附加信息）。
        assert_eq!(
            parse_tracked_output("A1B2\n"),
            Some(("A1B2".to_owned(), String::new()))
        );
        assert_eq!(parse_tracked_output(""), None);
        assert_eq!(parse_tracked_output("\n"), None);
        assert_eq!(parse_tracked_output("\t/dev/ttys003"), None);
    }

    /// 真机冒烟：开一个 tab 跑 `echo`，读回内容验证，再按 tty 只关该 tab。
    ///
    /// 会碰用户真实 iTerm 几秒钟；需手动 `cargo test -- --ignored` 运行。
    /// 若 macOS 弹出 Automation 授权框而无人点击，停止并如实上报。
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn smoke_open_tab_echo_and_close() {
        use std::collections::HashSet;
        use std::process::{Command, Stdio};

        fn osascript(script: &str) -> Result<String, String> {
            let out = Command::new(super::OSASCRIPT)
                .arg("-e")
                .arg(script)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("spawn osascript: {e}"))?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(format!(
                    "osascript failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ))
            }
        }

        fn all_ttys() -> HashSet<String> {
            let script = "tell application \"iTerm\"\n\
                 \tset out to {}\n\
                 \trepeat with w in windows\n\
                 \t\trepeat with t in tabs of w\n\
                 \t\t\trepeat with s in sessions of t\n\
                 \t\t\t\tset end of out to (tty of s)\n\
                 \t\t\tend repeat\n\
                 \t\tend repeat\n\
                 \tend repeat\n\
                 \treturn out\n\
                 end tell";
            let out = osascript(script).expect("列出现有 tty");
            out.split(|c: char| !c.is_ascii_alphanumeric() && c != '/' && c != '.')
                .filter(|s| s.starts_with("/dev/"))
                .map(str::to_owned)
                .collect()
        }

        let before = all_ttys();
        let token = format!(
            "OMP_RESUME_SMOKE_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        open_tab(&format!("cd '/tmp' && echo {token}")).expect("open_tab");

        // 轮询新 tab 的内容，最多约 12s。
        let mut new_tty: Option<String> = None;
        for _ in 0..24 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let after = all_ttys();
            let fresh: Vec<String> = after.difference(&before).cloned().collect();
            for tty in &fresh {
                let script = format!(
                    "tell application \"iTerm\"\n\
                     \trepeat with w in windows\n\
                     \t\trepeat with t in tabs of w\n\
                     \t\t\trepeat with s in sessions of t\n\
                     \t\t\t\tif tty of s is equal to \"{tty}\" then return contents of s\n\
                     \t\t\tend repeat\n\
                     \t\tend repeat\n\
                     \tend repeat\n\
                     \treturn \"\"\n\
                     end tell"
                );
                if let Ok(contents) = osascript(&script) {
                    if contents.contains(&token) {
                        new_tty = Some(tty.clone());
                        break;
                    }
                }
            }
            if new_tty.is_some() {
                break;
            }
        }
        let new_tty = new_tty.expect("新 tab 内未观测到 echo 输出");

        // 只关我们创建的那个 session（按 tty 精确定位）。
        let close_script = format!(
            "tell application \"iTerm\"\n\
             \trepeat with w in windows\n\
             \t\trepeat with t in tabs of w\n\
             \t\t\trepeat with s in sessions of t\n\
             \t\t\t\tif tty of s is equal to \"{new_tty}\" then close s\n\
             \t\t\tend repeat\n\
             \t\tend repeat\n\
             \tend repeat\n\
             end tell"
        );
        osascript(&close_script).expect("关闭冒烟 tab");
    }

    /// 真机恢复冒烟（手动 `cargo test --lib -- --ignored smoke_resume_real`）：
    /// 用**临时**会话文件（有效 v3 header、唯一 UUID、cwd=/tmp）经生产
    /// `open_in_iterm_impl` + 真实 `open_tab_tracked` 恢复，确认它返回 `Ok`
    /// （即观测到绑定本次标签页 tty 的 omp 进程），打印实际 omp 进程与 tty，
    /// 然后只结束该会话路径的进程、只按本次标签页 session id 关闭它。
    ///
    /// 不碰 `/Applications`、不使用任何运行中会话、不向标签页发额外按键。
    /// 若 macOS 弹自动化授权框而无人点击，测试会失败——如实上报，不绕过。
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn smoke_resume_real() {
        use std::cell::RefCell;
        use std::process::{Command, Stdio};

        fn osascript(script: &str) -> Result<String, String> {
            let out = Command::new(super::OSASCRIPT)
                .arg("-e")
                .arg(script)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("spawn osascript: {e}"))?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(format!(
                    "osascript failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ))
            }
        }

        let root = std::env::temp_dir().join(format!(
            "omp-resume-rs-smoke-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let sessions = root.join("sessions");
        let proj = sessions.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let uuid = "01aff000-0000-7000-8000-0000000000a1";
        let path = proj.join(format!("2026-01-01T00-00-00-000Z_{uuid}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "session",
                    "version": 3,
                    "id": uuid,
                    "timestamp": "2026-01-01T00:00:00.000Z",
                    "cwd": "/tmp"
                }),
                serde_json::json!({
                    "type": "message",
                    "id": "u1",
                    "parentId": null,
                    "timestamp": "2026-01-01T00:00:01.000Z",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "smoke"}],
                        "attribution": "user",
                        "timestamp": 1_767_225_601_000i64
                    }
                })
            ),
        )
        .unwrap();
        let cfg = crate::config::Config {
            sessions_dir: sessions.clone(),
            owners_dir: root.join("owners"),
            extra_roots: vec![],
        };
        // omp 在 argv 里打印 canonical 路径（/private/var/…），匹配也必须用它。
        let session_path = std::fs::canonicalize(&path)
            .expect("canonicalize fixture")
            .display()
            .to_string();

        // 记录本次标签页身份：opener 仍是生产实现，只是旁路读回 id/tty。
        let tracked: RefCell<Option<(String, String)>> = RefCell::new(None);
        let opener = |cmd: &str| {
            let r = super::open_tab_tracked(cmd);
            if let Ok(pair) = &r {
                tracked.replace(Some(pair.clone()));
            }
            r
        };
        let started = std::time::Instant::now();
        let result = crate::ops::commands::open_in_iterm_impl(&cfg, &session_path, &opener);
        let elapsed = started.elapsed();
        println!("open_in_iterm_impl -> {result:?} after {elapsed:?}");

        fn raw_ps(path: &str) -> Vec<String> {
            let out = Command::new("/bin/ps")
                .args(["-axo", "pid=,tty=,args="])
                .output()
                .expect("ps");
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| l.contains(path))
                .map(|l| l.trim().to_owned())
                .collect()
        }

        // 实际观测：该会话路径的 omp 进程及其控制终端，必须与本次标签页一致。
        let observed: Vec<(u32, Option<String>)> = super::matching_pids(&session_path)
            .unwrap_or_default()
            .into_iter()
            .map(|pid| {
                (
                    pid,
                    crate::menubar::iterm::tty_of_pid(pid, &crate::menubar::iterm::SystemRunner),
                )
            })
            .collect();
        let tab_id = tracked.borrow().clone();
        let tail_now = tab_id
            .as_ref()
            .map(|(id, _)| super::diagnostic_tail_for_session(id))
            .unwrap_or_default();
        println!("tracked tab: {tab_id:?}");
        println!("observed omp: {observed:?}");
        println!("ps lines: {:?}", raw_ps(&session_path));
        println!("--- tab tail (immediately after confirm) ---\n{tail_now}\n---");
        std::thread::sleep(std::time::Duration::from_secs(2));
        println!("ps lines (+2s): {:?}", raw_ps(&session_path));
        let tail_later = tab_id
            .as_ref()
            .map(|(id, _)| super::diagnostic_tail_for_session(id))
            .unwrap_or_default();
        println!("--- tab tail (+2s) ---\n{tail_later}\n---");

        // 清理：只杀本会话路径的进程；只关闭本次标签页（按 session id）。
        let pids: Vec<String> = observed.iter().map(|(p, _)| p.to_string()).collect();
        if !pids.is_empty() {
            let _ = Command::new("kill").arg("-TERM").args(&pids).status();
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
        let mut close_err = None;
        if let Some((id, _)) = tracked.borrow().clone() {
            let escaped = super::applescript_escape(&id);
            let script = format!(
                "tell application \"iTerm\"\n\
                 \trepeat with w in windows\n\
                 \t\trepeat with t in tabs of w\n\
                 \t\t\trepeat with s in sessions of t\n\
                 \t\t\t\tif (id of s as text) is equal to \"{escaped}\" then close s\n\
                 \t\t\tend repeat\n\
                 \t\tend repeat\n\
                 \tend repeat\n\
                 end tell"
            );
            close_err = osascript(&script).err();
        }
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            result.is_ok(),
            "恢复未被确认：{result:?}（跟踪标签页 {tracked:?}）"
        );
        let (_, tty) = tracked.into_inner().expect("应读回标签页身份");
        assert!(
            observed
                .iter()
                .any(|(_, t)| super::tty_matches_start(&tty, t.as_deref())),
            "未观测到绑定本次 tty({tty}) 的 omp 进程：{observed:?}"
        );
        assert!(close_err.is_none(), "关闭本次标签页失败：{close_err:?}");
    }

    /// 真机**失败**冒烟（手动 `cargo test --lib -- --ignored smoke_resume_failure_real`）：
    /// 在真 iTerm 里走生产 `open_tab_tracked` + 生产 `diagnostic_tail_for_session`
    /// 的**超时**分支（既有 `smoke_resume_real` 只覆盖成功）。标签页先打印一个
    /// 唯一 sentinel 再 `sleep`，不启动 omp：轮询超时后
    /// `open_tracked_and_confirm` 必须返回 `ITERM_FAILED`，消息含确切命令与
    /// 该 sentinel——后者证明诊断尾部真的经 AppleScript 从**本次**标签页读到。
    ///
    /// 清理只按 `open_tab_tracked` 读回的 session UUID 关闭这**一个** tab，
    /// 不按全局 tty 差集，不碰用户其他标签页；`sleep` 自行退出。
    /// 若 macOS 弹自动化授权框而无人点击，测试会失败——如实上报，不绕过。
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn smoke_resume_failure_real() {
        use std::cell::RefCell;
        use std::time::Duration;

        fn osascript(script: &str) -> Result<String, String> {
            let out = std::process::Command::new(super::OSASCRIPT)
                .arg("-e")
                .arg(script)
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|e| format!("spawn osascript: {e}"))?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(format!(
                    "osascript failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ))
            }
        }

        let tag = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        let sentinel = format!("OMP_RESUME_FAIL_SMOKE_{tag}");
        // `printf` 把 sentinel 拆成格式串 + 参数：整串**不**出现在 write text
        // 的命令回显里，只出现在执行结果中，所以「消息含整串」只能来自 tab 输出。
        let command = format!(
            "cd {} && printf {} {} && sleep 3",
            super::shell_quote("/tmp"),
            super::shell_quote("OMP_RESUME_FAIL_SMOKE_%s\\n"),
            super::shell_quote(&tag),
        );
        assert!(
            !command.contains(&sentinel),
            "命令文本不得含完整 sentinel（否则回显即可骗过断言）：{command}"
        );
        // 记录本次标签页身份（清理与归属断言的唯一依据）。
        let tracked: RefCell<Option<(String, String)>> = RefCell::new(None);
        // shell 就绪时间不确定：先等该 tab 真的打出 sentinel，再进入 400ms
        // 确认窗口（窗口内仍无 omp 证据 → 必然超时，这正是要走的失败分支）。
        let opener = |cmd: &str| {
            let r = super::open_tab_tracked(cmd);
            if let Ok((id, _)) = &r {
                tracked.replace(Some((id.clone(), r.as_ref().unwrap().1.clone())));
                let mut seen = String::new();
                for _ in 0..40 {
                    std::thread::sleep(Duration::from_millis(100));
                    seen = super::diagnostic_tail_for_session(id);
                    if seen.contains(&sentinel) {
                        break;
                    }
                }
                println!("--- tab tail before confirm window ---\n{seen}\n---");
            }
            r
        };
        // 记录诊断查询过的 session id：必须恰好是本次标签页。
        let asked: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let diagnostic = |id: &str| {
            asked.borrow_mut().push(id.to_owned());
            super::diagnostic_tail_for_session(id)
        };

        let result = crate::ops::commands::open_tracked_and_confirm(
            &command,
            Duration::from_millis(400),
            &opener,
            &|_| false,
            &diagnostic,
        );
        let tab = tracked.borrow().clone();
        println!("tracked tab: {tab:?}\nresult: {result:?}");

        // 清理：只按本次 session id 关闭这一个 tab。
        let mut close_err = None;
        if let Some((id, _)) = &tab {
            let escaped = super::applescript_escape(id);
            let script = format!(
                "tell application \"iTerm\"\n\
                 \trepeat with w in windows\n\
                 \t\trepeat with t in tabs of w\n\
                 \t\t\trepeat with s in sessions of t\n\
                 \t\t\t\tif (id of s as text) is equal to \"{escaped}\" then close s\n\
                 \t\t\tend repeat\n\
                 \t\tend repeat\n\
                 \tend repeat\n\
                 end tell"
            );
            close_err = osascript(&script).err();
        }

        let err = result.expect_err("不启动 omp 的命令必须判失败，不能报成功");
        assert_eq!(err.code, ErrorCode::ItermFailed, "{err:?}");
        assert!(
            err.message.contains(&command),
            "失败消息必须含准确命令 {command:?}：{err:?}"
        );
        assert!(
            err.message.contains(&sentinel),
            "失败消息应含本次标签页的 sentinel {sentinel:?}（诊断须真读到该 tab）：{err:?}"
        );
        let (id, tty) = tab.expect("应读回本次标签页身份");
        assert!(!tty.is_empty(), "本次标签页应读回 tty");
        assert_eq!(
            asked.borrow().as_slice(),
            [id],
            "诊断只能查询本次 tracked session，不得遍历其他标签页"
        );
        assert!(close_err.is_none(), "关闭本次标签页失败：{close_err:?}");
    }

    /// 真机冒烟（手动 `cargo test --lib -- --ignored smoke_new_session_real`）：
    /// 经 `new_session_in_iterm_impl` 在临时目录开新 tab，确认该 tab 内确实
    /// 启动了 omp 进程，再结束 omp 并只关闭该 tab（不留残留标签页/进程）。
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn smoke_new_session_real() {
        use std::collections::HashSet;
        use std::process::{Command, Stdio};
        use std::time::Duration;

        fn osascript(script: &str) -> Result<String, String> {
            let out = Command::new("osascript")
                .arg("-e")
                .arg(script)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("spawn osascript: {e}"))?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(format!(
                    "osascript failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ))
            }
        }

        fn all_ttys() -> HashSet<String> {
            let script = "tell application \"iTerm\"\n\
                 \tset out to {}\n\
                 \trepeat with w in windows\n\
                 \t\trepeat with t in tabs of w\n\
                 \t\t\trepeat with s in sessions of t\n\
                 \t\t\t\tset end of out to (tty of s)\n\
                 \t\t\tend repeat\n\
                 \t\tend repeat\n\
                 \tend repeat\n\
                 \treturn out\n\
                 end tell";
            let out = osascript(script).expect("列出现有 tty");
            out.split(|c: char| !c.is_ascii_alphanumeric() && c != '/' && c != '.')
                .filter(|s| s.starts_with("/dev/"))
                .map(str::to_owned)
                .collect()
        }

        let before = all_ttys();
        let dir = std::env::temp_dir().join(format!("omp-resume-ns-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::ops::commands::new_session_in_iterm_impl(
            &dir.display().to_string(),
            None,
            &crate::ops::iterm::open_tab,
        )
        .expect("new_session_in_iterm_impl");

        // 轮询新 tab 的前台进程，最多约 20s：应出现 omp 进程。
        let mut found: Option<(String, Vec<String>)> = None;
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(500));
            for tty in all_ttys().difference(&before) {
                let short = tty.trim_start_matches("/dev/");
                let ps = Command::new("ps")
                    .args(["-t", short, "-o", "pid=,args="])
                    .output()
                    .expect("ps");
                let pids: Vec<String> = String::from_utf8_lossy(&ps.stdout)
                    .lines()
                    .filter(|l| l.contains("omp"))
                    .filter_map(|l| l.split_whitespace().next().map(str::to_owned))
                    .collect();
                if !pids.is_empty() {
                    found = Some((tty.clone(), pids));
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }

        // 清理（无论是否观测到 omp）：结束 omp，再关闭本次新增的所有 tab，不留残留。
        let fresh: Vec<String> = all_ttys().difference(&before).cloned().collect();
        if let Some((_, pids)) = &found {
            let _ = Command::new("kill").arg("-TERM").args(pids).status();
            std::thread::sleep(Duration::from_millis(1500));
        }
        for tty in &fresh {
            let close_script = format!(
                "tell application \"iTerm\"\n\
                 \trepeat with w in windows\n\
                 \t\trepeat with t in tabs of w\n\
                 \t\t\trepeat with s in sessions of t\n\
                 \t\t\t\tif tty of s is equal to \"{tty}\" then close s\n\
                 \t\t\tend repeat\n\
                 \t\tend repeat\n\
                 \tend repeat\n\
                 end tell"
            );
            osascript(&close_script).expect("关闭冒烟 tab");
        }
        let _ = std::fs::remove_dir_all(&dir);
        let (tty, pids) = found.expect("新 tab 内未观测到 omp 进程");
        assert!(!pids.is_empty(), "{tty}");
    }
}
