//! iTerm 新 tab 打开原语。
//!
//! - 纯函数：`shell_quote` / `applescript_escape` / `resume_command` /
//!   `new_session_command` / `build_script`，均可单测。
//! - 副作用：`open_tab` 经 `osascript` 驱动 iTerm（`std::process::Command`
//!   直接传 argv，脚本走 `-e` 参数，**绝不经过 shell 字符串拼接**）。
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

/// 新开会话命令：`cd '<cwd>' && omp`。**不带任何参数、不带 prompt**，
/// 只启动 omp 交互界面（与「在 iTerm 继续」的 `--resume` 区分）。
pub fn new_session_command(cwd: &str) -> String {
    format!("cd {} && omp", shell_quote(cwd))
}

/// 生成驱动 iTerm 的完整 AppleScript（纯函数，便于单测锁定脚本形状）。
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
         \t\ttell current session of newTab to write text \"{escaped}\"\n\
         \tend tell\n\
         end tell\n"
    )
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
pub fn open_tab(command: &str) -> Result<(), AppError> {
    run_osascript(&build_script(command))
}

fn run_osascript(script: &str) -> Result<(), AppError> {
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
        Ok(())
    } else {
        Err(map_osascript_failure(
            &String::from_utf8_lossy(&output.stderr),
            output.status.code(),
        ))
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
        assert_eq!(new_session_command("/tmp"), "cd '/tmp' && omp");
        assert_eq!(
            new_session_command("/Users/x/My Project"),
            "cd '/Users/x/My Project' && omp"
        );
        assert_eq!(
            new_session_command("/Users/x/it's 中文"),
            "cd '/Users/x/it'\"'\"'s 中文' && omp"
        );
        // 末尾只能是裸 `omp`：不带 --resume、prompt 或其他参数。
        assert!(new_session_command("/tmp/a b").ends_with("&& omp"));
    }

    #[test]
    fn new_session_command_survives_applescript() {
        // 引号与反斜杠先经 shell 单引号保护，再经 AppleScript 字符串转义。
        let cmd = new_session_command("/Users/x/say \"hi\"\\中文");
        let script = build_script(&cmd);
        assert!(
            script.contains("write text \"cd '/Users/x/say \\\"hi\\\"\\\\中文' && omp\""),
            "{script}"
        );
    }

    #[test]
    fn build_script_shape() {
        let cmd = resume_command("/tmp", "/s/a.jsonl");
        let script = build_script(&cmd);
        // 关键动词都在（与 iTerm2.sdef 核对过）。
        for verb in [
            "tell application \"iTerm\"",
            "activate",
            "create window with default profile",
            "create tab with default profile",
            "write text",
        ] {
            assert!(script.contains(verb), "missing {verb}:\n{script}");
        }
        // 命令原文进入 write text，且 shell 保留（无 exit/exec）。
        assert!(script.contains(&cmd));
        assert!(!script.contains("exit"));
        assert!(!script.contains("exec"));
        // 含引号的命令被正确转义进 AppleScript 字符串。
        let tricky = build_script("echo \"a\\b\"");
        assert!(tricky.contains("echo \\\"a\\\\b\\\""), "{tricky}");
        // 换行被剥离，脚本自身不跨行破裂。
        let multiline = build_script("echo a\necho b");
        assert!(
            multiline.contains("write text \"echo aecho b\""),
            "{multiline}"
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
