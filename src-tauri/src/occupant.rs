//! 占用者识别（CONTRACT §3.1）：`in_use` 会话的锁持有者归属应用（尽力识别，仅展示）。
//!
//! 写门禁仍只看 [`crate::lock`] 的 flock 探测；本模块任何失败都静默降级为
//! "无占用者信息"（`occupant: None`），永不报错、永不改变 `in_use`。
//!
//! 机制（macOS）：锁文件 0 字节、无 PID，先用系统 `lsof` 一次查出全部
//! in-use 会话的持有者 PID，再用 `sysctl([CTL_KERN, KERN_PROCARGS2, pid])`
//! 读该进程环境（仅提取白名单变量），最后由纯函数 [`classify`] 映射为展示名。
//! 祖先链回溯不使用（iTerm2 会话父进程已消亡，实测验证）。

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crate::model::Occupant;

/// `lsof` 绝对路径（GUI 应用 PATH 极简，必须写死）。
const LSOF: &str = "/usr/sbin/lsof";
/// `lsof` 硬超时：超时则杀子进程，降级为无信息。
const LSOF_TIMEOUT: Duration = Duration::from_secs(2);

/// 环境白名单：只提取这些变量，其余一律丢弃（不保留、不日志、不传前端）。
const WL_TERM_PROGRAM: &str = "TERM_PROGRAM";
const WL_TERM_PROGRAM_VERSION: &str = "TERM_PROGRAM_VERSION";
const WL_BUNDLE_ID: &str = "__CFBundleIdentifier";
const WL_TMUX: &str = "TMUX";
const WL_TERMINAL_EMULATOR: &str = "TERMINAL_EMULATOR";

/// 持有者进程环境中提取出的白名单变量（其余已丢弃）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HolderEnv {
    pub term_program: Option<String>,
    pub term_program_version: Option<String>,
    pub bundle_id: Option<String>,
    pub tmux: Option<String>,
    pub terminal_emulator: Option<String>,
}

impl HolderEnv {
    fn get(&self, key: &str) -> Option<&str> {
        match key {
            _ if key == WL_TERM_PROGRAM => self.term_program.as_deref(),
            _ if key == WL_TERM_PROGRAM_VERSION => self.term_program_version.as_deref(),
            _ if key == WL_BUNDLE_ID => self.bundle_id.as_deref(),
            _ if key == WL_TMUX => self.tmux.as_deref(),
            _ if key == WL_TERMINAL_EMULATOR => self.terminal_emulator.as_deref(),
            _ => None,
        }
    }

    fn set(&mut self, key: &str, value: String) {
        match key {
            _ if key == WL_TERM_PROGRAM => self.term_program = Some(value),
            _ if key == WL_TERM_PROGRAM_VERSION => self.term_program_version = Some(value),
            _ if key == WL_BUNDLE_ID => self.bundle_id = Some(value),
            _ if key == WL_TMUX => self.tmux = Some(value),
            _ if key == WL_TERMINAL_EMULATOR => self.terminal_emulator = Some(value),
            _ => {}
        }
    }

    /// 是否白名单变量。
    fn is_whitelisted(key: &str) -> bool {
        key == WL_TERM_PROGRAM
            || key == WL_TERM_PROGRAM_VERSION
            || key == WL_BUNDLE_ID
            || key == WL_TMUX
            || key == WL_TERMINAL_EMULATOR
    }
}

/// `__CFBundleIdentifier` → 展示名（`com.jetbrains.` 为前缀匹配，其余精确匹配）。
fn bundle_label(bundle_id: &str) -> Option<&'static str> {
    if bundle_id.starts_with("com.jetbrains.") {
        return Some("JetBrains");
    }
    match bundle_id {
        "com.googlecode.iterm2" => Some("iTerm2"), // VERIFIED
        "com.microsoft.VSCode" => Some("VS Code"), // VERIFIED
        "com.microsoft.VSCodeInsiders" => Some("VS Code Insiders"),
        "com.apple.Terminal" => Some("Terminal"),
        "com.mitchellh.ghostty" => Some("Ghostty"),
        "com.todesktop.230313mzl4w4u92" => Some("Cursor"),
        "dev.zed.Zed" => Some("Zed"),
        "dev.warp.Warp-Stable" => Some("Warp"),
        "com.github.wez.wezterm" => Some("WezTerm"),
        "net.kovidgoyal.kitty" => Some("kitty"),
        "org.alacritty" => Some("Alacritty"),
        "co.zeit.hyper" => Some("Hyper"),
        _ => None,
    }
}

