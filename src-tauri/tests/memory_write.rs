//! 记忆库写操作（CONTRACT §18.8）：合成 bank + 临时备份区，不碰真实 `~/.omp`。
//!
//! DDL 取自上游 v18.12.3（含 FTS5 虚表与同步触发器，验证触发器级联）；
//! 内容全为合成文本。真实数据端到端见文末 `e2e_on_real_copy`（`#[ignore]`，
//! 在 /tmp 副本上删/恢复，只打印计数，并断言真实树 untouched）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use omp_resume_lib::memory::delete::{
    backups_impl, delete_backup_impl, delete_bank_impl_with, delete_items_impl_with, preview_impl,
    restore_impl_with, status_impl_with, Gate, DELETE_IDS_MAX,
};
use omp_resume_lib::model::{ErrorCode, MemoryBackupKind, MemorySkipReason};
use rusqlite::{params, Connection};

/// 上游建表 + FTS5 虚表与触发器（`schema.ts` 原样语义）。
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
    fact_type TEXT,
    key TEXT,
    value TEXT,
    source_memory_id TEXT
);
CREATE TABLE annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE memory_embeddings (
    memory_id TEXT PRIMARY KEY,
    embedding_json TEXT NOT NULL,
    model TEXT
);
CREATE TABLE gists (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    memory_id TEXT
);
CREATE TABLE graph_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    UNIQUE(source, target, edge_type)
);
CREATE TABLE memory_validations (
    validation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    validator TEXT NOT NULL,
    action TEXT NOT NULL
);
CREATE VIRTUAL TABLE fts_working USING fts5(id UNINDEXED, content);
CREATE TRIGGER wm_ai AFTER INSERT ON working_memory BEGIN
    INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
END;
CREATE TRIGGER wm_ad AFTER DELETE ON working_memory BEGIN
    DELETE FROM fts_working WHERE id = old.id;
END;
CREATE TRIGGER wm_au AFTER UPDATE OF content, embed_text ON working_memory BEGIN
    DELETE FROM fts_working WHERE id = old.id;
    INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
END;
CREATE VIRTUAL TABLE fts_episodes USING fts5(content, content='episodic_memory', content_rowid='rowid');
CREATE TRIGGER em_ai AFTER INSERT ON episodic_memory BEGIN
    INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER em_ad AFTER DELETE ON episodic_memory BEGIN
    INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER em_au AFTER UPDATE ON episodic_memory BEGIN
    INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;
";

struct Env {
    _tmp: tempfile::TempDir,
    banks: PathBuf,
    data: PathBuf,
}

fn setup() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let banks = tmp.path().join("banks");
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&banks).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    Env {
        _tmp: tmp,
        banks,
        data,
    }
}

fn make_bank(env: &Env, name: &str) -> PathBuf {
    let dir = env.banks.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mnemopi.db");
    Connection::open(&db)
        .unwrap()
        .execute_batch(SCHEMA)
        .unwrap();
    db
}

fn prod_gate() -> Gate {
    Gate {
        lsof: PathBuf::from("/usr/sbin/lsof"),
        timeout: Duration::from_secs(5),
    }
}

fn idle_gate() -> Gate {
    // 恒报空闲的假门禁（WAL 测试用：绕开“测试进程自身持有”）。
    static SCRIPT: &str = "#!/bin/sh\nexit 1\n";
    let dir = std::env::temp_dir().join("omp-resume-idle-lsof");
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("lsof-idle");
    if !bin.exists() {
        std::fs::write(&bin, SCRIPT).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    Gate {
        lsof: bin,
        timeout: Duration::from_secs(5),
    }
}

fn add_working(db: &Path, bank: &str, id: &str, content: &str) {
    Connection::open(db)
        .unwrap()
        .execute(
            "INSERT INTO working_memory (id, content, session_id) VALUES (?1, ?2, ?3)",
            params![id, content, bank],
        )
        .unwrap();
}

fn add_episodic(db: &Path, bank: &str, id: &str, content: &str, summary_of: &str) {
    Connection::open(db)
        .unwrap()
        .execute(
            "INSERT INTO episodic_memory (id, content, session_id, summary_of) VALUES (?1, ?2, ?3, ?4)",
            params![id, content, bank, summary_of],
        )
        .unwrap();
}

/// 给记忆挂全套附属物（facts/memoria/embedding/annotation/gist/边）。
fn attach_all(db: &Path, id: &str) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) \
         VALUES (?1, 's', 's', 'p', 'o', ?2)",
        params![format!("fact-{id}"), id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memoria_facts (fact_type, key, value, source_memory_id) VALUES ('t', ?1, 'v', ?2)",
        params![format!("k-{id}"), id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?1, '[0.1]')",
        params![id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO annotations (memory_id, kind, value) VALUES (?1, 'occurred_on', '2026-01-01')",
        params![id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO gists (id, text, memory_id) VALUES (?1, 'gist', ?2)",
        params![format!("gist_{id}"), id],
    )
    .unwrap();
    // 边：裸 id、gist_<id>、fact_id 各一条。
    for (s, t) in [
        (id, "other"),
        (&format!("gist_{id}"), "other2"),
        (&format!("fact-{id}"), "other3"),
    ] {
        conn.execute(
            "INSERT INTO graph_edges (source, target, edge_type) VALUES (?1, ?2, 'linked')",
            params![s, t],
        )
        .unwrap();
    }
}

fn table_count(db: &Path, table: &str) -> i64 {
    Connection::open(db)
        .unwrap()
        .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
            r.get(0)
        })
        .unwrap()
}

fn assert_integrity_ok(db: &Path) {
    let conn = Connection::open(db).unwrap();
    let s: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(s.to_lowercase(), "ok");
}

fn assert_fts_clean(db: &Path, table: &str) {
    let conn = Connection::open(db).unwrap();
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = ?1",
            [table],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return;
    }
    let sql = format!("INSERT INTO {table}({table}) VALUES('integrity-check')");
    let mut stmt = conn.prepare(&sql).unwrap();
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect();
    assert!(rows.is_empty(), "{table} FTS integrity: {rows:?}");
}

