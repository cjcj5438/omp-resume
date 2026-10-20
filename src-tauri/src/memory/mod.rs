//! 记忆库（Mnemopi bank）浏览与维护（CONTRACT §18）。
//!
//! - 数据源：`OMP_RESUME_MEMORY_DIR` >
//!   `$HOME/.omp/agent/memories/mnemopi/banks/<bank>/mnemopi.db`（+ WAL/SHM 边车）。
//! - 读路径（§18.1–§18.4）**只读**：`SQLITE_OPEN_READ_ONLY` 打开 live 库（含 WAL），
//!   永不创建/修改文件；写路径（§18.8，`memory/delete.rs`）另走门禁 + 备份 + 事务。
//! - omp 私有 schema，随时可能变化：缺表/缺列一律按“零 / None / 空”降级，
//!   用 `PRAGMA table_info` / `sqlite_master` 事先探测，永不 panic。
//! - 后端日志/错误永不含记忆正文。

pub mod backup;
pub mod delete;
pub mod gate;
pub mod rows;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags};

use crate::config::Config;
use crate::model::{AppError, ErrorCode, MemoryBankSummary, MemoryOverview, MemoryTotals};
/// Bank 根目录覆盖（测试/开发用，供 `resolve_bank_root`）。
pub const MEMORY_DIR_ENV: &str = "OMP_RESUME_MEMORY_DIR";
/// 每 bank 目录内的库文件名（上游 `BankManager` 固定）。
pub const DB_FILENAME: &str = "mnemopi.db";
/// 只读忙等待（同 `history.rs`：omp 可能正在写入）。
pub const BUSY_TIMEOUT_MS: u64 = 500;
/// 列表 snippet 字符数（CONTRACT `MEMORY_SNIPPET_CHARS`）。
pub const SNIPPET_CHARS: usize = 240;
/// 列表在 SQL 内截取的正文前缀字符数（Rust 侧再折叠截断为 snippet）。
pub const SNIPPET_SQL_PREFIX: u32 = 512;
/// 详情全文上限字节数（CONTRACT `MEMORY_CONTENT_CAP_BYTES`）。
pub const CONTENT_CAP_BYTES: usize = 204_800;
/// 列表默认/最大条数（CONTRACT `MEMORY_LIST_LIMIT`）。
pub const LIST_LIMIT_DEFAULT: i64 = 50;
pub const LIST_LIMIT_MAX: i64 = 200;
/// 详情 facts 上限（CONTRACT `MEMORY_DETAIL_FACTS_LIMIT`）。
pub const DETAIL_FACTS_LIMIT: i64 = 50;
/// 趋势最大天数（CONTRACT `MEMORY_GROWTH_DAYS`）。
pub const GROWTH_DAYS_MAX: i64 = 365;

/// 覆盖 bank 根目录的环境变量名（`resolve_bank_root_with` 注入点）。
pub fn resolve_bank_root_with(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    env(MEMORY_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".omp/agent/memories/mnemopi/banks"))
}

/// 解析 bank 根目录：`OMP_RESUME_MEMORY_DIR` >
/// `$HOME/.omp/agent/memories/mnemopi/banks`。
pub fn resolve_bank_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    resolve_bank_root_with(
        |k| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned()),
        &home,
    )
}

/// 只读打开；库不存在或无法打开 ⇒ `None`（不创建文件）。
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

/// 单表存在性 + 列集合（表/列缺失时降级，不报错）。
pub(crate) struct TableSchema {
    pub exists: bool,
    pub columns: HashSet<String>,
}

