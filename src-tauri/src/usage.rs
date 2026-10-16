//! 只读用量统计：流式最小字段解析、fork 链归属与进程内逐文件缓存。
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use serde::Deserialize;

use crate::config::{validate_session_path, Config};
use crate::model::{
    AppError, AppResult, ErrorCode, SessionUsage, UsageDay, UsageModel, UsageProject, UsageStats,
    UsageTokens,
};

#[derive(Default)]
pub struct UsageCache(Mutex<HashMap<PathBuf, CachedFile>>);

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    modified: SystemTime,
    size: u64,
    // ctime 捕捉同尺寸替换与被恢复的 mtime；inode 捕捉原子替换。
    changed: (i64, i64),
    inode: u64,
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

struct CachedFile {
    stamp: Stamp,
    data: Arc<ParsedFile>,
}

#[derive(Default)]
struct ParsedFile {
    id: String,
    cwd: String,
    parent: Option<String>,
    version: Option<u32>,
    entries: Vec<Entry>,
    by_id: HashMap<String, Vec<usize>>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    User,
    Assistant,
    Background,
}

#[derive(PartialEq)]
struct Entry {
    id: Option<String>,
    parent: Option<String>,
    timestamp: Option<i64>,
    kind: Kind,
    provider: String,
    model: String,
    tokens: UsageTokens,
    cost: f64,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    parent_id: Option<String>,
    timestamp: Option<Timestamp>,
    version: Option<u32>,
    cwd: String,
    parent_session: Option<String>,
    provider: String,
    model: String,
    usage: Option<RawUsage>,
    message: Option<Message>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Message {
    role: String,
    provider: String,
    model: String,
    usage: Option<RawUsage>,
    timestamp: Option<Timestamp>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Timestamp {
    Text(String),
    Millis(i64),
}

impl Timestamp {
    fn millis(&self) -> Option<i64> {
        match self {
            Self::Text(text) => DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|t| t.timestamp_millis()),
            Self::Millis(ms) => Utc
                .timestamp_millis_opt(*ms)
                .single()
                .map(|t| t.timestamp_millis()),
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawUsage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total_tokens: Option<u64>,
    cost: Option<RawCost>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawCost {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    total: Option<f64>,
}

fn io_error(err: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("读取用量失败：{err}"))
}

fn parse_file(path: &Path) -> AppResult<ParsedFile> {
    let mut parsed = ParsedFile::default();
    let mut reader = BufReader::new(File::open(path).map_err(io_error)?);
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).map_err(io_error)? == 0 {
            break;
        }
        let Ok(raw) = serde_json::from_slice::<Line>(&line) else {
            continue;
        };
        if raw.kind == "session" {
            parsed.id = raw.id.unwrap_or_default();
            parsed.cwd = raw.cwd;
            parsed.parent = raw.parent_session;
            parsed.version = raw.version;
            continue;
        }
        let (kind, provider, model, usage, timestamp) = match (raw.kind.as_str(), raw.message) {
            ("model_usage", _) => (Kind::Background, raw.provider, raw.model, raw.usage, None),
            ("message", Some(m)) if m.role == "user" || m.role == "assistant" => (
                if m.role == "user" {
                    Kind::User
                } else {
                    Kind::Assistant
                },
                m.provider,
                m.model,
                if m.role == "user" { None } else { m.usage },
                m.timestamp,
            ),
            _ => continue,
        };
        let usage = usage.unwrap_or_default();
        let total = usage.total_tokens.unwrap_or_else(|| {
            usage
                .input
                .saturating_add(usage.output)
                .saturating_add(usage.cache_read)
                .saturating_add(usage.cache_write)
        });
        let cost = usage.cost.unwrap_or_default();
        let cost = cost
            .total
            .unwrap_or(cost.input + cost.output + cost.cache_read + cost.cache_write);
        parsed.entries.push(Entry {
            id: raw.id,
            parent: raw.parent_id,
            timestamp: timestamp
                .as_ref()
                .and_then(Timestamp::millis)
                .or_else(|| raw.timestamp.as_ref().and_then(Timestamp::millis)),
            kind,
            provider,
            model,
            tokens: UsageTokens {
                input: usage.input,
                output: usage.output,
                cache_read: usage.cache_read,
                cache_write: usage.cache_write,
                total,
            },
            cost: if cost.is_finite() && cost >= 0.0 {
                cost
            } else {
                0.0
            },
        });
    }
    if parsed.version == Some(3) {
        for (i, entry) in parsed.entries.iter().enumerate() {
            if let Some(id) = &entry.id {
                parsed.by_id.entry(id.clone()).or_default().push(i);
            }
        }
    }
    Ok(parsed)
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

struct ScannedFile {
    path: PathBuf,
    owner: usize,
    data: Arc<ParsedFile>,
}

struct Library {
    files: Vec<ScannedFile>,
    top_count: usize,
    ancestors: Vec<Vec<usize>>,
}

fn is_jsonl(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "jsonl")
        && path
            .file_name()
            .is_some_and(|n| !n.to_string_lossy().starts_with('.'))
}

// 不跟随目录/文件软链接；每次递归重新枚举全部嵌套文件及 metadata，
// 因而嵌套增删、非最新文件追加均不会被目录级时间戳缓存漏掉。
fn nested_files(path: &Path, out: &mut Vec<PathBuf>) -> AppResult<()> {
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

fn scan(cfg: &Config, cache: &UsageCache) -> AppResult<Library> {
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
    fn inherited(&self, file: usize, entry: &Entry) -> bool {
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

fn add_tokens(to: &mut UsageTokens, from: &UsageTokens) {
    to.input += from.input;
    to.output += from.output;
    to.cache_read += from.cache_read;
    to.cache_write += from.cache_write;
    to.total += from.total;
}

fn add_usage(usage: &mut SessionUsage, entry: &Entry, nested: bool) {
    match entry.kind {
        Kind::User => usage.messages.user += 1,
        Kind::Assistant => usage.messages.assistant += 1,
        Kind::Background => {}
    }
    add_tokens(&mut usage.tokens, &entry.tokens);
    match entry.kind {
        Kind::Background => usage.cost.background += entry.cost,
        Kind::Assistant if nested => usage.cost.subagent += entry.cost,
        Kind::Assistant => usage.cost.main += entry.cost,
        Kind::User => {}
    }
    usage.cost.total = usage.cost.main + usage.cost.background + usage.cost.subagent;
}

fn add_model(models: &mut HashMap<(String, String), UsageModel>, entry: &Entry) {
    if entry.kind == Kind::User {
        return;
    }
    let model = models
        .entry((entry.provider.clone(), entry.model.clone()))
        .or_insert_with(|| UsageModel {
            provider: entry.provider.clone(),
            model: entry.model.clone(),
            ..UsageModel::default()
        });
    model.messages += 1;
    model.cost += entry.cost;
    add_tokens(&mut model.tokens, &entry.tokens);
}

fn sorted_models(models: HashMap<(String, String), UsageModel>) -> Vec<UsageModel> {
    let mut models: Vec<_> = models.into_values().collect();
    models.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then_with(|| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)))
    });
    models
}

