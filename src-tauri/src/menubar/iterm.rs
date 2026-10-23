//! iTerm 只读查询与聚焦（T3 + 菜单“聚焦”动作）。
//!
//! 硬性约束：
//! - 查询 iTerm 前必须先确认进程在跑（`pgrep -x iTerm2`）：
//!   `tell application "iTerm2"` 会把没在跑的 iTerm 拉起来，轮询绝不能这么做；
//! - 聚焦只允许 `activate` + 按 tty `select`：绝不 `write text`、绝不发按键；
//! - 所有外部命令经 [`Runner`] 注入，单测用假实现。

use std::collections::HashMap;

use super::classify::TitleState;

/// 可注入的命令执行器（生产用 [`SystemRunner`]，单测用闭包桩）。
pub trait Runner {
    /// 运行 `prog args…`，成功返回 stdout（已 trim 尾部换行由调用方处理），
    /// 失败返回人类可读的错误摘要。
    fn run(&self, prog: &str, args: &[&str]) -> Result<String, String>;
}

/// 生产实现：直接 spawn 子进程（stdin null，不经过 shell）。
pub struct SystemRunner;

impl Runner for SystemRunner {
    fn run(&self, prog: &str, args: &[&str]) -> Result<String, String> {
        let output = std::process::Command::new(prog)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("无法启动 {prog}：{e}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(format!(
                "{prog} 退出码 {}：{}",
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

/// iTerm2 是否在运行（`pgrep -x iTerm2`，精确匹配进程名）。
///
/// 绝对路径（GUI 应用 PATH 极简，与 `occupant.rs` 的 `LSOF` 同一口径）。
/// pgrep 在个别 GUI 上下文会误报不在运行（2026-10-16 实测），回退到
/// System Events 的进程存在性查询——它**绝不会**拉起 iTerm2
/// （`tell application "iTerm2"` 才会，门禁的意义就在这里）。
pub fn iterm_running(run: &dyn Runner) -> bool {
    if run.run("/usr/bin/pgrep", &["-x", "iTerm2"]).is_ok() {
        return true;
    }
    run.run(
        crate::ops::iterm::OSASCRIPT,
        &[
            "-e",
            "tell application \"System Events\" to exists process \"iTerm2\"",
        ],
    )
    .map(|out| out.trim() == "true")
    .unwrap_or(false)
}

/// 批量取全部 iTerm 会话 `tty → 标题` 的 AppleScript（一次脚本取回全部）。
///
/// 注意：不能直接用 `tab` 常量——在 `tell application "iTerm2"` 块内 `tab`
/// 会被解析为 iTerm 的 tab 类，实测会原样输出字符串 "tab"；改用
/// `character id 9`（实测验证）。
pub fn titles_script() -> String {
    "tell application \"iTerm2\"\n\
     \tset out to \"\"\n\
     \tset sep to character id 9\n\
     \trepeat with w in windows\n\
     \t\trepeat with t in tabs of w\n\
     \t\t\trepeat with s in sessions of t\n\
     \t\t\t\tset out to out & (tty of s) & sep & (name of s) & linefeed\n\
     \t\t\tend repeat\n\
     \t\tend repeat\n\
     \tend repeat\n\
     \treturn out\n\
     end tell\n"
        .to_string()
}

/// 解析批量脚本输出：每行 `<tty>\t<标题>`。坏行跳过。
pub fn parse_titles_output(out: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let Some((tty, name)) = line.split_once('\t') else {
            continue;
        };
        if tty.is_empty() || !tty.starts_with("/dev/") {
            continue;
        }
        map.insert(tty.to_string(), name.to_string());
    }
    map
}

/// 取全部 iTerm 会话标题（调用方须先过 [`iterm_running`] 门禁）。
/// 任何失败 → 空表（静默降级为无标题信号）。
pub fn fetch_titles(run: &dyn Runner) -> HashMap<String, String> {
    let script = titles_script();
    match run.run(crate::ops::iterm::OSASCRIPT, &["-e", &script]) {
        Ok(out) => parse_titles_output(&out),
        Err(_) => HashMap::new(),
    }
}

/// 解析后的 iTerm 会话标题。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTitle {
    pub state: TitleState,
    /// 去掉 `π ` 前缀与 ` (omp)` 后缀的展示标题。
    pub text: String,
}

/// 解析 iTerm 会话标题：`π <状态符> <emoji> <标题> (omp)`。
///
/// - 状态符 `>` → 在提示符等待输入；
/// - 盲文旋转符（U+2800–U+28FF 任一）→ 正在工作；
/// - 无 π 前缀 / 状态符无法识别 → [`TitleState::Other`]，标题取原文。
pub fn parse_title(name: &str) -> ParsedTitle {
    let Some(rest) = name.strip_prefix("π ") else {
        return ParsedTitle {
            state: TitleState::Other,
            text: name.to_string(),
        };
    };
    let mut chars = rest.chars();
    let Some(flag) = chars.next() else {
        return ParsedTitle {
            state: TitleState::Other,
            text: String::new(),
        };
    };
    let state = if flag == '>' {
        TitleState::Prompt
    } else if ('\u{2800}'..='\u{28FF}').contains(&flag) {
        TitleState::Working
    } else {
        TitleState::Other
    };
    // 去掉状态符 + 后续空格，再去 `(omp)` 后缀。
    let mut text: &str = chars.as_str().strip_prefix(' ').unwrap_or(chars.as_str());
    text = text.strip_suffix("(omp)").unwrap_or(text).trim_end();
    ParsedTitle {
        state,
        text: text.to_string(),
    }
}

/// 按 tty 聚焦的 AppleScript：`activate` + 遍历选中（`select` 动词已对
/// iTerm2.sdef 核对：“Make receiver visible and selected.”）。
/// 找到返回 `ok`，否则返回 `not-found`。
pub fn focus_script(tty: &str) -> String {
    let escaped = crate::ops::iterm::applescript_escape(tty);
    format!(
        "tell application \"iTerm2\"\n\
         \tactivate\n\
         \trepeat with w in windows\n\
         \t\trepeat with t in tabs of w\n\
         \t\t\trepeat with s in sessions of t\n\
         \t\t\t\tif tty of s is \"{escaped}\" then\n\
         \t\t\t\t\tselect w\n\
         \t\t\t\t\tselect t\n\
         \t\t\t\t\tselect s\n\
         \t\t\t\t\treturn \"ok\"\n\
         \t\t\t\tend if\n\
         \t\t\tend repeat\n\
         \t\tend repeat\n\
         \tend repeat\n\
         \treturn \"not-found\"\n\
         end tell\n"
    )
}

/// 聚焦失败原因（展示给用户看的中文，不静默）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FocusError {
    /// iTerm 未运行。
    NotRunning,
    /// iTerm 在跑但找不到该 tty（标签已关 / 会话已迁移）。
    NotFound,
    /// macOS Automation 授权被拒（-1743）。
    Automation(String),
    /// 其他 osascript 失败。
    Failed(String),
}

