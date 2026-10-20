//! 记忆库行级只读：列表/详情（CONTRACT §18.2–§18.3）。
//!
//! SQL 内 `COUNT` / `LIMIT` / `OFFSET` / `GROUP BY`，列表不读全文；
//! 缺表/缺列降级；`sessions` 目录每命令调用至多扫描一次。

use std::collections::HashSet;
use std::path::Path;

use chrono::Utc;
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;

use super::{
    col_or_null, io, iso_millis_opt, like_pattern, make_snippet, metadata_field, metadata_object,
    not_found, open_readonly, parse_memory_ts, scan_session_uuids, table_schema, truncate_bytes,
    unreadable_reason, validate_bank, TableSchema, CONTENT_CAP_BYTES, DB_FILENAME,
    DETAIL_FACTS_LIMIT, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, SNIPPET_SQL_PREFIX,
};
use crate::model::{
    AppError, MemoryDetail, MemoryFact, MemoryItem, MemoryKind, MemoryKindFilter, MemoryPage,
    MemorySort,
};

/// `memory_list` 参数（`Default` 即全部缺省）。
pub struct ListParams {
    pub bank: String,
    pub query: Option<String>,
    pub kind: MemoryKindFilter,
    pub only_never_recalled: bool,
    pub only_unconsolidated: bool,
    pub only_missing_source: bool,
    pub sort: MemorySort,
    pub limit: i64,
    pub offset: i64,
}

impl Default for ListParams {
    fn default() -> Self {
        Self {
            bank: String::new(),
            query: None,
            kind: MemoryKindFilter::All,
            only_never_recalled: false,
            only_unconsolidated: false,
            only_missing_source: false,
            sort: MemorySort::Newest,
            limit: LIST_LIMIT_DEFAULT,
            offset: 0,
        }
    }
}

/// UNION 后的统一行。
struct FetchedRow {
    kind: MemoryKind,
    id: String,
    snippet_src: String,
    content_len: i64,
    timestamp: Option<String>,
    metadata: Option<String>,
    recall_count: Option<i64>,
    last_recalled: Option<String>,
    importance: Option<f64>,
    veracity: Option<String>,
    memory_type: Option<String>,
    consolidated_at: Option<String>,
    valid_until: Option<String>,
    superseded_by: Option<String>,
}

impl FetchedRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let kind_text: String = row.get(0)?;
        Ok(Self {
            kind: if kind_text == "episodic" {
                MemoryKind::Episodic
            } else {
                MemoryKind::Working
            },
            id: row.get(1)?,
            snippet_src: row.get(2)?,
            content_len: row.get(3)?,
            timestamp: row.get(4)?,
            metadata: row.get(5)?,
            recall_count: row.get(6)?,
            last_recalled: row.get(7)?,
            importance: row.get(8)?,
            veracity: row.get(9)?,
            memory_type: row.get(10)?,
            consolidated_at: row.get(11)?,
            valid_until: row.get(12)?,
            superseded_by: row.get(13)?,
        })
    }

    /// 组装 `MemoryItem`（`source_session_exists` 由调用方回填）。
    fn into_item(self, now: &chrono::DateTime<Utc>) -> MemoryItem {
        MemoryItem {
            id: self.id,
            kind: self.kind,
            snippet: make_snippet(&self.snippet_src, self.content_len.max(0) as u64),
            content_chars: self.content_len.max(0) as u64,
            created_at: iso_millis_opt(self.timestamp.as_deref()),
            source_session_id: metadata_field(self.metadata.as_deref(), "session_id"),
            source_session_exists: None,
            recall_count: self.recall_count.unwrap_or(0),
            last_recalled_at: iso_millis_opt(self.last_recalled.as_deref()),
            importance: self.importance.filter(|v| v.is_finite()),
            veracity: self.veracity,
            memory_type: self.memory_type,
            consolidated: consolidated_of(self.kind, self.consolidated_at.as_deref()),
            superseded: is_superseded(
                self.valid_until.as_deref(),
                self.superseded_by.as_deref(),
                now,
            ),
        }
    }
}

