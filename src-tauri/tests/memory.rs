//! 记忆库只读命令（CONTRACT §18）：合成 bank 库 fixture，不碰真实 `~/.omp`。
//!
//! DDL 取自上游 `packages/mnemopi/src/core/beam/schema.ts`（v18.12.3）的表结构；
//! 内容全为合成文本。真实数据回归见文末 `real_data_readonly`（`#[ignore]`，
//! 只打印计数与耗时）。

use std::path::{Path, PathBuf};

use omp_resume_lib::memory::rows::{detail_impl, growth_impl, list_impl, ListParams};
use omp_resume_lib::memory::{overview_impl, CONTENT_CAP_BYTES};
use omp_resume_lib::model::{ErrorCode, MemoryKindFilter, MemorySort};
use rusqlite::{params, Connection};

/// 上游 `initBeam` / `EpisodicGraph` 的建表语句（只含读路径用到的表）。
const SCHEMA: &str = "
CREATE TABLE working_memory (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embed_text TEXT DEFAULT NULL,
    source TEXT,
    timestamp TEXT,
    session_id TEXT DEFAULT 'default',
    importance REAL DEFAULT 0.5,
    metadata_json TEXT,
    veracity TEXT DEFAULT 'unknown',
    memory_type TEXT DEFAULT 'unknown',
    consolidated_at TEXT,
    recall_count INTEGER DEFAULT 0,
    last_recalled TIMESTAMP DEFAULT NULL,
    valid_until TIMESTAMP DEFAULT NULL,
    superseded_by TEXT DEFAULT NULL,
    scope TEXT DEFAULT 'global',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE episodic_memory (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    timestamp TEXT,
    session_id TEXT DEFAULT 'default',
    importance REAL DEFAULT 0.5,
    metadata_json TEXT,
    summary_of TEXT DEFAULT '',
    veracity TEXT DEFAULT 'unknown',
    tier INTEGER DEFAULT 1,
    memory_type TEXT DEFAULT 'unknown',
    binary_vector BLOB,
    recall_count INTEGER DEFAULT 0,
    last_recalled TIMESTAMP DEFAULT NULL,
    valid_until TIMESTAMP DEFAULT NULL,
    superseded_by TEXT DEFAULT NULL,
    scope TEXT DEFAULT 'global',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE facts (
    fact_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    timestamp TEXT,
    source_msg_id TEXT,
    confidence REAL DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE memoria_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT DEFAULT 'default',
    message_idx INTEGER,
    fact_type TEXT,
    key TEXT,
    value TEXT,
    context_snippet TEXT,
    importance REAL DEFAULT 0.5,
    timestamp TEXT,
    source_memory_id TEXT
);
CREATE TABLE graph_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    timestamp TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, target, edge_type)
);
";

fn make_bank(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mnemopi.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    db
}

#[allow(clippy::too_many_arguments)]
fn add_working(
    db: &Path,
    id: &str,
    content: &str,
    timestamp: Option<&str>,
    metadata: Option<&str>,
    recall: i64,
    consolidated: Option<&str>,
    extra: Option<(&str, &str)>,
) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO working_memory (id, content, timestamp, metadata_json, recall_count, \
         consolidated_at, valid_until, superseded_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            content,
            timestamp,
            metadata,
            recall,
            consolidated,
            extra.map(|e| e.0),
            extra.and_then(|e| if e.1.is_empty() { None } else { Some(e.1) }),
        ],
    )
    .unwrap();
}

fn add_episodic(
    db: &Path,
    id: &str,
    content: &str,
    timestamp: Option<&str>,
    metadata: Option<&str>,
    recall: i64,
    summary_of: &str,
) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO episodic_memory (id, content, timestamp, metadata_json, recall_count, summary_of) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, content, timestamp, metadata, recall, summary_of],
    )
    .unwrap();
}

fn add_fact(db: &Path, fact_id: &str, source_msg_id: &str) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) \
         VALUES (?1, 'bank', ?2, ?3, ?4, ?5)",
        params![
            fact_id,
            format!("sub-{fact_id}"),
            format!("pred-{fact_id}"),
            format!("obj-{fact_id}"),
            source_msg_id
        ],
    )
    .unwrap();
}

fn add_memoria_fact(db: &Path, key: &str, value: &str, source_memory_id: &str) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO memoria_facts (fact_type, key, value, source_memory_id) VALUES ('pref', ?1, ?2, ?3)",
        params![key, value, source_memory_id],
    )
    .unwrap();
}

fn add_edge(db: &Path, source: &str, target: &str) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO graph_edges (source, target, edge_type) VALUES (?1, ?2, 'linked')",
        params![source, target],
    )
    .unwrap();
}

