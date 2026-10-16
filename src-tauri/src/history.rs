//! omp 提示词历史与会话 recap（只读，CONTRACT §13）。
//!
//! - 数据源：omp 的 `~/.omp/agent/history.db`；`OMP_RESUME_HISTORY_DB` 可覆盖（供测试）。
//! - **只读打开**（`SQLITE_OPEN_READ_ONLY`）：不写、不 checkpoint、不创建库文件。
//! - 功能隐藏式降级：库不存在、表/列对不上、任何 SQL 错误 ⇒ 空结果 / `None`，静默。
//! - 搜索用 `LIKE`（不用 FTS5：默认分词器不切 CJK，约 400 行规模 LIKE 足够）。
//!   `LIKE` 的大小写不敏感仅对 ASCII 生效，CJK 本无大小写。

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags};

use crate::model::PromptHistoryEntry;

/// 提示词搜索的默认返回条数（CONTRACT §13.2）。
pub const DEFAULT_SEARCH_LIMIT: u32 = 200;

/// 解析 history.db 路径：`OMP_RESUME_HISTORY_DB` > `$HOME/.omp/agent/history.db`。
pub fn resolve_db_path() -> PathBuf {
    if let Some(p) = std::env::var_os("OMP_RESUME_HISTORY_DB") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(".omp/agent/history.db")
}

/// 只读打开；库不存在或无法打开 ⇒ `None`（不创建文件）。
fn open_readonly(db: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    // omp 可能正在写入（WAL）：短暂等待锁，避免偶发 BUSY 被静默成空结果。
    conn.busy_timeout(Duration::from_millis(500)).ok()?;
    Some(conn)
}

/// 会话最新一条 recap（按 `created_at`、`id` 取最大）。无 / 空白 / 出错 ⇒ `None`。
pub fn session_recap(db: &Path, session_id: &str) -> Option<String> {
    let conn = open_readonly(db)?;
    conn.query_row(
        "SELECT recap FROM session_recaps WHERE session_id = ?1 \
         ORDER BY created_at DESC, id DESC LIMIT 1",
        [session_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|recap| !recap.trim().is_empty())
}

/// 提示词历史搜索，按 `created_at` 降序。`query` 为空白或 `None` ⇒ 不过滤。
/// 出错 ⇒ 空列表（静默）。
pub fn search_prompts(db: &Path, query: Option<&str>, limit: u32) -> Vec<PromptHistoryEntry> {
    let Some(conn) = open_readonly(db) else {
        return Vec::new();
    };
    let pattern = query
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(like_pattern);
    query_entries(&conn, pattern, limit).unwrap_or_default()
}

/// 把用户输入转为 `LIKE` 子串模式：转义 `\`、`%`、`_`（SQL 中配合 `ESCAPE '\'`），
/// 两端加 `%`。
fn like_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for c in query.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn query_entries(
    conn: &Connection,
    pattern: Option<String>,
    limit: u32,
) -> rusqlite::Result<Vec<PromptHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(prompt, ''), cwd, session_id, created_at, COALESCE(use_count, 0) \
         FROM history \
         WHERE ?1 IS NULL OR prompt LIKE ?1 ESCAPE '\\' \
         ORDER BY created_at DESC, id DESC \
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pattern, limit], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, prompt, cwd, session_id, created, use_count) = row?;
        // 时间戳缺失或越界的行直接跳过（不影响其他行）。
        let Some(created_at) = created.and_then(iso_millis_utc) else {
            continue;
        };
        out.push(PromptHistoryEntry {
            id,
            prompt,
            cwd: non_empty(cwd),
            session_id: non_empty(session_id),
            created_at,
            use_count,
        });
    }
    Ok(out)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

/// history 的 `created_at` 为秒级 epoch；输出 ISO-8601 UTC 毫秒（CONTRACT 时间约定）。
fn iso_millis_utc(secs: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(secs, 0).map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
}