/// 探测表结构。`table` 只取内部常量（PRAGMA 不支持绑定参数，禁止外部输入）。
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
        // `table` 为内部常量；PRAGMA 标识符加双引号。
        let pragma = format!("PRAGMA table_info(\"{table}\")");
        if let Ok(mut stmt) = conn.prepare(&pragma) {
            let rows = stmt.query_map([], |row| row.get::<_, String>(1));
            if let Ok(rows) = rows {
                for name in rows.flatten() {
                    columns.insert(name);
                }
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

/// 校验 bank id（CONTRACT §18.5）：非空纯目录名单段；join 根目录后 canonicalize
/// 必须仍位于根目录内（防 symlink 逃逸）。不存在 ⇒ `NOT_FOUND`。
pub fn validate_bank(root: &Path, bank: &str) -> Result<PathBuf, AppError> {
    if bank.is_empty()
        || bank == "."
        || bank == ".."
        || bank.contains('/')
        || bank.contains('\\')
        || bank.contains('\0')
    {
        return Err(AppError::new(ErrorCode::OutsideRoot, "非法的记忆库名称"));
    }
    let joined = root.join(bank);
    if std::fs::symlink_metadata(&joined).is_err() {
        return Err(AppError::new(ErrorCode::NotFound, "记忆库不存在"));
    }
    let canon_root = root
        .canonicalize()
        .map_err(|_| AppError::new(ErrorCode::NotFound, "记忆库不存在"))?;
    let canon_bank = joined
        .canonicalize()
        .map_err(|_| AppError::new(ErrorCode::NotFound, "记忆库不存在"))?;
    if !canon_bank.starts_with(&canon_root) {
        return Err(AppError::new(ErrorCode::OutsideRoot, "记忆库路径越界"));
    }
    if !canon_bank.is_dir() {
        return Err(AppError::new(ErrorCode::NotFound, "记忆库不存在"));
    }
    Ok(canon_bank)
}

/// bank 不可读时的简短非敏感原因（overview 置灰行展示）。
pub(crate) fn unreadable_reason(db: &Path) -> String {
    if !db.exists() {
        "数据库文件缺失".to_owned()
    } else {
        "数据库文件损坏".to_owned()
    }
}

/// 单个库文件的字节数（缺失/不可读按 0）。
pub(crate) fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// bank 磁盘占用：`mnemopi.db` + `-wal` + `-shm`。
pub(crate) fn bank_bytes(bank_dir: &Path) -> u64 {
    let db = bank_dir.join(DB_FILENAME);
    file_bytes(&db)
        + file_bytes(&db.with_extension("db-wal"))
        + file_bytes(&db.with_extension("db-shm"))
}

/// UUID 形状校验（`8-4-4-4-12` 十六进制，sessions 文件名匹配用）。
fn is_uuid_shape(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            if *b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// 扫描 sessions 目录**文件名**收集会话 UUID（CONTRACT §18.6）：
/// 各项目顶层非点文件 `*.jsonl`，取末段 `_` 后、`.jsonl` 前的部分。
/// 不读文件内容；目录不可读时返回空集（调用方按“来源缺失”偏高处理）。
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
            let Some((_, uuid)) = stem.rsplit_once('_') else {
                continue;
            };
            if is_uuid_shape(uuid) {
                out.insert(uuid.to_owned());
            }
        }
    }
    out
}

/// 解析记忆库时间戳为 UTC：RFC3339（含 `Z` / 偏移）优先，回退
/// `YYYY-MM-DD HH:MM:SS[.f]`（SQLite `CURRENT_TIMESTAMP`，UTC）与
/// `YYYY-MM-DDTHH:MM:SS[.f]`（无时区，按 UTC）。解析失败 ⇒ `None`。
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
    // 日期独行（`occurred_on` 类注解形态，容忍）：按 UTC 午夜。
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0).map(|d| d.and_utc());
    }
    None
}