/// 断言六表对给定 id 无残留。
fn assert_no_orphans(db: &Path, ids: &[&str]) {
    let conn = Connection::open(db).unwrap();
    let ph = format!(
        "({})",
        ids.iter().map(|_| "?").collect::<Vec<_>>().join(",")
    );
    let params: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    for (table, col) in [
        ("facts", "source_msg_id"),
        ("annotations", "memory_id"),
        ("memory_embeddings", "memory_id"),
        ("gists", "memory_id"),
        ("memoria_facts", "source_memory_id"),
    ] {
        let n: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{col}\" IN {ph}"),
                params.as_slice(),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "{table}.{col} 残留 {n} 行");
    }
    let mut refs: Vec<String> = Vec::new();
    for id in ids {
        refs.push((*id).to_owned());
        refs.push(format!("gist_{id}"));
        refs.push(format!("fact-{id}"));
    }
    let rph = format!(
        "({})",
        refs.iter().map(|_| "?").collect::<Vec<_>>().join(",")
    );
    let rparams: Vec<&dyn rusqlite::ToSql> =
        refs.iter().map(|r| r as &dyn rusqlite::ToSql).collect();
    let mut both = rparams.clone();
    both.extend(rparams.iter().copied());
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM graph_edges WHERE source IN {rph} OR target IN {rph}"),
            both.as_slice(),
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0, "graph_edges 残留 {n} 行");
}

/// 内容快照（恢复一致性比对用）：两表 (id, content) 有序 + 附属表计数。
type Snapshot = (Vec<(String, String, String)>, Vec<(&'static str, i64)>);

fn content_snapshot(db: &Path) -> Snapshot {
    let conn = Connection::open(db).unwrap();
    let mut rows = Vec::new();
    for table in ["working_memory", "episodic_memory"] {
        let mut stmt = conn
            .prepare(&format!("SELECT id, content FROM \"{table}\" ORDER BY id"))
            .unwrap();
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .flatten()
        {
            rows.push((table.to_owned(), row.0, row.1));
        }
    }
    let counts = [
        "facts",
        "annotations",
        "memory_embeddings",
        "gists",
        "graph_edges",
        "memoria_facts",
    ]
    .into_iter()
    .map(|t| {
        (
            t,
            conn.query_row(&format!("SELECT COUNT(*) FROM \"{t}\""), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        )
    })
    .collect();
    (rows, counts)
}

#[test]
fn preview_numbers_equal_actual_deletion() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "alpha one");
    add_working(&db, "b-1", "w2", "alpha two");
    add_episodic(&db, "b-1", "e1", "epi one", "w1");
    attach_all(&db, "w1");
    attach_all(&db, "e1");
    // w2 无附属物。

    let ids = [
        "w1".to_owned(),
        "e1".to_owned(),
        "missing".to_owned(),
        "w1".to_owned(),
    ];
    let preview = preview_impl(&env.banks, "b-1", &ids).unwrap();
    assert_eq!(preview.requested, 3); // 去重后
    assert_eq!(preview.deletable.working, 1);
    assert_eq!(preview.deletable.episodic, 1);
    assert_eq!(preview.not_found, 1);
    assert_eq!(preview.unsupported, 0);
    assert_eq!(preview.cascade.facts, 2);
    assert_eq!(preview.cascade.embeddings, 2);
    assert_eq!(preview.cascade.annotations, 2);
    assert_eq!(preview.cascade.edges, 6);
    assert_eq!(preview.cascade.other, 4); // gists 2 + memoria 2
    assert_eq!(preview.cited_by_summaries, 1); // e1 引用 w1（e1 自身也被删，不影响计数）

    let before = [
        table_count(&db, "facts"),
        table_count(&db, "memory_embeddings"),
        table_count(&db, "annotations"),
        table_count(&db, "graph_edges"),
        table_count(&db, "gists") + table_count(&db, "memoria_facts"),
    ];
    let result = delete_items_impl_with(&env.banks, &env.data, "b-1", &ids, &prod_gate()).unwrap();
    assert_eq!(result.deleted, ["w1", "e1"]);
    assert_eq!(result.skipped.len(), 1);
    assert_eq!(result.skipped[0].reason, MemorySkipReason::NotFound);
    assert_eq!(result.backup.kind, MemoryBackupKind::BeforeDelete);
    // preview 数字 == 实际删除数字。
    let after = [
        table_count(&db, "facts"),
        table_count(&db, "memory_embeddings"),
        table_count(&db, "annotations"),
        table_count(&db, "graph_edges"),
        table_count(&db, "gists") + table_count(&db, "memoria_facts"),
    ];
    let deleted: Vec<i64> = before.into_iter().zip(after).map(|(b, a)| b - a).collect();
    assert_eq!(
        deleted,
        [
            preview.cascade.facts as i64,
            preview.cascade.embeddings as i64,
            preview.cascade.annotations as i64,
            preview.cascade.edges as i64,
            preview.cascade.other as i64,
        ]
    );
    // w2 及其（无）附属物不受影响；FTS 触发器已清 w1/e1。
    assert_eq!(table_count(&db, "working_memory"), 1);
    let conn = Connection::open(&db).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM fts_working WHERE id IN ('w1','e1')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    drop(conn);
    assert_integrity_ok(&db);
    assert_fts_clean(&db, "fts_working");
    assert_fts_clean(&db, "fts_episodes");
    assert_no_orphans(&db, &["w1", "e1"]);
}

#[test]
fn delete_episodic_covers_facts_gists_memoria() {
    // 回归：episodic 与 working 共用 purge（facts/memoria/gists 可引用 episodic id）。
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_episodic(&db, "b-1", "e9", "epi nine", "");
    attach_all(&db, "e9");
    let ids = ["e9".to_owned()];
    let preview = preview_impl(&env.banks, "b-1", &ids).unwrap();
    assert_eq!(preview.deletable.episodic, 1);
    assert_eq!(preview.cascade.facts, 1);
    assert_eq!(preview.cascade.other, 2);
    let result = delete_items_impl_with(&env.banks, &env.data, "b-1", &ids, &prod_gate()).unwrap();
    assert_eq!(result.deleted, ["e9"]);
    assert_eq!(table_count(&db, "episodic_memory"), 0);
    assert_eq!(table_count(&db, "facts"), 0);
    assert_eq!(table_count(&db, "memoria_facts"), 0);
    assert_eq!(table_count(&db, "gists"), 0);
    assert_no_orphans(&db, &["e9"]);
    assert_integrity_ok(&db);
}

#[test]
fn session_mismatch_is_unsupported_and_untouched() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO working_memory (id, content, session_id) VALUES ('wX', 'x', 'other-bank')",
            [],
        )
        .unwrap();
    let ids = ["wX".to_owned()];
    let preview = preview_impl(&env.banks, "b-1", &ids).unwrap();
    assert_eq!(preview.unsupported, 1);
    assert_eq!(preview.deletable.working, 0);
    // 全部 unsupported ⇒ INVALID_INPUT，行与备份区均不动。
    let err = delete_items_impl_with(&env.banks, &env.data, "b-1", &ids, &prod_gate()).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(backups_impl(&env.data, Some("b-1")).is_empty());
    assert_eq!(table_count(&db, "working_memory"), 1);
    // 混合：一个可删 + 一个 unsupported ⇒ 成功，unsupported 进 skipped。
    add_working(&db, "b-1", "w-ok", "y");
    let mixed = ["w-ok".to_owned(), "wX".to_owned()];
    let result =
        delete_items_impl_with(&env.banks, &env.data, "b-1", &mixed, &prod_gate()).unwrap();
    assert_eq!(result.deleted, ["w-ok"]);
    assert_eq!(result.skipped.len(), 1);
    assert_eq!(result.skipped[0].id, "wX");
    assert_eq!(result.skipped[0].reason, MemorySkipReason::Unsupported);
    assert_eq!(result.backup.kind, MemoryBackupKind::BeforeDelete);
    assert_eq!(backups_impl(&env.data, Some("b-1")).len(), 1);
    assert_eq!(table_count(&db, "working_memory"), 1); // wX 仍在
}

