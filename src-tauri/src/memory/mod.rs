//! 记忆库（Mnemopi bank）浏览与维护（CONTRACT §18）。
//!
//! 读路径只读打开 live 库（含 WAL），永不写文件；缺表/缺列按零/None/空降级。
//! 写路径见 `delete.rs`（门禁 + 备份 + 事务）。日志/错误永不含记忆正文。

pub mod backup;
pub mod delete;
pub mod gate;
pub mod rows;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags};

use crate::config::Config;
use crate::model::{
    AppError, ErrorCode, MemoryBackup, MemoryBankStatus, MemoryBankSummary, MemoryDeletePreview,
    MemoryDeleteResult, MemoryDetail, MemoryKindFilter, MemoryOverview, MemoryPage,
    MemoryRestoreResult, MemorySort, MemoryTotals,
};

/// 根目录覆盖 / 库文件名 / 只读忙等待 / snippet 前缀与长度 / 正文上限 /
/// 列表条数 / 详情 facts（对应 CONTRACT §18 的 `MEMORY_*`）。
pub const MEMORY_DIR_ENV: &str = "OMP_RESUME_MEMORY_DIR";
pub const DB_FILENAME: &str = "mnemopi.db";
pub const BUSY_TIMEOUT_MS: u64 = 500;
pub const SNIPPET_CHARS: usize = 240;
pub const SNIPPET_SQL_PREFIX: u32 = 512;
pub const CONTENT_CAP_BYTES: usize = 204_800;
pub const LIST_LIMIT_DEFAULT: i64 = 50;
pub const LIST_LIMIT_MAX: i64 = 200;
pub const DETAIL_FACTS_LIMIT: i64 = 50;

/// 解析 bank 根目录：`OMP_RESUME_MEMORY_DIR` > `$HOME/.omp/agent/memories/mnemopi/banks`。
pub fn resolve_bank_root_with(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    env(MEMORY_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".omp/agent/memories/mnemopi/banks"))
}

pub fn resolve_bank_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    resolve_bank_root_with(
        |k| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned()),
        &home,
    )
}

/// 只读打开；失败 ⇒ `None`（不创建文件）。
pub(crate) fn open_readonly(db: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))
        .ok()?;
    Some(conn)
}

/// 单表存在性 + 列集合（缺表/列时降级，不报错）。
pub(crate) struct TableSchema {
    pub exists: bool,
    pub columns: HashSet<String>,
}

/// 探测表结构（`table` 只取内部常量，禁止外部输入）。
pub(crate) fn table_schema(conn: &Connection, table: &str) -> TableSchema {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1 LIMIT 1",
            [table],
            |_| Ok(true),
        )
        .unwrap_or(false);
    let mut columns = HashSet::new();
    if exists {
        if let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info(\"{table}\")")) {
            if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) {
                columns.extend(rows.flatten());
            }
        }
    }
    TableSchema { exists, columns }
}

impl TableSchema {
    pub fn has(&self, column: &str) -> bool {
        self.exists && self.columns.contains(column)
    }
}

/// 缺列填 `NULL AS <列>`（UNION 两侧列对齐）。
pub(crate) fn col_or_null(schema: &TableSchema, name: &str) -> String {
    if schema.has(name) {
        name.to_owned()
    } else {
        format!("NULL AS {name}")
    }
}

/// 错误构造捷径（message 均非敏感）。
pub(crate) fn io(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Io, msg)
}
pub(crate) fn invalid(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, msg)
}
pub(crate) fn outside(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OutsideRoot, msg)
}
pub(crate) fn not_found(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::NotFound, msg)
}

/// bank 名词法：非空纯目录名单段。
pub(crate) fn bank_segment_ok(bank: &str) -> bool {
    !(bank.is_empty()
        || bank == "."
        || bank == ".."
        || bank.contains('/')
        || bank.contains('\\')
        || bank.contains('\0'))
}

/// `root` 下相对路径必须存在、为目录、canonicalize 后仍在根内（防 symlink 逃逸）。
pub(crate) fn resolve_contained_dir(
    root: &Path,
    rel: &Path,
    missing: &str,
    outside_msg: &str,
) -> Result<PathBuf, AppError> {
    let joined = root.join(rel);
    if std::fs::symlink_metadata(&joined).is_err() {
        return Err(not_found(missing));
    }
    let canon_root = root.canonicalize().map_err(|_| not_found(missing))?;
    let canon = joined.canonicalize().map_err(|_| not_found(missing))?;
    if !canon.starts_with(&canon_root) {
        return Err(outside(outside_msg));
    }
    if !canon.is_dir() {
        return Err(not_found(missing));
    }
    Ok(canon)
}

