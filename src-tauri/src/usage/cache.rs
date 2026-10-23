//! 用量缓存与库扫描。
use std::collections::{HashMap, HashSet};
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::config::{validate_session_path, Config};
use crate::model::{AppError, AppResult, ErrorCode};

use super::{
    io_error,
    parse::{parse_file, Entry, ParsedFile},
};

#[derive(Default)]
pub struct UsageCache(pub(super) Mutex<HashMap<PathBuf, CachedFile>>);

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    pub(super) modified: SystemTime,
    pub(super) size: u64,
    // ctime 捕捉同尺寸替换与被恢复的 mtime；inode 捕捉原子替换。
    pub(super) changed: (i64, i64),
    pub(super) inode: u64,
}

impl Stamp {
    fn from(meta: &Metadata) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            modified: meta.modified()?,
            size: meta.len(),
            changed: (meta.ctime(), meta.ctime_nsec()),
            inode: meta.ino(),
        })
    }
}

pub(super) struct CachedFile {
    pub(super) stamp: Stamp,
    pub(super) data: Arc<ParsedFile>,
}

impl UsageCache {
    fn read(&self, path: &Path) -> AppResult<Arc<ParsedFile>> {
        // 读前、读后校验；读期间追加的结果不写缓存，下次必定重读。
        let before = Stamp::from(&fs::metadata(path).map_err(io_error)?).map_err(io_error)?;
        if let Some(hit) = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(path)
        {
            if hit.stamp == before {
                return Ok(Arc::clone(&hit.data));
            }
        }
        let data = Arc::new(parse_file(path)?);
        let after = Stamp::from(&fs::metadata(path).map_err(io_error)?).map_err(io_error)?;
        if before == after {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(
                    path.to_owned(),
                    CachedFile {
                        stamp: after,
                        data: Arc::clone(&data),
                    },
                );
        }
        Ok(data)
    }
}

pub(super) struct ScannedFile {
    pub(super) path: PathBuf,
    pub(super) owner: usize,
    pub(super) data: Arc<ParsedFile>,
}

pub(super) struct Library {
    pub(super) files: Vec<ScannedFile>,
    pub(super) top_count: usize,
    pub(super) ancestors: Vec<Vec<usize>>,
}

pub(super) fn is_jsonl(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "jsonl")
        && path
            .file_name()
            .is_some_and(|n| !n.to_string_lossy().starts_with('.'))
}

// 不跟随目录/文件软链接；每次递归重新枚举全部嵌套文件及 metadata，
// 因而嵌套增删、非最新文件追加均不会被目录级时间戳缓存漏掉。
pub(super) fn nested_files(path: &Path, out: &mut Vec<PathBuf>) -> AppResult<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(io_error(err)),
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let typ = entry.file_type().map_err(io_error)?;
        if entry.file_name().to_string_lossy().starts_with('.') || typ.is_symlink() {
            continue;
        }
        if typ.is_dir() {
            nested_files(&entry.path(), out)?;
        } else if typ.is_file() && is_jsonl(&entry.path()) {
            out.push(entry.path());
        }
    }
    Ok(())
}

pub(super) fn scan(cfg: &Config, cache: &UsageCache) -> AppResult<Library> {
    let root = cfg.sessions_dir.canonicalize().map_err(io_error)?;
    let mut tops = Vec::new();
    for dir in fs::read_dir(&root).map_err(io_error)? {
        let dir = dir.map_err(io_error)?;
        if !dir.file_type().map_err(io_error)?.is_dir()
            || dir.file_name().to_string_lossy().starts_with('.')
        {
            continue;
        }
        for entry in fs::read_dir(dir.path()).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if entry.file_type().map_err(io_error)?.is_file() && is_jsonl(&entry.path()) {
                tops.push(validate_session_path(cfg, &entry.path().to_string_lossy())?);
            }
        }
    }
    tops.sort();
    let top_count = tops.len();
    let mut paths: Vec<_> = tops
        .iter()
        .enumerate()
        .map(|(i, p)| (p.clone(), i))
        .collect();
    for (owner, top) in tops.iter().enumerate() {
        let mut nested = Vec::new();
        nested_files(&top.with_extension(""), &mut nested)?;
        nested.sort();
        for path in nested {
            let canonical = path.canonicalize().map_err(io_error)?;
            if !canonical.starts_with(&root) || !canonical.starts_with(top.with_extension("")) {
                return Err(AppError::new(
                    ErrorCode::OutsideRoot,
                    "子代理路径逃出会话目录",
                ));
            }
            paths.push((canonical, owner));
        }
    }
    let mut files = Vec::with_capacity(paths.len());
    for (path, owner) in paths {
        let data = cache.read(&path)?;
        files.push(ScannedFile { path, owner, data });
    }
    let mut ids: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut path_map = HashMap::new();
    for (i, file) in files.iter().enumerate() {
        if !file.data.id.is_empty() {
            ids.entry(&file.data.id).or_default().push(i);
        }
        path_map.insert(file.path.as_path(), i);
    }
    let parents: Vec<Option<usize>> = files
        .iter()
        .map(|file| {
            let raw = file.data.parent.as_deref()?;
            if let Some(matches) = ids.get(raw) {
                if matches.len() == 1 {
                    return Some(matches[0]);
                }
            }
            let p = Path::new(raw);
            let candidate = if p.is_absolute() {
                p.to_owned()
            } else {
                root.join(p)
            };
            // 只解析已扫描、仍存在的安全会话路径，绝不读任意 parentSession 文件。
            candidate
                .canonicalize()
                .ok()
                .and_then(|p| path_map.get(p.as_path()).copied())
        })
        .collect();
    let ancestors = (0..files.len())
        .map(|start| {
            let mut chain = Vec::new();
            let mut seen = HashSet::from([start]);
            let mut parent = parents[start];
            while let Some(i) = parent {
                // 血缘成环则无法确认最早来源，整条链不做去重。
                if !seen.insert(i) {
                    return Vec::new();
                }
                chain.push(i);
                parent = parents[i];
            }
            chain
        })
        .collect();
    let live: HashSet<_> = files.iter().map(|f| f.path.clone()).collect();
    cache
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|p, _| live.contains(p));
    Ok(Library {
        files,
        top_count,
        ancestors,
    })
}

impl Library {
    pub(super) fn inherited(&self, file: usize, entry: &Entry) -> bool {
        let Some(id) = entry.id.as_deref() else {
            return false;
        };
        // 无时间无法确认来源；同 id 不足以证明是复制，按自身计。
        if entry.timestamp.is_none() {
            return false;
        }
        for &i in &self.ancestors[file] {
            if self.files[i].data.by_id.get(id).is_some_and(|indices| {
                indices
                    .iter()
                    .any(|&j| &self.files[i].data.entries[j] == entry)
            }) {
                return true;
            }
        }
        false
    }
}