fn meta(cwd: &str, sid: &str) -> String {
    format!(r#"{{"cwd":"{cwd}","session_id":"{sid}","message_count":3}}"#)
}

fn sessions_dir(tmp: &Path) -> PathBuf {
    let dir = tmp.join("sessions");
    std::fs::create_dir_all(dir.join("-proj")).unwrap();
    dir
}

fn add_session_file(sessions: &Path, uuid: &str) {
    let name = format!("2026-10-14T02-18-47-387Z_{uuid}.jsonl");
    std::fs::write(sessions.join("-proj").join(name), "{}\n").unwrap();
}

fn list_params(bank: &str) -> ListParams {
    ListParams {
        bank: bank.to_owned(),
        ..ListParams::default()
    }
}

#[test]
fn overview_missing_root_is_empty_state_not_error() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("no-such-banks");
    let sessions = sessions_dir(tmp.path());
    let over = overview_impl(&root, &sessions).unwrap();
    assert!(!over.available);
    assert_eq!(over.banks.len(), 0);
    assert_eq!(over.totals.banks, 0);
    assert_eq!(over.totals.working, 0);
    assert!(over.root.ends_with("no-such-banks"));
}

#[test]
fn overview_multi_bank_counts_sort_and_cwd() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let sessions = sessions_dir(tmp.path());
    let sid_present = "01a13834-1111-2222-3333-444444444444";
    let sid_missing = "02b24945-1111-2222-3333-444444444444";
    add_session_file(&sessions, sid_present);

    // 真实存在的 cwd（断言 cwdExists=true）与不存在的 cwd。
    let real_cwd = tmp.path().join("proj");
    std::fs::create_dir_all(&real_cwd).unwrap();
    let real_cwd = real_cwd.to_str().unwrap().to_owned();

    let db_new = make_bank(&root, "alpha-aaa111");
    add_working(
        &db_new,
        "w1",
        "first",
        Some("2026-10-10T10:00:00.000Z"),
        Some(&meta(&real_cwd, sid_present)),
        0,
        None,
        None,
    );
    add_working(
        &db_new,
        "w2",
        "second",
        Some("2026-10-12T10:00:00.000Z"),
        Some(&meta(&real_cwd, sid_missing)),
        3,
        Some("2026-10-12T11:00:00.000Z"),
        None,
    );
    add_episodic(
        &db_new,
        "e1",
        "epi",
        Some("2026-10-11T10:00:00.000Z"),
        Some(&meta("/gone/proj", sid_present)),
        0,
        "w1",
    );
    add_fact(&db_new, "f1", "w1");

    let db_old = make_bank(&root, "beta-bbb222");
    add_working(
        &db_old,
        "w9",
        "old",
        Some("2026-09-01T10:00:00.000Z"),
        None,
        0,
        None,
        None,
    );
    // 空 bank（有库无行）与坏 bank（垃圾文件）。
    make_bank(&root, "empty-ccc333");
    let bad_dir = root.join("broken-ddd444");
    std::fs::create_dir_all(&bad_dir).unwrap();
    std::fs::write(bad_dir.join("mnemopi.db"), b"not a database").unwrap();

    let over = overview_impl(&root, &sessions).unwrap();
    assert!(over.available);
    assert_eq!(over.totals.banks, 4);
    assert_eq!(over.totals.working, 3);
    assert_eq!(over.totals.episodic, 1);
    assert_eq!(over.totals.facts, 1);
    // 排序：lastMemoryAt 倒序；空/坏 bank 沉底（lastMemoryAt 均为 null 时按名）。
    let names: Vec<&str> = over.banks.iter().map(|b| b.bank.as_str()).collect();
    assert_eq!(
        names,
        [
            "alpha-aaa111",
            "beta-bbb222",
            "broken-ddd444",
            "empty-ccc333"
        ]
    );

    let alpha = &over.banks[0];
    assert_eq!(alpha.display_name, "proj");
    assert_eq!(alpha.cwd.as_deref(), Some(real_cwd.as_str()));
    assert_eq!(alpha.cwd_exists, Some(true));
    assert_eq!(
        alpha.first_memory_at.as_deref(),
        Some("2026-10-10T10:00:00.000Z")
    );
    assert_eq!(
        alpha.last_memory_at.as_deref(),
        Some("2026-10-12T10:00:00.000Z")
    );
    assert_eq!(alpha.never_recalled, 2); // w1 + e1
    assert_eq!(alpha.unconsolidated, 1); // w1
    assert_eq!(alpha.source_sessions, 2);
    assert_eq!(alpha.missing_source_sessions, 1); // sid_missing
    assert!(alpha.bytes > 0);
    assert!(alpha.readable);
    assert_eq!(alpha.error, None);

    let beta = &over.banks[1];
    // cwd 未知 ⇒ displayName 去 hash 后缀。
    assert_eq!(beta.display_name, "beta");
    assert_eq!(beta.cwd, None);
    assert_eq!(beta.cwd_exists, None);
    assert_eq!(beta.source_sessions, 0);

    let broken = &over.banks[2];
    assert!(!broken.readable);
    assert!(broken.error.is_some());
    assert_eq!(broken.working, 0);
    let empty = &over.banks[3];
    assert!(empty.readable);
    assert_eq!(empty.working, 0);
    assert_eq!(empty.last_memory_at, None);
}

