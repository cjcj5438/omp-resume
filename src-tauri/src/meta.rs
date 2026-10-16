//! 会话别名 / 标签 / 备注（应用侧 `meta.json`，绝不写会话文件）。
//!
//! 存储：`$HOME/Library/Application Support/omp-resume/meta.json`
//! （`OMP_RESUME_DATA_DIR` 可覆盖目录，供测试/开发）。
//! 格式：`{"version":1,"revision":N,"sessions":{"<id>":{alias,tags,note,updatedAt}}}`。
//! 以会话 id 为键；文件不存在 = revision 0、空 sessions。
//!
//! 并发：写入（set/删除联动清理）经进程级静态互斥串行，读-改-写全程持锁；
//! 读不加锁（原子 rename 保证读到完整的新旧其一）。revision 冲突保护 +
//! 临时文件 + 原子 rename + 新文件 0600 的写法复用 `mcp_config` 的思路。
//! 之所以用静态锁而非 Tauri managed state，是因为删除成功路径
//! （`ops::commands::delete_one`，无 Tauri 上下文）也要联动清理条目，
//! 静态锁让两条路径共享同一把锁且不改删除命令签名。

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions, Permissions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::model::{AppError, AppResult, ErrorCode, MetaSnapshot, SessionMeta, SessionMetaInput};

/// meta.json 的 schema 版本；不兼容的 version 拒绝读写（`META_CORRUPT`）。
pub const META_VERSION: u32 = 1;
/// 别名上限（trim 后字符数）。
pub const ALIAS_MAX_CHARS: usize = 80;
/// 单个标签上限（trim 后字符数）。
pub const TAG_MAX_CHARS: usize = 24;
/// 每个会话的标签个数上限。
pub const TAGS_MAX_COUNT: usize = 10;
/// 备注上限（trim 后字符数）。
pub const NOTE_MAX_CHARS: usize = 2000;
/// 会话 id 上限（字符数；omp 的 uuid 远小于此，仅防垃圾键）。
const SESSION_ID_MAX_CHARS: usize = 256;

/// 覆盖数据目录的环境变量（测试/开发用）。
pub const DATA_DIR_ENV: &str = "OMP_RESUME_DATA_DIR";

/// 进程级写锁：覆盖重读、revision 比对、修改与原子写入。
static META_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 磁盘文件形状（与 `MetaSnapshot` 相比多一个 `version`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MetaFile {
    version: u32,
    revision: u64,
    #[serde(default)]
    sessions: BTreeMap<String, SessionMeta>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn io(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Io, message)
}

fn conflict() -> AppError {
    AppError::new(ErrorCode::Conflict, "备注已被外部修改，请重新载入后重试")
}

fn corrupt(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::MetaCorrupt, message)
}

fn lock_poisoned() -> AppError {
    io("备注写入锁不可用")
}

fn join_error(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("后台任务失败：{e}"))
}

/// 解析数据目录：`OMP_RESUME_DATA_DIR`（非空即用）>
/// `$HOME/Library/Application Support/omp-resume`。
pub fn data_dir() -> AppResult<PathBuf> {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV)
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty())
    {
        return Ok(dir);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .map(|home| home.join("Library/Application Support/omp-resume"))
        .ok_or_else(|| io("无法确定 HOME 目录"))
}

fn meta_path(data_dir: &Path) -> PathBuf {
    data_dir.join("meta.json")
}

fn read_bytes(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(format!("无法读取备注文件：{error}"))),
    }
}

/// 解析文件 bytes：JSON 非法或 version 不兼容都报 `META_CORRUPT`，
/// 调用方必须拒绝写入、绝不覆盖损坏文件。
fn parse_file(bytes: &[u8]) -> AppResult<MetaFile> {
    let file: MetaFile = serde_json::from_slice(bytes)
        .map_err(|_| corrupt("备注文件已损坏，请手动修复或删除后重试"))?;
    if file.version != META_VERSION {
        return Err(corrupt(format!(
            "备注文件版本（{}）不受支持，请更新应用后重试",
            file.version
        )));
    }
    Ok(file)
}

