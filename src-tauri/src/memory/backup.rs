//! 记忆库备份：`VACUUM INTO` 快照 + manifest + 留存修剪。
//!
//! 落点 `<data_dir>/memory-backups/<bank>/<ts>-<kind>/`：快照类含 `mnemopi.db` +
//! `manifest.json`，`bank-removed` 含 `bank/`（移入的整目录）+ `manifest.json`。
//! 目录 `0700`、文件 `0600`。`backupId` 为 `{bank}@{dirname}`，严格校验、防穿越。

use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::{bank_segment_ok, io, open_readonly, outside, resolve_contained_dir, table_schema};
use crate::model::{AppError, MemoryBackup, MemoryBackupKind};

/// 备份根目录名 / 快照库名 / manifest 名 / `bank-removed` 内的移入目录名 / 自动留存数
/// （仅 before-delete、before-restore）。
pub const BACKUP_DIR_NAME: &str = "memory-backups";
pub const BACKUP_DB_FILENAME: &str = "mnemopi.db";
pub const MANIFEST_FILENAME: &str = "manifest.json";
pub const REMOVED_SUBDIR: &str = "bank";
pub const BACKUP_KEEP: usize = 5;

/// 备份根目录。
pub fn backup_root(data_dir: &Path) -> PathBuf {
    data_dir.join(BACKUP_DIR_NAME)
}

/// kind ↔ 目录后缀。
const KINDS: [(MemoryBackupKind, &str); 3] = [
    (MemoryBackupKind::BeforeDelete, "before-delete"),
    (MemoryBackupKind::BeforeRestore, "before-restore"),
    (MemoryBackupKind::BankRemoved, "bank-removed"),
];

pub(crate) fn kind_suffix(kind: MemoryBackupKind) -> &'static str {
    KINDS.iter().find(|(k, _)| *k == kind).unwrap().1
}

fn kind_from_suffix(suffix: &str) -> Option<MemoryBackupKind> {
    KINDS.iter().find(|(_, n)| *n == suffix).map(|(k, _)| *k)
}

/// 严格校验备份目录名：`^\d{8}T\d{6}Z-(before-delete|before-restore|bank-removed)$`。
fn parse_dirname(dirname: &str) -> Option<MemoryBackupKind> {
    // stamp 固定 16 字节（纯 ASCII 逐字节校验，避免多字节切分 panic）。
    let (stamp, rest) = dirname.as_bytes().split_at_checked(16)?;
    if !stamp[0..8].iter().all(u8::is_ascii_digit)
        || stamp[8] != b'T'
        || !stamp[9..15].iter().all(u8::is_ascii_digit)
        || stamp[15] != b'Z'
    {
        return None;
    }
    kind_from_suffix(std::str::from_utf8(rest.strip_prefix(b"-")?).ok()?)
}

/// 目录名时间戳 → ISO-8601 UTC（调用方已保证形状合法）。
fn dirname_to_iso(dirname: &str) -> String {
    format!(
        "{}-{}-{}T{}:{}:{}.000Z",
        &dirname[0..4],
        &dirname[4..6],
        &dirname[6..8],
        &dirname[9..11],
        &dirname[11..13],
        &dirname[13..15],
    )
}

/// 已解析的备份引用。
#[derive(Debug)]
pub(crate) struct BackupRef {
    pub bank: String,
    pub dirname: String,
    pub kind: MemoryBackupKind,
    pub dir: PathBuf,
}

/// 解析 `backupId`（按最后 `@` 切分），防穿越。形状非法 ⇒ `OUTSIDE_ROOT`；不存在 ⇒ `NOT_FOUND`。
pub(crate) fn resolve_backup_id(
    backup_root: &Path,
    backup_id: &str,
) -> Result<BackupRef, AppError> {
    let invalid = || outside("非法的备份标识");
    let (bank, dirname) = backup_id.rsplit_once('@').ok_or_else(invalid)?;
    let kind = parse_dirname(dirname)
        .filter(|_| bank_segment_ok(bank))
        .ok_or_else(invalid)?;
    let dir = resolve_contained_dir(
        backup_root,
        &Path::new(bank).join(dirname),
        "备份不存在",
        "备份路径越界",
    )?;
    Ok(BackupRef {
        bank: bank.to_owned(),
        dirname: dirname.to_owned(),
        kind,
        dir,
    })
}