#[test]
fn overview_cwd_points_at_missing_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "gone-xyz9");
    add_working(
        &db,
        "w1",
        "x",
        Some("2026-10-10T10:00:00.000Z"),
        Some(&meta("/definitely/not/here-omp-resume", "s")),
        0,
        None,
        None,
    );
    let over = overview_impl(&root, &tmp.path().join("sessions")).unwrap();
    assert_eq!(over.banks[0].cwd_exists, Some(false));
    assert_eq!(over.banks[0].display_name, "here-omp-resume");
}

#[test]
fn overview_degrades_missing_columns_and_tables() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    // 缺 recall_count / consolidated_at / metadata_json / facts 表。
    let dir = root.join("thin-1");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mnemopi.db");
    Connection::open(&db)
        .unwrap()
        .execute_batch(
            "CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, timestamp TEXT); \
             CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT);",
        )
        .unwrap();
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO working_memory (id, content) VALUES ('w1', 'x')",
            [],
        )
        .unwrap();

    let over = overview_impl(&root, &tmp.path().join("sessions")).unwrap();
    let b = &over.banks[0];
    assert!(b.readable);
    assert_eq!(b.working, 1);
    assert_eq!(b.facts, 0);
    // recall 列缺失 ⇒ 全算 neverRecalled；consolidated 列缺失 ⇒ 0。
    assert_eq!(b.never_recalled, 1);
    assert_eq!(b.unconsolidated, 0);
    assert_eq!(b.cwd, None);
    assert_eq!(b.source_sessions, 0);
}

#[test]
fn overview_bank_with_no_memory_tables_is_unreadable() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let dir = root.join("odd-1");
    std::fs::create_dir_all(&dir).unwrap();
    Connection::open(dir.join("mnemopi.db"))
        .unwrap()
        .execute_batch("CREATE TABLE something_else (id INTEGER);")
        .unwrap();
    let over = overview_impl(&root, &tmp.path().join("sessions")).unwrap();
    assert!(!over.banks[0].readable);
    assert_eq!(over.banks[0].error.as_deref(), Some("缺少记忆表"));
    assert_eq!(over.totals.working, 0);
}

#[test]
fn overview_single_table_bank_stays_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let dir = root.join("half-1");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mnemopi.db");
    Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT);")
        .unwrap();
    let over = overview_impl(&root, &tmp.path().join("sessions")).unwrap();
    assert!(over.banks[0].readable);
    assert_eq!(over.banks[0].episodic, 0);
}

#[test]
fn list_paging_sort_and_kind() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    for (i, ts, recall) in [
        (1, "2026-10-10T10:00:00.000Z", 5),
        (2, "2026-10-11T10:00:00.000Z", 0),
        (3, "2026-10-12T10:00:00.000Z", 9),
    ] {
        add_working(
            &db,
            &format!("w{i}"),
            &format!("content {i}"),
            Some(ts),
            None,
            recall,
            None,
            None,
        );
    }
    add_episodic(
        &db,
        "e1",
        "epi",
        Some("2026-10-13T10:00:00.000Z"),
        None,
        1,
        "",
    );
    let sessions = sessions_dir(tmp.path());

    // newest 全量顺序。
    let mut p = list_params("b-1");
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 4);
    assert_eq!(
        page.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["e1", "w3", "w2", "w1"]
    );
    // 分页：total 不变，offset 生效。
    p.limit = 2;
    p.offset = 1;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 4);
    assert_eq!(
        page.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["w3", "w2"]
    );
    // oldest。
    p.limit = 50;
    p.offset = 0;
    p.sort = MemorySort::Oldest;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(
        page.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["w1", "w2", "w3", "e1"]
    );
    // mostRecalled：9,5,1,0。
    p.sort = MemorySort::MostRecalled;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(
        page.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["w3", "w1", "e1", "w2"]
    );
    // kind 过滤。
    p.sort = MemorySort::Newest;
    p.kind = MemoryKindFilter::Working;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 3);
    p.kind = MemoryKindFilter::Episodic;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 1);
}