/// 校验 bank id：词法 + 存在 + 不逃逸。不存在 ⇒ `NOT_FOUND`。
pub fn validate_bank(root: &Path, bank: &str) -> Result<PathBuf, AppError> {
    if !bank_segment_ok(bank) {
        return Err(outside("非法的记忆库名称"));
    }
    resolve_contained_dir(root, Path::new(bank), "记忆库不存在", "记忆库路径越界")
}

/// bank 不可读的简短非敏感原因（overview 置灰行展示）。
pub(crate) fn unreadable_reason(db: &Path) -> String {
    if db.exists() {
        "数据库文件损坏".to_owned()
    } else {
        "数据库文件缺失".to_owned()
    }
}

/// 单个库文件字节数（缺失按 0）。
pub(crate) fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// bank 磁盘占用：db + `-wal` + `-shm`。
pub(crate) fn bank_bytes(bank_dir: &Path) -> u64 {
    let db = bank_dir.join(DB_FILENAME);
    file_bytes(&db)
        + file_bytes(&db.with_extension("db-wal"))
        + file_bytes(&db.with_extension("db-shm"))
}

/// 根下非点子目录名；根不可读 ⇒ `None`。
pub(crate) fn list_bank_names(root: &Path) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir() || t.is_symlink())
            .unwrap_or(false);
        if !is_dir {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if !name.starts_with('.') {
                names.push(name.to_owned());
            }
        }
    }
    Some(names)
}

/// UUID 形状（`8-4-4-4-12` 十六进制）。
fn is_uuid_shape(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// 扫 sessions 目录**文件名**收会话 UUID（`*.jsonl` 取末段 `_` 后部分；不读内容）。
pub fn scan_session_uuids(sessions_dir: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(projects) = std::fs::read_dir(sessions_dir) else {
        return out;
    };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let Some(name) = file.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !name.ends_with(".jsonl") || name.starts_with('.') {
                continue;
            }
            let stem = &name[..name.len() - ".jsonl".len()];
            if let Some((_, uuid)) = stem.rsplit_once('_') {
                if is_uuid_shape(uuid) {
                    out.insert(uuid.to_owned());
                }
            }
        }
    }
    out
}

/// 记忆库时间戳 → UTC：RFC3339 优先，回退 SQLite `CURRENT_TIMESTAMP` 与无时区 `T` 形态。
pub fn parse_memory_ts(raw: &str) -> Option<DateTime<Utc>> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Some(dt.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Some(naive.and_utc());
        }
    }
    // 日期独行（容忍）：按 UTC 午夜。
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0).map(|d| d.and_utc());
    }
    None
}

