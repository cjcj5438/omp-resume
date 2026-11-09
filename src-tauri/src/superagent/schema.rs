//! Superagent 状态库 schema 预检：spawn 前比对库版本与守护进程支持范围。
//!
//! - 状态库 `<state_dir>/superagent.sqlite` 的 `kv('schema')` 行存着库版本
//!   （JSON 数字，与守护进程 `store.ts` 的写入口径一致）；
//! - 守护进程支持范围经 `<omp> run <assets>/dist/daemon.js --print-schema`
//!   查询（stdout 里 `schema {"schema":N,"oldest":M}` 一行）；
//! - 任一侧缺失/不可读 ⇒ `Unknown`，按今天的行为继续 spawn（只做加法，
//!   不改变未知情况下的旧行为）。
//!
//! 只有确认失配（`TooNew`/`TooOld`）才拦停：`supervisor` 置 `Incompatible`
//! 并让用户一键改名归档后重建状态目录，而不是看着守护进程秒退、无限退避。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};

/// 状态库文件名（守护进程 `runtime.ts` 写死）。
pub const DB_FILE: &str = "superagent.sqlite";
/// `kv` 表中存库版本的行键（守护进程 `kv.ts` 的 `KV.store.schema`）。
const SCHEMA_KEY: &str = "schema";
/// `--print-schema` 的 stdout 前缀：`schema {"schema":13,"oldest":10}`。
const SCHEMA_LINE_PREFIX: &str = "schema ";
/// `--print-schema` 探测硬超时。
const DAEMON_SCHEMA_TIMEOUT: Duration = Duration::from_secs(10);

/// 状态库路径 `S/superagent.sqlite`。
pub fn db_path(state_dir: &Path) -> PathBuf {
    state_dir.join(DB_FILE)
}

/// 读状态库的 schema 版本：只读打开，永不创建文件。
///
/// 文件缺失 / 表或行缺失 / 值不是数字 / 任何 SQL 错误 ⇒ `None`
/// （调用方按 `Unknown` 处理，继续 spawn）。
pub fn read_state_schema(db: &Path) -> Option<u32> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    // 守护进程用 WAL 且可能正在写入：短暂等锁，BUSY 不误报为未知。
    // 只读连接不做 checkpoint，不写回任何字节。
    conn.busy_timeout(Duration::from_millis(500)).ok()?;
    let value: String = conn
        .query_row("SELECT value FROM kv WHERE key = ?1", [SCHEMA_KEY], |row| {
            row.get(0)
        })
        .ok()?;
    // `store.ts` 以 `JSON.stringify(number)` 写入：纯数字，也可能是带空白的 JSON。
    serde_json::from_str::<serde_json::Value>(value.trim())
        .ok()
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
}

/// 守护进程支持的 schema 范围 `(oldest, newest)`。
///
/// 经 `<omp> run <assets>/dist/daemon.js --print-schema` 查询：环境变量与
/// `supervisor` spawn 时一致（`BUN_BE_BUN`/`NO_COLOR`/增广 `PATH`），10 秒超时；
/// 扫描 stdout 里 `schema ` 前缀行并解析 JSON。任何失败 ⇒ `None`
/// （调用方按 `Unknown` 处理，继续 spawn）。
pub fn daemon_schema(assets: &Path, omp: &Path) -> Option<(u32, u32)> {
    daemon_schema_inner(assets, omp, DAEMON_SCHEMA_TIMEOUT)
}

fn daemon_schema_inner(assets: &Path, omp: &Path, timeout: Duration) -> Option<(u32, u32)> {
    let daemon_js = assets.join("dist/daemon.js");
    let mut child = std::process::Command::new(omp)
        .arg("run")
        .arg(&daemon_js)
        .arg("--print-schema")
        .env("BUN_BE_BUN", "1")
        .env("NO_COLOR", "1")
        .env("PATH", crate::omp_cli::augmented_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // 硬超时等待：到期 kill；stdout 在子进程退出后再一次性读走。
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
    let mut stdout = String::new();
    child.stdout.as_mut()?.read_to_string(&mut stdout).ok()?;
    parse_schema_line(&stdout)
}

/// 从 `--print-schema` 的 stdout 里找 `schema {...}` 行并解析。
fn parse_schema_line(stdout: &str) -> Option<(u32, u32)> {
    let json = stdout
        .lines()
        .filter_map(|line| line.strip_prefix(SCHEMA_LINE_PREFIX))
        .next_back()?;
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let newest = v.get("schema")?.as_u64()?;
    let oldest = v.get("oldest")?.as_u64()?;
    Some((u32::try_from(oldest).ok()?, u32::try_from(newest).ok()?))
}

/// 预检结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    /// 在 `[oldest, newest]` 内（含两端）：正常启动。
    Compatible,
    /// 库版本高于守护进程支持：必须拦停，等用户一键归档或升级版本。
    TooNew { state: u32, newest: u32 },
    /// 库版本低于守护进程可迁移下限：必须拦停，等用户一键归档。
    TooOld { state: u32, oldest: u32 },
    /// 任一侧未知：按今天的行为继续 spawn。
    Unknown,
}