/// `superseded`：`superseded_by` 非空，或 `valid_until` 可解析且早于 now。
fn is_superseded(
    valid_until: Option<&str>,
    superseded_by: Option<&str>,
    now: &chrono::DateTime<Utc>,
) -> bool {
    if superseded_by.is_some_and(|s| !s.is_empty()) {
        return true;
    }
    valid_until
        .and_then(parse_memory_ts)
        .is_some_and(|dt| dt < *now)
}

/// working = `consolidated_at` 非空；episodic 恒 true。
fn consolidated_of(kind: MemoryKind, at: Option<&str>) -> bool {
    match kind {
        MemoryKind::Working => at.is_some_and(|s| !s.is_empty()),
        MemoryKind::Episodic => true,
    }
}

/// 单表 SELECT 的统一列（`id` / `content` 为调用方已保证的前提）。
fn union_select(table: &str, kind: &str, schema: &TableSchema) -> String {
    let cols = [
        "timestamp",
        "metadata_json",
        "recall_count",
        "last_recalled",
        "importance",
        "veracity",
        "memory_type",
        "consolidated_at",
        "valid_until",
        "superseded_by",
    ]
    .map(|c| col_or_null(schema, c));
    format!(
        "SELECT '{kind}' AS kind, id, substr(content, 1, {SNIPPET_SQL_PREFIX}) AS snippet_src, \
         LENGTH(content) AS content_len, {} FROM \"{table}\"",
        cols.join(", "),
    )
}

/// 单表 WHERE 子句。
fn where_clauses(
    params: &ListParams,
    pattern: Option<&str>,
    schema: &TableSchema,
    is_working: bool,
    sessions: Option<&HashSet<String>>,
) -> (String, Vec<SqlValue>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if let Some(p) = pattern {
        if schema.has("embed_text") {
            clauses
                .push("(content LIKE ? ESCAPE '\\' OR embed_text LIKE ? ESCAPE '\\')".to_owned());
            values.push(SqlValue::Text(p.to_owned()));
            values.push(SqlValue::Text(p.to_owned()));
        } else {
            clauses.push("content LIKE ? ESCAPE '\\'".to_owned());
            values.push(SqlValue::Text(p.to_owned()));
        }
    }
    if params.only_never_recalled && schema.has("recall_count") {
        clauses.push("COALESCE(recall_count, 0) = 0".to_owned());
    }
    if params.only_unconsolidated {
        if is_working && schema.has("consolidated_at") {
            clauses.push("consolidated_at IS NULL".to_owned());
        } else {
            // episodic 永不命中；working 缺列时命中 0 行。
            clauses.push("0".to_owned());
        }
    }
    if params.only_missing_source {
        if !schema.has("metadata_json") {
            clauses.push("0".to_owned());
        } else {
            // 脏 JSON 会让 `json_extract` / `json_type` 直接报错，故先 `json_valid` 守卫；
            // `json_type = 'text'` 与 Rust 侧“非字符串 ⇒ None”一致。
            let sid = "(CASE WHEN json_valid(metadata_json) \
                       THEN json_extract(metadata_json, '$.session_id') ELSE NULL END)";
            let typ = "(CASE WHEN json_valid(metadata_json) \
                       THEN json_type(metadata_json, '$.session_id') ELSE NULL END)";
            let mut clause = format!("({sid} IS NOT NULL AND {sid} != '' AND {typ} = 'text'");
            match sessions.filter(|s| !s.is_empty()) {
                Some(set) => {
                    let ph = set.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                    clause.push_str(&format!(" AND {sid} NOT IN ({ph}))"));
                    let mut ids: Vec<&String> = set.iter().collect();
                    ids.sort();
                    values.extend(ids.into_iter().cloned().map(SqlValue::Text));
                }
                None => clause.push(')'),
            }
            clauses.push(clause);
        }
    }
    if clauses.is_empty() {
        (String::new(), values)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), values)
    }
}

