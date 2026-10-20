//! 记忆库占用门禁：`lsof` 查 bank 三文件（db / `-wal` / `-shm`）持有者。
//!
//! - 任一持有者 ⇒ 调用方报 `IN_USE`（message 含 pid + command 名）。
//! - lsof 缺失 / 超时 / 输出不可解析 ⇒ [`ProbeFailed`]（调用方报 `PROBE_FAILED`）。
//! - 歧义一律按“不敢断言空闲”处理（误报 busy 可接受，误报 idle 不可接受）。
//! - 二进制路径与超时复用 [`crate::occupant`] 常量；`*_with` 变体供测试注入。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::model::MemoryHolder;

/// 探针失败（lsof 缺失 / 超时 / 不可解析）：调用方必须拒绝写操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProbeFailed;

/// 解析 `lsof -nP -F pcn` 输出 → pid → command（同 pid 多文件去重，command 取首个非空）。
/// 至少带一个 `n` 行的 `p` 组才算持有者；垃圾行忽略。
pub(crate) fn parse_holders(output: &str) -> BTreeMap<u32, String> {
    let mut holders: BTreeMap<u32, String> = BTreeMap::new();
    let mut cur_pid: Option<u32> = None;
    let mut cur_cmd: Option<String> = None;
    let mut cur_has_file = false;
    let mut flush = |pid: &mut Option<u32>, cmd: &mut Option<String>, has_file: &mut bool| {
        if *has_file {
            if let Some(p) = pid.take() {
                holders
                    .entry(p)
                    .or_insert_with(|| cmd.take().unwrap_or_default());
            }
        }
        *pid = None;
        *cmd = None;
        *has_file = false;
    };
    for line in output.lines() {
        let Some((field, value)) = line.split_at_checked(1) else {
            continue;
        };
        match field {
            "p" => {
                flush(&mut cur_pid, &mut cur_cmd, &mut cur_has_file);
                if let Ok(pid) = value.parse::<u32>() {
                    // pid 0 不可能是文件持有者（防御）。
                    cur_pid = if pid == 0 { None } else { Some(pid) };
                }
            }
            "c" => {
                if cur_pid.is_some() && cur_cmd.is_none() && !value.is_empty() {
                    cur_cmd = Some(value.to_owned());
                }
            }
            "n" if cur_pid.is_some() => {
                cur_has_file = true;
            }
            "n" => {}
            _ => {}
        }
    }
    flush(&mut cur_pid, &mut cur_cmd, &mut cur_has_file);
    holders
}

/// 查 `files` 的持有者（`lsof` 路径与超时可注入，供测试）。
pub(crate) fn holders_for_files_with(
    files: &[PathBuf],
    lsof_bin: &Path,
    timeout: Duration,
) -> Result<Vec<MemoryHolder>, ProbeFailed> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let mut cmd = std::process::Command::new(lsof_bin);
    cmd.args(["-nP", "-F", "pcn", "--"]);
    for file in files {
        cmd.arg(file);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|_| ProbeFailed)?;
    // 硬超时等待（同 `occupant.rs`：轮询 try_wait，超时则 kill）。
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ProbeFailed);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                return Err(ProbeFailed);
            }
        }
    }
    let output = child.wait_with_output().map_err(|_| ProbeFailed)?;
    // exit 0/1 皆可：0 = 有命中，1 = 无命中；其余 ⇒ 失败。
    match output.status.code() {
        Some(0) | Some(1) => {}
        _ => return Err(ProbeFailed),
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let holders = parse_holders(&text);
    if !holders.is_empty() {
        return Ok(holders
            .into_iter()
            .map(|(pid, command)| MemoryHolder {
                pid,
                command: if command.is_empty() {
                    "unknown".to_owned()
                } else {
                    command
                },
            })
            .collect());
    }
    // 有输出但零可解析组 ⇒  garbled；空白输出 ⇒ 空闲。
    if text.trim().is_empty() {
        Ok(Vec::new())
    } else {
        Err(ProbeFailed)
    }
}

/// bank 三文件路径（db / `-wal` / `-shm`；不存在的也传入，lsof 会忽略）。
pub(crate) fn bank_files(bank_dir: &Path) -> Vec<PathBuf> {
    let db = bank_dir.join(crate::memory::DB_FILENAME);
    vec![
        db.clone(),
        db.with_extension("db-wal"),
        db.with_extension("db-shm"),
    ]
}