#[test]
fn list_null_timestamp_sorts_last() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    add_working(
        &db,
        "w1",
        "a",
        Some("2026-10-10T10:00:00.000Z"),
        None,
        0,
        None,
        None,
    );
    add_working(&db, "w2", "b", None, None, 0, None, None);
    let sessions = sessions_dir(tmp.path());
    let p = list_params("b-1");
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(
        page.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["w1", "w2"]
    );
    assert_eq!(page.items[1].created_at, None);
}

#[test]
fn list_query_matches_cjk_substring_and_escapes_wildcards() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    // CJK 长串内部子串（FTS token 边界对不齐，LIKE 必须命中）。
    add_working(
        &db,
        "w1",
        "合成记忆内容用于测试搜索",
        Some("2026-10-10T10:00:00.000Z"),
        None,
        0,
        None,
        None,
    );
    add_working(
        &db,
        "w2",
        "100% coverage_guaranteed",
        Some("2026-10-11T10:00:00.000Z"),
        None,
        0,
        None,
        None,
    );
    add_working(
        &db,
        "w3",
        "plain text",
        Some("2026-10-12T10:00:00.000Z"),
        None,
        0,
        None,
        None,
    );
    let sessions = sessions_dir(tmp.path());

    let mut p = list_params("b-1");
    p.query = Some("记忆内容".to_owned());
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].id, "w1");

    // `%` / `_` 按字面量匹配，不做通配。
    p.query = Some("100%".to_owned());
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].id, "w2");
    p.query = Some("coverage_guaranteed".to_owned());
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 1);
    // 反斜杠字面量：库里没有反斜杠 ⇒ 0 条（且 SQL 不报错）。
    p.query = Some("a\\b".to_owned());
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 0);
    // 空白 query = 不过滤。
    p.query = Some("   ".to_owned());
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 3);
}

#[test]
fn list_query_also_matches_embed_text() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO working_memory (id, content, embed_text) VALUES ('w1', 'visible', 'hidden-marker')",
        [],
    )
    .unwrap();
    drop(conn);
    let sessions = sessions_dir(tmp.path());
    let mut p = list_params("b-1");
    p.query = Some("hidden-marker".to_owned());
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 1);
}

#[test]
fn list_filters_never_recalled_unconsolidated_missing_source() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let sessions = sessions_dir(tmp.path());
    let sid_present = "01a13834-1111-2222-3333-444444444444";
    let sid_missing = "02b24945-1111-2222-3333-444444444444";
    add_session_file(&sessions, sid_present);
    let db = make_bank(&root, "b-1");
    add_working(
        &db,
        "w1",
        "a",
        None,
        Some(&meta("/p", sid_missing)),
        0,
        None,
        None,
    );
    add_working(
        &db,
        "w2",
        "b",
        None,
        Some(&meta("/p", sid_present)),
        7,
        Some("2026-10-01T00:00:00.000Z"),
        None,
    );
    add_working(&db, "w3", "c", None, Some("{oops malformed"), 0, None, None);
    add_working(
        &db,
        "w4",
        "d",
        None,
        Some(r#"{"session_id":42}"#),
        0,
        None,
        None,
    );
    add_episodic(&db, "e1", "e", None, Some(&meta("/p", sid_missing)), 0, "");

    let mut p = list_params("b-1");
    p.only_never_recalled = true;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 4); // 除 w2 外全命中

    p.only_never_recalled = false;
    p.only_unconsolidated = true;
    let page = list_impl(&root, &sessions, &p).unwrap();
    // working 未巩固：w1/w3/w4；episodic 永不命中。
    assert_eq!(page.total, 3);
    assert!(page
        .items
        .iter()
        .all(|i| i.kind == omp_resume_lib::model::MemoryKind::Working));

    p.only_unconsolidated = false;
    p.only_missing_source = true;
    let page = list_impl(&root, &sessions, &p).unwrap();
    // w1 + e1（sid_missing）；脏 JSON / 数字 id 不命中且不报错。
    assert_eq!(page.total, 2);
    assert!(page
        .items
        .iter()
        .all(|i| i.source_session_id.as_deref() == Some(sid_missing)));
}

#[test]
fn list_limit_clamped_and_offset_floored() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    let conn = Connection::open(&db).unwrap();
    for i in 0..210 {
        conn.execute(
            "INSERT INTO working_memory (id, content) VALUES (?1, 'x')",
            params![format!("w{i:03}")],
        )
        .unwrap();
    }
    drop(conn);
    let sessions = sessions_dir(tmp.path());
    let mut p = list_params("b-1");
    p.limit = 500;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 210);
    assert_eq!(page.items.len(), 200);
    p.limit = 0;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.items.len(), 1);
    p.limit = 50;
    p.offset = -5;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.items.len(), 50);
}