impl FocusError {
    pub fn message(&self) -> String {
        match self {
            FocusError::NotRunning => "iTerm 未运行，无法聚焦".to_string(),
            FocusError::NotFound => "在 iTerm 里找不到该会话的标签（可能已关闭）".to_string(),
            FocusError::Automation(detail) => format!(
                "系统已拒绝自动化控制：请到“系统设置 → 隐私与安全性 → 自动化”中，\
                 允许本应用控制 iTerm，然后重试。{detail}"
            ),
            FocusError::Failed(detail) => format!("聚焦失败：{detail}"),
        }
    }
}

/// 聚焦指定 tty 的 iTerm 标签（只读定位 + activate/select）。
pub fn focus_tty(tty: &str, run: &dyn Runner) -> Result<(), FocusError> {
    if !iterm_running(run) {
        return Err(FocusError::NotRunning);
    }
    let script = focus_script(tty);
    match run.run(crate::ops::iterm::OSASCRIPT, &["-e", &script]) {
        Ok(out) => {
            let out = out.trim();
            if out == "ok" {
                Ok(())
            } else {
                Err(FocusError::NotFound)
            }
        }
        Err(stderr) => {
            if stderr.contains("-1743") || stderr.contains("Not authorized to send Apple events") {
                Err(FocusError::Automation(stderr))
            } else {
                Err(FocusError::Failed(stderr))
            }
        }
    }
}

