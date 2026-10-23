//! 记忆库集成测试共享 fixture：上游建表（v18.12.3 超集，含 FTS5 虚表与触发器）、
//! bank 构造与断言辅助。两个测试二进制各用其中一部分。
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// 上游建表 + FTS5 虚表与触发器；读路径忽略多余表。
pub const SCHEMA: &str = "
CREATE TABLE working_memory (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, embed_text TEXT DEFAULT NULL, source TEXT,
    timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5,
    metadata_json TEXT, veracity TEXT DEFAULT 'unknown', memory_type TEXT DEFAULT 'unknown',
    consolidated_at TEXT, recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP DEFAULT NULL,
    valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL,
    scope TEXT DEFAULT 'global', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE episodic_memory (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
    source TEXT, timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5,
    metadata_json TEXT, summary_of TEXT DEFAULT '', veracity TEXT DEFAULT 'unknown',
    tier INTEGER DEFAULT 1, memory_type TEXT DEFAULT 'unknown', binary_vector BLOB,
    recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP DEFAULT NULL,
    valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL,
    scope TEXT DEFAULT 'global', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE facts (
    fact_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, subject TEXT NOT NULL,
    predicate TEXT NOT NULL, object TEXT NOT NULL, timestamp TEXT, source_msg_id TEXT,
    confidence REAL DEFAULT 1.0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE memoria_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT DEFAULT 'default', fact_type TEXT,
    key TEXT, value TEXT, source_memory_id TEXT
);
CREATE TABLE annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT NOT NULL, model TEXT);
CREATE TABLE gists (id TEXT PRIMARY KEY, text TEXT NOT NULL, memory_id TEXT);
CREATE TABLE graph_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL,
    edge_type TEXT NOT NULL, UNIQUE(source, target, edge_type)
);
CREATE TABLE memory_validations (
    validation_id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
    validator TEXT NOT NULL, action TEXT NOT NULL
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

/// `Option<&str>` → SQL 字面量（None ⇒ NULL）。
pub fn sql_opt(value: Option<&str>) -> String {
    value.map_or_else(|| "NULL".to_owned(), |v| format!("'{v}'"))
}

/// `metadata_json` 合成值。
pub fn meta(cwd: &str, sid: &str) -> String {
    format!(r#"{{"cwd":"{cwd}","session_id":"{sid}","message_count":3}}"#)
}

pub fn owned(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| (*s).to_owned()).collect()
}

/// 单个合成 bank 库。
pub struct Bank {
    pub dir: PathBuf,
}

impl Bank {
    pub fn new(root: &Path, name: &str) -> Self {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let bank = Bank { dir };
        bank.exec(SCHEMA);
        bank
    }

    pub fn db(&self) -> PathBuf {
        self.dir.join("mnemopi.db")
    }

    pub fn exec(&self, sql: &str) {
        Connection::open(self.db())
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    }

    /// 最小 working 行（无时间戳/元数据、recall 0、未巩固）。
    pub fn w(&self, bank: &str, id: &str) {
        self.exec(&format!(
            "INSERT INTO working_memory (id, content, session_id) VALUES ('{id}', 'x', '{bank}')"
        ));
    }

    pub fn wt(&self, id: &str, content: &str, ts: &str) {
        self.exec(&format!(
            "INSERT INTO working_memory (id, content, timestamp) VALUES ('{id}', '{content}', '{ts}')"
        ));
    }

    pub fn wm(&self, id: &str, content: &str, ts: Option<&str>, meta: &str, recall: i64) {
        self.exec(&format!(
            "INSERT INTO working_memory (id, content, timestamp, metadata_json, recall_count) \
             VALUES ('{id}', '{content}', {}, '{meta}', {recall})",
            sql_opt(ts)
        ));
    }

    pub fn e(&self, bank: &str, id: &str, summary_of: &str) {
        self.exec(&format!(
            "INSERT INTO episodic_memory (id, content, session_id, summary_of) \
             VALUES ('{id}', 'x', '{bank}', '{summary_of}')"
        ));
    }

    pub fn et(&self, id: &str, content: &str, ts: Option<&str>, summary_of: &str) {
        self.exec(&format!(
            "INSERT INTO episodic_memory (id, content, timestamp, summary_of) \
             VALUES ('{id}', '{content}', {}, '{summary_of}')",
            sql_opt(ts)
        ));
    }

    pub fn fact(&self, fact_id: &str, source_msg_id: &str) {
        self.exec(&format!(
            "INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) \
             VALUES ('{fact_id}', 'bank', 'sub-{fact_id}', 'pred-{fact_id}', 'obj-{fact_id}', '{source_msg_id}')"
        ));
    }

    pub fn memoria_fact(&self, key: &str, value: &str, source_memory_id: &str) {
        self.exec(&format!(
            "INSERT INTO memoria_facts (fact_type, key, value, source_memory_id) \
             VALUES ('pref', '{key}', '{value}', '{source_memory_id}')"
        ));
    }

    pub fn edge(&self, source: &str, target: &str) {
        self.exec(&format!(
            "INSERT INTO graph_edges (source, target, edge_type) VALUES ('{source}', '{target}', 'linked')"
        ));
    }

    /// 挂全套附属物（facts/memoria/embedding/annotation/gist/三类边）。
    pub fn attach(&self, id: &str) {
        self.exec(&format!(
            "INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) \
             VALUES ('fact-{id}', 's', 's', 'p', 'o', '{id}');
             INSERT INTO memoria_facts (fact_type, key, value, source_memory_id) \
             VALUES ('t', 'k-{id}', 'v', '{id}');
             INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES ('{id}', '[0.1]');
             INSERT INTO annotations (memory_id, kind, value) VALUES ('{id}', 'occurred_on', '2026-01-01');
             INSERT INTO gists (id, text, memory_id) VALUES ('gist_{id}', 'gist', '{id}');
             INSERT INTO graph_edges (source, target, edge_type) VALUES ('{id}', 'other', 'linked');
             INSERT INTO graph_edges (source, target, edge_type) VALUES ('gist_{id}', 'other2', 'linked');
             INSERT INTO graph_edges (source, target, edge_type) VALUES ('fact-{id}', 'other3', 'linked');"
        ));
    }

    pub fn count(&self, table: &str) -> i64 {
        Connection::open(self.db())
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
                r.get(0)
            })
            .unwrap()
    }

    /// 两表 `(table:id, content)` 有序 + 六表计数（恢复一致性比对）。
    pub fn snapshot(&self) -> (Vec<(String, String)>, [i64; 6]) {
        let conn = Connection::open(self.db()).unwrap();
        let mut rows = Vec::new();
        for table in ["working_memory", "episodic_memory"] {
            let mut stmt = conn
                .prepare(&format!("SELECT id, content FROM \"{table}\" ORDER BY id"))
                .unwrap();
            let mapped = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap();
            for row in mapped.flatten() {
                rows.push((format!("{table}:{}", row.0), row.1));
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
        .map(|t| {
            conn.query_row(&format!("SELECT COUNT(*) FROM \"{t}\""), [], |r| r.get(0))
                .unwrap()
        });
        (rows, counts)
    }

    pub fn integrity_ok(&self) -> bool {
        let s: String = Connection::open(self.db())
            .unwrap()
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        s.eq_ignore_ascii_case("ok")
    }

    /// FTS5 外部内容表自检；表不存在 ⇒ 视为干净。
    pub fn fts_clean(&self, table: &str) -> bool {
        let conn = Connection::open(self.db()).unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = ?1",
                [table],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return true;
        }
        let mut stmt = conn
            .prepare(&format!(
                "INSERT INTO {table}({table}) VALUES('integrity-check')"
            ))
            .unwrap();
        let mut rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.next().is_none()
    }

    /// 六表对给定 id 无残留。
    pub fn no_orphans(&self, ids: &[&str]) -> bool {
        let conn = Connection::open(self.db()).unwrap();
        let placeholders = |n: usize| format!("({})", vec!["?"; n].join(","));
        let id_params: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let tables = [
            ("facts", "source_msg_id"),
            ("annotations", "memory_id"),
            ("memory_embeddings", "memory_id"),
            ("gists", "memory_id"),
            ("memoria_facts", "source_memory_id"),
        ];
        let cleared = tables.iter().all(|(table, col)| {
            let n: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM \"{table}\" WHERE \"{col}\" IN {}",
                        placeholders(ids.len())
                    ),
                    id_params.as_slice(),
                    |r| r.get(0),
                )
                .unwrap();
            n == 0
        });
        let refs: Vec<String> = ids
            .iter()
            .flat_map(|id| [(*id).to_owned(), format!("gist_{id}"), format!("fact-{id}")])
            .collect();
        let ref_params: Vec<&dyn rusqlite::ToSql> =
            refs.iter().map(|r| r as &dyn rusqlite::ToSql).collect();
        let mut both = ref_params.clone();
        both.extend(ref_params.iter().copied());
        let ph = placeholders(refs.len());
        let edges: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM graph_edges WHERE source IN {ph} OR target IN {ph}"),
                both.as_slice(),
                |r| r.get(0),
            )
            .unwrap();
        cleared && edges == 0
    }

    pub fn sha256(&self) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(std::fs::read(self.db()).unwrap()))
    }
}

