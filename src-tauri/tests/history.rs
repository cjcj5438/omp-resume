//! 提示词历史 / recap 只读查询（CONTRACT §13）：临时库 fixture，不碰真实 `~/.omp`。

use std::path::{Path, PathBuf};

use omp_resume_lib::history::{search_prompts, session_recap};
use rusqlite::{params, Connection};

const SCHEMA: &str = "
CREATE TABLE history (
    id INTEGER PRIMARY KEY,
    prompt TEXT UNIQUE,
    created_at INTEGER,
    cwd TEXT,
    session_id TEXT,
    use_count INTEGER
);
CREATE TABLE session_recaps (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    cwd TEXT,
    recap TEXT,
    created_at INTEGER
);
";

fn make_db(dir: &Path) -> PathBuf {
    let p = dir.join("history.db");
    let conn = Connection::open(&p).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    p
}

fn add_prompt(
    db: &Path,
    id: i64,
    prompt: &str,
    created_at: i64,
    cwd: Option<&str>,
    sid: Option<&str>,
) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO history (id, prompt, created_at, cwd, session_id, use_count) VALUES (?1, ?2, ?3, ?4, ?5, 1)",
        params![id, prompt, created_at, cwd, sid],
    )
    .unwrap();
}

fn add_recap(db: &Path, id: i64, sid: &str, recap: &str, created_at: i64) {
    let conn = Connection::open(db).unwrap();
    conn.execute(
        "INSERT INTO session_recaps (id, session_id, cwd, recap, created_at) VALUES (?1, ?2, '/x', ?3, ?4)",
        params![id, sid, recap, created_at],
    )
    .unwrap();
}

fn prompts(db: &Path, q: Option<&str>) -> Vec<String> {
    search_prompts(db, q, 1000)
        .into_iter()
        .map(|e| e.prompt)
        .collect()
}

#[test]
fn recap_picks_latest_by_created_at_then_id() {
    let t = tempfile::tempdir().unwrap();
    let db = make_db(t.path());
    // created_at 更大者胜；同时间戳下 id 更大者胜（id 故意与插入顺序相反）。
    add_recap(&db, 9, "s1", "较早但 id 大", 200);
    add_recap(&db, 5, "s1", "同时间、id 较大", 300);
    add_recap(&db, 2, "s1", "同时间、id 较小", 300);
    add_recap(&db, 7, "s2", "别的会话", 999);
    assert_eq!(session_recap(&db, "s1").as_deref(), Some("同时间、id 较大"));
    assert_eq!(session_recap(&db, "s2").as_deref(), Some("别的会话"));
    assert_eq!(session_recap(&db, "nope"), None);
}

#[test]
fn recap_blank_is_none() {
    let t = tempfile::tempdir().unwrap();
    let db = make_db(t.path());
    add_recap(&db, 1, "s1", "   \n", 100);
    assert_eq!(session_recap(&db, "s1"), None);
}

#[test]
fn missing_db_is_silent_and_not_created() {
    let t = tempfile::tempdir().unwrap();
    let db = t.path().join("absent.db");
    assert_eq!(session_recap(&db, "s1"), None);
    assert!(search_prompts(&db, None, 10).is_empty());
    assert!(search_prompts(&db, Some("x"), 10).is_empty());
    assert!(!db.exists(), "只读查询不得创建库文件");
}

#[test]
fn schema_mismatch_is_silent() {
    let t = tempfile::tempdir().unwrap();
    // 无表的库：两条查询都静默降级。
    let empty = t.path().join("empty.db");
    Connection::open(&empty)
        .unwrap()
        .execute_batch("CREATE TABLE other (x INTEGER);")
        .unwrap();
    assert_eq!(session_recap(&empty, "s1"), None);
    assert!(search_prompts(&empty, None, 10).is_empty());
    // history 表缺 prompt 列：SQL 出错 ⇒ 空结果，而不是 panic 或报错。
    let bad = t.path().join("bad.db");
    Connection::open(&bad)
        .unwrap()
        .execute_batch("CREATE TABLE history (id INTEGER PRIMARY KEY, created_at INTEGER);")
        .unwrap();
    assert!(search_prompts(&bad, None, 10).is_empty());
}

#[test]
fn search_orders_desc_and_honours_limit() {
    let t = tempfile::tempdir().unwrap();
    let db = make_db(t.path());
    add_prompt(&db, 1, "first", 100, None, None);
    add_prompt(&db, 2, "second", 300, None, None);
    add_prompt(&db, 3, "third", 200, None, None);
    add_prompt(&db, 4, "fourth", 400, None, None);
    assert_eq!(prompts(&db, None), ["fourth", "second", "third", "first"]);
    let top2: Vec<String> = search_prompts(&db, None, 2)
        .into_iter()
        .map(|e| e.prompt)
        .collect();
    assert_eq!(top2, ["fourth", "second"]);
}