/// NULL / 空 timestamp 恒排最后；次级 kind 再 id，保证分页稳定。
fn order_by(sort: MemorySort) -> &'static str {
    match sort {
        MemorySort::Newest => {
            "(timestamp IS NULL OR timestamp = '') ASC, timestamp DESC, kind ASC, id ASC"
        }
        MemorySort::Oldest => {
            "(timestamp IS NULL OR timestamp = '') ASC, timestamp ASC, kind ASC, id ASC"
        }
        MemorySort::MostRecalled => "COALESCE(recall_count, 0) DESC, kind ASC, id ASC",
    }
}

/// 打开 bank 库（校验 + 只读打开），失败语义见 CONTRACT §18.2。
fn open_bank_db(root: &Path, bank: &str) -> Result<Connection, AppError> {
    let dir = validate_bank(root, bank)?;
    let db = dir.join(DB_FILENAME);
    open_readonly(&db).ok_or_else(|| io(unreadable_reason(&db)))
}

/// CONTRACT §18.2 实现（同步，调用方包 `spawn_blocking`）。
pub fn list_impl(
    root: &Path,
    sessions_dir: &Path,
    params: &ListParams,
) -> Result<MemoryPage, AppError> {
    let conn = open_bank_db(root, &params.bank)?;
    let wm = table_schema(&conn, "working_memory");
    let em = table_schema(&conn, "episodic_memory");
    let want = |k: MemoryKindFilter| params.kind == MemoryKindFilter::All || params.kind == k;
    let mut union_sql = String::new();
    let mut filter_values: Vec<SqlValue> = Vec::new();
    // `onlyMissingSource` 的会话集合（本命令内至多扫一次）。
    let sessions: Option<HashSet<String>> = params
        .only_missing_source
        .then(|| scan_session_uuids(sessions_dir));
    for (table, kind, schema, wanted) in [
        (
            "working_memory",
            "working",
            &wm,
            want(MemoryKindFilter::Working),
        ),
        (
            "episodic_memory",
            "episodic",
            &em,
            want(MemoryKindFilter::Episodic),
        ),
    ] {
        // 可查侧：表存在且有 `id` + `content`。
        if !(wanted && schema.exists && schema.has("id") && schema.has("content")) {
            continue;
        }
        if !union_sql.is_empty() {
            union_sql.push_str(" UNION ALL ");
        }
        let pattern = params
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(like_pattern);
        let (where_sql, mut values) = where_clauses(
            params,
            pattern.as_deref(),
            schema,
            table == "working_memory",
            sessions.as_ref(),
        );
        union_sql.push_str(&union_select(table, kind, schema));
        union_sql.push_str(&where_sql);
        filter_values.append(&mut values);
    }
    if union_sql.is_empty() {
        // 两表皆无 ⇒ 不可读；仅 kind 指向缺失侧 ⇒ 空页。
        if !wm.exists && !em.exists {
            return Err(io("缺少记忆表"));
        }
        return Ok(MemoryPage {
            total: 0,
            items: Vec::new(),
        });
    }
    let limit = params.limit.clamp(1, LIST_LIMIT_MAX);
    let offset = params.offset.max(0);
    let list_err = || io("查询记忆列表失败");
    let total: u64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM ({union_sql})"),
            rusqlite::params_from_iter(filter_values.iter()),
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n.max(0) as u64)
        .map_err(|_| list_err())?;
    let sql = format!(
        "SELECT kind, id, snippet_src, content_len, timestamp, metadata_json, recall_count, \
         last_recalled, importance, veracity, memory_type, consolidated_at, valid_until, \
         superseded_by FROM ({union_sql}) ORDER BY {order} LIMIT ? OFFSET ?",
        order = order_by(params.sort),
    );
    let mut page_values = filter_values;
    page_values.push(SqlValue::Integer(limit));
    page_values.push(SqlValue::Integer(offset));
    let mut stmt = conn.prepare(&sql).map_err(|_| list_err())?;
    let fetched = stmt
        .query_map(
            rusqlite::params_from_iter(page_values.iter()),
            FetchedRow::from_row,
        )
        .map_err(|_| list_err())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| list_err())?;
    let now = Utc::now();
    let mut items: Vec<MemoryItem> = fetched.into_iter().map(|r| r.into_item(&now)).collect();
    // 来源存在性：已有集合直接用，否则仅当页内有会话 id 时才扫一次。
    if items.iter().any(|i| i.source_session_id.is_some()) {
        let fresh: HashSet<String>;
        let lookup = match sessions.as_ref() {
            Some(s) => s,
            None => {
                fresh = scan_session_uuids(sessions_dir);
                &fresh
            }
        };
        for item in &mut items {
            if let Some(sid) = item.source_session_id.as_deref() {
                item.source_session_exists = Some(lookup.contains(sid));
            }
        }
    }
    Ok(MemoryPage { total, items })
}