/// 递归收集 `(路径, 字节数)` 并排序（只读契约用）。
pub fn dir_snapshot(root: &Path) -> Vec<(PathBuf, u64)> {
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

/// 在 sessions 目录造一个会话文件名。
pub fn add_session_file(sessions: &Path, uuid: &str) {
    std::fs::create_dir_all(sessions.join("-proj")).unwrap();
    let name = format!("2026-10-14T02-18-47-387Z_{uuid}.jsonl");
    std::fs::write(sessions.join("-proj").join(name), "{}\n").unwrap();
}

// ---------------------------------------------------------------------------
// 会话 fixture 辅助（backend/safety/ops 三文件共用；user_msg/assistant_msg 夹具
// 内容不同，各自保留）。
// ---------------------------------------------------------------------------

pub fn cfg(root: &Path) -> omp_resume_lib::config::Config {
    omp_resume_lib::config::Config {
        sessions_dir: root.to_path_buf(),
        owners_dir: root.join("owners"),
    }
}

pub fn write_bytes(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

pub fn write_lines(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
    write_bytes(dir, name, (lines.join("\n") + "\n").as_bytes())
}

pub fn header(id: &str, cwd: &str) -> String {
    serde_json::json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-14T00:00:00.000Z","cwd":cwd})
        .to_string()
}

pub fn msg(id: &str, parent: Option<&str>, message: serde_json::Value) -> String {
    serde_json::json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-14T00:00:01.000Z","message":message}).to_string()
}