#[test]
fn like_wildcards_are_literal() {
    let t = tempfile::tempdir().unwrap();
    let db = make_db(t.path());
    add_prompt(&db, 1, "100% done", 1, None, None);
    add_prompt(&db, 2, "100 done", 2, None, None);
    add_prompt(&db, 3, "axb", 3, None, None);
    add_prompt(&db, 4, "a_b", 4, None, None);
    add_prompt(&db, 5, "back\\slash", 5, None, None);
    // `%` 不得当通配符：只命中字面 `%`。
    assert_eq!(prompts(&db, Some("%")), ["100% done"]);
    assert_eq!(prompts(&db, Some("0%")), ["100% done"]);
    // `_` 不得当单字符通配：`a_b` 不命中 `axb`。
    assert_eq!(prompts(&db, Some("_")), ["a_b"]);
    assert_eq!(prompts(&db, Some("a_b")), ["a_b"]);
    // 反斜杠（转义符本身）按字面匹配。
    assert_eq!(prompts(&db, Some("\\")), ["back\\slash"]);
}

#[test]
fn search_matches_cjk_substring_and_ascii_case_insensitively() {
    let t = tempfile::tempdir().unwrap();
    let db = make_db(t.path());
    add_prompt(&db, 1, "修复登录 bug", 1, None, None);
    add_prompt(&db, 2, "Fix README.md typo", 2, None, None);
    add_prompt(&db, 3, "unrelated", 3, None, None);
    assert_eq!(prompts(&db, Some("登录")), ["修复登录 bug"]);
    assert_eq!(prompts(&db, Some("readme")), ["Fix README.md typo"]);
    // 空白查询 = 不过滤。
    assert_eq!(prompts(&db, Some("   ")).len(), 3);
}

#[test]
fn entry_fields_are_mapped() {
    let t = tempfile::tempdir().unwrap();
    let db = make_db(t.path());
    // 1700000000 = 2023-11-14T22:13:20Z；空 cwd / 空 session_id 映射为 null。
    add_prompt(&db, 1, "p", 1_700_000_000, Some("/a b"), Some("sess-1"));
    add_prompt(&db, 2, "q", 1_700_000_001, Some(""), None);
    let got = search_prompts(&db, None, 10);
    assert_eq!(got[0].id, 2);
    assert_eq!(got[0].cwd, None);
    assert_eq!(got[0].session_id, None);
    assert_eq!(got[1].cwd.as_deref(), Some("/a b"));
    assert_eq!(got[1].session_id.as_deref(), Some("sess-1"));
    assert_eq!(got[1].created_at, "2023-11-14T22:13:20.000Z");
    assert_eq!(got[1].use_count, 1);
}

/// 只读铁律：查询前后主库字节与 mtime 不变（WAL 模式库经正常关闭后做 fixture）。
#[test]
fn readonly_queries_leave_db_bytes_untouched() {
    let t = tempfile::tempdir().unwrap();
    let db = make_db(t.path());
    add_prompt(&db, 1, "读取不应改写", 1, Some("/p"), Some("s1"));
    add_recap(&db, 1, "s1", "recap 文本", 1);
    {
        // 正常关闭（checkpoint）后再测只读路径。
        let conn = Connection::open(&db).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    }
    let before = std::fs::read(&db).unwrap();
    let mtime = std::fs::metadata(&db).unwrap().modified().unwrap();

    assert_eq!(session_recap(&db, "s1").as_deref(), Some("recap 文本"));
    assert_eq!(prompts(&db, Some("改写")), ["读取不应改写"]);

    assert_eq!(std::fs::read(&db).unwrap(), before, "主库字节不得变化");
    assert_eq!(std::fs::metadata(&db).unwrap().modified().unwrap(), mtime);
}

/// 真实库只读探测（手动 `cargo test --test history -- --ignored probe_real_history_db`）。
/// 只打印条数，不打印任何提示词或 recap 内容。
#[test]
#[ignore]
fn probe_real_history_db() {
    let db = omp_resume_lib::history::resolve_db_path();
    let conn = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open real history.db read-only");
    let prompts: i64 = conn
        .query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0))
        .unwrap();
    let recaps: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_recaps", [], |r| r.get(0))
        .unwrap();
    let sessions: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT session_id) FROM session_recaps",
            [],
            |r| r.get(0),
        )
        .unwrap();
    println!("PROBE prompts={prompts} recaps={recaps} recap_sessions={sessions}");
    println!(
        "PROBE api_search_all={}",
        search_prompts(&db, None, u32::MAX).len()
    );
}