/// 详情 SELECT 列（`content` 缺失则该表不可查）。
fn detail_select(table: &str, schema: &TableSchema, want_summary: bool) -> Option<String> {
    if !schema.exists || !schema.has("id") || !schema.has("content") {
        return None;
    }
    let cols = [
        "content",
        "embed_text",
        "timestamp",
        "metadata_json",
        "recall_count",
        "last_recalled",
        "importance",
        "veracity",
        "memory_type",
        "consolidated_at",
        "valid_until",
        "superseded_by",
    ]
    .map(|c| col_or_null(schema, c));
    let mut select = cols.join(", ");
    if want_summary {
        select.push_str(&format!(", {}", col_or_null(schema, "summary_of")));
    }
    Some(format!(
        "SELECT {select} FROM \"{table}\" WHERE id = ?1 LIMIT 1"
    ))
}

/// 详情行（全文，未截断）。
struct DetailRow {
    kind: MemoryKind,
    content: Option<String>,
    embed_text: Option<String>,
    timestamp: Option<String>,
    metadata: Option<String>,
    recall_count: Option<i64>,
    last_recalled: Option<String>,
    importance: Option<f64>,
    veracity: Option<String>,
    memory_type: Option<String>,
    consolidated_at: Option<String>,
    valid_until: Option<String>,
    superseded_by: Option<String>,
    summary_of: Option<String>,
}

/// 查 `facts` / `memoria_facts` 反向引用（facts 在前，各按 rowid 升序）。
fn detail_facts(conn: &Connection, id: &str) -> Vec<MemoryFact> {
    // （表，引用列，[取列 0/1/2]，是否 memoria 形态）。
    let sources = [
        (
            "facts",
            "source_msg_id",
            ["subject", "predicate", "object"],
            false,
        ),
        (
            "memoria_facts",
            "source_memory_id",
            ["fact_type", "value", "key"],
            true,
        ),
    ];
    let mut out = Vec::new();
    for (table, refcol, cols, memoria) in sources {
        if out.len() as i64 >= DETAIL_FACTS_LIMIT {
            break;
        }
        let schema = table_schema(conn, table);
        if !schema.has(refcol) {
            continue;
        }
        let sel = cols.map(|c| col_or_null(&schema, c));
        let sql = format!(
            "SELECT {}, {}, {} FROM \"{table}\" WHERE {refcol} = ?1 ORDER BY rowid LIMIT {}",
            sel[0],
            sel[1],
            sel[2],
            DETAIL_FACTS_LIMIT - out.len() as i64,
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map([id], |row| {
                let a: Option<String> = row.get(0)?;
                let b: Option<String> = row.get(1)?;
                let c: Option<String> = row.get(2)?;
                Ok(if memoria {
                    MemoryFact {
                        subject: None,
                        predicate: a,
                        object: b,
                        key: c,
                    }
                } else {
                    MemoryFact {
                        subject: a,
                        predicate: b,
                        object: c,
                        key: None,
                    }
                })
            }) {
                out.extend(rows.flatten());
            }
        }
    }
    out
}