#[test]
fn vec_bank_episodic_unsupported_working_still_deletable() {
    let env = setup();
    let db = make_bank(&env, "b-vec");
    // 普通表同名即可触发 sqlite_master 守卫（真 vec 虚表需扩展，建不出）。
    Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE vec_episodes (rowid INTEGER);")
        .unwrap();
    add_working(&db, "b-vec", "w1", "x");
    add_episodic(&db, "b-vec", "e1", "y", "");
    let ids = ["w1".to_owned(), "e1".to_owned()];
    let preview = preview_impl(&env.banks, "b-vec", &ids).unwrap();
    assert_eq!(preview.deletable.working, 1);
    assert_eq!(preview.deletable.episodic, 0);
    assert_eq!(preview.unsupported, 1);
    let result =
        delete_items_impl_with(&env.banks, &env.data, "b-vec", &ids, &prod_gate()).unwrap();
    assert_eq!(result.deleted, ["w1"]);
    assert_eq!(result.skipped[0].reason, MemorySkipReason::Unsupported);
    assert_eq!(table_count(&db, "episodic_memory"), 1);
}

#[test]
fn delete_limits_and_dedupe() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    // 空 ids。
    assert_eq!(
        preview_impl(&env.banks, "b-1", &[]).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        delete_items_impl_with(&env.banks, &env.data, "b-1", &[], &prod_gate())
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    // 超限（501 个互不相同）。
    let many: Vec<String> = (0..DELETE_IDS_MAX + 1).map(|i| format!("id-{i}")).collect();
    assert_eq!(
        delete_items_impl_with(&env.banks, &env.data, "b-1", &many, &prod_gate())
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    // 去重：同一 id 传 3 次 ⇒ requested=1，删一次。
    let dup = ["w1".to_owned(), "w1".to_owned(), "w1".to_owned()];
    let preview = preview_impl(&env.banks, "b-1", &dup).unwrap();
    assert_eq!(preview.requested, 1);
    let result = delete_items_impl_with(&env.banks, &env.data, "b-1", &dup, &prod_gate()).unwrap();
    assert_eq!(result.deleted, ["w1"]);
    assert_eq!(table_count(&db, "working_memory"), 0);
}

#[test]
fn not_found_never_aborts_rest_and_keeps_order() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    add_working(&db, "b-1", "w2", "y");
    let ids = [
        "no-a".to_owned(),
        "w2".to_owned(),
        "no-b".to_owned(),
        "w1".to_owned(),
    ];
    let result = delete_items_impl_with(&env.banks, &env.data, "b-1", &ids, &prod_gate()).unwrap();
    assert_eq!(result.deleted, ["w2", "w1"]);
    assert_eq!(result.skipped.len(), 2);
    assert_eq!(result.skipped[0].id, "no-a");
    assert_eq!(result.skipped[1].id, "no-b");
    assert_eq!(table_count(&db, "working_memory"), 0);
}

/// 事务内 recount 与计划不一致（触发器静默吞掉 base 表删除）⇒ 整个事务回滚。
#[test]
fn recount_mismatch_rolls_back_whole_transaction() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "alpha");
    add_working(&db, "b-1", "w2", "beta");
    attach_all(&db, "w1");
    // 模拟“计划删了但没删”：BEFORE DELETE 触发器静默忽略 working 删除。
    Connection::open(&db)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER wm_block BEFORE DELETE ON working_memory \
             BEGIN SELECT RAISE(IGNORE); END;",
        )
        .unwrap();
    let before = content_snapshot(&db);
    let err = delete_items_impl_with(
        &env.banks,
        &env.data,
        "b-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert!(err.message.contains("删除校验不一致"), "{}", err.message);
    // 全事务回滚：base 两表与六表附属数据都与删除前一致（级联删除也被撤销）。
    assert_eq!(content_snapshot(&db), before);
    assert_integrity_ok(&db);
    assert_fts_clean(&db, "fts_working");
    assert_fts_clean(&db, "fts_episodes");
}

