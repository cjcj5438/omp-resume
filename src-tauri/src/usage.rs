//! 只读用量统计：流式最小字段解析、fork 链归属与进程内逐文件缓存。
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use chrono::{DateTime, Duration, Local, TimeZone, Timelike, Utc};
use serde::Deserialize;

use crate::config::{validate_session_path, Config};
use crate::model::{
    AppError, AppResult, CacheByModel, ErrorCode, ErrorKind, ErrorKindCount, ErrorRecent,
    FallbackRecent, FallbackTarget, ModelRef, SessionUsage, TimelinePoint, TrendUnit,
    UsageCacheStats, UsageHealth, UsageModel, UsageProject, UsageRange, UsageStats, UsageTimeline,
    UsageTokens, UsageTrend, UsageTrendPoint,
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
    /// model_change 行：只用于兜底统计与 from 推断，不产生花费/消息数。
    ModelChange,
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
    /// assistant：message.stopReason（缺省空）。
    stop_reason: String,
    /// assistant：message.errorMessage 原文（缺省空；输出时截断脱敏）。
    error_message: String,
    /// model_change：role（缺省空；缺 role 与空字符串同义）。
    change_role: String,
    /// model_change：resolvedModelIsFallback。
    is_fallback: bool,
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
    role: Option<String>,
    resolved_model_is_fallback: bool,
    usage: Option<RawUsage>,
    message: Option<Message>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Message {
    role: String,
    provider: String,
    model: String,
    usage: Option<RawUsage>,
    timestamp: Option<Timestamp>,
    stop_reason: String,
    error_message: String,
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

/// 拆 model_change 的 "provider/model"（按首个 '/'；model 名本身可含 '/'）。
/// 无 '/' 时 provider 为空、整体为 model。
fn split_model(combined: &str) -> (String, String) {
    match combined.split_once('/') {
        Some((provider, model)) => (provider.to_owned(), model.to_owned()),
        None => (String::new(), combined.to_owned()),
    }
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
        // kind、provider、model、usage、内层时间、stop、错误原文、切换角色、兜底标记。
        let parsed_entry = match (raw.kind.as_str(), raw.message) {
            ("model_usage", _) => (
                Kind::Background,
                raw.provider,
                raw.model,
                raw.usage,
                None,
                String::new(),
                String::new(),
                String::new(),
                false,
            ),
            ("message", Some(m)) if m.role == "user" || m.role == "assistant" => {
                let assistant = m.role == "assistant";
                (
                    if assistant {
                        Kind::Assistant
                    } else {
                        Kind::User
                    },
                    m.provider,
                    m.model,
                    if assistant { m.usage } else { None },
                    m.timestamp,
                    if assistant {
                        m.stop_reason
                    } else {
                        String::new()
                    },
                    if assistant {
                        m.error_message
                    } else {
                        String::new()
                    },
                    String::new(),
                    false,
                )
            }
            ("model_change", _) => {
                let (provider, model) = split_model(&raw.model);
                (
                    Kind::ModelChange,
                    provider,
                    model,
                    None,
                    None,
                    String::new(),
                    String::new(),
                    raw.role.unwrap_or_default(),
                    raw.resolved_model_is_fallback,
                )
            }
            _ => continue,
        };
        let (
            kind,
            provider,
            model,
            usage,
            timestamp,
            stop_reason,
            error_message,
            change_role,
            is_fallback,
        ) = parsed_entry;
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
            stop_reason,
            error_message,
            change_role,
            is_fallback,
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

/// token 累加：损坏数据可能带极大单值，饱和加避免 debug panic / release 回绕。
fn add_tokens(to: &mut UsageTokens, from: &UsageTokens) {
    to.input = to.input.saturating_add(from.input);
    to.output = to.output.saturating_add(from.output);
    to.cache_read = to.cache_read.saturating_add(from.cache_read);
    to.cache_write = to.cache_write.saturating_add(from.cache_write);
    to.total = to.total.saturating_add(from.total);
}

fn add_usage(usage: &mut SessionUsage, entry: &Entry, nested: bool) {
    match entry.kind {
        Kind::User => usage.messages.user += 1,
        Kind::Assistant => usage.messages.assistant += 1,
        Kind::Background | Kind::ModelChange => {}
    }
    if entry.kind == Kind::ModelChange {
        return;
    }
    add_tokens(&mut usage.tokens, &entry.tokens);
    match entry.kind {
        Kind::Background => usage.cost.background += entry.cost,
        Kind::Assistant if nested => usage.cost.subagent += entry.cost,
        Kind::Assistant => usage.cost.main += entry.cost,
        Kind::User | Kind::ModelChange => {}
    }
    usage.cost.total = usage.cost.main + usage.cost.background + usage.cost.subagent;
}

fn add_model(models: &mut HashMap<(String, String), UsageModel>, entry: &Entry) {
    if entry.kind == Kind::User || entry.kind == Kind::ModelChange {
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

/// 时间窗口：毫秒起止（仅 All 为 None 表不限；固定窗口起止恒为 Some）
/// 分桶单位 + 固定窗口的预设桶 key（升序）。
struct Window {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    unit: TrendUnit,
    keys: Vec<String>,
}

/// 本地 naive 时刻 → epoch 毫秒。返回 None 仅表示该本地时刻不存在
/// （DST“春季前跳”缺口，如 02:00–03:00），绝不表示“起点不限”——
/// 固定窗口起点必须经 `resolve_start_ms` 解析为绝对时间，禁止把 None
/// 直接装进 `Window.start_ms`（`in_window` 会把 None 起点当作不限，
/// 固定窗口将静默变成全量统计）。
fn local_millis<Tz: TimeZone>(timezone: &Tz, naive: &chrono::NaiveDateTime) -> Option<i64>
where
    Tz::Offset: std::fmt::Display,
{
    timezone
        .from_local_datetime(naive)
        .earliest()
        .map(|t| t.timestamp_millis())
}

/// 固定窗口起点解析（恒返回绝对时间，绝不为 None）：
/// 起点本地时刻若落在 DST 缺口内，向前取第一个存在的时刻（+1h 步进、
/// 最多 3 次，覆盖常见 <3h 跳变）；整日跳过等极端情况仍失败时用
/// `fallback_ms`（调用方保证为 ≤ now 且不早于 now−窗口长度的合理下界）。
fn resolve_start_ms<Tz: TimeZone>(
    timezone: &Tz,
    naive: &chrono::NaiveDateTime,
    fallback_ms: i64,
) -> i64
where
    Tz::Offset: std::fmt::Display,
{
    let mut candidate = *naive;
    for _ in 0..4 {
        if let Some(ms) = local_millis(timezone, &candidate) {
            return ms;
        }
        candidate += Duration::hours(1);
    }
    fallback_ms
}

/// 本地时区窗口：
/// today 当天 0 点起；24h 当前整点前推 23 小时（24 个整点桶）；
/// 7d/30d 含今天的自然日；all 不限。
/// 固定窗口的 start_ms 恒为 Some，只有 All 为 None：24h 由 now 的绝对时间截断
/// 本地整点再减 23h（不经 earliest，无缺口/重复歧义）；today/7d/30d 的午夜缺口
/// 经 resolve_start_ms 前跳到缺口后第一个存在的时刻。
fn window_at<Tz: TimeZone>(range: UsageRange, now: DateTime<Utc>, timezone: &Tz) -> Window
where
    Tz::Offset: std::fmt::Display,
{
    let end_ms = match range {
        UsageRange::All => None,
        _ => Some(now.timestamp_millis()),
    };
    let local = now.with_timezone(timezone);
    match range {
        UsageRange::Today => {
            let date = local.date_naive();
            let midnight = date.and_hms_opt(0, 0, 0).expect("午夜恒合法");
            let keys = (0..=local.hour())
                .map(|h| format!("{} {h:02}", date.format("%Y-%m-%d")))
                .collect();
            Window {
                start_ms: Some(resolve_start_ms(
                    timezone,
                    &midnight,
                    now.timestamp_millis() - Duration::days(1).num_milliseconds(),
                )),
                end_ms,
                unit: TrendUnit::Hour,
                keys,
            }
        }
        UsageRange::Last24Hours => {
            let hour_start = local
                .date_naive()
                .and_hms_opt(local.hour(), 0, 0)
                .expect("整点恒合法");
            let first = hour_start - Duration::hours(23);
            let keys = (0..24)
                .map(|i| {
                    (first + Duration::hours(i))
                        .format("%Y-%m-%d %H")
                        .to_string()
                })
                .collect();
            Window {
                // 绝对时间起点：now 减去本地挂钟已过整点分数，即当前本地整点的
                // 绝对毫秒（半小时偏移同样成立；重复整点自然取 now 所在的一次；
                // 不经 earliest()，无缺口/重复歧义），再减 23 小时。
                start_ms: Some(
                    now.timestamp_millis()
                        - (local.minute() as i64 * 60 + local.second() as i64) * 1000
                        - (local.nanosecond() / 1_000_000) as i64
                        - Duration::hours(23).num_milliseconds(),
                ),
                end_ms,
                unit: TrendUnit::Hour,
                keys,
            }
        }
        UsageRange::Last7Days | UsageRange::Last30Days => {
            let days: i64 = if range == UsageRange::Last7Days {
                7
            } else {
                30
            };
            let today = local.date_naive();
            let dates: Vec<_> = (0..days)
                .rev()
                .map(|i| {
                    today
                        .checked_sub_signed(Duration::days(i))
                        .expect("日期回退恒合法")
                })
                .collect();
            let keys = dates
                .iter()
                .map(|d| d.format("%Y-%m-%d").to_string())
                .collect();
            let first_midnight = dates[0].and_hms_opt(0, 0, 0).expect("午夜恒合法");
            let floor_ms = now.timestamp_millis() - Duration::days(days).num_milliseconds();
            Window {
                start_ms: Some(resolve_start_ms(timezone, &first_midnight, floor_ms)),
                end_ms,
                unit: TrendUnit::Day,
                keys,
            }
        }
        UsageRange::All => Window {
            start_ms: None,
            end_ms: None,
            unit: TrendUnit::Day,
            keys: Vec::new(),
        },
    }
}

/// 窗口过滤：无时间戳条目只进入 all（带窗口统计无法安置它们）；
/// 固定窗口上下界为 [起点, now]（起点恒为 Some，见 resolve_start_ms，此处 None 分支只服务 All），
/// 未来时间戳不计入（保证分桶合计恒等于总计）。
fn in_window(window: &Window, timestamp: Option<i64>) -> bool {
    match timestamp {
        None => window.start_ms.is_none() && window.end_ms.is_none(),
        Some(t) => window.start_ms.is_none_or(|s| t >= s) && window.end_ms.is_none_or(|e| t <= e),
    }
}

fn bucket_key<Tz: TimeZone>(unit: TrendUnit, ms: i64, timezone: &Tz) -> Option<String>
where
    Tz::Offset: std::fmt::Display,
{
    let local = Utc
        .timestamp_millis_opt(ms)
        .single()?
        .with_timezone(timezone);
    Some(match unit {
        TrendUnit::Hour => local.format("%Y-%m-%d %H").to_string(),
        TrendUnit::Day => local.format("%Y-%m-%d").to_string(),
    })
}

/// 固定窗口钳位：夏令时跳变等极端情况导致桶 key 落到预设范围外时，
/// 归入首/末桶，保证分桶合计恒等于总计。
fn clamp_key(window: &Window, key: &mut String) {
    if window.keys.is_empty() {
        return;
    }
    if key.as_str() < window.keys[0].as_str() {
        *key = window.keys[0].clone();
    } else if key.as_str() > window.keys[window.keys.len() - 1].as_str() {
        *key = window.keys[window.keys.len() - 1].clone();
    }
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

pub fn usage_stats(cfg: &Config, cache: &UsageCache, range: UsageRange) -> AppResult<UsageStats> {
    stats_at(cfg, cache, range, Utc::now(), &Local)
}

fn stats_at<Tz: TimeZone>(
    cfg: &Config,
    cache: &UsageCache,
    range: UsageRange,
    now: DateTime<Utc>,
    timezone: &Tz,
) -> AppResult<UsageStats>
where
    Tz::Offset: std::fmt::Display,
{
    let window = window_at(range, now, timezone);
    let library = scan(cfg, cache)?;
    let mut stats = UsageStats::default();
    let mut models = HashMap::new();
    let mut projects: HashMap<String, UsageProject> = HashMap::new();
    let mut trend: BTreeMap<String, (f64, UsageTokens)> = BTreeMap::new();
    let mut sessions = HashSet::new();
    for (i, file) in library.files.iter().enumerate() {
        if file.data.version != Some(3) || library.files[file.owner].data.version != Some(3) {
            continue;
        }
        let cwd = &library.files[file.owner].data.cwd;
        for entry in &file.data.entries {
            if !in_window(&window, entry.timestamp) || library.inherited(i, entry) {
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
            // 趋势只收纳用量条目（model_change 恒零花费，不进趋势）。
            if entry.kind == Kind::ModelChange {
                continue;
            }
            let Some(ms) = entry.timestamp else {
                continue;
            };
            let Some(mut key) = bucket_key(window.unit, ms, timezone) else {
                continue;
            };
            clamp_key(&window, &mut key);
            let slot = trend
                .entry(key)
                .or_insert_with(|| (0.0, UsageTokens::default()));
            slot.0 += entry.cost;
            add_tokens(&mut slot.1, &entry.tokens);
        }
    }
    stats.by_project = projects.into_values().collect();
    stats
        .by_project
        .sort_by(|a, b| b.cost.total_cmp(&a.cost).then_with(|| a.cwd.cmp(&b.cwd)));
    stats.by_model = sorted_models(models);
    stats.total.models = stats.by_model.clone();
    stats.trend = UsageTrend {
        unit: window.unit,
        points: if window.keys.is_empty() {
            trend
                .into_iter()
                .map(|(key, (cost, tokens))| UsageTrendPoint { key, cost, tokens })
                .collect()
        } else {
            window
                .keys
                .iter()
                .map(|key| {
                    let (cost, tokens) = trend
                        .get(key)
                        .cloned()
                        .unwrap_or((0.0, UsageTokens::default()));
                    UsageTrendPoint {
                        key: key.clone(),
                        cost,
                        tokens,
                    }
                })
                .collect()
        },
    };
    Ok(stats)
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| text.contains(n))
}

/// 错误分类（大小写不敏感，先命中先赢）：
/// quota → rate_limit → timeout → auth → network → server → other。
/// 按本机真实 errorMessage 形态制定：
/// "402 ...usage limit" 系 quota；"timed out/stalled" 系 timeout；
/// "ECONNRESET/Connection" 系 network；"server_error/502/503" 系 server。
/// 注意 "Retry budget exhausted" 是重试预算耗尽而非额度用尽，不归 quota。
fn classify_error(message: &str) -> ErrorKind {
    let lower = message.to_lowercase();
    let text = lower.as_str();
    // 行首 HTTP 状态码（如 "402 {...}"）。
    let status: Option<u16> = {
        let head: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
        if head.len() == 3
            && text
                .as_bytes()
                .get(3)
                .is_some_and(|b| *b == b' ' || *b == b'{')
        {
            head.parse().ok()
        } else {
            None
        }
    };
    if status == Some(402)
        || contains_any(
            text,
            &[
                "usage limit",
                "usage_limit",
                "usage-limit",
                "quota",
                "payment",
                "subscription",
                "billing",
                "insufficient",
                "out of credit",
            ],
        )
    {
        return ErrorKind::Quota;
    }
    if status == Some(429)
        || contains_any(
            text,
            &["rate limit", "rate_limit", "ratelimit", "too many requests"],
        )
    {
        return ErrorKind::RateLimit;
    }
    if contains_any(
        text,
        &[
            "timed out",
            "timeout",
            "time-out",
            "stalled",
            "deadline exceeded",
            "stream_timeout",
            "etimedout",
        ],
    ) {
        return ErrorKind::Timeout;
    }
    if matches!(status, Some(401 | 403))
        || contains_any(
            text,
            &[
                "unauthorized",
                "unauthenticated",
                "invalid api key",
                "invalid_api_key",
                "invalid key",
                "authentication failed",
                "authentication error",
                "forbidden",
                "api key not valid",
                "incorrect api key",
                "invalid credentials",
            ],
        )
    {
        return ErrorKind::Auth;
    }
    if contains_any(
        text,
        &[
            "econnreset",
            "econnrefused",
            "econnaborted",
            "enotfound",
            "eai_again",
            "epipe",
            "ehostunreach",
            "enetunreach",
            "connection",
            "socket",
            "network",
            "fetch failed",
            "fetching",
            "tls",
            "certificate",
            "cert_",
            "broken pipe",
            "reset by peer",
            "stream was interrupted",
            "stream_interrupted",
            "closed before",
            "ended before completion",
            "eof",
        ],
    ) {
        return ErrorKind::Network;
    }
    if matches!(status, Some(500..=599))
        || contains_any(
            text,
            &[
                "server_error",
                "server error",
                "upstream",
                "unavailable",
                "internal error",
                "internal server",
                "bad gateway",
                "service unavailable",
                "overloaded",
                "capacity",
                "try again later",
                "failed to generate",
            ],
        )
    {
        return ErrorKind::Server;
    }
    ErrorKind::Other
}

/// 错误原文 → 单行、≤200 字符；形似密钥的片段脱敏为 [已脱敏]。
fn sanitize_message(raw: &str) -> String {
    redact_secrets(&raw.split_whitespace().collect::<Vec<_>>().join(" "))
        .chars()
        .take(200)
        .collect()
}

/// 保守脱敏：只处理明确像密钥的形态（真实数据中未见密钥，此为防御性处理）。
fn redact_secrets(text: &str) -> String {
    const MARK: &str = "[已脱敏]";
    // 常见密钥前缀：命中则整词替换。
    const PREFIXES: &[&str] = &[
        "sk-",
        "sk_",
        "eyJ",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "AKIA",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxs-",
        "sq0atp-",
        "AIza",
    ];
    let mut words: Vec<String> = text.split(' ').map(str::to_owned).collect();
    let mut cred_next = false;
    for word in words.iter_mut() {
        if cred_next {
            *word = MARK.to_owned();
            cred_next = false;
            continue;
        }
        // "Bearer <token>" / "Authorization: <token>"：凭证在下一个词。
        if word.eq_ignore_ascii_case("bearer")
            || word.eq_ignore_ascii_case("bearer:")
            || word.eq_ignore_ascii_case("authorization")
            || word.eq_ignore_ascii_case("authorization:")
        {
            cred_next = true;
            continue;
        }
        if PREFIXES
            .iter()
            .any(|p| word.len() >= p.len() + 8 && word.starts_with(p))
        {
            *word = MARK.to_owned();
            continue;
        }
        if looks_like_jwt(word) || looks_like_opaque_secret(word) {
            *word = MARK.to_owned();
            continue;
        }
        // key=value / key: value 形态：键名像密钥则只保留键名。
        if let Some(pos) = word.find('=').or_else(|| word.find(':')) {
            let key: String = word[..pos]
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
                .to_lowercase();
            if [
                "api_key",
                "apikey",
                "api-key",
                "secret",
                "password",
                "passwd",
                "token",
                "authorization",
            ]
            .iter()
            .any(|k| key.ends_with(k))
                && word.len() > pos + 1
            {
                *word = format!("{}{MARK}", &word[..=pos]);
            }
        }
    }
    words.join(" ")
}

/// 去单词首尾标点（供无特征形态判定；不改变原词）。
fn trim_edge_punct(word: &str) -> &str {
    word.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.' | ';' | ':' | '!' | '?'
        )
    })
}

/// JWT 紧凑形态：三段 base64url（各 ≥8 字符）。
fn looks_like_jwt(word: &str) -> bool {
    let parts: Vec<&str> = trim_edge_punct(word).split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            p.len() >= 8
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// 无特征长串：去首尾标点后 ≥32 个 base64/十六进制字符；
/// 字符集不含 `-./`，避免误伤路径、URL、域名与 UUID。
fn looks_like_opaque_secret(word: &str) -> bool {
    let core = trim_edge_punct(word);
    core.len() >= 32
        && core
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'_' | b'='))
}

/// 缓存命中率：分母为 0，或范围内 cacheRead + cacheWrite 全为 0（上游不报缓存）时为 null。
fn hit_rate(read: u64, input: u64, write: u64) -> Option<f64> {
    let denom = input as f64 + read as f64 + write as f64;
    if denom == 0.0 || (read == 0 && write == 0) {
        return None;
    }
    Some(read as f64 / denom)
}

#[derive(Default)]
struct TimelineAcc {
    requests: u64,
    errors: u64,
    fallbacks: u64,
    cache_read: u64,
    prompt: u64,
}

pub fn usage_health(cfg: &Config, cache: &UsageCache, range: UsageRange) -> AppResult<UsageHealth> {
    health_at(cfg, cache, range, Utc::now(), &Local)
}

fn health_at<Tz: TimeZone>(
    cfg: &Config,
    cache: &UsageCache,
    range: UsageRange,
    now: DateTime<Utc>,
    timezone: &Tz,
) -> AppResult<UsageHealth>
where
    Tz::Offset: std::fmt::Display,
{
    let window = window_at(range, now, timezone);
    let library = scan(cfg, cache)?;
    // 每文件兜底 from 预查：文件内此前最近 model_change（任何 role）/ assistant 的模型，
    // 不过滤窗口与去重（只描述切换瞬间此前生效的模型）；找不到为 None。
    let froms: Vec<Vec<Option<(String, String)>>> = library
        .files
        .iter()
        .map(|file| {
            let mut last: Option<(String, String)> = None;
            file.data
                .entries
                .iter()
                .map(|entry| {
                    let from = last.clone();
                    match entry.kind {
                        Kind::Assistant | Kind::ModelChange if !entry.model.is_empty() => {
                            last = Some((entry.provider.clone(), entry.model.clone()));
                        }
                        _ => {}
                    }
                    from
                })
                .collect()
        })
        .collect();
    let mut health = UsageHealth::default();
    let mut by_kind: HashMap<ErrorKind, u64> = HashMap::new();
    let mut errors_recent: Vec<ErrorRecent> = Vec::new();
    let mut by_target: HashMap<(String, String), u64> = HashMap::new();
    let mut fallbacks_recent: Vec<FallbackRecent> = Vec::new();
    let mut cache_input = 0u64;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    // (provider, model) → (requests, input, read, write)。
    let mut cache_models: HashMap<(String, String), (u64, u64, u64, u64)> = HashMap::new();
    let mut timeline: BTreeMap<String, TimelineAcc> = BTreeMap::new();
    for (i, file) in library.files.iter().enumerate() {
        if file.data.version != Some(3) || library.files[file.owner].data.version != Some(3) {
            continue;
        }
        for (j, entry) in file.data.entries.iter().enumerate() {
            if !in_window(&window, entry.timestamp) || library.inherited(i, entry) {
                continue;
            }
            // 请求口径：assistant 消息 + model_usage 后台调用；与 stats 同窗口同 scan 下
            // by_model.messages 之和同集合（add_model 恰计这两类），故恒等于该和。
            let is_request = matches!(entry.kind, Kind::Assistant | Kind::Background);
            if is_request {
                health.requests = health.requests.saturating_add(1);
                cache_input = cache_input.saturating_add(entry.tokens.input);
                cache_read = cache_read.saturating_add(entry.tokens.cache_read);
                cache_write = cache_write.saturating_add(entry.tokens.cache_write);
                let slot = cache_models
                    .entry((entry.provider.clone(), entry.model.clone()))
                    .or_insert((0, 0, 0, 0));
                slot.0 = slot.0.saturating_add(1);
                slot.1 = slot.1.saturating_add(entry.tokens.input);
                slot.2 = slot.2.saturating_add(entry.tokens.cache_read);
                slot.3 = slot.3.saturating_add(entry.tokens.cache_write);
            }
            // 错误只认 assistant 消息；model_usage 的 stopReason/errorMessage 不计错误。
            let is_error = entry.kind == Kind::Assistant && entry.stop_reason == "error";
            if is_error {
                health.errors.total = health.errors.total.saturating_add(1);
                let kind = classify_error(&entry.error_message);
                *by_kind.entry(kind).or_default() += 1;
                if let Some(ms) = entry.timestamp {
                    errors_recent.push(ErrorRecent {
                        time: ms,
                        provider: entry.provider.clone(),
                        model: entry.model.clone(),
                        kind,
                        message: sanitize_message(&entry.error_message),
                    });
                }
            }
            if entry.kind == Kind::Assistant && entry.stop_reason == "aborted" {
                health.errors.aborted = health.errors.aborted.saturating_add(1);
            }
            let is_fallback = entry.kind == Kind::ModelChange
                && entry.change_role == "fallback"
                && entry.is_fallback;
            if is_fallback {
                health.fallbacks.total = health.fallbacks.total.saturating_add(1);
                *by_target
                    .entry((entry.provider.clone(), entry.model.clone()))
                    .or_default() += 1;
                if let Some(ms) = entry.timestamp {
                    fallbacks_recent.push(FallbackRecent {
                        time: ms,
                        from: froms[i][j]
                            .clone()
                            .map(|(provider, model)| ModelRef { provider, model }),
                        to: ModelRef {
                            provider: entry.provider.clone(),
                            model: entry.model.clone(),
                        },
                    });
                }
            }
            // 时间线：所有带合法时间的归属条目都可建桶；只有用量条目贡献 token。
            if let Some(ms) = entry.timestamp {
                let Some(mut key) = bucket_key(window.unit, ms, timezone) else {
                    continue;
                };
                clamp_key(&window, &mut key);
                let slot = timeline.entry(key).or_default();
                if is_request {
                    slot.requests = slot.requests.saturating_add(1);
                    slot.cache_read = slot.cache_read.saturating_add(entry.tokens.cache_read);
                    slot.prompt = slot
                        .prompt
                        .saturating_add(entry.tokens.input)
                        .saturating_add(entry.tokens.cache_read)
                        .saturating_add(entry.tokens.cache_write);
                }
                if is_error {
                    slot.errors = slot.errors.saturating_add(1);
                }
                if is_fallback {
                    slot.fallbacks = slot.fallbacks.saturating_add(1);
                }
            }
        }
    }
    fn kind_name(kind: ErrorKind) -> &'static str {
        match kind {
            ErrorKind::Quota => "quota",
            ErrorKind::RateLimit => "rate_limit",
            ErrorKind::Auth => "auth",
            ErrorKind::Timeout => "timeout",
            ErrorKind::Network => "network",
            ErrorKind::Server => "server",
            ErrorKind::Other => "other",
        }
    }
    let mut by_kind: Vec<ErrorKindCount> = by_kind
        .into_iter()
        .map(|(kind, count)| ErrorKindCount { kind, count })
        .collect();
    by_kind.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| kind_name(a.kind).cmp(kind_name(b.kind)))
    });
    health.errors.by_kind = by_kind;
    // 稳定排序：同毫秒保持文件扫描顺序。
    errors_recent.sort_by_key(|a| std::cmp::Reverse(a.time));
    errors_recent.truncate(20);
    health.errors.recent = errors_recent;
    let mut by_target: Vec<FallbackTarget> = by_target
        .into_iter()
        .map(|((provider, model), count)| FallbackTarget {
            provider,
            model,
            count,
        })
        .collect();
    by_target.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)))
    });
    health.fallbacks.by_target = by_target;
    fallbacks_recent.sort_by_key(|a| std::cmp::Reverse(a.time));
    fallbacks_recent.truncate(20);
    health.fallbacks.recent = fallbacks_recent;
    let mut cache_by_model: Vec<CacheByModel> = cache_models
        .into_iter()
        .map(
            |((provider, model), (requests, input, read, write))| CacheByModel {
                provider,
                model,
                requests,
                hit_rate: hit_rate(read, input, write),
            },
        )
        .collect();
    cache_by_model.sort_by(|a, b| {
        b.requests
            .cmp(&a.requests)
            .then_with(|| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)))
    });
    health.cache = UsageCacheStats {
        hit_rate: hit_rate(cache_read, cache_input, cache_write),
        read: cache_read,
        write: cache_write,
        input: cache_input,
        by_model: cache_by_model,
    };
    health.timeline = UsageTimeline {
        unit: window.unit,
        points: if window.keys.is_empty() {
            timeline
                .into_iter()
                .map(
                    |(
                        key,
                        TimelineAcc {
                            requests,
                            errors,
                            fallbacks,
                            cache_read,
                            prompt,
                        },
                    )| TimelinePoint {
                        key,
                        requests,
                        errors,
                        fallbacks,
                        cache_read,
                        prompt_tokens: prompt,
                    },
                )
                .collect()
        } else {
            window
                .keys
                .iter()
                .map(|key| {
                    let acc = timeline.get(key);
                    TimelinePoint {
                        key: key.clone(),
                        requests: acc.map(|a| a.requests).unwrap_or(0),
                        errors: acc.map(|a| a.errors).unwrap_or(0),
                        fallbacks: acc.map(|a| a.fallbacks).unwrap_or(0),
                        cache_read: acc.map(|a| a.cache_read).unwrap_or(0),
                        prompt_tokens: acc.map(|a| a.prompt).unwrap_or(0),
                    }
                })
                .collect()
        },
    };
    Ok(health)
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
    range: UsageRange,
) -> AppResult<UsageStats> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    tauri::async_runtime::spawn_blocking(move || usage_stats(&cfg, &cache, range))
        .await
        .map_err(io_error)?
}

#[tauri::command]
pub async fn get_usage_health(
    cfg: tauri::State<'_, Config>,
    cache: tauri::State<'_, Arc<UsageCache>>,
    range: UsageRange,
) -> AppResult<UsageHealth> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    tauri::async_runtime::spawn_blocking(move || usage_health(&cfg, &cache, range))
        .await
        .map_err(io_error)?
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