pub fn session_usage(cfg: &Config, cache: &UsageCache, path: &str) -> AppResult<SessionUsage> {
    let path = validate_session_path(cfg, path)?;
    let library = scan(cfg, cache)?;
    let owner = library
        .files
        .iter()
        .take(library.top_count)
        .position(|f| f.path == path)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "会话文件不存在"))?;
    if library.files[owner].data.version != Some(3) {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            "该会话格式暂不支持用量统计",
        ));
    }
    let mut usage = SessionUsage::default();
    let mut models = HashMap::new();
    for (i, file) in library
        .files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.owner == owner && f.data.version == Some(3))
    {
        for entry in &file.data.entries {
            if library.inherited(i, entry) {
                continue;
            }
            add_usage(&mut usage, entry, i >= library.top_count);
            add_model(&mut models, entry);
        }
    }
    usage.models = sorted_models(models);
    Ok(usage)
}

pub fn usage_stats(
    cfg: &Config,
    cache: &UsageCache,
    since_days: Option<u32>,
) -> AppResult<UsageStats> {
    stats_at(cfg, cache, since_days, Utc::now(), &Local)
}

fn stats_at<Tz: TimeZone>(
    cfg: &Config,
    cache: &UsageCache,
    since_days: Option<u32>,
    now: DateTime<Utc>,
    timezone: &Tz,
) -> AppResult<UsageStats>
where
    Tz::Offset: std::fmt::Display,
{
    let cutoff = since_days.and_then(|d| now.checked_sub_signed(Duration::days(i64::from(d))));
    let library = scan(cfg, cache)?;
    let mut stats = UsageStats::default();
    let mut models = HashMap::new();
    let mut projects: HashMap<String, UsageProject> = HashMap::new();
    let mut days: HashMap<String, UsageDay> = HashMap::new();
    let mut sessions = HashSet::new();
    for (i, file) in library.files.iter().enumerate() {
        if file.data.version != Some(3) || library.files[file.owner].data.version != Some(3) {
            continue;
        }
        let cwd = &library.files[file.owner].data.cwd;
        for entry in &file.data.entries {
            let timestamp = entry
                .timestamp
                .and_then(|t| Utc.timestamp_millis_opt(t).single());
            if cutoff.is_some_and(|cutoff| timestamp.is_none_or(|t| t < cutoff))
                || library.inherited(i, entry)
            {
                continue;
            }
            add_usage(&mut stats.total, entry, i >= library.top_count);
            add_model(&mut models, entry);
            let project = projects.entry(cwd.clone()).or_insert_with(|| UsageProject {
                cwd: cwd.clone(),
                ..UsageProject::default()
            });
            project.cost += entry.cost;
            add_tokens(&mut project.tokens, &entry.tokens);
            if sessions.insert(file.owner) {
                project.sessions += 1;
            }
            if let Some(timestamp) = timestamp {
                let date = timestamp
                    .with_timezone(timezone)
                    .format("%Y-%m-%d")
                    .to_string();
                let day = days.entry(date.clone()).or_insert_with(|| UsageDay {
                    date,
                    ..UsageDay::default()
                });
                day.cost += entry.cost;
                add_tokens(&mut day.tokens, &entry.tokens);
            }
        }
    }
    stats.by_project = projects.into_values().collect();
    stats
        .by_project
        .sort_by(|a, b| b.cost.total_cmp(&a.cost).then_with(|| a.cwd.cmp(&b.cwd)));
    stats.by_model = sorted_models(models);
    stats.total.models = stats.by_model.clone();
    stats.by_day = days.into_values().collect();
    stats.by_day.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(stats)
}

#[tauri::command]
pub async fn get_session_usage(
    cfg: tauri::State<'_, Config>,
    cache: tauri::State<'_, Arc<UsageCache>>,
    path: String,
) -> AppResult<SessionUsage> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    tauri::async_runtime::spawn_blocking(move || session_usage(&cfg, &cache, &path))
        .await
        .map_err(io_error)?
}

#[tauri::command]
pub async fn get_usage_stats(
    cfg: tauri::State<'_, Config>,
    cache: tauri::State<'_, Arc<UsageCache>>,
    since_days: Option<u32>,
) -> AppResult<UsageStats> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    tauri::async_runtime::spawn_blocking(move || usage_stats(&cfg, &cache, since_days))
        .await
        .map_err(io_error)?
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