/// `tail -f` 按住文件，返回子进程（调用方 kill）。
fn hold_with_tail(path: &Path) -> std::process::Child {
    std::process::Command::new("/usr/bin/tail")
        .args(["-f", path.to_str().unwrap()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

fn wait_held(env: &Env, bank: &str) {
    // 等待 lsof 能看到持有者（最多 ~2.5s）。
    for _ in 0..50 {
        let status = status_impl_with(&env.banks, &env.data, bank, &prod_gate()).unwrap();
        if status.in_use {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("lsof 未能看到 tail 持有者");
}

#[test]
fn gate_refuses_delete_status_and_bank_removal_when_held() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    // 确保 -wal 文件存在（WAL 模式写一行再关；文件残留）。
    Connection::open(&db)
        .unwrap()
        .execute_batch("PRAGMA journal_mode=WAL;")
        .unwrap();
    let wal = db.with_extension("db-wal");

    // 按住主文件 ⇒ 删行/删 bank/恢复全拒，status 报占用。
    let mut tail = hold_with_tail(&db);
    wait_held(&env, "b-1");
    let status = status_impl_with(&env.banks, &env.data, "b-1", &prod_gate()).unwrap();
    assert!(status.in_use);
    assert!(!status.probe_failed);
    assert_eq!(status.holders.len(), 1);
    assert_eq!(status.holders[0].pid, tail.id());
    assert_eq!(status.holders[0].command, "tail");
    let err = delete_items_impl_with(
        &env.banks,
        &env.data,
        "b-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InUse);
    assert!(
        err.message.contains(&tail.id().to_string()),
        "{}",
        err.message
    );
    assert!(err.message.contains("tail"), "{}", err.message);
    assert_eq!(
        delete_bank_impl_with(&env.banks, &env.data, "b-1", &prod_gate())
            .unwrap_err()
            .code,
        ErrorCode::InUse
    );
    // preview 纯只读 ⇒ 不设门禁，照常工作。
    let preview = preview_impl(&env.banks, "b-1", &["w1".to_owned()]).unwrap();
    assert_eq!(preview.deletable.working, 1);
    let _ = tail.kill();
    let _ = tail.wait();

    // 按住 -wal 同样拒绝。
    let mut tail = hold_with_tail(&wal);
    wait_held(&env, "b-1");
    assert_eq!(
        delete_items_impl_with(
            &env.banks,
            &env.data,
            "b-1",
            &["w1".to_owned()],
            &prod_gate()
        )
        .unwrap_err()
        .code,
        ErrorCode::InUse
    );
    let _ = tail.kill();
    let _ = tail.wait();
    // 松开后恢复。
    let status = status_impl_with(&env.banks, &env.data, "b-1", &prod_gate()).unwrap();
    assert!(!status.in_use);
    assert_eq!(table_count(&db, "working_memory"), 1);
}

#[test]
fn gate_probe_failure_refuses_writes_but_not_status() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    let bad_gate = Gate {
        lsof: PathBuf::from("/nonexistent/lsof-probe"),
        timeout: Duration::from_secs(2),
    };
    assert_eq!(
        delete_items_impl_with(&env.banks, &env.data, "b-1", &["w1".to_owned()], &bad_gate)
            .unwrap_err()
            .code,
        ErrorCode::ProbeFailed
    );
    assert_eq!(
        delete_bank_impl_with(&env.banks, &env.data, "b-1", &bad_gate)
            .unwrap_err()
            .code,
        ErrorCode::ProbeFailed
    );
    // status 不报错 ⇒ probeFailed=true。
    let status = status_impl_with(&env.banks, &env.data, "b-1", &bad_gate).unwrap();
    assert!(status.probe_failed);
    assert!(!status.in_use);
    assert!(status.holders.is_empty());
    assert_eq!(table_count(&db, "working_memory"), 1);
}

fn file_sha256(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).unwrap();
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn failed_backup_leaves_db_byte_identical() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    // data_dir 是文件 ⇒ 备份根建不出 ⇒ 备份失败。
    let file_as_data = env.data.join("not-a-dir");
    std::fs::write(&file_as_data, b"x").unwrap();
    let before = file_sha256(&db);
    let err = delete_items_impl_with(
        &env.banks,
        &file_as_data,
        "b-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert!(err.message.contains("备份失败"), "{}", err.message);
    assert_eq!(file_sha256(&db), before);
    // 删 bank 同理：目录原样。
    let err = delete_bank_impl_with(&env.banks, &file_as_data, "b-1", &prod_gate()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert!(env.banks.join("b-1").is_dir());
}

#[test]
fn retention_prunes_oldest_but_never_bank_removed() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    // 12 条真实可删记忆（每次删一条 ⇒ 每次产生一个 before-delete 备份）。
    for i in 0..12 {
        add_working(&db, "b-1", &format!("w{i:02}"), "x");
    }
    make_bank(&env, "b-2");
    // 7 次删除 ⇒ before-delete 只留 5。
    for i in 0..7 {
        delete_items_impl_with(
            &env.banks,
            &env.data,
            "b-1",
            &[format!("w{i:02}")],
            &prod_gate(),
        )
        .unwrap();
    }
    let items = backups_impl(&env.data, Some("b-1"));
    assert_eq!(items.len(), 5);
    assert!(items
        .iter()
        .all(|b| b.kind == MemoryBackupKind::BeforeDelete));
    // newest first（createdAt 倒序，同刻按 id 倒序）。
    for pair in items.windows(2) {
        assert!(
            (pair[0].created_at.clone(), pair[0].id.clone())
                >= (pair[1].created_at.clone(), pair[1].id.clone()),
            "{:?}",
            pair.iter().map(|b| &b.id).collect::<Vec<_>>()
        );
    }
    // bank-removed 永不剪。
    delete_bank_impl_with(&env.banks, &env.data, "b-2", &prod_gate()).unwrap();
    for i in 7..12 {
        delete_items_impl_with(
            &env.banks,
            &env.data,
            "b-1",
            &[format!("w{i:02}")],
            &prod_gate(),
        )
        .unwrap();
    }
    let all = backups_impl(&env.data, None);
    assert!(all.iter().any(|b| b.kind == MemoryBackupKind::BankRemoved));
    assert_eq!(all.iter().filter(|b| b.bank == "b-1").count(), 5);
}

#[test]
fn noop_delete_creates_no_backup_and_prunes_nothing() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    // 先做一次真实删除，得到 1 个有价值的历史备份。
    delete_items_impl_with(
        &env.banks,
        &env.data,
        "b-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap();
    // session 不符的行（unsupported）：基线前就位，之后也不得被动。
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO working_memory (id, content, session_id) VALUES ('wX', 'x', 'other')",
            [],
        )
        .unwrap();
    let keep = backups_impl(&env.data, Some("b-1"));
    assert_eq!(keep.len(), 1);
    let snap_before = content_snapshot(&db);
    let db_before = file_sha256(&db);

    // 全部 not_found / unsupported ⇒ INVALID_INPUT，且不建备份、不修剪、不开写连接。
    for ids in [
        vec!["nope-1".to_owned()],
        vec!["nope-1".to_owned(), "nope-2".to_owned()],
        vec!["w1".to_owned()], // 已删除 ⇒ not_found
        vec!["wX".to_owned()], // session 不符 ⇒ unsupported
    ] {
        let err =
            delete_items_impl_with(&env.banks, &env.data, "b-1", &ids, &prod_gate()).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{ids:?}");
        assert!(err.message.contains("均不可删除"), "{}", err.message);
    }
    // 备份列表与内容完全未变（no-op 不产生新快照、不挤掉旧快照）。
    assert_eq!(backups_impl(&env.data, Some("b-1")), keep);
    assert_eq!(content_snapshot(&db), snap_before);
    assert_eq!(file_sha256(&db), db_before);
    // 反复 no-op 12 次：旧备份仍在（不被挤出 keep-5）。
    for i in 0..12 {
        let _ = delete_items_impl_with(
            &env.banks,
            &env.data,
            "b-1",
            &[format!("ghost-{i}")],
            &prod_gate(),
        );
    }
    assert_eq!(backups_impl(&env.data, Some("b-1")), keep);
}

#[test]
fn leftover_backup_dir_without_manifest_ignored_and_never_pruned() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    // 伪造一个“最新”的崩溃残留目录（形状合法、无 manifest、只有半个 db）。
    let bank_backup = env.data.join("memory-backups").join("b-1");
    std::fs::create_dir_all(&bank_backup).unwrap();
    let leftover = bank_backup.join("20991231T235959Z-before-delete");
    std::fs::create_dir_all(&leftover).unwrap();
    std::fs::write(leftover.join("mnemopi.db"), b"partial").unwrap();
    // 它不列出。
    assert!(backups_impl(&env.data, Some("b-1")).is_empty());
    assert!(backups_impl(&env.data, None).is_empty());
    // 也不占留存名额：7 次真实删除后仍留 5，且残留目录还在。
    for i in 0..7 {
        add_working(&db, "b-1", &format!("w{i}"), "x");
        delete_items_impl_with(
            &env.banks,
            &env.data,
            "b-1",
            &[format!("w{i}")],
            &prod_gate(),
        )
        .unwrap();
    }
    let items = backups_impl(&env.data, Some("b-1"));
    assert_eq!(items.len(), 5);
    assert!(items.iter().all(|b| b.working.is_some()));
    assert!(leftover.is_dir(), "无 manifest 的残留目录不得被剪");
    assert!(!items.iter().any(|b| b.id.contains("20991231")));
    // 恢复它 ⇒ 明确失败（无 manifest 计数）且原库不变。
    let guard = content_snapshot(&db);
    let err = restore_impl_with(
        &env.banks,
        &env.data,
        "b-1@20991231T235959Z-before-delete",
        &prod_gate(),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(content_snapshot(&db), guard);
}

#[test]
fn bank_remove_restore_roundtrip_identical() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "alpha");
    add_episodic(&db, "b-1", "e1", "beta", "w1");
    attach_all(&db, "w1");
    let before = content_snapshot(&db);
    let removed = delete_bank_impl_with(&env.banks, &env.data, "b-1", &prod_gate()).unwrap();
    assert_eq!(removed.kind, MemoryBackupKind::BankRemoved);
    assert_eq!(removed.working, Some(1));
    assert_eq!(removed.episodic, Some(1));
    assert!(!env.banks.join("b-1").exists());
    // 备份区 bank/ 目录 + manifest + 权限。
    let backup_dir = env.data.join("memory-backups").join("b-1");
    let entry: Vec<_> = std::fs::read_dir(&backup_dir).unwrap().flatten().collect();
    assert_eq!(entry.len(), 1);
    let ts_dir = entry[0].path();
    assert!(ts_dir.join("bank").join("mnemopi.db").is_file());
    assert!(ts_dir.join("manifest.json").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&ts_dir.join("bank")), 0o700);
        assert_eq!(mode(&ts_dir.join("bank").join("mnemopi.db")), 0o600);
    }
    // 恢复 ⇒ 内容完全一致；目标原先不存在 ⇒ 无 safety。
    let restored = restore_impl_with(&env.banks, &env.data, &removed.id, &prod_gate()).unwrap();
    assert_eq!(restored.bank, "b-1");
    assert!(restored.safety_backup.is_none());
    assert_eq!(
        content_snapshot(&env.banks.join("b-1").join("mnemopi.db")),
        before
    );
    assert_integrity_ok(&env.banks.join("b-1").join("mnemopi.db"));
    // 备份仍在（恢复是复制，非搬回）。
    assert!(ts_dir.join("bank").join("mnemopi.db").is_file());
}