fn snapshot_of(file: Option<&MetaFile>) -> MetaSnapshot {
    match file {
        Some(file) => MetaSnapshot {
            revision: file.revision,
            sessions: file.sessions.clone(),
        },
        None => MetaSnapshot {
            revision: 0,
            sessions: BTreeMap::new(),
        },
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn normalize_alias(alias: Option<&str>) -> AppResult<Option<String>> {
    let trimmed = alias.map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = trimmed {
        if s.chars().count() > ALIAS_MAX_CHARS {
            return Err(invalid(format!("别名最多 {ALIAS_MAX_CHARS} 个字符")));
        }
        Ok(Some(s.to_owned()))
    } else {
        Ok(None)
    }
}

fn normalize_tags(tags: &[String]) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > TAG_MAX_CHARS {
            return Err(invalid(format!(
                "单个标签最多 {TAG_MAX_CHARS} 个字符：{trimmed}"
            )));
        }
        // 大小写不敏感去重，保留首次出现的原文。
        if seen.insert(trimmed.to_lowercase()) {
            out.push(trimmed.to_owned());
        }
    }
    if out.len() > TAGS_MAX_COUNT {
        return Err(invalid(format!("标签最多 {TAGS_MAX_COUNT} 个")));
    }
    Ok(out)
}

fn normalize_note(note: Option<&str>) -> AppResult<Option<String>> {
    let trimmed = note.map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = trimmed {
        if s.chars().count() > NOTE_MAX_CHARS {
            return Err(invalid(format!("备注最多 {NOTE_MAX_CHARS} 个字符")));
        }
        Ok(Some(s.to_owned()))
    } else {
        Ok(None)
    }
}

fn normalize_session_id(session_id: &str) -> AppResult<String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Err(invalid("会话 id 不能为空"));
    }
    if trimmed.chars().count() > SESSION_ID_MAX_CHARS {
        return Err(invalid("会话 id 过长"));
    }
    Ok(trimmed.to_owned())
}

struct PendingFile(PathBuf);