/// `TERM_PROGRAM` → 展示名（未知非空值原样返回；调用方据此判断版本一致性）。
fn term_program_label(term_program: &str) -> Option<String> {
    match term_program {
        "iTerm.app" => Some("iTerm2".to_string()), // VERIFIED
        "Apple_Terminal" => Some("Terminal".to_string()),
        "vscode" => Some("VS Code".to_string()), // VERIFIED
        "ghostty" => Some("Ghostty".to_string()),
        "WarpTerminal" => Some("Warp".to_string()),
        "WezTerm" => Some("WezTerm".to_string()),
        "Hyper" => Some("Hyper".to_string()),
        "" => None,
        other => Some(other.to_string()),
    }
}

/// 归属分类（纯函数）：返回 `(应用展示名, 版本)`；无法识别时 `(None, None)`。
///
/// 优先级：tmux > bundle id > TERM_PROGRAM。版本仅当所选展示名与
/// TERM_PROGRAM 派生名一致时才取 `TERM_PROGRAM_VERSION`（如 Cursor 进程带
/// `TERM_PROGRAM=vscode`，不能把 VS Code 的版本号算到 Cursor 头上）；tmux 永无版本。
pub fn classify(env: &HolderEnv) -> (Option<String>, Option<String>) {
    fn nonempty(o: Option<&str>) -> Option<&str> {
        o.filter(|s| !s.is_empty())
    }
    // a. tmux：TMUX 非空或 TERM_PROGRAM == "tmux"。
    if nonempty(env.get(WL_TMUX)).is_some() || env.get(WL_TERM_PROGRAM) == Some("tmux") {
        return (Some("tmux".to_string()), None);
    }
    // b. bundle id 优先于 TERM_PROGRAM（VS Code 系 fork 会伪装 TERM_PROGRAM=vscode）。
    if let Some(bundle) = nonempty(env.get(WL_BUNDLE_ID)) {
        // JetBrains 亦可由 TERMINAL_EMULATOR 判定。
        if env.get(WL_TERMINAL_EMULATOR) == Some("JetBrains-JediTerm") {
            return (Some("JetBrains".to_string()), None);
        }
        if let Some(label) = bundle_label(bundle) {
            let version = match term_program_label(env.get(WL_TERM_PROGRAM).unwrap_or("")) {
                Some(tp_label) if tp_label == label => {
                    nonempty(env.get(WL_TERM_PROGRAM_VERSION)).map(str::to_string)
                }
                _ => None,
            };
            return (Some(label.to_string()), version);
        }
        // 未知 bundle id 但 TERMINAL_EMULATOR 指向 JetBrains 时仍识别。
        if env.get(WL_TERMINAL_EMULATOR) == Some("JetBrains-JediTerm") {
            return (Some("JetBrains".to_string()), None);
        }
    } else if env.get(WL_TERMINAL_EMULATOR) == Some("JetBrains-JediTerm") {
        return (Some("JetBrains".to_string()), None);
    }
    // c. TERM_PROGRAM 表。
    if let Some(tp) = nonempty(env.get(WL_TERM_PROGRAM)) {
        if let Some(label) = term_program_label(tp) {
            let version = nonempty(env.get(WL_TERM_PROGRAM_VERSION)).map(str::to_string);
            return (Some(label), version);
        }
    }
    // d. 无法识别。
    (None, None)
}

