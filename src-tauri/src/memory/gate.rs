//! 记忆库占用门禁：`lsof` 查 bank 三文件（db / `-wal` / `-shm`）持有者。
//!
//! 任一持有者 ⇒ 调用方报 `IN_USE`；lsof 缺失/超时/不可解析 ⇒ [`ProbeFailed`]。
//! 歧义一律按“不敢断言空闲”处理。二进制路径与超时复用 [`crate::occupant`] 常量。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::model::MemoryHolder;

/// 探针失败（lsof 缺失 / 超时 / 不可解析）：调用方必须拒绝写操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProbeFailed;

/// 解析 `lsof -nP -F pcn` 输出 → pid → command（同 pid 去重，command 取首个非空）。
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
                    cur_pid = if pid == 0 { None } else { Some(pid) };
                }
            }
            "c" => {
                if cur_pid.is_some() && cur_cmd.is_none() && !value.is_empty() {
                    cur_cmd = Some(value.to_owned());
                }
            }
            "n" if cur_pid.is_some() => cur_has_file = true,
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
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProbeFailed);
            }
        }
    }
    let output = child.wait_with_output().map_err(|_| ProbeFailed)?;
    // exit 0 = 有命中，1 = 无命中；其余 ⇒ 失败。
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
    // 有输出但零可解析组 ⇒ garbled；空白输出 ⇒ 空闲。
    if text.trim().is_empty() {
        Ok(Vec::new())
    } else {
        Err(ProbeFailed)
    }
}

/// bank 三文件路径（不存在的也传入，lsof 会忽略）。
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
    fn parse_pid_command_files_garbage_and_pid_zero() {
        let holders =
            parse_holders("p1234\ncompA\nn/db/a\np1234\ncompA\nn/db/a-wal\np99\nn/db/a\n");
        assert_eq!(holders.len(), 2);
        assert_eq!(holders[&1234], "ompA");
        assert_eq!(holders[&99], ""); // 无 command 行 ⇒ 空串（调用方兜底 unknown）
                                      // 垃圾行、pid 0、无 `n` 行的组一律忽略。
        assert!(parse_holders("garbage\np0\nctest\nn/x\np\np77\nzzz\n").is_empty());
        assert!(parse_holders("").is_empty());
        assert!(parse_holders("   \n").is_empty());
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
    fn probe_matrix() {
        let tmp = tempfile::tempdir().unwrap();
        let files = vec![PathBuf::from("/tmp/x.db")];
        let probe = |bin: &Path, timeout: Duration| holders_for_files_with(&files, bin, timeout);
        // 缺失二进制 ⇒ 失败。
        assert_eq!(
            probe(
                Path::new("/nonexistent/lsof-test-binary"),
                Duration::from_secs(2)
            )
            .unwrap_err(),
            ProbeFailed
        );
        // （脚本，超时 /ms，期望）：exit 1 空输出 ⇒ 空闲；exit 0 可解析 ⇒ 持有者；
        // 垃圾输出 / exit 2 / 超时 ⇒ 失败。
        let cases = [
            ("idle", "#!/bin/sh\nexit 1\n", 2000, 0),
            (
                "busy",
                "#!/bin/sh\nprintf 'p4242\\nctest-proc\\nn/tmp/x.db\\n'\n",
                2000,
                1,
            ),
            ("garbled", "#!/bin/sh\necho '???'\n", 2000, -1),
            ("err", "#!/bin/sh\nexit 2\n", 2000, -1),
            ("slow", "#!/bin/sh\nsleep 30\n", 200, -1),
        ];
        for (name, script, timeout_ms, want) in cases {
            let bin = fake_lsof(tmp.path(), &format!("lsof-{name}"), script);
            let start = std::time::Instant::now();
            match (probe(&bin, Duration::from_millis(timeout_ms)), want) {
                (Ok(holders), 0) => assert!(holders.is_empty(), "{name}"),
                (Ok(holders), 1) => {
                    assert_eq!(holders.len(), 1, "{name}");
                    assert_eq!(holders[0].pid, 4242);
                    assert_eq!(holders[0].command, "test-proc");
                }
                (Err(ProbeFailed), -1) => {
                    assert!(start.elapsed() < Duration::from_secs(10), "{name}")
                }
                (got, _) => panic!("{name}: unexpected {got:?}"),
            }
        }
    }
}