#[test]
fn restore_snapshot_with_safety_roundtrip() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    add_working(&db, "b-1", "w2", "y");
    let full = content_snapshot(&db);
    // 删 w1（备份 A = 删除前完整态）。
    let deleted = delete_items_impl_with(
        &env.banks,
        &env.data,
        "b-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap();
    let partial = content_snapshot(&db);
    assert_ne!(full, partial);
    // 恢复 A ⇒ 完整态 + safety（删除后态快照）。
    let r1 = restore_impl_with(&env.banks, &env.data, &deleted.backup.id, &prod_gate()).unwrap();
    assert_eq!(r1.bank, "b-1");
    assert_eq!(r1.restored_from.id, deleted.backup.id);
    let safety = r1.safety_backup.unwrap();
    assert_eq!(safety.kind, MemoryBackupKind::BeforeRestore);
    assert_eq!(content_snapshot(&db), full);
    // 恢复 safety ⇒ 回到删除后态。
    let r2 = restore_impl_with(&env.banks, &env.data, &safety.id, &prod_gate()).unwrap();
    assert!(r2.safety_backup.is_some());
    assert_eq!(content_snapshot(&db), partial);
}

#[test]
fn restore_rollback_on_unverifiable_backup() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    // 先造 5 个真实 before-delete 备份 + 1 次成功恢复（得到 1 个 before-restore），
    // 这样失败的恢复若误剪/误留都会在备份列表上暴露。
    let mut first_backup = None;
    for i in 0..5 {
        add_working(&db, "b-1", &format!("pad{i}"), "x");
        let d = delete_items_impl_with(
            &env.banks,
            &env.data,
            "b-1",
            &[format!("pad{i}")],
            &prod_gate(),
        )
        .unwrap();
        first_backup.get_or_insert(d.backup.id);
    }
    let r = restore_impl_with(&env.banks, &env.data, &first_backup.unwrap(), &prod_gate()).unwrap();
    assert!(r.safety_backup.is_some());
    let before = content_snapshot(&db);
    let listing_before = backups_impl(&env.data, Some("b-1"));
    // 手工伪造损坏备份：合法 id 形状 + 行数对不上的 manifest + 垃圾 db。
    let ts_dir = env
        .data
        .join("memory-backups")
        .join("b-1")
        .join("20261020T120000Z-before-delete");
    std::fs::create_dir_all(&ts_dir).unwrap();
    std::fs::write(ts_dir.join("mnemopi.db"), b"garbage-not-sqlite").unwrap();
    std::fs::write(
        ts_dir.join("manifest.json"),
        r#"{"bank":"b-1","kind":"before-delete","createdAt":"2026-10-20T12:00:00.000Z","cwd":null,"working":99,"episodic":0,"sourceBankDirName":"b-1"}"#,
    )
    .unwrap();
    let bad_listing = backups_impl(&env.data, Some("b-1"));
    let err = restore_impl_with(
        &env.banks,
        &env.data,
        "b-1@20261020T120000Z-before-delete",
        &prod_gate(),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert!(err.message.contains("已回滚"), "{}", err.message);
    // 原库内容不变（回滚已验证）。
    assert_eq!(content_snapshot(&db), before);
    assert_integrity_ok(&db);
    // 失败的恢复：不修剪、不留 stray before-restore 目录（冗余安全快照已删）。
    assert_eq!(backups_impl(&env.data, Some("b-1")), bad_listing);
    assert_eq!(bad_listing.len(), listing_before.len() + 1);
    let before_restore_dirs = std::fs::read_dir(env.data.join("memory-backups").join("b-1"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with("before-restore"))
        .count();
    assert_eq!(
        before_restore_dirs,
        listing_before
            .iter()
            .filter(|b| b.kind == MemoryBackupKind::BeforeRestore)
            .count()
    );
}

#[test]
fn restore_missing_snapshot_file_aborts_cleanly() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    let before = content_snapshot(&db);
    let ts_dir = env
        .data
        .join("memory-backups")
        .join("b-1")
        .join("20261020T120000Z-before-delete");
    std::fs::create_dir_all(&ts_dir).unwrap();
    std::fs::write(ts_dir.join("manifest.json"), r#"{"bank":"b-1","kind":"before-delete","createdAt":"2026-10-20T12:00:00.000Z","cwd":null,"working":1,"episodic":0,"sourceBankDirName":"b-1"}"#).unwrap();
    let listing = backups_impl(&env.data, Some("b-1"));
    let err = restore_impl_with(
        &env.banks,
        &env.data,
        "b-1@20261020T120000Z-before-delete",
        &prod_gate(),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(content_snapshot(&db), before);
    // 没有 stray before-restore；备份列表不变。
    assert_eq!(backups_impl(&env.data, Some("b-1")), listing);
    assert!(!listing
        .iter()
        .any(|b| b.kind == MemoryBackupKind::BeforeRestore));
}

/// bank-removed 恢复到“已存在”的库、整目录拷回中途失败：回滚前整目录重建，
/// 不留失败拷贝的杂散文件；安全快照经校验后被删除（已冗余）。
#[test]
#[cfg(unix)]
fn restore_bank_removed_partial_copy_rolls_back_clean() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "alpha");
    let removed = delete_bank_impl_with(&env.banks, &env.data, "b-1", &prod_gate()).unwrap();
    let dirname = removed.id.rsplit_once('@').unwrap().1.to_owned();
    let backup_bank = env
        .data
        .join("memory-backups")
        .join("b-1")
        .join(&dirname)
        .join("bank");
    // 目标库重建（“已存在”路径 ⇒ 会拍 before-restore 安全快照）。
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w2", "beta");
    let before = content_snapshot(&db);
    // 弄坏备份：多一个普通文件 + 一个符号链接 ⇒ copy_dir_recursive 中途失败。
    std::fs::write(backup_bank.join("extra.txt"), b"stray").unwrap();
    std::os::unix::fs::symlink("/etc/hosts", backup_bank.join("evil")).unwrap();
    let err = restore_impl_with(&env.banks, &env.data, &removed.id, &prod_gate()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert!(err.message.contains("已回滚"), "{}", err.message);
    // 回滚后目录只含安全快照的 db（没有 extra.txt / evil）。
    let target = env.banks.join("b-1");
    let mut names: Vec<String> = std::fs::read_dir(&target)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["mnemopi.db"], "{names:?}");
    assert_eq!(content_snapshot(&target.join("mnemopi.db")), before);
    assert_integrity_ok(&target.join("mnemopi.db"));
    // 回滚已验证 ⇒ 冗余安全快照被删；失败路径不修剪其它备份。
    let listing = backups_impl(&env.data, Some("b-1"));
    assert!(!listing
        .iter()
        .any(|b| b.kind == MemoryBackupKind::BeforeRestore));
    assert!(listing.iter().any(|b| b.id == removed.id));
}