/// 解析 `lsof -nP -F pn` 字段输出 → 会话 id → 最低持有者 PID。
///
/// 按锁文件名 basename（`<id>.lock`）匹配会话，不过滤路径。同一会话多个
/// PID 持有时取最低 pid（确定性）。垃圾行忽略。
pub fn parse_lsof_output(output: &str) -> HashMap<String, u32> {
    let mut out: HashMap<String, u32> = HashMap::new();
    let mut cur_pid: Option<u32> = None;
    for line in output.lines() {
        let Some(body) = line.strip_prefix('p') else {
            // `f<fd>` / `n<path>` 行：只有 n 行携带路径。
            if let Some(rest) = line.strip_prefix('n') {
                if let Some(pid) = cur_pid {
                    // basename 匹配：`<id>.lock`。
                    let base = rest.rsplit('/').next().unwrap_or(rest);
                    if let Some(id) = base.strip_suffix(".lock") {
                        if !id.is_empty() {
                            out.entry(id.to_string())
                                .and_modify(|p| *p = (*p).min(pid))
                                .or_insert(pid);
                        }
                    }
                }
            }
            continue;
        };
        // `p<pid>` 行：切换当前进程；非法 pid 则后续 n 行无人认领。
        cur_pid = body.trim().parse::<u32>().ok();
    }
    out
}

/// 解析 KERN_PROCARGS2 缓冲区 → 白名单环境变量。
///
/// 布局：i32 argc，小端；exec 路径 NUL 结尾；NUL 填充；argc 个 argv 字符串
/// （NUL 结尾）；之后是环境字符串（NUL 结尾）直到末尾或空串。截断/缺段/
/// 非 UTF-8（lossy 容忍）均降级：能提多少提多少，绝不 panic。
pub fn parse_procargs2(buf: &[u8]) -> HolderEnv {
    let mut env = HolderEnv::default();
    if buf.len() < 4 {
        return env;
    }
    let argc = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc < 0 {
        return env;
    }
    // 按 NUL 切分：[exec, pad?...(空串), argv..., env...]；空串只跳过一次填充?
    // 实际上填充可能是多个 NUL，均为空串；但 argv 空串参数理论上也可能出现。
    // 简化：跳过 exec 后的连续空串（填充），随后跳过 argc 个字段，再把剩余
    // 非空字段按 `KEY=VALUE` 解析。argc=0 时 exec 后全部视为环境。
    let mut fields = buf[4..].split(|b| *b == 0);
    let _exec = fields.next();
    let mut fields = fields.peekable();
    // 跳过 NUL 填充（连续空串）。
    while fields.peek().is_some_and(|f| f.is_empty()) {
        fields.next();
    }
    // 跳过 argv。
    for _ in 0..argc {
        if fields.next().is_none() {
            return env; // 截断：无环境段
        }
    }
    for kv in fields {
        if kv.is_empty() {
            break; // 环境段结束
        }
        let Some(eq) = kv.iter().position(|b| *b == b'=') else {
            continue;
        };
        let (k, v) = (&kv[..eq], &kv[eq + 1..]);
        // key 必须为 UTF-8 且在白名单中；value 非 UTF-8 时 lossy 转换。
        let Ok(key) = std::str::from_utf8(k) else {
            continue;
        };
        if !HolderEnv::is_whitelisted(key) {
            continue;
        }
        env.set(key, String::from_utf8_lossy(v).into_owned());
    }
    env
}

/// 读进程环境（`sysctl([CTL_KERN, KERN_PROCARGS2, pid])`）。失败返回空环境。
fn holder_env(pid: u32) -> HolderEnv {
    let pid_i32 = i32::try_from(pid).unwrap_or(i32::MAX);
    // SAFETY: mib 指向栈上 3 个 c_int 的数组，sysctl 只读。
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid_i32];
    let mut size: libc::size_t = 0;
    // 先取长度。
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 || size > 1024 * 1024 {
        return HolderEnv::default();
    }
    let mut buf = vec![0u8; size];
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return HolderEnv::default();
    }
    buf.truncate(size);
    parse_procargs2(&buf)
}