#[test]
fn list_item_flags_snippet_and_source_existence() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let sessions = sessions_dir(tmp.path());
    let sid = "01a13834-1111-2222-3333-444444444444";
    add_session_file(&sessions, sid);
    let db = make_bank(&root, "b-1");
    let long_cjk: String = "字".repeat(300);
    let content = format!("  hello   world\n{long_cjk}  ");
    add_working(
        &db,
        "w1",
        &content,
        Some("2026-10-10T10:00:00.000Z"),
        Some(&meta("/p", sid)),
        2,
        Some("2026-10-11T00:00:00.000Z"),
        Some(("2000-01-01T00:00:00.000Z", "")),
    );
    add_working(
        &db,
        "w2",
        "future",
        Some("2026-10-10T10:00:00.000Z"),
        None,
        0,
        None,
        Some(("2999-01-01T00:00:00.000Z", "")),
    );
    add_working(
        &db,
        "w3",
        "bad-date",
        Some("2026-10-10T10:00:00.000Z"),
        None,
        0,
        None,
        Some(("not-a-date", "")),
    );
    let mut p = list_params("b-1");
    p.sort = MemorySort::Oldest;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 3);
    let w1 = &page.items[0];
    // snippet：空白折叠 + 240 字 + `…`；contentChars 为字符数。
    assert!(w1.snippet.starts_with("hello world "));
    assert!(w1.snippet.ends_with('…'));
    assert_eq!(w1.snippet.chars().count(), 241);
    assert_eq!(w1.content_chars, content.chars().count() as u64);
    assert_eq!(w1.created_at.as_deref(), Some("2026-10-10T10:00:00.000Z"));
    assert_eq!(w1.source_session_id.as_deref(), Some(sid));
    assert_eq!(w1.source_session_exists, Some(true));
    assert_eq!(w1.recall_count, 2);
    assert!(w1.consolidated);
    assert!(w1.superseded); // valid_until 过去
                            // 未来 valid_until ⇒ 未过期；脏日期 ⇒ 未过期。
    assert!(!page.items[1].superseded);
    assert!(!page.items[2].superseded);
    assert_eq!(page.items[1].source_session_exists, None);
}

#[test]
fn list_errors_bank_validation() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let sessions = sessions_dir(tmp.path());
    let mut p = list_params("../escape");
    assert_eq!(
        list_impl(&root, &sessions, &p).unwrap_err().code,
        ErrorCode::OutsideRoot
    );
    p.bank = "missing".to_owned();
    assert_eq!(
        list_impl(&root, &sessions, &p).unwrap_err().code,
        ErrorCode::NotFound
    );
    // 坏库 ⇒ IO。
    let bad = root.join("bad-1");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("mnemopi.db"), b"garbage").unwrap();
    p.bank = "bad-1".to_owned();
    assert_eq!(
        list_impl(&root, &sessions, &p).unwrap_err().code,
        ErrorCode::Io
    );
}

#[test]
fn detail_working_full_shape() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let sessions = sessions_dir(tmp.path());
    let sid = "01a13834-1111-2222-3333-444444444444";
    add_session_file(&sessions, sid);
    let db = make_bank(&root, "b-1");
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO working_memory (id, content, embed_text, timestamp, metadata_json, recall_count, \
         last_recalled, importance, veracity, memory_type, consolidated_at, superseded_by) \
         VALUES ('w1', 'full-content', 'different-embed', '2026-10-10T10:00:00.000Z', \
         '{\"cwd\":\"/p\",\"session_id\":\"01a13834-1111-2222-3333-444444444444\",\"api_key\":\"K\"}', \
         4, '2026-10-12T00:00:00.000Z', 0.9, 'stated', 'lesson', '2026-10-11T00:00:00.000Z', 'w2')",
        [],
    )
    .unwrap();
    drop(conn);
    add_fact(&db, "f1", "w1");
    add_memoria_fact(&db, "topic", "rust", "w1");
    add_edge(&db, "w1", "other");
    add_edge(&db, "other", "w1");
    add_edge(&db, "unrelated", "else");

    let d = detail_impl(&root, &sessions, "b-1", "w1").unwrap();
    assert_eq!(d.item.id, "w1");
    assert_eq!(d.item.kind, omp_resume_lib::model::MemoryKind::Working);
    assert_eq!(d.content, "full-content");
    assert!(!d.truncated);
    assert_eq!(d.embed_text.as_deref(), Some("different-embed"));
    assert_eq!(d.item.recall_count, 4);
    assert_eq!(d.item.importance, Some(0.9));
    assert_eq!(d.item.veracity.as_deref(), Some("stated"));
    assert_eq!(d.item.memory_type.as_deref(), Some("lesson"));
    assert!(d.item.consolidated);
    assert!(d.item.superseded); // superseded_by 非空
    assert_eq!(d.item.source_session_exists, Some(true));
    assert_eq!(
        d.item.last_recalled_at.as_deref(),
        Some("2026-10-12T00:00:00.000Z")
    );
    // metadata 解析 + 密钥键删除。
    let meta = d.metadata.unwrap();
    assert_eq!(meta.get("cwd").unwrap(), "/p");
    assert!(meta.get("api_key").is_none());
    // facts：facts 表在前，memoria 在后。
    assert_eq!(d.facts.len(), 2);
    assert_eq!(d.facts[0].subject.as_deref(), Some("sub-f1"));
    assert_eq!(d.facts[0].key, None);
    assert_eq!(d.facts[1].subject, None);
    assert_eq!(d.facts[1].predicate.as_deref(), Some("pref"));
    assert_eq!(d.facts[1].object.as_deref(), Some("rust"));
    assert_eq!(d.facts[1].key.as_deref(), Some("topic"));
    assert!(d.summary_of.is_empty());
    assert_eq!(d.related_edges, 2);
}