/// 时间戳 → ISO-8601 UTC 毫秒（§0 时间约定）；解析失败 ⇒ `None`。
pub fn iso_millis_opt(raw: Option<&str>) -> Option<String> {
    raw.and_then(parse_memory_ts)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// 把用户输入转为 `LIKE` 子串模式：转义 `\`、`%`、`_`（SQL 中配合 `ESCAPE '\'`），
/// 两端加 `%`（同 `history.rs`）。
pub(crate) fn like_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for ch in query.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

/// 列表 snippet：空白折叠为单空格后取前 [`SNIPPET_CHARS`] 字符，
/// 字符边界安全，超长尾加 `…`。`total_chars` 为正文总字符数，
/// `prefix` 为 SQL 侧截取的前缀（[`SNIPPET_SQL_PREFIX`] 字符内）。
pub fn make_snippet(prefix: &str, total_chars: u64) -> String {
    let mut folded = String::with_capacity(prefix.len().min(512));
    for word in prefix.split_whitespace() {
        if !folded.is_empty() {
            folded.push(' ');
        }
        folded.push_str(word);
    }
    let prefix_chars = prefix.chars().count() as u64;
    let truncated = folded.chars().count() > SNIPPET_CHARS || total_chars > prefix_chars;
    if !truncated {
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
    let text = meta?;
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
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

/// 解析 `metadata_json` 为对象（数组/标量/解析失败 ⇒ `None`），
/// 防御性删除键名含疑似密钥子串的顶层键。
pub fn metadata_object(meta: Option<&str>) -> Option<serde_json::Value> {
    let text = meta?;
    let mut value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object_mut()?;
    object.retain(|k, _| {
        let lower = k.to_lowercase();
        !SECRET_SUBSTRINGS.iter().any(|s| lower.contains(s))
    });
    Some(value)
}

/// bank 展示名：cwd basename；cwd 未知时去掉目录名末段 `-<hash>` 后缀。
pub fn display_name(bank: &str, cwd: Option<&str>) -> String {
    if let Some(dir) = cwd {
        if let Some(base) = Path::new(dir)
            .file_name()
            .and_then(|b| b.to_str())
            .filter(|b| !b.is_empty())
        {
            return base.to_owned();
        }
    }
    match bank
        .rsplit_once('-')
        .map(|(pre, _)| pre)
        .filter(|pre| !pre.is_empty())
    {
        Some(pre) => pre.to_owned(),
        None => bank.to_owned(),
    }
}

/// 只读读取 `memory.backend` 配置（经既有安全 runner，不占写门禁）；
/// omp 缺失/超时/输出异常 ⇒ `None`（永不让 overview 失败）。
pub(crate) fn memory_backend() -> Option<String> {
    let bin = crate::omp_cli::resolve_omp()?;
    let mut discard = |_: &str| {};
    let output = crate::omp_cli::run_omp(
        &bin,
        &["config", "get", "memory.backend", "--json"],
        crate::omp_cli::VERSION_TIMEOUT,
        &mut discard,
    )
    .ok()?;
    let stdout = crate::omp_cli::require_success(output, "读取记忆后端配置").ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    parsed
        .get("value")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn join_error(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("后台任务失败：{e}"))
}

/// CONTRACT §18.1：bank 总览（阻塞 IO 在后台线程）。
#[tauri::command]
pub async fn memory_overview(cfg: tauri::State<'_, Config>) -> Result<MemoryOverview, AppError> {
    let sessions_dir = cfg.sessions_dir.clone();
    tauri::async_runtime::spawn_blocking(move || overview_impl(&resolve_bank_root(), &sessions_dir))
        .await
        .map_err(join_error)?
}

/// CONTRACT §18.2：bank 内分页列表 + 搜索（阻塞 IO 在后台线程）。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn memory_list(
    cfg: tauri::State<'_, Config>,
    bank: String,
    query: Option<String>,
    kind: Option<crate::model::MemoryKindFilter>,
    only_never_recalled: Option<bool>,
    only_unconsolidated: Option<bool>,
    only_missing_source: Option<bool>,
    sort: Option<crate::model::MemorySort>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<crate::model::MemoryPage, AppError> {
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
    tauri::async_runtime::spawn_blocking(move || {
        rows::list_impl(&resolve_bank_root(), &sessions_dir, &params)
    })
    .await
    .map_err(join_error)?
}

/// CONTRACT §18.3：单条记忆详情（阻塞 IO 在后台线程）。
#[tauri::command]
pub async fn memory_detail(
    cfg: tauri::State<'_, Config>,
    bank: String,
    id: String,
) -> Result<crate::model::MemoryDetail, AppError> {
    let sessions_dir = cfg.sessions_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rows::detail_impl(&resolve_bank_root(), &sessions_dir, &bank, &id)
    })
    .await
    .map_err(join_error)?
}

/// CONTRACT §18.4：增长趋势（阻塞 IO 在后台线程）。
#[tauri::command]
pub async fn memory_growth(
    bank: Option<String>,
    days: i64,
) -> Result<Vec<crate::model::MemoryGrowthPoint>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        rows::growth_impl(&resolve_bank_root(), bank.as_deref(), days)
    })
    .await
    .map_err(join_error)?
}
/// 数据目录（备份根父目录；`meta::data_dir`，`OMP_RESUME_DATA_DIR` 可覆盖）。
fn data_dir_or_io() -> Result<PathBuf, AppError> {
    crate::meta::data_dir()
}