/// 纯函数：比对状态库版本与守护进程支持范围。
pub fn check(state_db: Option<u32>, daemon: Option<(u32, u32)>) -> Check {
    let (Some(state), Some((oldest, newest))) = (state_db, daemon) else {
        return Check::Unknown;
    };
    if state > newest {
        Check::TooNew { state, newest }
    } else if state < oldest {
        Check::TooOld { state, oldest }
    } else {
        Check::Compatible
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个带 `kv('schema', …)` 的临时库（`store.ts` 同款写入口径）。
    fn temp_db_with_schema(value_sql: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(DB_FILE);
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            &format!("INSERT INTO kv VALUES ('{SCHEMA_KEY}', '{value_sql}')"),
            [],
        )
        .unwrap();
        drop(conn);
        (dir, db)
    }

    #[test]
    fn reads_json_number_schema() {
        let (_dir, db) = temp_db_with_schema("13");
        assert_eq!(read_state_schema(&db), Some(13));
        // 带空白的 JSON 文本同样接受。
        let (_dir, db) = temp_db_with_schema("  9  ");
        assert_eq!(read_state_schema(&db), Some(9));
    }

    #[test]
    fn missing_file_does_not_create_it() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(DB_FILE);
        assert_eq!(read_state_schema(&db), None);
        assert!(!db.exists());
    }

    #[test]
    fn missing_row_unparsable_or_empty_is_none() {
        // 有表无行。
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(DB_FILE);
        Connection::open(&db)
            .unwrap()
            .execute(
                "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
        assert_eq!(read_state_schema(&db), None);
        // 非数字 / 非 JSON / 超界。
        for bad in ["abc", "\"13\"", "1.5", "4294967296", "-1"] {
            let (_dir, db) = temp_db_with_schema(bad);
            assert_eq!(read_state_schema(&db), None, "value {bad:?}");
        }
        // 根本不是 sqlite 文件。
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(DB_FILE);
        std::fs::write(&db, b"not a database").unwrap();
        assert_eq!(read_state_schema(&db), None);
    }

    #[test]
    fn read_does_not_fail_with_wal_sidecars() {
        let (_dir, db) = temp_db_with_schema("13");
        // 开 WAL 并保持写连接不关闭（关掉会 checkpoint 吃掉旁车）：只读打开
        // 必须仍能读到版本——这正是守护进程运行中预检的真实场景。
        let writer = Connection::open(&db).unwrap();
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        writer
            .execute(
                &format!("UPDATE kv SET value = '14' WHERE key = '{SCHEMA_KEY}'"),
                [],
            )
            .unwrap();
        let mut wal = db.as_os_str().to_os_string();
        wal.push("-wal");
        assert!(Path::new(&wal).exists(), "WAL 旁车没建出来，前置条件失效");
        assert_eq!(read_state_schema(&db), Some(14));
        drop(writer);
    }

    #[test]
    fn parses_schema_line_from_noisy_stdout() {
        assert_eq!(
            parse_schema_line("schema {\"schema\":13,\"oldest\":10}\n"),
            Some((10, 13))
        );
        // 前后噪音 + 取最后一行。
        let noisy = "bun x omp\nschema {\"schema\":11,\"oldest\":9}\nwarn: slow\nschema {\"schema\":13,\"oldest\":10}\n";
        assert_eq!(parse_schema_line(noisy), Some((10, 13)));
        // 无前缀行 / 坏 JSON / 缺键 / 超界 ⇒ None。
        assert_eq!(parse_schema_line("{\"schema\":13,\"oldest\":10}\n"), None);
        assert_eq!(parse_schema_line("schema not-json\n"), None);
        assert_eq!(parse_schema_line("schema {\"schema\":13}\n"), None);
        assert_eq!(
            parse_schema_line("schema {\"schema\":4294967296,\"oldest\":10}\n"),
            None
        );
    }

    #[test]
    fn check_matrix() {
        assert_eq!(check(Some(11), Some((10, 13))), Check::Compatible);
        assert_eq!(check(Some(10), Some((10, 13))), Check::Compatible);
        assert_eq!(check(Some(13), Some((10, 13))), Check::Compatible);
        assert_eq!(
            check(Some(14), Some((10, 13))),
            Check::TooNew {
                state: 14,
                newest: 13
            }
        );
        assert_eq!(
            check(Some(9), Some((10, 13))),
            Check::TooOld {
                state: 9,
                oldest: 10
            }
        );
        // 任一侧缺失 ⇒ Unknown（继续 spawn）。
        assert_eq!(check(None, Some((10, 13))), Check::Unknown);
        assert_eq!(check(Some(11), None), Check::Unknown);
        assert_eq!(check(None, None), Check::Unknown);
    }

    #[test]
    fn daemon_schema_parses_fake_omp_output() {
        let _guard = crate::omp_cli::subprocess_test_guard();
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(assets.join("dist")).unwrap();
        std::fs::write(assets.join("dist/daemon.js"), "// fake\n").unwrap();
        let bin = dir.path().join("omp");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho 'boot noise'\necho 'schema {\"schema\":13,\"oldest\":10}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            daemon_schema_inner(&assets, &bin, Duration::from_secs(5)),
            Some((10, 13))
        );
    }

    #[test]
    fn daemon_schema_failure_is_none() {
        let _guard = crate::omp_cli::subprocess_test_guard();
        let dir = tempfile::tempdir().unwrap();
        // omp 不存在。
        assert_eq!(
            daemon_schema_inner(
                dir.path(),
                &dir.path().join("no-such-omp"),
                Duration::from_secs(5)
            ),
            None
        );
        // 超时（脚本睡过去）。
        let bin = dir.path().join("omp");
        std::fs::write(&bin, "#!/bin/sh\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            daemon_schema_inner(dir.path(), &bin, Duration::from_millis(100)),
            None
        );
        // 退出但无 schema 行。
        std::fs::write(&bin, "#!/bin/sh\necho 'no schema here'\n").unwrap();
        assert_eq!(
            daemon_schema_inner(dir.path(), &bin, Duration::from_secs(5)),
            None
        );
    }
}