/// manifest 内容（缺失/损坏 ⇒ 条目降级）。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    bank: String,
    kind: MemoryBackupKind,
    created_at: String,
    cwd: Option<String>,
    working: u64,
    episodic: u64,
    source_bank_dir_name: String,
}

/// 目录字节数（递归求和；不可读按 0）。
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

/// 组装单个备份条目。manifest 缺失/损坏 ⇒ `None`（崩溃残留不算备份）。
fn describe_backup(bank: &str, dirname: &str, dir: &Path) -> Option<MemoryBackup> {
    let kind = parse_dirname(dirname)?;
    let manifest: Manifest = std::fs::read(dir.join(MANIFEST_FILENAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
    Some(MemoryBackup {
        id: format!("{bank}@{dirname}"),
        bank: bank.to_owned(),
        kind,
        created_at: manifest.created_at.clone(),
        bytes: dir_bytes(dir),
        working: Some(manifest.working),
        episodic: Some(manifest.episodic),
        cwd: manifest.cwd,
    })
}

/// 列出备份（`bank=None` ⇒ 全部）；newest first。根不可读 ⇒ 空列表。
pub(crate) fn list_backups(backup_root: &Path, bank: Option<&str>) -> Vec<MemoryBackup> {
    let mut out = Vec::new();
    let Ok(bank_dirs) = std::fs::read_dir(backup_root) else {
        return out;
    };
    let canon_root = backup_root
        .canonicalize()
        .unwrap_or_else(|_| backup_root.to_path_buf());
    for bank_dir in bank_dirs.flatten() {
        let Some(bank_name) = bank_dir.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if bank_name.starts_with('.') || bank.is_some_and(|w| w != bank_name) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(bank_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry
                .file_type()
                .map(|t| t.is_dir() || t.is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            let Some(dirname) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if parse_dirname(&dirname).is_none() {
                continue;
            }
            let Ok(canon) = entry.path().canonicalize() else {
                continue;
            };
            if !canon.starts_with(&canon_root) {
                continue;
            }
            out.extend(describe_backup(&bank_name, &dirname, &canon));
        }
    }
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    out
}

/// 建目录并置 `0700`（已存在则仅修正权限）。
pub(crate) fn ensure_dir_0700(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// 写文件并置 `0600`。
fn write_file_0600(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(bytes)
        })?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// SQL 单引号转义（路径含 `'` 时防注入）。
fn sql_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// 快照统计：working/episodic 行数 + 最新 cwd（表缺失 ⇒ 零/None）。
pub(crate) fn snapshot_stats(conn: &Connection) -> (u64, u64, Option<String>) {
    let count = |table: &str| -> u64 {
        if !table_schema(conn, table).exists {
            return 0;
        }
        conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
    };
    let working = count("working_memory");
    let episodic = count("episodic_memory");
    // 最新 cwd：两表按 timestamp 倒序扫前 200 条元数据。
    let mut cwd = None;
    for table in ["working_memory", "episodic_memory"] {
        let schema = table_schema(conn, table);
        if !schema.has("timestamp") || !schema.has("metadata_json") {
            continue;
        }
        let sql =
            format!("SELECT metadata_json FROM \"{table}\" ORDER BY timestamp DESC LIMIT 200");
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let Ok(rows) = stmt.query_map([], |row| row.get::<_, Option<String>>(0)) else {
            continue;
        };
        cwd = rows
            .flatten()
            .find_map(|m| super::metadata_field(m.as_deref(), "cwd"));
        if cwd.is_some() {
            break;
        }
    }
    (working, episodic, cwd)
}

/// 选空闲备份目录名（同秒冲突则秒数递增，最多 120 次）。
pub(crate) fn pick_dirname(bank_dir: &Path, kind: MemoryBackupKind) -> Result<String, AppError> {
    let mut moment = chrono::Utc::now();
    for _ in 0..120 {
        let dirname = format!("{}-{}", moment.format("%Y%m%dT%H%M%SZ"), kind_suffix(kind));
        if std::fs::symlink_metadata(bank_dir.join(&dirname)).is_err() {
            return Ok(dirname);
        }
        moment += chrono::Duration::seconds(1);
    }
    Err(io("备份失败：无法分配备份目录名"))
}

/// 写 manifest（`0600`）。
pub(crate) fn write_manifest(
    dir: &Path,
    bank: &str,
    kind: MemoryBackupKind,
    dirname: &str,
    cwd: Option<String>,
    working: u64,
    episodic: u64,
) -> Result<(), AppError> {
    let manifest = Manifest {
        bank: bank.to_owned(),
        kind,
        created_at: dirname_to_iso(dirname),
        cwd,
        working,
        episodic,
        source_bank_dir_name: bank.to_owned(),
    };
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| io("备份失败：无法序列化备份清单"))?;
    write_file_0600(&dir.join(MANIFEST_FILENAME), &bytes)
        .map_err(|e| io(format!("备份失败：无法写入备份清单：{e}")))
}

/// 快照落盘（建目录 → `VACUUM INTO` → 统计 + manifest）；失败由调用方清目录。
fn snapshot_into(
    dir: &Path,
    bank_dir: &Path,
    bank: &str,
    kind: MemoryBackupKind,
    dirname: &str,
) -> Result<(), AppError> {
    let fail = |msg: String| io(msg);
    ensure_dir_0700(dir).map_err(|e| fail(format!("备份失败：无法创建备份目录：{e}")))?;
    let target = dir.join(BACKUP_DB_FILENAME);
    // 源库只读打开（`VACUUM INTO` 在只读连接上可跑，WAL 数据一致并入）。
    let conn = super::open_readonly(&bank_dir.join(super::DB_FILENAME))
        .ok_or_else(|| fail("备份失败：无法打开源数据库".to_owned()))?;
    conn.execute_batch(&format!("VACUUM INTO {}", sql_quote(&target)))
        .map_err(|e| fail(format!("备份失败：数据库快照失败：{e}")))?;
    drop(conn);
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| fail(format!("备份失败：无法设置快照权限：{e}")))?;
    // 统计取自快照本身（与恢复内容一致）。
    let stats = open_readonly(&target);
    let (working, episodic, cwd) = stats.as_ref().map(snapshot_stats).unwrap_or((0, 0, None));
    drop(stats);
    write_manifest(dir, bank, kind, dirname, cwd, working, episodic)
}

/// 建快照备份。任何失败 ⇒ 清理已建目录并报 `IO`（原库不动）。
pub(crate) fn create_snapshot_backup(
    backup_root: &Path,
    bank_dir: &Path,
    bank: &str,
    kind: MemoryBackupKind,
) -> Result<BackupRef, AppError> {
    let bank_backup_dir = backup_root.join(bank);
    ensure_dir_0700(&bank_backup_dir)
        .map_err(|e| io(format!("备份失败：无法创建备份目录：{e}")))?;
    let dirname = pick_dirname(&bank_backup_dir, kind)?;
    let dir = bank_backup_dir.join(&dirname);
    if let Err(e) = snapshot_into(&dir, bank_dir, bank, kind, &dirname) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(BackupRef {
        bank: bank.to_owned(),
        dirname,
        kind,
        dir: dir.canonicalize().unwrap_or(dir),
    })
}

/// manifest 可解析 ⇒ 有效备份。
fn has_manifest(dir: &Path) -> bool {
    std::fs::read(dir.join(MANIFEST_FILENAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
        .is_some()
}

/// 修剪：同 bank 同 kind 只留最新 [`BACKUP_KEEP`] 个（按目录名倒序）。
/// 只对有效备份计数与删除；`bank-removed` 由调用方排除（永不剪）。
pub(crate) fn prune_backups(backup_root: &Path, bank: &str, kind: MemoryBackupKind) {
    let bank_dir = backup_root.join(bank);
    let Ok(entries) = std::fs::read_dir(&bank_dir) else {
        return;
    };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter(|e| {
            e.file_type()
                .map(|t| t.is_dir() || t.is_symlink())
                .unwrap_or(false)
        })
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|name| parse_dirname(name) == Some(kind) && has_manifest(&bank_dir.join(name)))
        .collect();
    dirs.sort();
    dirs.reverse();
    for extra in dirs.into_iter().skip(BACKUP_KEEP) {
        // 形状已校验：复用 resolve 再删（防穿越双保险）。
        if let Ok(reference) = resolve_backup_id(backup_root, &format!("{bank}@{extra}")) {
            let _ = std::fs::remove_dir_all(&reference.dir);
        }
    }
}

/// 永久删除一个备份（仅备份区内路径）。
pub(crate) fn delete_backup_dir(backup_root: &Path, backup_id: &str) -> Result<(), AppError> {
    let reference = resolve_backup_id(backup_root, backup_id)?;
    std::fs::remove_dir_all(&reference.dir).map_err(|e| io(format!("删除备份失败：{e}")))
}

/// 取备份条目展示。manifest 缺失（异常）⇒ 计数为 null，不伪造数字。
pub(crate) fn describe_ref(reference: &BackupRef) -> MemoryBackup {
    describe_backup(&reference.bank, &reference.dirname, &reference.dir).unwrap_or(MemoryBackup {
        id: format!("{}@{}", reference.bank, reference.dirname),
        bank: reference.bank.clone(),
        kind: reference.kind,
        created_at: dirname_to_iso(&reference.dirname),
        bytes: dir_bytes(&reference.dir),
        working: None,
        episodic: None,
        cwd: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ErrorCode;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("memory-backups");
        (tmp, root)
    }

    #[test]
    fn dirname_shape_strict() {
        assert_eq!(
            parse_dirname("20261020T120000Z-before-delete"),
            Some(MemoryBackupKind::BeforeDelete)
        );
        assert_eq!(
            parse_dirname("20261020T120000Z-bank-removed"),
            Some(MemoryBackupKind::BankRemoved)
        );
        // 分隔符/长度/大小写/多字节/路径 任一不符即拒（防切分 panic 与穿越）。
        for bad in [
            "",
            "20261020T120000Z",
            "20261020T120000Z-",
            "20261020T120000Z-evil",
            "20261020T120000Z before-delete",
            "20261020T120000Z_before-delete",
            "20261020T120000Z-BEFORE-DELETE",
            "2026102T120000Z-before-delete",
            "20261020T1200000Z-before-delete",
            "20261020T12é000Z-before-delete",
            "20261020T120000Z-before-delete/..",
        ] {
            assert_eq!(parse_dirname(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn backup_id_splits_at_last_at_and_rejects_traversal() {
        let (_tmp, root) = root();
        // bank 含 @：按最后 @ 切分仍可解析（不存在 ⇒ NOT_FOUND）。
        let err = resolve_backup_id(&root, "a@b@20261020T120000Z-before-delete").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        for bad in [
            "no-at-sign",
            "@20261020T120000Z-before-delete",
            "bank@",
            "../x@20261020T120000Z-before-delete",
            "a/b@20261020T120000Z-before-delete",
            "..@20261020T120000Z-before-delete",
            "bank@20261020T120000Z-evil",
            "bank@20261020T120000Z-before-delete/../x",
        ] {
            let err = resolve_backup_id(&root, bad).unwrap_err();
            assert_eq!(err.code, ErrorCode::OutsideRoot, "{bad:?}");
        }
        // 备份根不存在 ⇒ NOT_FOUND（非 panic）。
        let err = resolve_backup_id(&root, "b@20261020T120000Z-before-delete").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    #[cfg(unix)]
    fn resolve_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("memory-backups");
        std::fs::create_dir_all(root.join("b")).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(
            &outside,
            root.join("b").join("20261020T120000Z-before-delete"),
        )
        .unwrap();
        let err = resolve_backup_id(&root, "b@20261020T120000Z-before-delete").unwrap_err();
        assert_eq!(err.code, ErrorCode::OutsideRoot);
    }

    #[test]
    fn snapshot_backup_round_trip_with_perms() {
        let tmp = tempfile::tempdir().unwrap();
        let bank_dir = tmp.path().join("banks").join("b-1");
        std::fs::create_dir_all(&bank_dir).unwrap();
        let conn = Connection::open(bank_dir.join("mnemopi.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, timestamp TEXT, metadata_json TEXT); \
             INSERT INTO working_memory VALUES ('w1', 'x', '2026-10-10T10:00:00.000Z', '{\"cwd\":\"/p\"}');",
        )
        .unwrap();
        drop(conn);
        let root = tmp.path().join("memory-backups");
        let reference =
            create_snapshot_backup(&root, &bank_dir, "b-1", MemoryBackupKind::BeforeDelete)
                .unwrap();
        assert!(reference.dir.join("mnemopi.db").is_file());
        assert!(reference.dir.join("manifest.json").is_file());
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&reference.dir), 0o700);
        assert_eq!(mode(&reference.dir.join("mnemopi.db")), 0o600);
        assert_eq!(mode(&reference.dir.join("manifest.json")), 0o600);
        let item = describe_ref(&reference);
        assert_eq!(item.bank, "b-1");
        assert_eq!(item.kind, MemoryBackupKind::BeforeDelete);
        assert_eq!(item.working, Some(1));
        assert_eq!(item.episodic, Some(0));
        assert_eq!(item.cwd.as_deref(), Some("/p"));
        assert!(item.bytes > 0);
        assert!(item.created_at.ends_with('Z'));
        let snap = open_readonly(&reference.dir.join("mnemopi.db")).unwrap();
        let n: i64 = snap
            .query_row("SELECT COUNT(*) FROM working_memory", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    /// 写一个合法 manifest（形状与生产一致）。
    fn write_manifest_for(dir: &Path, bank: &str, kind: MemoryBackupKind, stamp: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let bytes = format!(
            r#"{{"bank":"{bank}","kind":"{}","createdAt":"{}","cwd":null,"working":1,"episodic":0,"sourceBankDirName":"{bank}"}}"#,
            kind_suffix(kind),
            dirname_to_iso(stamp)
        );
        std::fs::write(dir.join(MANIFEST_FILENAME), bytes).unwrap();
    }

    #[test]
    fn list_sorted_newest_first_and_prune_keeps_five() {
        let (_tmp, root) = root();
        let bank_dir = root.join("b-1");
        for i in 0..7 {
            let dirname = format!("2026102{i}T120000Z-before-delete");
            write_manifest_for(
                &bank_dir.join(&dirname),
                "b-1",
                MemoryBackupKind::BeforeDelete,
                &dirname,
            );
        }
        write_manifest_for(
            &bank_dir.join("20261029T120000Z-bank-removed"),
            "b-1",
            MemoryBackupKind::BankRemoved,
            "20261029T120000Z",
        );
        // 崩溃残留：无 manifest ⇒ 不列出、不占名额、不被删。
        let orphan = bank_dir.join("20261028T120000Z-before-delete");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("mnemopi.db"), b"partial").unwrap();
        std::fs::write(bank_dir.join("junk.txt"), b"x").unwrap();

        let items = list_backups(&root, Some("b-1"));
        assert_eq!(items.len(), 8);
        assert!(items[0].id.ends_with("bank-removed"));
        assert!(items.iter().all(|b| b.working.is_some()));
        assert!(!items.iter().any(|b| b.id.contains("20261028T120000Z")));

        prune_backups(&root, "b-1", MemoryBackupKind::BeforeDelete);
        let items = list_backups(&root, Some("b-1"));
        assert_eq!(items.len(), 6);
        assert!(orphan.is_dir());
        prune_backups(&root, "b-1", MemoryBackupKind::BankRemoved);
        assert_eq!(list_backups(&root, Some("b-1")).len(), 6);
    }
}