/// 解析 `lsof -a -p <pid> -d 0` 输出，取 fd 0 行的设备路径（如 `/dev/ttys001`）。
pub fn parse_lsof_fd0(out: &str) -> Option<String> {
    for line in out.lines() {
        if line.starts_with("COMMAND") {
            continue;
        }
        // fd 列形如 `0u` / `0r`：按空白分字段找恰好该列。
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let fd = fields[3];
        if !(fd == "0u" || fd == "0r" || fd == "0w") {
            continue;
        }
        let name = fields[fields.len() - 1];
        // 只认终端设备（/dev/ttysXXX、/dev/ttyXXX、/dev/console）：
        // stdin 重定向过 /dev/null 的 holder 不是可聚焦的终端。
        if name.starts_with("/dev/tty") || name == "/dev/console" {
            return Some(name.to_string());
        }
    }
    None
}

/// 查进程的控制终端（`/usr/sbin/lsof` 绝对路径，GUI 的 PATH 极简）。
/// 失败 → None（静默无 tty，该行不可聚焦）。
pub fn tty_of_pid(pid: u32, run: &dyn Runner) -> Option<String> {
    let pid = pid.to_string();
    run.run("/usr/sbin/lsof", &["-a", "-p", &pid, "-d", "0"])
        .ok()
        .and_then(|out| parse_lsof_fd0(&out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 可编程假 Runner：按 (prog, args) 录制调用并返回预设结果。
    struct Fake {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        pgrep_ok: bool,
        osascript_out: Result<String, String>,
        lsof_out: Result<String, String>,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                pgrep_ok: true,
                osascript_out: Ok(String::new()),
                lsof_out: Err("no".into()),
            }
        }
    }

    impl Runner for Fake {
        fn run(&self, prog: &str, args: &[&str]) -> Result<String, String> {
            self.calls.borrow_mut().push((
                prog.to_string(),
                args.iter().map(|s| s.to_string()).collect(),
            ));
            match prog {
                "/usr/bin/pgrep" => {
                    if self.pgrep_ok {
                        Ok("123\n".into())
                    } else {
                        Err("exit 1".into())
                    }
                }
                "/usr/bin/osascript" => self.osascript_out.clone(),
                _ => self.lsof_out.clone(),
            }
        }
    }

    #[test]
    fn title_prompt_and_spinner() {
        let p = parse_title("π > 🚀 SHADOW: 修个 bug (omp)");
        assert_eq!(p.state, TitleState::Prompt);
        assert_eq!(p.text, "🚀 SHADOW: 修个 bug");
        // 旋转符各帧（U+2800–U+28FF）都算工作中。
        for flag in ['⠁', '⠧', '⠙', '⠴', '\u{2800}', '\u{28FF}'] {
            let p = parse_title(&format!("π {flag} 🗂️ RESUME: 标题 (omp)"));
            assert_eq!(p.state, TitleState::Working, "flag {flag}");
            assert_eq!(p.text, "🗂️ RESUME: 标题");
        }
    }

    #[test]
    fn title_tricky_shapes() {
        // 含括号/中文/emoji、无 (omp) 后缀。
        let p = parse_title("π > 📌 示例标题（含备注）(v2) ✅");
        assert_eq!(p.state, TitleState::Prompt);
        assert_eq!(p.text, "📌 示例标题（含备注）(v2) ✅");
        // 没有 π 前缀：状态未知，标题取原文。
        let p = parse_title("zsh — ttys001");
        assert_eq!(p.state, TitleState::Other);
        assert_eq!(p.text, "zsh — ttys001");
        // 状态符无法识别。
        let p = parse_title("π X something (omp)");
        assert_eq!(p.state, TitleState::Other);
        assert_eq!(p.text, "something");
        // 空标题。
        let p = parse_title("π >  (omp)");
        assert_eq!(p.state, TitleState::Prompt);
        assert_eq!(p.text, "");
    }

    #[test]
    fn titles_output_parsing_skips_garbage() {
        let out = "/dev/ttys001\tπ > A (omp)\n\
                   garbage-line\n\
                   \n\
                   /dev/ttys002\tπ ⠧ B (omp)\r\n\
                   not-a-tty\tC\n";
        let map = parse_titles_output(out);
        assert_eq!(map.len(), 2);
        assert_eq!(map["/dev/ttys001"], "π > A (omp)");
        assert_eq!(map["/dev/ttys002"], "π ⠧ B (omp)");
    }

    #[test]
    fn focus_checks_running_first() {
        let fake = Fake {
            pgrep_ok: false,
            ..Fake::new()
        };
        assert_eq!(
            focus_tty("/dev/ttys001", &fake),
            Err(FocusError::NotRunning)
        );
        // pgrep 失败后绝不碰 osascript（否则会拉起 iTerm）。
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "/usr/bin/pgrep");
    }

    #[test]
    fn focus_ok_and_not_found() {
        let fake = Fake {
            osascript_out: Ok("ok\n".into()),
            ..Fake::new()
        };
        assert_eq!(focus_tty("/dev/ttys001", &fake), Ok(()));
        // 脚本里只允许 activate + select：绝无 write text。
        let calls = fake.calls.borrow();
        let script = calls
            .iter()
            .find(|(p, _)| p == "/usr/bin/osascript")
            .map(|(_, a)| a[1].clone())
            .unwrap();
        assert!(script.contains("activate"), "{script}");
        assert!(script.contains("select s"), "{script}");
        assert!(!script.contains("write text"), "{script}");

        let fake = Fake {
            osascript_out: Ok("not-found\n".into()),
            ..Fake::new()
        };
        assert_eq!(focus_tty("/dev/ttys001", &fake), Err(FocusError::NotFound));
    }

    #[test]
    fn focus_automation_denied() {
        let fake = Fake {
            osascript_out: Err(
                "execution error: Not authorized to send Apple events (-1743)".into(),
            ),
            ..Fake::new()
        };
        let err = focus_tty("/dev/ttys001", &fake).unwrap_err();
        assert!(matches!(err, FocusError::Automation(_)));
        assert!(err.message().contains("自动化"), "{}", err.message());
    }

    #[test]
    fn lsof_fd0_parsing() {
        let out = "COMMAND   PID USER   FD   TYPE DEVICE  SIZE/OFF NODE NAME\n\
                   omp     4242 u    0u   CHR   16,1 0x1000442  442 /dev/ttys001\n";
        assert_eq!(parse_lsof_fd0(out), Some("/dev/ttys001".to_string()));
        // 无 fd0 行 / 只有表头 → None。
        assert_eq!(parse_lsof_fd0("COMMAND PID\n"), None);
        assert_eq!(parse_lsof_fd0(""), None);
        // 非 /dev/ 路径不取。
        let out = "COMMAND   PID USER   FD   TYPE DEVICE  SIZE/OFF NODE NAME\n\
                   omp     1 u    0u   CHR   16,1 0x1  1 socket\n";
        assert_eq!(parse_lsof_fd0(out), None);
    }

    #[test]
    fn titles_script_shape() {
        let s = titles_script();
        // 批量取回：单脚本遍历全部 window/tab/session。
        assert!(s.contains("repeat with w in windows"), "{s}");
        assert!(s.contains("tty of s"), "{s}");
        assert!(s.contains("character id 9"), "{s}");
        assert!(!s.contains("write text"), "{s}");
        assert!(!s.contains("activate"), "{s}");
    }
}