/// `IN_USE` 错误消息（含 pid + command 名，无记忆内容）。
pub(crate) fn in_use_message(holders: &[MemoryHolder]) -> String {
    let list = holders
        .iter()
        .take(5)
        .map(|h| format!("{}（{}）", h.pid, h.command))
        .collect::<Vec<_>>()
        .join("、");
    if holders.len() > 5 {
        format!("记忆库正被 {} 个进程占用：{}等", holders.len(), list)
    } else {
        format!("记忆库正被占用：{list}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_groups_pid_command_and_files() {
        let out = "p1234\ncompA\nn/db/a\np1234\ncompA\nn/db/a-wal\np99\nn/db/a\n";
        let holders = parse_holders(out);
        assert_eq!(holders.len(), 2);
        assert_eq!(holders[&1234], "ompA");
        // 无 command 行 ⇒ 空串（调用方再兜底为 unknown）。
        assert_eq!(holders[&99], "");
    }

    #[test]
    fn parse_ignores_garbage_and_pid_zero() {
        let out = "garbage\np0\nctest\nn/x\np\np77\nzzz\n";
        let holders = parse_holders(out);
        // p0 丢弃；p77 无 n 行 ⇒ 不算持有者。
        assert!(holders.is_empty());
        // 空输出 ⇒ 空。
        assert!(parse_holders("").is_empty());
        assert!(parse_holders("   \n").is_empty());
    }

    #[test]
    fn probe_missing_binary_is_failure() {
        let err = holders_for_files_with(
            &[PathBuf::from("/tmp/x.db")],
            Path::new("/nonexistent/lsof-test-binary"),
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert_eq!(err, ProbeFailed);
    }

    /// 造一个假 lsof（shell 脚本）：按需输出/退出码/睡眠。
    fn fake_lsof(dir: &Path, name: &str, script: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[test]
    fn probe_fake_lsof_matrix() {
        let tmp = tempfile::tempdir().unwrap();
        let files = vec![PathBuf::from("/tmp/x.db")];
        // exit 1 空输出 ⇒ 空闲。
        let bin = fake_lsof(tmp.path(), "lsof-idle", "#!/bin/sh\nexit 1\n");
        assert!(holders_for_files_with(&files, &bin, Duration::from_secs(2))
            .unwrap()
            .is_empty());
        // exit 0 可解析 ⇒ 持有者。
        let bin = fake_lsof(
            tmp.path(),
            "lsof-busy",
            "#!/bin/sh\nprintf 'p4242\\nctest-proc\\nn/tmp/x.db\\n'\n",
        );
        let holders = holders_for_files_with(&files, &bin, Duration::from_secs(2)).unwrap();
        assert_eq!(holders.len(), 1);
        assert_eq!(holders[0].pid, 4242);
        assert_eq!(holders[0].command, "test-proc");
        // exit 0 垃圾 ⇒ 失败。
        let bin = fake_lsof(tmp.path(), "lsof-garbled", "#!/bin/sh\necho '???'\n");
        assert_eq!(
            holders_for_files_with(&files, &bin, Duration::from_secs(2)).unwrap_err(),
            ProbeFailed
        );
        // exit 2 ⇒ 失败。
        let bin = fake_lsof(tmp.path(), "lsof-err", "#!/bin/sh\nexit 2\n");
        assert_eq!(
            holders_for_files_with(&files, &bin, Duration::from_secs(2)).unwrap_err(),
            ProbeFailed
        );
        // 超时 ⇒ 失败（脚本睡 30s，超时 200ms）。
        let bin = fake_lsof(tmp.path(), "lsof-slow", "#!/bin/sh\nsleep 30\n");
        let start = std::time::Instant::now();
        assert_eq!(
            holders_for_files_with(&files, &bin, Duration::from_millis(200)).unwrap_err(),
            ProbeFailed
        );
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn probe_real_lsof_sees_tail_holder() {
        // 真 lsof：`tail -f` 按住文件 ⇒ 探针必须报出持有者。
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("held.db");
        std::fs::write(&file, b"x").unwrap();
        let mut tail = std::process::Command::new("/usr/bin/tail")
            .args(["-f", file.to_str().unwrap()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        // 给 tail 一点时间打开文件。
        let lsof = Path::new(crate::occupant::LSOF);
        let timeout = crate::occupant::LSOF_TIMEOUT;
        let mut holders = Vec::new();
        for _ in 0..50 {
            holders = holders_for_files_with(std::slice::from_ref(&file), lsof, timeout)
                .unwrap_or_default();
            if !holders.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = tail.kill();
        let _ = tail.wait();
        assert_eq!(holders.len(), 1, "{holders:?}");
        assert_eq!(holders[0].pid, tail.id());
        assert_eq!(holders[0].command, "tail");
        // 进程退出后 ⇒ 空闲。
        let holders = holders_for_files_with(std::slice::from_ref(&file), lsof, timeout).unwrap();
        assert!(holders.is_empty());
    }

    #[test]
    fn in_use_message_lists_holders() {
        let msg = in_use_message(&[MemoryHolder {
            pid: 1,
            command: "omp".into(),
        }]);
        assert!(msg.contains('1') && msg.contains("omp"), "{msg}");
        let many: Vec<MemoryHolder> = (1..=7)
            .map(|pid| MemoryHolder {
                pid,
                command: "x".into(),
            })
            .collect();
        let msg = in_use_message(&many);
        assert!(msg.contains('7'), "{msg}");
    }
}