#[test]
fn backup_list_delete_and_id_validation() {
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    // 空备份区 ⇒ 空列表（非错误）。
    assert!(backups_impl(&env.data, None).is_empty());
    let r = delete_items_impl_with(
        &env.banks,
        &env.data,
        "b-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap();
    let items = backups_impl(&env.data, None);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, r.backup.id);
    assert!(items[0].created_at.ends_with('Z'));
    // 按 bank 过滤。
    assert_eq!(backups_impl(&env.data, Some("b-1")).len(), 1);
    assert!(backups_impl(&env.data, Some("other")).is_empty());
    // 永久删除。
    delete_backup_impl(&env.data, &r.backup.id).unwrap();
    assert!(backups_impl(&env.data, None).is_empty());
    assert_eq!(
        delete_backup_impl(&env.data, &r.backup.id)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    // 形状非法 ⇒ OUTSIDE_ROOT。
    for bad in [
        "nope",
        "b-1@evil",
        "../x@20261020T120000Z-before-delete",
        "b-1@20261020T120000Z-before-delete/../y",
    ] {
        assert_eq!(
            delete_backup_impl(&env.data, bad).unwrap_err().code,
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
        assert_eq!(
            restore_impl_with(&env.banks, &env.data, bad, &prod_gate())
                .unwrap_err()
                .code,
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
    }
}

#[test]
fn traversal_rejected_on_bank_and_status_and_preview() {
    let env = setup();
    for bad in ["..", "../x", "a/b", "a\\b", ""] {
        assert_eq!(
            preview_impl(&env.banks, bad, &["w1".to_owned()])
                .unwrap_err()
                .code,
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
        assert_eq!(
            status_impl_with(&env.banks, &env.data, bad, &prod_gate())
                .unwrap_err()
                .code,
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
        assert_eq!(
            delete_items_impl_with(&env.banks, &env.data, bad, &["w1".to_owned()], &prod_gate())
                .unwrap_err()
                .code,
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
        assert_eq!(
            delete_bank_impl_with(&env.banks, &env.data, bad, &prod_gate())
                .unwrap_err()
                .code,
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
    }
}

#[test]
#[cfg(unix)]
fn symlink_escape_bank_rejected() {
    use std::os::unix::fs::symlink;
    let env = setup();
    let outside = env._tmp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    symlink(&outside, env.banks.join("evil")).unwrap();
    assert_eq!(
        delete_items_impl_with(
            &env.banks,
            &env.data,
            "evil",
            &["w1".to_owned()],
            &prod_gate()
        )
        .unwrap_err()
        .code,
        ErrorCode::OutsideRoot
    );
}

#[test]
fn wal_only_data_backed_up_and_restored() {
    let env = setup();
    let db = make_bank(&env, "b-wal");
    // 写连接保持打开：数据留在 WAL 未 checkpoint。
    let writer = Connection::open(&db).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    writer
        .execute("INSERT INTO working_memory (id, content, session_id) VALUES ('w1', 'wal-row', 'b-wal')", [])
        .unwrap();
    writer
        .execute("INSERT INTO working_memory (id, content, session_id) VALUES ('w2', 'wal-row2', 'b-wal')", [])
        .unwrap();
    assert!(db.with_extension("db-wal").exists());
    // 真门禁下：测试进程自身持有 ⇒ IN_USE（lsof 能看到自己）。
    let status = status_impl_with(&env.banks, &env.data, "b-wal", &prod_gate()).unwrap();
    assert!(status.in_use, "lsof 应看到测试进程自身持有");
    // 假空闲门禁下删除 ⇒ 备份必须含 WAL 行。
    let result = delete_items_impl_with(
        &env.banks,
        &env.data,
        "b-wal",
        &["w1".to_owned()],
        &idle_gate(),
    )
    .unwrap();
    assert_eq!(result.deleted, ["w1"]);
    // 备份快照含 w1+w2（删除前态）。
    let snap_db = env.data.join("memory-backups").join("b-wal");
    let entry: Vec<_> = std::fs::read_dir(&snap_db).unwrap().flatten().collect();
    assert_eq!(entry.len(), 1);
    let n: i64 = Connection::open(entry[0].path().join("mnemopi.db"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM working_memory", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
    drop(writer);
    // 恢复 ⇒ w1 回来。
    restore_impl_with(&env.banks, &env.data, &result.backup.id, &prod_gate()).unwrap();
    assert_eq!(table_count(&db, "working_memory"), 2);
}

#[test]
fn memory_validations_preserved_as_audit_trail() {
    // 与上游 forget 一致：审计表不动（文档化行为，单测锁定）。
    let env = setup();
    let db = make_bank(&env, "b-1");
    add_working(&db, "b-1", "w1", "x");
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO memory_validations (memory_id, validator, action) VALUES ('w1', 'v', 'confirm')",
            [],
        )
        .unwrap();
    delete_items_impl_with(
        &env.banks,
        &env.data,
        "b-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap();
    assert_eq!(table_count(&db, "memory_validations"), 1);
}

#[test]
fn delete_on_minimal_schema_without_optional_tables() {
    // 仅 working_memory（无 FTS/附属表）⇒ 删除照常，无 panic。
    let env = setup();
    let dir = env.banks.join("thin-1");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mnemopi.db");
    Connection::open(&db)
        .unwrap()
        .execute_batch(
            "CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, session_id TEXT);",
        )
        .unwrap();
    Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO working_memory VALUES ('w1', 'x', 'thin-1')",
            [],
        )
        .unwrap();
    let preview = preview_impl(&env.banks, "thin-1", &["w1".to_owned()]).unwrap();
    assert_eq!(preview.deletable.working, 1);
    assert_eq!(preview.cascade.facts, 0);
    let result = delete_items_impl_with(
        &env.banks,
        &env.data,
        "thin-1",
        &["w1".to_owned()],
        &prod_gate(),
    )
    .unwrap();
    assert_eq!(result.deleted, ["w1"]);
    assert_eq!(table_count(&db, "working_memory"), 0);
    assert_integrity_ok(&db);
}

fn dir_snapshot_names_sizes(root: &Path) -> Vec<(PathBuf, u64)> {
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
                out.push((path, entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX)));
            }
        }
    }
    out.sort();
    out
}

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap().flatten() {
        let dest = target.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), &dest).unwrap();
        }
    }
}

