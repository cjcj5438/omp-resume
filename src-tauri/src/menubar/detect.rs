//! T0/T1 检测：flock 全量探测 + 会话 id→路径索引。
//!
//! - T0 每轮都跑：遍历锁目录，flock 非阻塞探测（361 锁约 5ms，见 §17 实测）；
//! - 索引只在 inUse 集合变化（或每 10 轮）时重建：文件名 `<ts>_<id>.jsonl`
//!   尾段即会话 id，无需读文件；T2 读头时会用 header.id 复核。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// T0：探测全部锁，返回被持有的会话 id 集合。
/// 锁目录不可读 → Err（调用方跳过本轮、保留旧菜单）。
pub fn scan_inuse(owners_dir: &Path) -> std::io::Result<HashSet<String>> {
    let mut inuse = HashSet::new();
    for entry in std::fs::read_dir(owners_dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.ends_with(".lock") {
            continue;
        }
        let id = name.trim_end_matches(".lock");
        // 非法 id 的 probe 直接返回 UNKNOWN，不会误报占用。
        if crate::lock::probe(owners_dir, id).in_use {
            inuse.insert(id.to_string());
        }
    }
    Ok(inuse)
}

/// 从顶层文件名提取会话 id：`<ts>_<id>.jsonl` → `<id>`。
pub fn id_from_filename(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let stem = name.strip_suffix(".jsonl")?;
    let id = stem.rsplit('_').next()?;
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// 重建 id → 路径索引（只扫顶层，复用 `scan_top_level` 的忽略规则）。
/// 扫描失败 → Err（调用方保留旧索引）。
pub fn build_index(
    sessions_dir: &Path,
) -> Result<HashMap<String, PathBuf>, crate::model::AppError> {
    let (_root, files) = crate::sessions::list::scan_top_level(sessions_dir)?;
    let mut index = HashMap::with_capacity(files.len());
    for (_dir, path) in files {
        if let Some(id) = id_from_filename(&path) {
            index.insert(id, path);
        }
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_id_shapes() {
        assert_eq!(
            id_from_filename(Path::new(
                "/s/d/2026-10-16T12-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl"
            )),
            Some("01234567-89ab-cdef-0123-456789abcdef".to_string())
        );
        assert_eq!(id_from_filename(Path::new("/s/d/_.jsonl")), None);
        assert_eq!(
            id_from_filename(Path::new("/s/d/nounderscore.jsonl")),
            Some("nounderscore".to_string())
        );
        assert_eq!(id_from_filename(Path::new("/s/d/x.bak")), None);
    }

    #[test]
    fn scan_inuse_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let set = scan_inuse(dir.path()).unwrap();
        assert!(set.is_empty());
        // 缺失目录 → Err。
        assert!(scan_inuse(&dir.path().join("nope")).is_err());
    }

    #[test]
    fn scan_inuse_holds_and_releases() {
        use std::os::unix::io::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("aaa.lock"), "").unwrap();
        std::fs::write(dir.path().join("bbb.lock"), "").unwrap();
        std::fs::write(dir.path().join(".hidden.lock"), "").unwrap();
        std::fs::write(dir.path().join("note.txt"), "").unwrap();
        // 持有 bbb。
        let held = std::fs::OpenOptions::new()
            .read(true)
            .open(dir.path().join("bbb.lock"))
            .unwrap();
        unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        let set = scan_inuse(dir.path()).unwrap();
        assert_eq!(set, HashSet::from(["bbb".to_string()]));
    }

    #[test]
    fn build_index_top_level_only() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("proj");
        std::fs::create_dir(&proj).unwrap();
        std::fs::write(proj.join("2026-10-16T00-00-00-000Z_abc123.jsonl"), "{}\n").unwrap();
        std::fs::write(proj.join(".hidden.jsonl"), "{}\n").unwrap();
        let nested = proj.join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("2026-10-16T00-00-00-000Z_def456.jsonl"), "{}\n").unwrap();
        let index = build_index(dir.path()).unwrap();
        assert_eq!(index.len(), 1);
        assert!(index.contains_key("abc123"));
    }
}