/// CONTRACT §4.43：bank 状态（占用 + 备份；lsof 失败 ⇒ probe_failed，非错误）。
#[tauri::command]
pub async fn memory_bank_status(bank: String) -> Result<crate::model::MemoryBankStatus, AppError> {
    let data_dir = data_dir_or_io()?;
    tauri::async_runtime::spawn_blocking(move || {
        delete::status_impl(&resolve_bank_root(), &data_dir, &bank)
    })
    .await
    .map_err(join_error)?
}

/// CONTRACT §4.44：备份列表（`bank=None` ⇒ 全部）。
#[tauri::command]
pub async fn memory_backups(
    bank: Option<String>,
) -> Result<Vec<crate::model::MemoryBackup>, AppError> {
    let data_dir = data_dir_or_io()?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        delete::backups_impl(&data_dir, bank.as_deref())
    })
    .await
    .map_err(join_error)?;
    Ok(out)
}

/// CONTRACT §4.45：删除预览（纯只读，不设门禁）。
#[tauri::command]
pub async fn memory_delete_preview(
    bank: String,
    ids: Vec<String>,
) -> Result<crate::model::MemoryDeletePreview, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        delete::preview_impl(&resolve_bank_root(), &bank, &ids)
    })
    .await
    .map_err(join_error)?
}

/// CONTRACT §4.46：删除选中记忆（门禁 → 备份 → 复检 → 事务）。
#[tauri::command]
pub async fn memory_delete_items(
    bank: String,
    ids: Vec<String>,
) -> Result<crate::model::MemoryDeleteResult, AppError> {
    let data_dir = data_dir_or_io()?;
    tauri::async_runtime::spawn_blocking(move || {
        delete::delete_items_impl(&resolve_bank_root(), &data_dir, &bank, &ids)
    })
    .await
    .map_err(join_error)?
}

/// CONTRACT §4.47：整 bank 移入备份区（可恢复）。
#[tauri::command]
pub async fn memory_delete_bank(bank: String) -> Result<crate::model::MemoryBackup, AppError> {
    let data_dir = data_dir_or_io()?;
    tauri::async_runtime::spawn_blocking(move || {
        delete::delete_bank_impl(&resolve_bank_root(), &data_dir, &bank)
    })
    .await
    .map_err(join_error)?
}

/// CONTRACT §4.48：从备份恢复（含校验与回滚）。
#[tauri::command]
pub async fn memory_restore(
    backup_id: String,
) -> Result<crate::model::MemoryRestoreResult, AppError> {
    let data_dir = data_dir_or_io()?;
    tauri::async_runtime::spawn_blocking(move || {
        delete::restore_impl(&resolve_bank_root(), &data_dir, &backup_id)
    })
    .await
    .map_err(join_error)?
}

/// CONTRACT §4.49：永久删除一个备份。
#[tauri::command]
pub async fn memory_delete_backup(backup_id: String) -> Result<(), AppError> {
    let data_dir = data_dir_or_io()?;
    tauri::async_runtime::spawn_blocking(move || delete::delete_backup_impl(&data_dir, &backup_id))
        .await
        .map_err(join_error)?
}