/// CONTRACT §18.3 实现（同步，调用方包 `spawn_blocking`）。
pub fn detail_impl(
    root: &Path,
    sessions_dir: &Path,
    bank: &str,
    id: &str,
) -> Result<MemoryDetail, AppError> {
    let conn = open_bank_db(root, bank)?;
    let wm = table_schema(&conn, "working_memory");
    let em = table_schema(&conn, "episodic_memory");
    if !wm.exists && !em.exists {
        return Err(io("缺少记忆表"));
    }
    let mut found: Option<DetailRow> = None;
    for (table, kind, schema, want_summary) in [
        ("working_memory", MemoryKind::Working, &wm, false),
        ("episodic_memory", MemoryKind::Episodic, &em, true),
    ] {
        let Some(sql) = detail_select(table, schema, want_summary) else {
            continue;
        };
        let row = conn.query_row(&sql, [id], |r| {
            Ok(DetailRow {
                kind,
                content: r.get(0)?,
                embed_text: r.get(1)?,
                timestamp: r.get(2)?,
                metadata: r.get(3)?,
                recall_count: r.get(4)?,
                last_recalled: r.get(5)?,
                importance: r.get(6)?,
                veracity: r.get(7)?,
                memory_type: r.get(8)?,
                consolidated_at: r.get(9)?,
                valid_until: r.get(10)?,
                superseded_by: r.get(11)?,
                summary_of: if want_summary { r.get(12)? } else { None },
            })
        });
        match row {
            Ok(detail) => {
                found = Some(detail);
                break;
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(_) => return Err(io("查询记忆详情失败")),
        }
    }
    let row = found.ok_or_else(|| not_found("记忆不存在"))?;
    let now = Utc::now();
    let content_full = row.content.unwrap_or_default();
    let content_chars = content_full.chars().count() as u64;
    let (content, truncated) = truncate_bytes(&content_full, CONTENT_CAP_BYTES);
    let embed_text = match row.embed_text {
        Some(e) if e != content_full => Some(truncate_bytes(&e, CONTENT_CAP_BYTES).0),
        _ => None,
    };
    let source_session_id = metadata_field(row.metadata.as_deref(), "session_id");
    let source_session_exists = source_session_id
        .as_deref()
        .map(|sid| scan_session_uuids(sessions_dir).contains(sid));
    let summary_of: Vec<String> = match row.kind {
        MemoryKind::Episodic => row
            .summary_of
            .as_deref()
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        MemoryKind::Working => Vec::new(),
    };
    let edges = table_schema(&conn, "graph_edges");
    let related_edges: u64 = if edges.has("source") && edges.has("target") {
        conn.query_row(
            "SELECT COUNT(*) FROM graph_edges WHERE source = ?1 OR target = ?1",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
    } else {
        0
    };
    Ok(MemoryDetail {
        item: MemoryItem {
            id: id.to_owned(),
            kind: row.kind,
            snippet: make_snippet(&content_full, content_chars),
            content_chars,
            created_at: iso_millis_opt(row.timestamp.as_deref()),
            source_session_id,
            source_session_exists,
            recall_count: row.recall_count.unwrap_or(0),
            last_recalled_at: iso_millis_opt(row.last_recalled.as_deref()),
            importance: row.importance.filter(|v| v.is_finite()),
            veracity: row.veracity,
            memory_type: row.memory_type,
            consolidated: consolidated_of(row.kind, row.consolidated_at.as_deref()),
            superseded: is_superseded(
                row.valid_until.as_deref(),
                row.superseded_by.as_deref(),
                &now,
            ),
        },
        content,
        truncated,
        embed_text,
        metadata: metadata_object(row.metadata.as_deref()),
        facts: detail_facts(&conn, id),
        summary_of,
        related_edges,
    })
}