#[test]
fn detail_embed_text_identical_is_null() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO working_memory (id, content, embed_text) VALUES ('w1', 'same', 'same')",
        [],
    )
    .unwrap();
    drop(conn);
    let sessions = sessions_dir(tmp.path());
    let d = detail_impl(&root, &sessions, "b-1", "w1").unwrap();
    assert_eq!(d.embed_text, None);
}

#[test]
fn detail_episodic_summary_and_consolidated_true() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    add_episodic(
        &db,
        "e1",
        "epi",
        Some("2026-10-10T10:00:00.000Z"),
        None,
        0,
        "w1, w2,,w3 ",
    );
    let sessions = sessions_dir(tmp.path());
    let d = detail_impl(&root, &sessions, "b-1", "e1").unwrap();
    assert_eq!(d.item.kind, omp_resume_lib::model::MemoryKind::Episodic);
    assert!(d.item.consolidated);
    assert_eq!(d.summary_of, ["w1", "w2", "w3"]);
}

#[test]
fn detail_truncates_huge_content_at_char_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    // 70_000 个 `字` = 210_000 字节 > 200KB 上限。
    let huge: String = "字".repeat(70_000);
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO working_memory (id, content) VALUES ('w1', ?1)",
        params![huge],
    )
    .unwrap();
    drop(conn);
    let sessions = sessions_dir(tmp.path());
    let d = detail_impl(&root, &sessions, "b-1", "w1").unwrap();
    assert!(d.truncated);
    assert!(d.content.len() <= CONTENT_CAP_BYTES);
    assert!(d.content.len() > CONTENT_CAP_BYTES - 4);
    assert_eq!(d.item.content_chars, 70_000);
    // snippet 照常 240 + `…`。
    assert_eq!(d.item.snippet.chars().count(), 241);
}

#[test]
fn detail_facts_capped_at_50() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    add_working(&db, "w1", "x", None, None, 0, None, None);
    for i in 0..60 {
        add_fact(&db, &format!("f{i:02}"), "w1");
    }
    let sessions = sessions_dir(tmp.path());
    let d = detail_impl(&root, &sessions, "b-1", "w1").unwrap();
    assert_eq!(d.facts.len(), 50);
}

#[test]
fn detail_missing_graph_table_gives_zero_edges() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let dir = root.join("thin-1");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mnemopi.db");
    Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT);")
        .unwrap();
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO working_memory (id, content) VALUES ('w1', 'x')",
            [],
        )
        .unwrap();
    let sessions = sessions_dir(tmp.path());
    let d = detail_impl(&root, &sessions, "thin-1", "w1").unwrap();
    assert_eq!(d.related_edges, 0);
    assert!(d.facts.is_empty());
    assert!(!d.item.consolidated);
}

#[test]
fn detail_not_found_cases() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    make_bank(&root, "b-1");
    let sessions = sessions_dir(tmp.path());
    assert_eq!(
        detail_impl(&root, &sessions, "b-1", "nope")
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        detail_impl(&root, &sessions, "missing", "w1")
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        detail_impl(&root, &sessions, "..", "w1").unwrap_err().code,
        ErrorCode::OutsideRoot
    );
}