/// 一次 `lsof` 查出给定锁文件的持有者 PID（会话 id → pid）。任何失败 → 空表。
fn holder_pids(owners_dir: &Path, session_ids: &[String]) -> HashMap<String, u32> {
    if session_ids.is_empty() {
        return HashMap::new();
    }
    let mut cmd = std::process::Command::new(LSOF);
    cmd.args(["-nP", "-F", "pn", "--"]);
    for id in session_ids {
        // id 已过 lock::valid 校验（字母数字/`-`/`_`），拼接安全。
        cmd.arg(owners_dir.join(format!("{id}.lock")));
    }
    // stdin 悬空会继承奇怪的 fd：显式 null。
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };
    // 硬超时等待（无额外 crate）：轮询 try_wait，超时则 kill。
    let deadline = std::time::Instant::now() + LSOF_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return HashMap::new();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                return HashMap::new();
            }
        }
    }
    let output = child
        .wait_with_output()
        .map(|o| o.stdout)
        .unwrap_or_default();
    // lsof 无命中时 exit 1 且无输出 → 空表（正常情况，非错误）。
    let text = String::from_utf8_lossy(&output);
    let all = parse_lsof_output(&text);
    // 只保留本次请求的会话（lsof 按传入路径查，理论上全是；防御性过滤）。
    all.into_iter()
        .filter(|(id, _)| session_ids.iter().any(|w| w == id))
        .collect()
}

/// 解析单个持有者 PID → [`Occupant`]（PID 已知但应用未知时 app 全 null）。
fn occupant_for_pid(pid: u32) -> Occupant {
    let env = holder_env(pid);
    let (app, app_version) = classify(&env);
    Occupant {
        pid,
        app,
        app_version,
    }
}