impl Drop for PendingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// 原子写入：同目录独占创建临时文件（0600）→ 写 → 同步 →
/// 复检 revision（收窄跨进程竞态窗口）→ rename。
/// `expected_revision` 为本次修改所基于的 revision；复检不一致报 `CONFLICT`。
fn atomic_write(data_dir: &Path, file: &MetaFile, expected_revision: u64) -> AppResult<()> {
    let path = meta_path(data_dir);
    fs::create_dir_all(data_dir).map_err(|error| io(format!("无法创建备注目录：{error}")))?;
    let existing_permissions = fs::metadata(&path).ok().map(|md| md.permissions());
    let mut bytes =
        serde_json::to_vec_pretty(file).map_err(|error| io(format!("无法序列化备注：{error}")))?;
    bytes.push(b'\n');
    let (mut tmp, pending) = loop {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = data_dir.join(format!(".meta.json.{}.{sequence}.tmp", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&candidate)
        {
            Ok(file) => break (file, PendingFile(candidate)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io(format!("无法创建备注临时文件：{error}"))),
        }
    };
    tmp.write_all(&bytes)
        .map_err(|error| io(format!("无法写入备注：{error}")))?;
    tmp.set_permissions(existing_permissions.unwrap_or_else(|| Permissions::from_mode(0o600)))
        .map_err(|error| io(format!("无法设置备注文件权限：{error}")))?;
    tmp.sync_all()
        .map_err(|error| io(format!("无法同步备注文件：{error}")))?;
    drop(tmp);
    // 最终复检：锁外（另一进程）发生的写入会导致 revision 变化，此时放弃覆盖。
    match read_bytes(&path)? {
        Some(current) => {
            let current = parse_file(&current)?;
            if current.revision != expected_revision {
                return Err(conflict());
            }
        }
        None if expected_revision == 0 => {}
        None => return Err(conflict()),
    }
    fs::rename(&pending.0, &path).map_err(|error| io(format!("无法原子替换备注文件：{error}")))?;
    // rename 后临时路径已不存在；正常释放也不留垃圾。
    std::mem::forget(pending);
    Ok(())
}

/// 读取全量快照。文件不存在 = revision 0 空快照；损坏/版本不兼容 =
/// `META_CORRUPT`。孤儿条目（会话已不存在）原样返回，绝不修剪。
pub fn get_meta_impl(data_dir: &Path) -> AppResult<MetaSnapshot> {
    match read_bytes(&meta_path(data_dir))? {
        Some(bytes) => Ok(snapshot_of(Some(&parse_file(&bytes)?))),
        None => Ok(snapshot_of(None)),
    }
}

/// 新增/替换/删除单个会话条目。`meta=None` 或 trim 后全空 = 删除条目；
/// 值与现有完全一致时不写文件、不 bump revision。成功返回完整新快照。
pub fn set_session_meta_impl(
    data_dir: &Path,
    session_id: &str,
    meta: Option<SessionMetaInput>,
    expected_revision: u64,
) -> AppResult<MetaSnapshot> {
    let _guard = META_LOCK.lock().map_err(|_| lock_poisoned())?;
    let session_id = normalize_session_id(session_id)?;
    // 校验先行：输入非法时连 revision 都不读，避免无意义报错掩盖输入问题。
    let normalized = match meta.as_ref() {
        Some(input) => {
            let alias = normalize_alias(input.alias.as_deref())?;
            let tags = normalize_tags(&input.tags)?;
            let note = normalize_note(input.note.as_deref())?;
            if alias.is_none() && tags.is_empty() && note.is_none() {
                None
            } else {
                Some((alias, tags, note))
            }
        }
        None => None,
    };

    let path = meta_path(data_dir);
    let current = match read_bytes(&path)? {
        Some(bytes) => parse_file(&bytes)?,
        None => MetaFile {
            version: META_VERSION,
            revision: 0,
            sessions: BTreeMap::new(),
        },
    };
    if current.revision != expected_revision {
        return Err(conflict());
    }

    let existing = current.sessions.get(&session_id);
    let changed = match (&normalized, existing) {
        (None, None) => false,
        (Some((alias, tags, note)), Some(cur)) => {
            cur.alias.as_ref() != alias.as_ref()
                || &cur.tags != tags
                || cur.note.as_ref() != note.as_ref()
        }
        _ => true,
    };
    if !changed {
        return Ok(snapshot_of(Some(&current)));
    }

    let mut next = current.clone();
    match normalized {
        Some((alias, tags, note)) => {
            next.sessions.insert(
                session_id,
                SessionMeta {
                    alias,
                    tags,
                    note,
                    updated_at: now_iso(),
                },
            );
        }
        None => {
            next.sessions.remove(&session_id);
        }
    }
    next.revision += 1;
    atomic_write(data_dir, &next, current.revision)?;
    Ok(snapshot_of(Some(&next)))
}

/// 删除成功后联动清理该会话条目（best-effort：任何失败都静默忽略，
/// 绝不影响删除结果；损坏文件不碰）。
pub fn prune_session_after_delete(session_id: &str) {
    let Ok(dir) = data_dir() else {
        return;
    };
    let _ = prune_session_in_dir(&dir, session_id);
}

fn prune_session_in_dir(data_dir: &Path, session_id: &str) -> AppResult<bool> {
    let _guard = META_LOCK.lock().map_err(|_| lock_poisoned())?;
    let Some(bytes) = read_bytes(&meta_path(data_dir))? else {
        return Ok(false);
    };
    // 损坏/版本不兼容：拒绝改写，调用方（删除路径）静默忽略。
    let current = parse_file(&bytes)?;
    if !current.sessions.contains_key(session_id) {
        return Ok(false);
    }
    let mut next = current.clone();
    next.sessions.remove(session_id);
    next.revision += 1;
    atomic_write(data_dir, &next, current.revision)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Tauri 命令（阻塞文件 IO 在后台线程；`set` 经静态锁串行读-改-写）
// ---------------------------------------------------------------------------

/// 返回全量快照（文件不存在 = revision 0 空快照）。
#[tauri::command]
pub async fn get_meta() -> AppResult<MetaSnapshot> {
    tauri::async_runtime::spawn_blocking(|| get_meta_impl(&data_dir()?))
        .await
        .map_err(join_error)?
}

/// 设置单个会话条目并返回完整新快照。
#[tauri::command]
pub async fn set_session_meta(
    session_id: String,
    meta: Option<SessionMetaInput>,
    expected_revision: u64,
) -> AppResult<MetaSnapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        set_session_meta_impl(&data_dir()?, &session_id, meta, expected_revision)
    })
    .await
    .map_err(join_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn read_raw(dir: &Path) -> Vec<u8> {
        fs::read(meta_path(dir)).unwrap()
    }

    fn input(alias: Option<&str>, tags: &[&str], note: Option<&str>) -> SessionMetaInput {
        SessionMetaInput {
            alias: alias.map(str::to_owned),
            tags: tags.iter().map(|s| (*s).to_owned()).collect(),
            note: note.map(str::to_owned),
        }
    }

    #[test]
    fn missing_file_is_empty_snapshot_at_revision_zero() {
        let dir = tempdir().unwrap();
        let snap = get_meta_impl(dir.path()).unwrap();
        assert_eq!(snap.revision, 0);
        assert!(snap.sessions.is_empty());
    }

    #[test]
    fn roundtrip_sets_gets_and_bumps_revision() {
        let dir = tempdir().unwrap();
        let snap = set_session_meta_impl(
            dir.path(),
            "s1",
            Some(input(
                Some("  别名  "),
                &["bug", " Bug ", ""],
                Some(" 备注 "),
            )),
            0,
        )
        .unwrap();
        assert_eq!(snap.revision, 1);
        let entry = &snap.sessions["s1"];
        assert_eq!(entry.alias.as_deref(), Some("别名"));
        assert_eq!(entry.tags, vec!["bug".to_owned()]);
        assert_eq!(entry.note.as_deref(), Some("备注"));
        assert!(!entry.updated_at.is_empty());

        let got = get_meta_impl(dir.path()).unwrap();
        assert_eq!(got, snap);
    }

    #[test]
    fn stale_revision_conflicts_and_leaves_file_untouched() {
        let dir = tempdir().unwrap();
        set_session_meta_impl(dir.path(), "s1", Some(input(Some("a"), &[], None)), 0).unwrap();
        let before = read_raw(dir.path());
        let err = set_session_meta_impl(dir.path(), "s1", Some(input(Some("b"), &[], None)), 0)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(read_raw(dir.path()), before);
    }

    #[test]
    fn corrupt_file_is_never_overwritten() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(meta_path(dir.path()), b"{not json}").unwrap();

        let err = get_meta_impl(dir.path()).unwrap_err();
        assert_eq!(err.code, ErrorCode::MetaCorrupt);
        let err = set_session_meta_impl(dir.path(), "s1", Some(input(Some("a"), &[], None)), 0)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::MetaCorrupt);
        assert_eq!(read_raw(dir.path()), b"{not json}");

        // 删除联动清理同样不碰损坏文件。
        assert!(prune_session_in_dir(dir.path(), "s1").is_err());
        assert_eq!(read_raw(dir.path()), b"{not json}");
    }

    #[test]
    fn unsupported_version_is_refused() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(
            meta_path(dir.path()),
            br#"{"version":99,"revision":5,"sessions":{}}"#,
        )
        .unwrap();
        assert_eq!(
            get_meta_impl(dir.path()).unwrap_err().code,
            ErrorCode::MetaCorrupt
        );
        assert_eq!(
            set_session_meta_impl(dir.path(), "s1", Some(input(Some("a"), &[], None)), 5)
                .unwrap_err()
                .code,
            ErrorCode::MetaCorrupt
        );
    }

    #[test]
    fn new_file_has_0600_permissions() {
        let dir = tempdir().unwrap();
        set_session_meta_impl(dir.path(), "s1", Some(input(Some("a"), &[], None)), 0).unwrap();
        let mode = fs::metadata(meta_path(dir.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn validation_boundaries() {
        let dir = tempdir().unwrap();
        // 别名 80 可 / 81 拒。
        let ok = "别".repeat(80);
        set_session_meta_impl(dir.path(), "s1", Some(input(Some(&ok), &[], None)), 0).unwrap();
        let bad = "别".repeat(81);
        assert_eq!(
            set_session_meta_impl(dir.path(), "s1", Some(input(Some(&bad), &[], None)), 1)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        // 标签：24 可 / 25 拒，11 个拒，大小写不敏感去重保首个，空标签丢弃。
        let t24 = "t".repeat(24);
        let snap = set_session_meta_impl(
            dir.path(),
            "s1",
            Some(input(None, &[" Bug ", "BUG", "", &t24], None)),
            1,
        )
        .unwrap();
        assert_eq!(snap.sessions["s1"].tags, vec!["Bug".to_owned(), t24]);
        let t25 = "t".repeat(25);
        assert_eq!(
            set_session_meta_impl(dir.path(), "s1", Some(input(None, &[&t25], None)), 2)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        let eleven: Vec<String> = (0..11).map(|i| format!("tag{i}")).collect();
        let eleven_refs: Vec<&str> = eleven.iter().map(String::as_str).collect();
        assert_eq!(
            set_session_meta_impl(dir.path(), "s1", Some(input(None, &eleven_refs, None)), 2)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        // 备注 2000 可 / 2001 拒。
        let n2000 = "n".repeat(2000);
        set_session_meta_impl(dir.path(), "s1", Some(input(None, &[], Some(&n2000))), 2).unwrap();
        let n2001 = "n".repeat(2001);
        assert_eq!(
            set_session_meta_impl(dir.path(), "s1", Some(input(None, &[], Some(&n2001))), 3)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        // 会话 id 为空拒。
        assert_eq!(
            set_session_meta_impl(dir.path(), "  ", Some(input(Some("a"), &[], None)), 3)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn all_empty_deletes_entry_and_noop_skips_write() {
        let dir = tempdir().unwrap();
        set_session_meta_impl(
            dir.path(),
            "s1",
            Some(input(Some("a"), &["t"], Some("n"))),
            0,
        )
        .unwrap();
        // 全空（空白 alias/note + 空 tags）= 删除条目，revision 照样 +1。
        let snap =
            set_session_meta_impl(dir.path(), "s1", Some(input(Some("  "), &[], Some(""))), 1)
                .unwrap();
        assert_eq!(snap.revision, 2);
        assert!(!snap.sessions.contains_key("s1"));
        // null 同样删除（此处条目已不在 = 无操作，不 bump）。
        let snap2 = set_session_meta_impl(dir.path(), "s1", None, 2).unwrap();
        assert_eq!(snap2.revision, 2);
        // 值完全一致 = 无操作：revision 不变、文件 bytes 不变。
        set_session_meta_impl(dir.path(), "s2", Some(input(Some("a"), &[], None)), 2).unwrap();
        let before = read_raw(dir.path());
        let snap3 =
            set_session_meta_impl(dir.path(), "s2", Some(input(Some("a"), &[], None)), 3).unwrap();
        assert_eq!(snap3.revision, 3);
        assert_eq!(read_raw(dir.path()), before);
    }

    #[test]
    fn orphan_entries_are_kept_on_read() {
        let dir = tempdir().unwrap();
        set_session_meta_impl(dir.path(), "ghost-id", Some(input(Some("a"), &[], None)), 0)
            .unwrap();
        // 读取不修剪：会话早已不存在，条目仍在。
        let got = get_meta_impl(dir.path()).unwrap();
        assert!(got.sessions.contains_key("ghost-id"));
    }

    #[test]
    fn prune_removes_entry_and_ignores_missing() {
        let dir = tempdir().unwrap();
        set_session_meta_impl(dir.path(), "s1", Some(input(Some("a"), &[], None)), 0).unwrap();
        assert!(prune_session_in_dir(dir.path(), "s1").unwrap());
        let got = get_meta_impl(dir.path()).unwrap();
        assert_eq!(got.revision, 2);
        assert!(got.sessions.is_empty());
        // 条目不存在 = 无操作，不 bump。
        assert!(!prune_session_in_dir(dir.path(), "s1").unwrap());
        assert_eq!(get_meta_impl(dir.path()).unwrap().revision, 2);
    }

    #[test]
    fn data_dir_override_env_is_honored() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("custom");
        std::env::set_var(DATA_DIR_ENV, &target);
        let resolved = data_dir().unwrap();
        std::env::remove_var(DATA_DIR_ENV);
        assert_eq!(resolved, target);
    }

    /// 删除成功联动清条目、清理失败不影响删除（端到端走真实删除路径）。
    #[test]
    fn delete_success_prunes_meta_and_prune_failure_keeps_delete_ok() {
        use crate::config::Config;

        let root = tempdir().unwrap();
        let sessions_dir = root.path().join("sessions");
        let owners_dir = root.path().join("owners");
        let meta_dir = root.path().join("meta");
        fs::create_dir_all(owners_dir.clone()).unwrap();
        let proj = sessions_dir.join("-proj");
        fs::create_dir_all(&proj).unwrap();
        let cfg = Config {
            sessions_dir: sessions_dir.clone(),
            owners_dir,
        };

        // 会话一：正常 meta，删除后条目应被联动清除。
        let id1 = "01a13834-80db-70cb-83b5-2f528fc1d96c";
        let p1 = proj.join(format!("2026-10-14T02-18-47-387Z_{id1}.jsonl"));
        fs::write(
            &p1,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{id1}\",\"timestamp\":\"2026-10-14T02:18:47.387Z\",\"cwd\":\"/tmp\"}}\n"
            ),
        )
        .unwrap();
        set_session_meta_impl(&meta_dir, id1, Some(input(Some("a"), &[], None)), 0).unwrap();

        std::env::set_var(DATA_DIR_ENV, &meta_dir);
        let results =
            crate::ops::commands::delete_sessions_impl(&cfg, &[p1.to_string_lossy().into_owned()]);
        assert!(results[0].ok, "{:?}", results[0].error);
        assert!(!get_meta_impl(&meta_dir).unwrap().sessions.contains_key(id1));

        // 会话二：meta 文件损坏，删除照样成功、损坏文件原样保留。
        let id2 = "01a13834-80db-70cb-83b5-2f528fc1d96d";
        let p2 = proj.join(format!("2026-10-14T02-18-47-388Z_{id2}.jsonl"));
        fs::write(
            &p2,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{id2}\",\"timestamp\":\"2026-10-14T02:18:47.388Z\",\"cwd\":\"/tmp\"}}\n"
            ),
        )
        .unwrap();
        fs::write(meta_path(&meta_dir), b"{broken").unwrap();
        let results =
            crate::ops::commands::delete_sessions_impl(&cfg, &[p2.to_string_lossy().into_owned()]);
        std::env::remove_var(DATA_DIR_ENV);
        assert!(results[0].ok, "{:?}", results[0].error);
        assert_eq!(fs::read(meta_path(&meta_dir)).unwrap(), b"{broken");
    }
}