#[test]
fn growth_single_bank_zero_filled_and_validated() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    // 今天（UTC）两条 working + 一条 episodic；10 天前一条（范围外）。
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S.000Z")
        .to_string();
    let old = (chrono::Utc::now() - chrono::Duration::days(10))
        .format("%Y-%m-%dT%H:%M:%S.000Z")
        .to_string();
    add_working(&db, "w1", "a", Some(&now), None, 0, None, None);
    add_working(&db, "w2", "b", Some(&now), None, 0, None, None);
    add_working(&db, "w3", "c", Some(&old), None, 0, None, None);
    add_working(&db, "w4", "d", Some("garbage"), None, 0, None, None);
    add_episodic(&db, "e1", "e", Some(&now), None, 0, "");

    let points = growth_impl(&root, Some("b-1"), 3).unwrap();
    assert_eq!(points.len(), 3);
    // dense：日期连续。
    let days: Vec<&str> = points.iter().map(|p| p.date.as_str()).collect();
    assert_eq!(days.len(), 3);
    assert!(days[0] < days[1] && days[1] < days[2]);
    // 今天桶：working=2（UTC 今天 vs 本地今天可能差一天，取两侧最大值断言）。
    let today_working: u64 = points.iter().map(|p| p.working).sum();
    let today_episodic: u64 = points.iter().map(|p| p.episodic).sum();
    assert_eq!(today_working, 2);
    assert_eq!(today_episodic, 1);
    // 10 天前与脏时间不计入。
    assert!(points.iter().all(|p| p.working <= 2));

    assert_eq!(
        growth_impl(&root, Some("b-1"), 0).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        growth_impl(&root, Some("b-1"), 366).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        growth_impl(&root, Some("missing"), 7).unwrap_err().code,
        ErrorCode::NotFound
    );
}

#[test]
fn growth_buckets_match_local_day_convention() {
    // 23:30 UTC 在东八区是次日：分桶必须与 `usage.rs` 同约定（本地时区）。
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    // 取“本地今天 12:00”对应的 UTC 时刻，保证桶 = 本地今天（与 TZ 无关）。
    let local_noon = chrono::Local::now()
        .date_naive()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let utc = local_noon
        .and_local_timezone(chrono::Local)
        .unwrap()
        .with_timezone(&chrono::Utc);
    let ts = utc.format("%Y-%m-%dT%H:%M:%S.000Z").to_string();
    add_working(&db, "w1", "a", Some(&ts), None, 0, None, None);
    let points = growth_impl(&root, Some("b-1"), 1).unwrap();
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].working, 1);
    assert_eq!(
        points[0].date,
        chrono::Local::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string()
    );
}

#[test]
fn growth_all_banks_skips_broken_silently() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "good-1");
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S.000Z")
        .to_string();
    add_working(&db, "w1", "a", Some(&now), None, 0, None, None);
    let bad = root.join("bad-1");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("mnemopi.db"), b"garbage").unwrap();
    let points = growth_impl(&root, None, 7).unwrap();
    assert_eq!(points.len(), 7);
    assert_eq!(points.iter().map(|p| p.working).sum::<u64>(), 1);
    // 根目录缺失 ⇒ 全零（非错误）。
    let points = growth_impl(&root.join("missing"), None, 3).unwrap();
    assert_eq!(points.len(), 3);
    assert!(points.iter().all(|p| p.working == 0 && p.episodic == 0));
}

#[test]
fn reads_see_live_wal_data() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-wal");
    // 写连接保持打开：数据留在 WAL 未 checkpoint，读方必须可见。
    let writer = Connection::open(&db).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    writer
        .execute(
            "INSERT INTO working_memory (id, content, timestamp) VALUES ('w1', 'wal-only', '2026-10-10T10:00:00.000Z')",
            [],
        )
        .unwrap();
    let sessions = sessions_dir(tmp.path());
    let page = list_impl(&root, &sessions, &list_params("b-wal")).unwrap();
    assert_eq!(page.total, 1);
    let d = detail_impl(&root, &sessions, "b-wal", "w1").unwrap();
    assert_eq!(d.content, "wal-only");
    drop(writer);
    // 写连接关闭后（自动 checkpoint）仍可见。
    let page = list_impl(&root, &sessions, &list_params("b-wal")).unwrap();
    assert_eq!(page.total, 1);
}