/// 批量解析：in-use 会话 id → 占用者信息。任何失败静默跳过（调用方保持
/// `occupant: None`）。`session_ids` 去重由调用方保证或不保证均可。
pub fn resolve_occupants(owners_dir: &Path, session_ids: &[String]) -> HashMap<String, Occupant> {
    let pids = holder_pids(owners_dir, session_ids);
    pids.into_iter()
        .map(|(id, pid)| (id, occupant_for_pid(pid)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_full(term_program: &str, version: &str, bundle: &str) -> HolderEnv {
        HolderEnv {
            term_program: Some(term_program.to_string()),
            term_program_version: Some(version.to_string()),
            bundle_id: Some(bundle.to_string()),
            tmux: None,
            terminal_emulator: None,
        }
    }

    #[test]
    fn tmux_takes_precedence_over_bundle_and_term_program() {
        let mut e = env_full("vscode", "1.138.0", "com.microsoft.VSCode");
        e.tmux = Some("/tmp/tmux-501/default,123,0".to_string());
        assert_eq!(
            classify(&e),
            (Some("tmux".to_string()), None),
            "tmux 优先于 bundle id"
        );
        let e2 = HolderEnv {
            term_program: Some("tmux".to_string()),
            ..Default::default()
        };
        assert_eq!(classify(&e2), (Some("tmux".to_string()), None));
        // 空 TMUX 不算 tmux。
        let mut e3 = env_full("vscode", "1.138.0", "com.microsoft.VSCode");
        e3.tmux = Some(String::new());
        assert_eq!(
            classify(&e3),
            (Some("VS Code".to_string()), Some("1.138.0".to_string()))
        );
    }

    #[test]
    fn cursor_bundle_wins_over_vscode_term_program_without_version() {
        // Cursor 系 fork：TERM_PROGRAM=vscode + Cursor bundle id → Cursor，无版本。
        let e = env_full("vscode", "1.138.0", "com.todesktop.230313mzl4w4u92");
        assert_eq!(classify(&e), (Some("Cursor".to_string()), None));
    }

    #[test]
    fn iterm_and_vscode_with_matching_version() {
        let e = env_full("iTerm.app", "3.7.3", "com.googlecode.iterm2");
        assert_eq!(
            classify(&e),
            (Some("iTerm2".to_string()), Some("3.7.3".to_string()))
        );
        let e = env_full("vscode", "1.138.0", "com.microsoft.VSCode");
        assert_eq!(
            classify(&e),
            (Some("VS Code".to_string()), Some("1.138.0".to_string()))
        );
    }

    #[test]
    fn bundle_without_consistent_term_program_gets_no_version() {
        // bundle 是 Cursor，但 TERM_PROGRAM 缺失 → 有应用、无版本。
        let e = HolderEnv {
            bundle_id: Some("com.todesktop.230313mzl4w4u92".to_string()),
            ..Default::default()
        };
        assert_eq!(classify(&e), (Some("Cursor".to_string()), None));
        // bundle 与 TERM_PROGRAM 不一致（Ghostty 宿主里的 vscode 值）→ 无版本。
        let mut e = env_full("vscode", "9.9.9", "com.mitchellh.ghostty");
        e.term_program_version = Some("9.9.9".to_string());
        assert_eq!(classify(&e), (Some("Ghostty".to_string()), None));
    }

    #[test]
    fn unknown_term_program_shown_raw_and_empty_means_none() {
        let e = HolderEnv {
            term_program: Some("my-cool-term".to_string()),
            term_program_version: Some("2.0".to_string()),
            ..Default::default()
        };
        assert_eq!(
            classify(&e),
            (Some("my-cool-term".to_string()), Some("2.0".to_string()))
        );
        assert_eq!(classify(&HolderEnv::default()), (None, None));
        let e = HolderEnv {
            term_program: Some(String::new()),
            ..Default::default()
        };
        assert_eq!(classify(&e), (None, None));
    }

    #[test]
    fn jetbrains_via_prefix_or_terminal_emulator() {
        let e = HolderEnv {
            bundle_id: Some("com.jetbrains.intellij".to_string()),
            ..Default::default()
        };
        assert_eq!(classify(&e), (Some("JetBrains".to_string()), None));
        let e = HolderEnv {
            terminal_emulator: Some("JetBrains-JediTerm".to_string()),
            ..Default::default()
        };
        assert_eq!(classify(&e), (Some("JetBrains".to_string()), None));
    }

    /// 构造合成 KERN_PROCARGS2 缓冲区：argc + exec + 填充 + argv + env。
    fn procargs_buf(argv: &[&str], env: &[&str]) -> Vec<u8> {
        let mut b = (argv.len() as i32).to_le_bytes().to_vec();
        b.extend_from_slice(b"/fake/omp\0");
        b.push(0); // NUL 填充
        for a in argv {
            b.extend_from_slice(a.as_bytes());
            b.push(0);
        }
        for e in env {
            b.extend_from_slice(e.as_bytes());
            b.push(0);
        }
        b
    }

    #[test]
    fn procargs2_normal_extracts_only_whitelist() {
        let buf = procargs_buf(
            &["omp", "--resume"],
            &[
                "TERM_PROGRAM=iTerm.app",
                "TERM_PROGRAM_VERSION=3.7.3",
                "__CFBundleIdentifier=com.googlecode.iterm2",
                "HOME=/Users/x",
                "SECRET_TOKEN=abc",
                "PATH=/usr/bin",
            ],
        );
        let e = parse_procargs2(&buf);
        assert_eq!(e.term_program.as_deref(), Some("iTerm.app"));
        assert_eq!(e.term_program_version.as_deref(), Some("3.7.3"));
        assert_eq!(e.bundle_id.as_deref(), Some("com.googlecode.iterm2"));
        assert_eq!(e.tmux, None);
        // 非白名单变量不可见（字段层面即无处存放）。
        assert_eq!(
            e,
            HolderEnv {
                term_program: Some("iTerm.app".to_string()),
                term_program_version: Some("3.7.3".to_string()),
                bundle_id: Some("com.googlecode.iterm2".to_string()),
                tmux: None,
                terminal_emulator: None,
            }
        );
        let (app, ver) = classify(&e);
        assert_eq!(app.as_deref(), Some("iTerm2"));
        assert_eq!(ver.as_deref(), Some("3.7.3"));
    }

    #[test]
    fn procargs2_argc_zero_treats_rest_as_env() {
        let buf = procargs_buf(&[], &["TERM_PROGRAM=vscode"]);
        let e = parse_procargs2(&buf);
        assert_eq!(e.term_program.as_deref(), Some("vscode"));
    }

    #[test]
    fn procargs2_missing_env_section_gives_empty() {
        let mut b = (2i32).to_le_bytes().to_vec();
        b.extend_from_slice(b"/fake/omp\0");
        b.push(0);
        b.extend_from_slice(b"omp\0");
        // argv 截断（第二个缺失）→ 空环境，不 panic。
        let e = parse_procargs2(&b);
        assert_eq!(e, HolderEnv::default());
        // 空缓冲 / 短缓冲 → 空环境。
        assert_eq!(parse_procargs2(&[]), HolderEnv::default());
        assert_eq!(parse_procargs2(&[1, 2, 3]), HolderEnv::default());
    }

    #[test]
    fn procargs2_truncated_and_non_utf8() {
        // 无 NUL 结尾的截断缓冲：仅完整字段被提取。
        let mut b = (1i32).to_le_bytes().to_vec();
        b.extend_from_slice(b"/fake/omp\0");
        b.push(0);
        b.extend_from_slice(b"omp\0TERM_PROGRAM=tmux\0TMUX=/tmp/tmux");
        let e = parse_procargs2(&b);
        assert_eq!(e.term_program.as_deref(), Some("tmux"));
        // value 非 UTF-8 → lossy，不 panic，不污染其他字段。
        let mut b = (0i32).to_le_bytes().to_vec();
        b.extend_from_slice(b"/e\0\0");
        b.extend_from_slice(b"TERM_PROGRAM=\xff\xfe\0");
        b.extend_from_slice(b"TMUX=/tmp/x\0");
        let e = parse_procargs2(&b);
        assert_eq!(e.tmux.as_deref(), Some("/tmp/x"));
        assert!(e.term_program.is_some());
        // key 非 UTF-8 → 整行跳过。
        let mut b = (0i32).to_le_bytes().to_vec();
        b.extend_from_slice(b"/e\0\0");
        b.extend_from_slice(&[0xff, b'=', b'x', 0]);
        b.extend_from_slice(b"TMUX=/tmp/y\0");
        let e = parse_procargs2(&b);
        assert_eq!(e.tmux.as_deref(), Some("/tmp/y"));
        // 无 `=` 的行跳过。
        let mut b = (0i32).to_le_bytes().to_vec();
        b.extend_from_slice(b"/e\0\0");
        b.extend_from_slice(b"JUSTAFLAG\0TMUX=/tmp/z\0");
        let e = parse_procargs2(&b);
        assert_eq!(e.tmux.as_deref(), Some("/tmp/z"));
    }

    #[test]
    fn lsof_parser_multiple_pids_and_shared_lock() {
        let out =
            "p100\nf3\nn/owners/aaa.lock\nf4\nn/owners/bbb.lock\np50\nf7\nn/owners/aaa.lock\n";
        let m = parse_lsof_output(out);
        // aaa 被 100 与 50 同时持有 → 最低 pid 50；bbb → 100。
        assert_eq!(m.get("aaa"), Some(&50));
        assert_eq!(m.get("bbb"), Some(&100));
    }

    #[test]
    fn lsof_parser_one_pid_two_locks_basename_and_garbage() {
        let out = "garbage\np3074\nf12\nn/Users/x/.omp/run/session-owners/sess-1.lock\n\
            junk line\nf13\nn/elsewhere/sess-2.lock\np\nf1\nn/owners/ignored.lock\n";
        let m = parse_lsof_output(out);
        // basename 匹配（全路径不等也命中）；非法 `p` 行后的 n 行无人认领。
        assert_eq!(m.get("sess-1"), Some(&3074));
        assert_eq!(m.get("sess-2"), Some(&3074));
        assert!(!m.contains_key("ignored"));
        assert_eq!(parse_lsof_output(""), HashMap::new());
        assert_eq!(
            parse_lsof_output("p1\nf2\nn/owners/.lock\n"),
            HashMap::new()
        );
    }

    #[test]
    fn resolve_occupants_empty_or_missing_lsof_degrades_to_empty() {
        // 空请求不调 lsof，直接空表。
        let dir = std::env::temp_dir();
        assert!(resolve_occupants(&dir, &[]).is_empty());
        // 不存在的目录 → lsof 非零/无输出 → 空表，不 panic。
        let missing = dir.join("omp-resume-occupant-test-missing-dir");
        let ids = vec!["no-such-session".to_string()];
        assert!(resolve_occupants(&missing, &ids).is_empty());
    }
}
