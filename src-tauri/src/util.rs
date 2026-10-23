//! 共用小工具（CONTRACT §8）：安全临时目录、HOME、原子写、文本杂项。
//!
//! 收敛各模块的重复实现；调用方保留各自的建目录、symlink 策略与错误文案。

use std::fs::OpenOptions;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::model::{AppError, ErrorCode};

/// `<temp>/<prefix>-<pid>-<nanos>`，创建即 0700、非递归、遇同名重试；最后一段永不跟随 symlink（EEXIST）。
pub fn mk_secure_tempdir(prefix: &str) -> std::io::Result<PathBuf> {
    for _ in 0..100 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "临时目录重名冲突",
    ))
}

/// `$HOME`；缺失 → `/`（var_os，保留非 Unicode）。
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 缺失或相对路径 → Err(Io, "无法确定 HOME 目录")。
pub fn home_dir_strict() -> Result<PathBuf, AppError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .ok_or_else(|| AppError::new(ErrorCode::Io, "无法确定 HOME 目录"))
}

/// 原子写阶段（调用方据此映射各自的错误文案）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicStage {
    Create,
    Write,
    Chmod,
    Sync,
    Rename,
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 已写好并 fsync 的临时文件；Drop 时删除临时文件（未 commit）。
pub struct PendingAtomic {
    tmp_path: Option<PathBuf>,
}

impl Drop for PendingAtomic {
    fn drop(&mut self) {
        if let Some(path) = self.tmp_path.take() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

impl PendingAtomic {
    /// tmp = `{dest.parent}/.{tmp_prefix}.{pid}.{seq}.tmp`：create_new + 0600 → write → set_permissions(perms 或 0600) → sync_all。dest 无父目录 → Err((Create, InvalidInput))。不建目录。
    pub fn stage(
        dest: &Path,
        bytes: &[u8],
        tmp_prefix: &str,
        perms: Option<std::fs::Permissions>,
    ) -> Result<Self, (AtomicStage, std::io::Error)> {
        use std::io::Write;
        let parent = dest.parent().ok_or_else(|| {
            (
                AtomicStage::Create,
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "路径无效"),
            )
        })?;
        loop {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!(
                ".{tmp_prefix}.{}.{sequence}.tmp",
                std::process::id()
            ));
            let mut file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&candidate)
            {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err((AtomicStage::Create, e)),
            };
            if let Err(e) = file.write_all(bytes) {
                let _ = std::fs::remove_file(&candidate);
                return Err((AtomicStage::Write, e));
            }
            if let Err(e) = file
                .set_permissions(perms.unwrap_or_else(|| std::fs::Permissions::from_mode(0o600)))
            {
                let _ = std::fs::remove_file(&candidate);
                return Err((AtomicStage::Chmod, e));
            }
            if let Err(e) = file.sync_all() {
                let _ = std::fs::remove_file(&candidate);
                return Err((AtomicStage::Sync, e));
            }
            drop(file);
            return Ok(Self {
                tmp_path: Some(candidate),
            });
        }
    }

    /// rename(tmp → dest)；成功后不再删除。
    pub fn commit(mut self, dest: &Path) -> Result<(), (AtomicStage, std::io::Error)> {
        let tmp_path = self.tmp_path.take().expect("PendingAtomic 无临时文件");
        match std::fs::rename(&tmp_path, dest) {
            Ok(()) => {
                std::mem::forget(self);
                Ok(())
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_path);
                std::mem::forget(self);
                Err((AtomicStage::Rename, e))
            }
        }
    }
}

/// 合并输出中第一个以 `{` 开头的行及之后全部内容；没有 ⇒ `None`。
pub fn json_start(output: &str) -> Option<&str> {
    let mut index = 0;
    for segment in output.split_inclusive('\n') {
        if segment.starts_with('{') {
            return Some(&output[index..]);
        }
        index += segment.len();
    }
    None
}

/// YAML 标量：剥掉成对引号（双引号处理 `\\` `\"` `\n`，单引号处理 `''`）。
pub fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        let mut out = String::with_capacity(raw.len());
        let mut chars = raw[1..raw.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return out;
    }
    if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        return raw[1..raw.len() - 1].replace("''", "'");
    }
    raw.to_owned()
}

/// `LIKE` 转义（`%`/`_`/`\`），配合 `ESCAPE '\'`。
pub fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 用户输入 → `LIKE` 子串模式（两端加 `%`）。
pub fn like_pattern(query: &str) -> String {
    format!("%{}%", escape_like(query))
}

/// 在 ≤cap 的字符边界截断；仅截断时追加 suffix。返回 (文本, 是否截断)。
pub fn truncate_bytes(text: &str, cap: usize, suffix: &str) -> (String, bool) {
    if text.len() <= cap {
        return (text.to_owned(), false);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = text[..end].to_owned();
    out.push_str(suffix);
    (out, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mk_secure_tempdir_creates_0700_unique_dirs() {
        let a = mk_secure_tempdir("omp-resume-test").unwrap();
        let b = mk_secure_tempdir("omp-resume-test").unwrap();
        assert_ne!(a, b);
        for dir in [&a, &b] {
            let mode = std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{dir:?}");
        }
        std::fs::remove_dir_all(&a).unwrap();
        std::fs::remove_dir_all(&b).unwrap();
    }

    #[test]
    fn atomic_stage_drop_removes_tmp_and_commit_replaces() {
        let dir = mk_secure_tempdir("omp-resume-atomictest").unwrap();
        let dest = dir.join("data.json");
        std::fs::write(&dest, b"old").unwrap();

        // stage 后直接 drop：临时文件被删除，目标不变。
        let tmp_name = {
            let pending = PendingAtomic::stage(&dest, b"new", "data.json", None).unwrap();
            let name = pending.tmp_path.clone().unwrap();
            assert!(name.exists());
            name
        };
        assert!(!tmp_name.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");

        // stage + commit：目标被替换，不留临时文件。
        let pending = PendingAtomic::stage(&dest, b"new", "data.json", None).unwrap();
        let tmp_name = pending.tmp_path.clone().unwrap();
        pending.commit(&dest).unwrap();
        assert!(!tmp_name.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        // 同目录无残留 .tmp。
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".data.json."))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