fn dir_snapshot(root: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
                out.push((path, size));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn read_only_calls_create_no_files_and_keep_db_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    let db = make_bank(&root, "b-1");
    add_working(
        &db,
        "w1",
        "x",
        Some("2026-10-10T10:00:00.000Z"),
        None,
        0,
        None,
        None,
    );
    let sessions = sessions_dir(tmp.path());
    let before = dir_snapshot(&root);
    overview_impl(&root, &sessions).unwrap();
    list_impl(&root, &sessions, &list_params("b-1")).unwrap();
    detail_impl(&root, &sessions, "b-1", "w1").unwrap();
    growth_impl(&root, Some("b-1"), 7).unwrap();
    growth_impl(&root, None, 7).unwrap();
    let after = dir_snapshot(&root);
    // 无新文件；db 主文件字节数不变（`-shm` mtime 可能被 SQLite 刷新，属正常行为）。
    assert_eq!(before, after);
}

/// 真实库只读回归（`cargo test --test memory -- --ignored --nocapture`）：
/// 只打印计数与耗时，不打印任何记忆正文；校验无新文件、db/-wal 字节不变。
#[test]
#[ignore]
fn real_data_readonly() {
    use std::time::Instant;
    let home = std::env::var("HOME").unwrap();
    let root = PathBuf::from(format!("{home}/.omp/agent/memories/mnemopi/banks"));
    let sessions = PathBuf::from(format!("{home}/.omp/agent/sessions"));
    if !root.is_dir() {
        println!("no real bank root, skip");
        return;
    }
    let before = dir_snapshot(&root);
    let t = Instant::now();
    let over = overview_impl(&root, &sessions).unwrap();
    println!(
        "overview: available={} banks={} working={} episodic={} facts={} bytes={} elapsed={:?}",
        over.available,
        over.totals.banks,
        over.totals.working,
        over.totals.episodic,
        over.totals.facts,
        over.totals.bytes,
        t.elapsed()
    );
    println!(
        "  neverRecalled={} unconsolidated={} sourceSessions={} missingSource={} backend={:?}",
        over.totals.never_recalled,
        over.totals.unconsolidated,
        over.totals.source_sessions,
        over.totals.missing_source_sessions,
        over.backend,
    );
    let first_readable = over
        .banks
        .iter()
        .find(|b| b.readable && b.working + b.episodic > 0);
    if let Some(bank) = first_readable {
        let t = Instant::now();
        let page = list_impl(&root, &sessions, &list_params(&bank.bank)).unwrap();
        println!(
            "list({}): total={} items={} elapsed={:?}",
            bank.bank,
            page.total,
            page.items.len(),
            t.elapsed()
        );
        if let Some(item) = page.items.first() {
            let t = Instant::now();
            let d = detail_impl(&root, &sessions, &bank.bank, &item.id).unwrap();
            println!(
                "detail: chars={} truncated={} facts={} edges={} elapsed={:?}",
                d.item.content_chars,
                d.truncated,
                d.facts.len(),
                d.related_edges,
                t.elapsed()
            );
        }
    }
    let t = Instant::now();
    let points = growth_impl(&root, None, 30).unwrap();
    let (w, e): (u64, u64) = points
        .iter()
        .fold((0, 0), |(a, b), p| (a + p.working, b + p.episodic));
    println!(
        "growth(30d): points={} working={w} episodic={e} elapsed={:?}",
        points.len(),
        t.elapsed()
    );
    let after = dir_snapshot(&root);
    assert_eq!(before, after, "只读调用不得新增文件或改变文件大小");
    println!(
        "side-file check: {} files, names+sizes unchanged",
        after.len()
    );
}

#[test]
fn list_kind_miss_returns_empty_page_but_no_tables_is_io() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("banks");
    std::fs::create_dir_all(&root).unwrap();
    // 只有 episodic 表。
    let dir = root.join("half-1");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mnemopi.db");
    Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT);")
        .unwrap();
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO episodic_memory (id, content) VALUES ('e1', 'x')",
            [],
        )
        .unwrap();
    // 两表皆无。
    let odd = root.join("odd-1");
    std::fs::create_dir_all(&odd).unwrap();
    Connection::open(odd.join("mnemopi.db"))
        .unwrap()
        .execute_batch("CREATE TABLE something_else (id INTEGER);")
        .unwrap();
    let sessions = sessions_dir(tmp.path());

    let mut p = list_params("half-1");
    p.kind = MemoryKindFilter::Working;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 0);
    assert!(page.items.is_empty());
    p.kind = MemoryKindFilter::All;
    let page = list_impl(&root, &sessions, &p).unwrap();
    assert_eq!(page.total, 1);

    let p = list_params("odd-1");
    assert_eq!(
        list_impl(&root, &sessions, &p).unwrap_err().code,
        ErrorCode::Io
    );
    assert_eq!(
        detail_impl(&root, &sessions, "odd-1", "e1")
            .unwrap_err()
            .code,
        ErrorCode::Io
    );
}