/// 时间戳 → ISO-8601 UTC 毫秒；解析失败 ⇒ `None`。
pub fn iso_millis_opt(raw: Option<&str>) -> Option<String> {
    raw.and_then(parse_memory_ts)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// `LIKE` 转义（`%`/`_`/`\`），配合 `ESCAPE '\'`。
pub(crate) fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 用户输入 → `LIKE` 子串模式（两端加 `%`，同 `history.rs`）。
pub(crate) fn like_pattern(query: &str) -> String {
    format!("%{}%", escape_like(query))
}

/// 列表 snippet：空白折叠后取前 [`SNIPPET_CHARS`] 字符，超长尾加 `…`。
pub fn make_snippet(prefix: &str, total_chars: u64) -> String {
    let mut folded = String::with_capacity(prefix.len().min(512));
    for word in prefix.split_whitespace() {
        if !folded.is_empty() {
            folded.push(' ');
        }
        folded.push_str(word);
    }
    let prefix_chars = prefix.chars().count() as u64;
    if folded.chars().count() <= SNIPPET_CHARS && total_chars <= prefix_chars {
        return folded;
    }
    let mut out: String = folded.chars().take(SNIPPET_CHARS).collect();
    out.push('…');
    out
}

/// 按 UTF-8 字节上限截断（字符边界安全），返回（截断后文本，是否截断）。
pub fn truncate_bytes(text: &str, cap: usize) -> (String, bool) {
    if text.len() <= cap {
        return (text.to_owned(), false);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

/// 取 `metadata_json` 的字符串字段（缺失/非字符串/空串 ⇒ `None`）。
pub fn metadata_field(meta: Option<&str>, field: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(meta?).ok()?;
    value
        .get(field)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// metadata 疑似密钥子串（小写匹配，`memory_detail` 防御性删除顶层键）。
const SECRET_SUBSTRINGS: [&str; 7] = [
    "token",
    "key",
    "passwd",
    "password",
    "secret",
    "authorization",
    "credential",
];

/// `metadata_json` → 对象（非对象/解析失败 ⇒ `None`），删疑似密钥顶层键。
pub fn metadata_object(meta: Option<&str>) -> Option<serde_json::Value> {
    let mut value: serde_json::Value = serde_json::from_str(meta?).ok()?;
    let object = value.as_object_mut()?;
    object.retain(|k, _| {
        let lower = k.to_lowercase();
        !SECRET_SUBSTRINGS.iter().any(|s| lower.contains(s))
    });
    Some(value)
}

/// bank 展示名：cwd basename；cwd 未知时去掉目录名末段 `-<hash>` 后缀。
pub fn display_name(bank: &str, cwd: Option<&str>) -> String {
    if let Some(base) = cwd
        .and_then(|d| Path::new(d).file_name())
        .and_then(|b| b.to_str())
        .filter(|b| !b.is_empty())
    {
        return base.to_owned();
    }
    bank.rsplit_once('-')
        .map(|(pre, _)| pre)
        .filter(|pre| !pre.is_empty())
        .unwrap_or(bank)
        .to_owned()
}

/// 只读读 `memory.backend` 配置；omp 缺失/异常 ⇒ `None`（永不让 overview 失败）。
pub(crate) fn memory_backend() -> Option<String> {
    let bin = crate::omp_cli::resolve_omp()?;
    let output = crate::omp_cli::run_omp(
        &bin,
        &["config", "get", "memory.backend", "--json"],
        crate::omp_cli::VERSION_TIMEOUT,
        &mut |_: &str| {},
    )
    .ok()?;
    let stdout = crate::omp_cli::require_success(output, "读取记忆后端配置").ok()?;
    serde_json::from_str::<serde_json::Value>(&stdout)
        .ok()?
        .get("value")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn join_error(e: impl std::fmt::Display) -> AppError {
    io(format!("后台任务失败：{e}"))
}

/// 阻塞 IO 统一包 `spawn_blocking`。
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(join_error)?
}

/// CONTRACT §18.1：bank 总览。
#[tauri::command]
pub async fn memory_overview(cfg: tauri::State<'_, Config>) -> Result<MemoryOverview, AppError> {
    let sessions_dir = cfg.sessions_dir.clone();
    blocking(move || overview_impl(&resolve_bank_root(), &sessions_dir)).await
}

/// CONTRACT §18.2：bank 内分页列表 + 搜索。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn memory_list(
    cfg: tauri::State<'_, Config>,
    bank: String,
    query: Option<String>,
    kind: Option<MemoryKindFilter>,
    only_never_recalled: Option<bool>,
    only_unconsolidated: Option<bool>,
    only_missing_source: Option<bool>,
    sort: Option<MemorySort>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MemoryPage, AppError> {
    let sessions_dir = cfg.sessions_dir.clone();
    let params = rows::ListParams {
        bank,
        query,
        kind: kind.unwrap_or_default(),
        only_never_recalled: only_never_recalled.unwrap_or(false),
        only_unconsolidated: only_unconsolidated.unwrap_or(false),
        only_missing_source: only_missing_source.unwrap_or(false),
        sort: sort.unwrap_or_default(),
        limit: limit.unwrap_or(LIST_LIMIT_DEFAULT),
        offset: offset.unwrap_or(0),
    };
    blocking(move || rows::list_impl(&resolve_bank_root(), &sessions_dir, &params)).await
}

/// CONTRACT §18.3：单条记忆详情。
#[tauri::command]
pub async fn memory_detail(
    cfg: tauri::State<'_, Config>,
    bank: String,
    id: String,
) -> Result<MemoryDetail, AppError> {
    let sessions_dir = cfg.sessions_dir.clone();
    blocking(move || rows::detail_impl(&resolve_bank_root(), &sessions_dir, &bank, &id)).await
}

/// CONTRACT §4.43：bank 状态（lsof 失败 ⇒ probe_failed，非错误）。
#[tauri::command]
pub async fn memory_bank_status(bank: String) -> Result<MemoryBankStatus, AppError> {
    let data_dir = crate::meta::data_dir()?;
    blocking(move || {
        delete::status_impl_with(
            &resolve_bank_root(),
            &data_dir,
            &bank,
            &delete::Gate::production(),
        )
    })
    .await
}

/// CONTRACT §4.44：备份列表（`bank=None` ⇒ 全部）。
#[tauri::command]
pub async fn memory_backups(bank: Option<String>) -> Result<Vec<MemoryBackup>, AppError> {
    let data_dir = crate::meta::data_dir()?;
    blocking(move || Ok(delete::backups_impl(&data_dir, bank.as_deref()))).await
}

/// CONTRACT §4.45：删除预览（纯只读，不设门禁）。
#[tauri::command]
pub async fn memory_delete_preview(
    bank: String,
    ids: Vec<String>,
) -> Result<MemoryDeletePreview, AppError> {
    blocking(move || delete::preview_impl(&resolve_bank_root(), &bank, &ids)).await
}

/// CONTRACT §4.46：删除选中记忆（门禁 → 备份 → 复检 → 事务）。
#[tauri::command]
pub async fn memory_delete_items(
    bank: String,
    ids: Vec<String>,
) -> Result<MemoryDeleteResult, AppError> {
    let data_dir = crate::meta::data_dir()?;
    blocking(move || {
        delete::delete_items_impl_with(
            &resolve_bank_root(),
            &data_dir,
            &bank,
            &ids,
            &delete::Gate::production(),
        )
    })
    .await
}

/// CONTRACT §4.47：整 bank 移入备份区（可恢复）。
#[tauri::command]
pub async fn memory_delete_bank(bank: String) -> Result<MemoryBackup, AppError> {
    let data_dir = crate::meta::data_dir()?;
    blocking(move || {
        delete::delete_bank_impl_with(
            &resolve_bank_root(),
            &data_dir,
            &bank,
            &delete::Gate::production(),
        )
    })
    .await
}

/// CONTRACT §4.48：从备份恢复（含校验与回滚）。
#[tauri::command]
pub async fn memory_restore(backup_id: String) -> Result<MemoryRestoreResult, AppError> {
    let data_dir = crate::meta::data_dir()?;
    blocking(move || {
        delete::restore_impl_with(
            &resolve_bank_root(),
            &data_dir,
            &backup_id,
            &delete::Gate::production(),
        )
    })
    .await
}

/// CONTRACT §4.49：永久删除一个备份。
#[tauri::command]
pub async fn memory_delete_backup(backup_id: String) -> Result<(), AppError> {
    let data_dir = crate::meta::data_dir()?;
    blocking(move || delete::delete_backup_impl(&data_dir, &backup_id)).await
}

/// 单表轻量行（overview 只取时间戳与元数据，不读正文）。
struct OverviewRow {
    timestamp: Option<String>,
    metadata: Option<String>,
    recall_count: Option<i64>,
    consolidated_at: Option<String>,
}

/// 取单表 overview 所需列（缺列恒 `None`，调用方降级）。
fn overview_rows(
    conn: &Connection,
    table: &str,
    schema: &TableSchema,
) -> Result<Vec<OverviewRow>, rusqlite::Error> {
    let cols = [
        "timestamp",
        "metadata_json",
        "recall_count",
        "consolidated_at",
    ]
    .map(|c| col_or_null(schema, c));
    let mut stmt = conn.prepare(&format!("SELECT {} FROM \"{table}\"", cols.join(", ")))?;
    let rows = stmt.query_map([], |row| {
        Ok(OverviewRow {
            timestamp: row.get(0)?,
            metadata: row.get(1)?,
            recall_count: row.get(2)?,
            consolidated_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// 汇总单个 bank（任何失败都降级为 `readable=false` 行，不抛错）。
fn summarize_bank(root: &Path, bank: &str, sessions: &HashSet<String>) -> MemoryBankSummary {
    let unreadable = |bytes: u64, reason: &str| MemoryBankSummary {
        bank: bank.to_owned(),
        display_name: display_name(bank, None),
        bytes,
        readable: false,
        error: Some(reason.to_owned()),
        ..MemoryBankSummary::default()
    };
    let dir = match validate_bank(root, bank) {
        Ok(dir) => dir,
        Err(e) => {
            return unreadable(
                0,
                match e.code {
                    ErrorCode::OutsideRoot => "记忆库路径越界",
                    _ => "记忆库不存在",
                },
            );
        }
    };
    let bytes = bank_bytes(&dir);
    let db = dir.join(DB_FILENAME);
    let Some(conn) = open_readonly(&db) else {
        return unreadable(bytes, &unreadable_reason(&db));
    };
    let wm = table_schema(&conn, "working_memory");
    let em = table_schema(&conn, "episodic_memory");
    if !wm.exists && !em.exists {
        return unreadable(bytes, "缺少记忆表");
    }
    let facts: u64 = if table_schema(&conn, "facts").exists {
        conn.query_row("SELECT COUNT(*) FROM facts", [], |row| row.get::<_, i64>(0))
            .map(|n| n.max(0) as u64)
            .unwrap_or(0)
    } else {
        0
    };
    let mut working_rows = Vec::new();
    let mut episodic_rows = Vec::new();
    if wm.exists {
        match overview_rows(&conn, "working_memory", &wm) {
            Ok(rows) => working_rows = rows,
            Err(_) => return unreadable(bytes, "数据库文件损坏"),
        }
    }
    if em.exists {
        match overview_rows(&conn, "episodic_memory", &em) {
            Ok(rows) => episodic_rows = rows,
            Err(_) => return unreadable(bytes, "数据库文件损坏"),
        }
    }
    // 单遍：首末时间 / never / 来源会话 / 最新 cwd（同 timestamp 时首行 wins，与排序等价）。
    let mut first: Option<DateTime<Utc>> = None;
    let mut last: Option<DateTime<Utc>> = None;
    let mut never = 0u64;
    let mut sources = HashSet::new();
    let mut cwd_best: (Option<DateTime<Utc>>, Option<String>) = (None, None);
    for row in working_rows.iter().chain(&episodic_rows) {
        if row.recall_count.unwrap_or(0) == 0 {
            never += 1;
        }
        let meta = row.metadata.as_deref();
        if let Some(sid) = metadata_field(meta, "session_id") {
            sources.insert(sid);
        }
        let dt = row.timestamp.as_deref().and_then(parse_memory_ts);
        if let Some(c) = metadata_field(meta, "cwd") {
            if cwd_best.1.is_none() || dt > cwd_best.0 {
                cwd_best = (dt, Some(c));
            }
        }
        let Some(dt) = dt else {
            continue;
        };
        if first.is_none_or(|f| dt < f) {
            first = Some(dt);
        }
        if last.is_none_or(|l| dt > l) {
            last = Some(dt);
        }
    }
    // recall 列缺失时恒 None ⇒ 全算 never；consolidated 列缺失 ⇒ 0。
    let unconsolidated = if wm.has("consolidated_at") {
        working_rows
            .iter()
            .filter(|r| r.consolidated_at.as_deref().is_none_or(str::is_empty))
            .count() as u64
    } else {
        0
    };
    let cwd = cwd_best.1;
    MemoryBankSummary {
        bank: bank.to_owned(),
        display_name: display_name(bank, cwd.as_deref()),
        cwd_exists: cwd.as_ref().map(|c| Path::new(c).is_dir()),
        cwd,
        working: working_rows.len() as u64,
        episodic: episodic_rows.len() as u64,
        facts,
        bytes,
        first_memory_at: first.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
        last_memory_at: last.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
        never_recalled: never,
        unconsolidated,
        source_sessions: sources.len() as u64,
        missing_source_sessions: sources
            .iter()
            .filter(|sid| !sessions.contains(sid.as_str()))
            .count() as u64,
        readable: true,
        error: None,
    }
}

/// CONTRACT §18.1 实现（同步，调用方包 `spawn_blocking`）。
/// 根目录不存在/不可读 ⇒ `available=false`（非错误）。
pub fn overview_impl(root: &Path, sessions_dir: &Path) -> Result<MemoryOverview, AppError> {
    let backend = memory_backend();
    let root_display = root.to_string_lossy().into_owned();
    let Some(names) = list_bank_names(root) else {
        return Ok(MemoryOverview {
            available: false,
            backend,
            root: root_display,
            banks: Vec::new(),
            totals: MemoryTotals::default(),
        });
    };
    let sessions = scan_session_uuids(sessions_dir);
    let mut banks: Vec<MemoryBankSummary> = names
        .iter()
        .map(|n| summarize_bank(root, n, &sessions))
        .collect();
    // `lastMemoryAt` 倒序（null 最小），再按 bank 名升序稳定。
    banks.sort_by(|a, b| {
        b.last_memory_at
            .cmp(&a.last_memory_at)
            .then_with(|| a.bank.cmp(&b.bank))
    });
    let mut totals = MemoryTotals {
        banks: banks.len() as u64,
        ..MemoryTotals::default()
    };
    for bank in &banks {
        totals.working += bank.working;
        totals.episodic += bank.episodic;
        totals.facts += bank.facts;
        totals.bytes += bank.bytes;
        totals.never_recalled += bank.never_recalled;
        totals.unconsolidated += bank.unconsolidated;
        totals.missing_source_sessions += bank.missing_source_sessions;
        totals.source_sessions += bank.source_sessions;
    }
    Ok(MemoryOverview {
        available: true,
        backend,
        root: root_display,
        banks,
        totals,
    })
}

#[cfg(test)]
mod tests;