/// 真实库端到端（`cargo test --test memory_write -- --ignored --nocapture`）：
/// 在 /tmp 副本上删几行 → 校验 → 恢复 → 计数一致；只打印计数；
/// 断言真实树 untouched（names+sizes 全等；mtime 除 -shm 外全等）。
#[test]
#[ignore]
fn e2e_on_real_copy() {
    use std::time::Instant;
    let home = std::env::var("HOME").unwrap();
    let real_banks = PathBuf::from(format!("{home}/.omp/agent/memories/mnemopi/banks"));
    if !real_banks.is_dir() {
        println!("no real bank root, skip");
        return;
    }
    // 真实树快照（含 mtime）。
    let snapshot_full = || -> Vec<(PathBuf, u64, std::time::SystemTime)> {
        let mut out = Vec::new();
        let mut stack = vec![real_banks.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let meta = entry.metadata().unwrap();
                    out.push((path, meta.len(), meta.modified().unwrap()));
                }
            }
        }
        out.sort();
        out
    };
    let before = snapshot_full();
    println!("real tree files: {}", before.len());

    // 拷到 /tmp（含 -wal/-shm）。
    let tmp = tempfile::tempdir().unwrap();
    let banks = tmp.path().join("banks");
    let data = tmp.path().join("data");
    let t = Instant::now();
    copy_tree(&real_banks, &banks);
    println!("copy elapsed: {:?}", t.elapsed());
    assert_eq!(dir_snapshot_names_sizes(&banks).len(), before.len());

    // 找最大 bank（working 行数最多）。
    let mut biggest = String::new();
    let mut biggest_n = 0i64;
    for entry in std::fs::read_dir(&banks).unwrap().flatten() {
        let db = entry.path().join("mnemopi.db");
        if !db.is_file() {
            continue;
        }
        let Ok(conn) = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            continue;
        };
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM working_memory", [], |r| r.get(0))
            .unwrap_or(0);
        if n > biggest_n {
            biggest_n = n;
            biggest = entry.file_name().to_str().unwrap().to_owned();
        }
    }
    assert!(
        !biggest.is_empty() && biggest_n >= 3,
        "need a bank with >=3 working rows"
    );
    println!("biggest bank: {biggest} working={biggest_n}");

    // 取 3 个 working id（只取 id，不读正文）。
    let db = banks.join(&biggest).join("mnemopi.db");
    let conn =
        Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut stmt = conn
        .prepare("SELECT id FROM working_memory LIMIT 3")
        .unwrap();
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect();
    drop(stmt);
    drop(conn);
    assert_eq!(ids.len(), 3);

    // preview → delete → integrity → restore → 计数一致。
    let preview = preview_impl(&banks, &biggest, &ids).unwrap();
    println!(
        "preview: deletable w={} e={} unsupported={} notFound={} cascade facts={} emb={} ann={} edges={} other={} cited={}",
        preview.deletable.working,
        preview.deletable.episodic,
        preview.unsupported,
        preview.not_found,
        preview.cascade.facts,
        preview.cascade.embeddings,
        preview.cascade.annotations,
        preview.cascade.edges,
        preview.cascade.other,
        preview.cited_by_summaries,
    );
    let before_counts = content_snapshot(&db);
    let result = delete_items_impl_with(&banks, &data, &biggest, &ids, &prod_gate()).unwrap();
    println!(
        "deleted={} skipped={} backup_kind={:?}",
        result.deleted.len(),
        result.skipped.len(),
        result.backup.kind
    );
    assert_eq!(result.deleted.len(), 3);
    assert_integrity_ok(&db);
    assert_fts_clean(&db, "fts_working");
    assert_fts_clean(&db, "fts_episodes");
    let restored = restore_impl_with(&banks, &data, &result.backup.id, &prod_gate()).unwrap();
    assert!(restored.safety_backup.is_some());
    assert_eq!(content_snapshot(&db), before_counts);
    println!("restore ok, counts identical");

    // 真实树 untouched。
    let after = snapshot_full();
    assert_eq!(before.len(), after.len(), "file count changed!");
    for (b, a) in before.iter().zip(after.iter()) {
        assert_eq!(b.0, a.0);
        assert_eq!(b.1, a.1, "size changed: {}", b.0.display());
        let is_shm = b.0.extension().is_some_and(|e| e == "db-shm");
        if !is_shm {
            assert_eq!(b.2, a.2, "mtime changed: {}", b.0.display());
        }
    }
    println!("real tree untouched (names+sizes+mtimes, -shm mtime exempt)");
}