/// 单表轻量行（overview 只取时间戳与元数据，不读正文）。
struct OverviewRow {
    timestamp: Option<String>,
    metadata: Option<String>,
    recall_count: Option<i64>,
    consolidated_at: Option<String>,
}

/// 取单表 overview 所需列（缺列则该字段恒 `None`，调用方按降级语义处理）。
fn overview_rows(
    conn: &Connection,
    table: &str,
    schema: &TableSchema,
) -> Result<(Vec<OverviewRow>, bool), rusqlite::Error> {
    let has_ts = schema.has("timestamp");
    let has_meta = schema.has("metadata_json");
    let has_recall = schema.has("recall_count");
    let has_consol = schema.has("consolidated_at");
    let select = format!(
        "SELECT {ts}, {meta}, {recall}, {consol} FROM \"{table}\"",
        ts = if has_ts { "timestamp" } else { "NULL" },
        meta = if has_meta { "metadata_json" } else { "NULL" },
        recall = if has_recall { "recall_count" } else { "NULL" },
        consol = if has_consol {
            "consolidated_at"
        } else {
            "NULL"
        },
    );
    let mut stmt = conn.prepare(&select)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(OverviewRow {
                timestamp: row.get(0)?,
                metadata: row.get(1)?,
                recall_count: row.get(2)?,
                consolidated_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((rows, has_consol))
}

/// 汇总单个 bank（任何失败都降级为 `readable=false` 行，不抛错）。
fn summarize_bank(root: &Path, bank: &str, sessions: &HashSet<String>) -> MemoryBankSummary {
    let bytes_of = |dir: &Path| bank_bytes(dir);
    let unreadable = |bytes: u64, reason: &str| MemoryBankSummary {
        bank: bank.to_owned(),
        display_name: display_name(bank, None),
        cwd: None,
        cwd_exists: None,
        working: 0,
        episodic: 0,
        facts: 0,
        bytes,
        first_memory_at: None,
        last_memory_at: None,
        never_recalled: 0,
        unconsolidated: 0,
        source_sessions: 0,
        missing_source_sessions: 0,
        readable: false,
        error: Some(reason.to_owned()),
    };
    let dir = match validate_bank(root, bank) {
        Ok(dir) => dir,
        Err(e) => {
            let reason = match e.code {
                ErrorCode::OutsideRoot => "记忆库路径越界",
                _ => "记忆库不存在",
            };
            return unreadable(0, reason);
        }
    };
    let bytes = bytes_of(&dir);
    let db = dir.join(DB_FILENAME);
    let Some(conn) = open_readonly(&db) else {
        return unreadable(bytes, &unreadable_reason(&db));
    };
    let wm = table_schema(&conn, "working_memory");
    let em = table_schema(&conn, "episodic_memory");
    if !wm.exists && !em.exists {
        return unreadable(bytes, "缺少记忆表");
    }
    let facts_schema = table_schema(&conn, "facts");
    let facts: u64 = if facts_schema.exists {
        conn.query_row("SELECT COUNT(*) FROM facts", [], |row| row.get::<_, i64>(0))
            .map(|n| n.max(0) as u64)
            .unwrap_or(0)
    } else {
        0
    };
    // 两表轻量行：计数/首末时间/cwd/来源会话一次算完。
    let mut working_rows: Vec<OverviewRow> = Vec::new();
    let mut episodic_rows: Vec<OverviewRow> = Vec::new();
    let mut consol_col = false;
    if wm.exists {
        match overview_rows(&conn, "working_memory", &wm) {
            Ok((rows, has_consol)) => {
                working_rows = rows;
                consol_col = has_consol;
            }
            Err(_) => return unreadable(bytes, "数据库文件损坏"),
        }
    }
    if em.exists {
        match overview_rows(&conn, "episodic_memory", &em) {
            Ok((rows, _)) => episodic_rows = rows,
            Err(_) => return unreadable(bytes, "数据库文件损坏"),
        }
    }
    let working = working_rows.len() as u64;
    let episodic = episodic_rows.len() as u64;
    // recall 列缺失时 `recall_count` 恒 None ⇒ 全算 neverRecalled（§18.1）。
    let never_recalled = working_rows
        .iter()
        .chain(episodic_rows.iter())
        .filter(|r| r.recall_count.unwrap_or(0) == 0)
        .count() as u64;
    // consolidated_at 列缺失时为 0（视为已巩固，不过滤）。
    let unconsolidated = if consol_col {
        working_rows
            .iter()
            .filter(|r| r.consolidated_at.as_deref().is_none_or(str::is_empty))
            .count() as u64
    } else {
        0
    };
    // 首末时间：解析后比较（混用格式时仍正确），输出统一 ISO。
    let mut first: Option<DateTime<Utc>> = None;
    let mut last: Option<DateTime<Utc>> = None;
    for row in working_rows.iter().chain(episodic_rows.iter()) {
        let Some(text) = row.timestamp.as_deref() else {
            continue;
        };
        let Some(dt) = parse_memory_ts(text) else {
            continue;
        };
        if first.is_none_or(|f| dt < f) {
            first = Some(dt);
        }
        if last.is_none_or(|l| dt > l) {
            last = Some(dt);
        }
    }
    // cwd：按 timestamp 倒序第一条非空 `metadata_json.cwd`。
    let mut by_time: Vec<(Option<DateTime<Utc>>, Option<&str>)> = working_rows
        .iter()
        .chain(episodic_rows.iter())
        .map(|r| {
            (
                r.timestamp.as_deref().and_then(parse_memory_ts),
                r.metadata.as_deref(),
            )
        })
        .collect();
    by_time.sort_by_key(|r| std::cmp::Reverse(r.0));
    let cwd = by_time
        .iter()
        .find_map(|(_, meta)| metadata_field(*meta, "cwd"));
    let cwd_exists = cwd.as_ref().map(|c| Path::new(c).is_dir());
    // 来源会话去重 + 缺失统计。
    let mut source_ids: HashSet<String> = HashSet::new();
    for row in working_rows.iter().chain(episodic_rows.iter()) {
        if let Some(sid) = metadata_field(row.metadata.as_deref(), "session_id") {
            source_ids.insert(sid);
        }
    }
    let missing_source_sessions = source_ids
        .iter()
        .filter(|sid| !sessions.contains(sid.as_str()))
        .count() as u64;
    MemoryBankSummary {
        bank: bank.to_owned(),
        display_name: display_name(bank, cwd.as_deref()),
        cwd,
        cwd_exists,
        working,
        episodic,
        facts,
        bytes,
        first_memory_at: first.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
        last_memory_at: last.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
        never_recalled,
        unconsolidated,
        source_sessions: source_ids.len() as u64,
        missing_source_sessions,
        readable: true,
        error: None,
    }
}

/// CONTRACT §18.1 实现（同步，调用方包 `spawn_blocking`）。
/// 根目录不存在/不可读 ⇒ `available=false`（非错误）。
pub fn overview_impl(root: &Path, sessions_dir: &Path) -> Result<MemoryOverview, AppError> {
    let backend = memory_backend();
    let root_display = root.to_string_lossy().into_owned();
    let mut names: Vec<String> = Vec::new();
    match std::fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries.flatten() {
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
        }
        Err(_) => {
            return Ok(MemoryOverview {
                available: false,
                backend,
                root: root_display,
                banks: Vec::new(),
                totals: MemoryTotals::default(),
            });
        }
    }
    // sessions 目录每命令调用只扫一次（文件名，不读内容）。
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

/// 时间戳 → 本地日期桶（与 `usage.rs` 同约定：UTC 解析 → 本地时区分桶）。
/// 解析失败 ⇒ `None`（不计入任何一天）。
pub fn bucket_local_day(raw: Option<&str>) -> Option<String> {
    let dt = parse_memory_ts(raw?)?;
    Some(dt.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests;
