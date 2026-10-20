//! 记忆库只读命令（CONTRACT §18）：合成 bank 库 fixture，不碰真实 `~/.omp`。
//! 真实数据回归见文末 `real_data_readonly`（`#[ignore]`，只打印计数与耗时）。

mod common;

use std::path::PathBuf;

use common::{add_session_file, dir_snapshot, meta, Bank};
use omp_resume_lib::memory::rows::{detail_impl, list_impl, ListParams};
use omp_resume_lib::memory::{overview_impl, CONTENT_CAP_BYTES};
use omp_resume_lib::model::{
    ErrorCode, MemoryDetail, MemoryKind, MemoryKindFilter, MemoryOverview, MemoryPage, MemorySort,
};
use rusqlite::Connection;

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    sessions: PathBuf,
}

impl Fx {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("banks");
        std::fs::create_dir_all(&root).unwrap();
        let sessions = tmp.path().join("sessions");
        std::fs::create_dir_all(sessions.join("-proj")).unwrap();
        Fx {
            _tmp: tmp,
            root,
            sessions,
        }
    }

    fn overview(&self) -> MemoryOverview {
        overview_impl(&self.root, &self.sessions).unwrap()
    }

    fn bank(&self, name: &str) -> Bank {
        Bank::new(&self.root, name)
    }

    fn list(&self, p: &ListParams) -> MemoryPage {
        list_impl(&self.root, &self.sessions, p).unwrap()
    }

    fn list_err(&self, p: &ListParams) -> ErrorCode {
        list_impl(&self.root, &self.sessions, p).unwrap_err().code
    }

    fn detail(&self, bank: &str, id: &str) -> MemoryDetail {
        detail_impl(&self.root, &self.sessions, bank, id).unwrap()
    }

    fn detail_err(&self, bank: &str, id: &str) -> ErrorCode {
        detail_impl(&self.root, &self.sessions, bank, id)
            .unwrap_err()
            .code
    }
}

fn params(bank: &str) -> ListParams {
    ListParams {
        bank: bank.to_owned(),
        ..ListParams::default()
    }
}

fn ids(page: &MemoryPage) -> Vec<&str> {
    page.items.iter().map(|i| i.id.as_str()).collect()
}

const SID_OK: &str = "01a13834-1111-2222-3333-444444444444";
const SID_GONE: &str = "02b24945-1111-2222-3333-444444444444";

/// 概览：多 bank 计数/排序/displayName/cwdExists + 降级（缺列、缺表、垃圾库、空库、根缺失）。
#[test]
fn overview_counts_sort_and_degrade() {
    let f = Fx::new();
    add_session_file(&f.sessions, SID_OK);
    let cwd = f._tmp.path().join("proj");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd = cwd.to_str().unwrap().to_owned();

    let b = f.bank("alpha-aaa111");
    b.wm(
        "w1",
        "first",
        Some("2026-10-10T10:00:00.000Z"),
        &meta(&cwd, SID_OK),
        0,
    );
    b.wm(
        "w2",
        "second",
        Some("2026-10-12T10:00:00.000Z"),
        &meta(&cwd, SID_GONE),
        3,
    );
    b.exec(
        "UPDATE working_memory SET consolidated_at = '2026-10-12T11:00:00.000Z' WHERE id = 'w2'",
    );
    b.et("e1", "epi", Some("2026-10-11T10:00:00.000Z"), "w1");
    b.fact("f1", "w1");
    f.bank("beta-bbb222")
        .wt("w9", "old", "2026-09-01T10:00:00.000Z");
    f.bank("gone-xyz9")
        .exec("INSERT INTO working_memory (id, content) VALUES ('w1', 'x')");
    f.bank("empty-ccc333");
    // 缺 recall/consolidated/metadata/facts 列与表。
    let thin = f.bank("thin-1");
    thin.exec("DROP TABLE working_memory; DROP TABLE episodic_memory;");
    thin.exec(
        "CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, timestamp TEXT);
         CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT);
         INSERT INTO working_memory (id, content) VALUES ('w1', 'x');",
    );
    // 坏库与无记忆表。
    let bad = f.bank("broken-ddd444");
    std::fs::write(bad.db(), b"not a database").unwrap();
    let odd = f.bank("odd-1");
    odd.exec("DROP TABLE working_memory; DROP TABLE episodic_memory;");
    odd.exec("CREATE TABLE something_else (id INTEGER);");

    let over = f.overview();
    assert!(over.available);
    assert_eq!(over.totals.banks, 7);
    assert_eq!(over.totals.working, 5);
    assert_eq!(over.totals.episodic, 1);
    assert_eq!(over.totals.facts, 1);
    // lastMemoryAt 倒序；无时间的 bank 沉底并按名升序。
    let names: Vec<&str> = over.banks.iter().map(|b| b.bank.as_str()).collect();
    assert_eq!(
        names,
        [
            "alpha-aaa111",
            "beta-bbb222",
            "broken-ddd444",
            "empty-ccc333",
            "gone-xyz9",
            "odd-1",
            "thin-1"
        ]
    );

    let a = &over.banks[0];
    assert_eq!(a.display_name, "proj");
    assert_eq!(a.cwd.as_deref(), Some(cwd.as_str()));
    assert_eq!(a.cwd_exists, Some(true));
    assert!(a.last_memory_at.is_some());
    assert_eq!(a.never_recalled, 2); // w1 + e1（recall 0）
    assert_eq!(a.unconsolidated, 1); // w1
    assert_eq!(a.source_sessions, 2);
    assert_eq!(a.missing_source_sessions, 1);
    assert!(a.bytes > 0 && a.readable && a.error.is_none());

    // 坏库 / 空库 / cwd 未知（displayName 去 hash 后缀）/ 无记忆表 / 缺列降级。
    assert!(!over.banks[2].readable && over.banks[2].error.is_some());
    assert!(over.banks[3].readable && over.banks[3].last_memory_at.is_none());
    assert_eq!(over.banks[4].cwd, None);
    assert_eq!(over.banks[4].display_name, "gone");
    assert!(!over.banks[5].readable);
    let t = &over.banks[6];
    assert!(t.readable && t.working == 1 && t.facts == 0);
    assert_eq!(t.never_recalled, 1); // recall 列缺失 ⇒ 全算
    assert_eq!(t.unconsolidated, 0); // consolidated 列缺失 ⇒ 0
    assert!(t.cwd.is_none() && t.source_sessions == 0);

    // 根缺失 ⇒ 空状态（非错误）。
    let over = overview_impl(&f.root.join("no-such-banks"), &f.sessions).unwrap();
    assert!(!over.available && over.banks.is_empty() && over.totals.banks == 0);
    // bank/id 错误矩阵（preview/status/list/detail 语义一致）。
    for (bank, code) in [
        ("../escape", ErrorCode::OutsideRoot),
        ("missing", ErrorCode::NotFound),
        ("broken-ddd444", ErrorCode::Io),
        ("odd-1", ErrorCode::Io),
    ] {
        assert_eq!(f.list_err(&params(bank)), code, "{bank}");
    }
    for (bank, id, code) in [
        ("alpha-aaa111", "nope", ErrorCode::NotFound),
        ("missing", "w1", ErrorCode::NotFound),
        ("..", "w1", ErrorCode::OutsideRoot),
        ("odd-1", "e1", ErrorCode::Io),
    ] {
        assert_eq!(f.detail_err(bank, id), code, "{bank}/{id}");
    }
    // kind 指向缺失表（thin-1 有 working，无 episodic）⇒ 空页而非错误。
    let mut p = params("thin-1");
    p.kind = MemoryKindFilter::Episodic;
    assert_eq!(f.list(&p).total, 0);
}

/// 分页/排序/kind 过滤/limit 钳制/offset 取整/NULL 时间戳排最后。
#[test]
fn list_paging_sort_and_kind() {
    let f = Fx::new();
    let b = f.bank("b-1");
    b.wt("w1", "a", "2026-10-10T10:00:00.000Z");
    b.wt("w2", "b", "2026-10-11T10:00:00.000Z");
    b.wt("w3", "c", "2026-10-12T10:00:00.000Z");
    b.et("e1", "epi", Some("2026-10-13T10:00:00.000Z"), "");
    b.exec("INSERT INTO working_memory (id, content) VALUES ('w4', 'no timestamp')");
    b.exec("UPDATE working_memory SET recall_count = 5 WHERE id = 'w1'");
    b.exec("UPDATE working_memory SET recall_count = 9 WHERE id = 'w3'");
    b.exec("UPDATE episodic_memory SET recall_count = 1 WHERE id = 'e1'");

    let mut p = params("b-1");
    let page = f.list(&p);
    assert_eq!(page.total, 5);
    assert_eq!(ids(&page), ["e1", "w3", "w2", "w1", "w4"]);
    assert_eq!(page.items[4].created_at, None);
    p.limit = 2;
    p.offset = 1;
    let page = f.list(&p);
    assert_eq!(page.total, 5);
    assert_eq!(ids(&page), ["w3", "w2"]);
    p.limit = 50;
    p.offset = 0;
    p.sort = MemorySort::Oldest;
    assert_eq!(ids(&f.list(&p)), ["w1", "w2", "w3", "e1", "w4"]);
    p.sort = MemorySort::MostRecalled;
    assert_eq!(ids(&f.list(&p)), ["w3", "w1", "e1", "w2", "w4"]);
    p.sort = MemorySort::Newest;
    p.kind = MemoryKindFilter::Working;
    assert_eq!(f.list(&p).total, 4);
    p.kind = MemoryKindFilter::Episodic;
    assert_eq!(f.list(&p).total, 1);

    // limit 钳制 1..=200；offset 负数按 0。
    p.kind = MemoryKindFilter::All;
    p.limit = 0;
    assert_eq!(f.list(&p).items.len(), 1);
    p.limit = 50;
    p.offset = -5;
    assert_eq!(f.list(&p).items.len(), 5);
}

/// 搜索：CJK 内部子串（LIKE 而非 FTS token）、`%`/`_` 字面量、命中 `embed_text`、空白 = 不过滤。
#[test]
fn list_query_semantics() {
    let f = Fx::new();
    let b = f.bank("b-1");
    b.wt("w1", "合成记忆内容用于测试搜索", "2026-10-10T10:00:00.000Z");
    b.wt("w2", "100% coverage_guaranteed", "2026-10-11T10:00:00.000Z");
    b.wt("w3", "plain text", "2026-10-12T10:00:00.000Z");
    b.exec("UPDATE working_memory SET embed_text = 'hidden-marker' WHERE id = 'w3'");

    let mut p = params("b-1");
    for (query, want) in [
        ("记忆内容", "w1"),
        ("100%", "w2"),
        ("coverage_guaranteed", "w2"),
        ("hidden-marker", "w3"),
    ] {
        p.query = Some(query.to_owned());
        let page = f.list(&p);
        assert_eq!(
            (page.total, page.items[0].id.as_str()),
            (1, want),
            "{query}"
        );
    }
    // 反斜杠字面量：库里没有 ⇒ 0 条（且 SQL 不报错）。
    p.query = Some("a\\b".to_owned());
    assert_eq!(f.list(&p).total, 0);
    p.query = Some("   ".to_owned());
    assert_eq!(f.list(&p).total, 3);
}

/// 三个筛选：neverRecalled（缺列视为 0）/ unconsolidated（仅 working）/ missingSource
/// （脏 JSON 与数字 id 不命中且不报错）。
#[test]
fn list_filters() {
    let f = Fx::new();
    add_session_file(&f.sessions, SID_OK);
    let b = f.bank("b-1");
    b.wm("w1", "a", None, &meta("/p", SID_GONE), 0);
    b.wm("w2", "b", None, &meta("/p", SID_OK), 7);
    b.wm("w3", "c", None, "{oops malformed", 0);
    b.wm("w4", "d", None, r#"{"session_id":42}"#, 0);
    b.exec(&format!(
        "INSERT INTO episodic_memory (id, content, metadata_json) VALUES ('e1', 'e', '{}')",
        meta("/p", SID_GONE)
    ));

    let mut p = params("b-1");
    p.only_never_recalled = true;
    assert_eq!(f.list(&p).total, 4); // 除 w2 外全命中
    p.only_never_recalled = false;
    p.only_unconsolidated = true;
    let page = f.list(&p);
    assert_eq!(page.total, 4); // w1..w4；episodic 永不命中
    assert!(page.items.iter().all(|i| i.kind == MemoryKind::Working));
    p.only_unconsolidated = false;
    p.only_missing_source = true;
    let page = f.list(&p);
    assert_eq!(page.total, 2); // w1 + e1
    assert!(page
        .items
        .iter()
        .all(|i| i.source_session_id.as_deref() == Some(SID_GONE)));
}

/// 行字段：snippet 折叠/240 字/`…`、contentChars、来源存在性、superseded 判定。
#[test]
fn list_item_fields() {
    let f = Fx::new();
    add_session_file(&f.sessions, SID_OK);
    let b = f.bank("b-1");
    let content = format!("  hello   world\n{}  ", "字".repeat(300));
    b.exec(&format!(
        "INSERT INTO working_memory (id, content, timestamp, metadata_json, recall_count, consolidated_at, valid_until) \
         VALUES ('w1', '{content}', '2026-10-10T10:00:00.000Z', '{}', 2, '2026-10-11T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
        meta("/p", SID_OK)
    ));
    b.exec("INSERT INTO working_memory (id, content, valid_until) VALUES ('w2', 'future', '2999-01-01T00:00:00.000Z')");
    b.exec("INSERT INTO working_memory (id, content, valid_until) VALUES ('w3', 'bad-date', 'not-a-date')");

    let mut p = params("b-1");
    p.sort = MemorySort::Oldest;
    let page = f.list(&p);
    assert_eq!(page.total, 3);
    let w1 = &page.items[0];
    assert!(w1.snippet.starts_with("hello world ") && w1.snippet.ends_with('…'));
    assert_eq!(w1.snippet.chars().count(), 241);
    assert_eq!(w1.content_chars, content.chars().count() as u64);
    assert_eq!(w1.created_at.as_deref(), Some("2026-10-10T10:00:00.000Z"));
    assert_eq!(w1.source_session_id.as_deref(), Some(SID_OK));
    assert_eq!(w1.source_session_exists, Some(true));
    assert_eq!(w1.recall_count, 2);
    assert!(w1.consolidated);
    assert!(w1.superseded); // valid_until 过去
                            // 未来 valid_until / 脏日期 ⇒ 未过期；无会话 id ⇒ 存在性 null。
    assert!(!page.items[1].superseded);
    assert!(!page.items[2].superseded);
    assert_eq!(page.items[1].source_session_exists, None);
}

/// 详情：全字段、embed 与正文全等 ⇒ null、facts 顺序与 50 上限、summaryOf、边计数、200KB 截断。
#[test]
fn detail_shapes() {
    let f = Fx::new();
    add_session_file(&f.sessions, SID_OK);
    let b = f.bank("b-1");
    b.exec(&format!(
        "INSERT INTO working_memory (id, content, embed_text, timestamp, metadata_json, recall_count, last_recalled, importance, veracity, memory_type, consolidated_at, superseded_by) \
         VALUES ('w1', 'full-content', 'different-embed', '2026-10-10T10:00:00.000Z', '{}', 4, '2026-10-12T00:00:00.000Z', 0.9, 'stated', 'lesson', '2026-10-11T00:00:00.000Z', 'w2')",
        meta("/p", SID_OK).replace('}', r#","api_key":"K"}"#)
    ));
    b.exec("INSERT INTO working_memory (id, content, embed_text) VALUES ('w2', 'same', 'same')");
    b.exec(&format!(
        "INSERT INTO working_memory (id, content) VALUES ('w3', '{}')",
        "字".repeat(70_000)
    ));
    b.et("e1", "epi", Some("2026-10-10T10:00:00.000Z"), "w1, w2,,w3 ");
    b.fact("f1", "w1");
    b.memoria_fact("topic", "rust", "w1");
    b.edge("w1", "other");
    b.edge("other", "w1");
    b.edge("unrelated", "else");
    for i in 0..60 {
        b.fact(&format!("g{i:02}"), "w2");
    }

    let d = f.detail("b-1", "w1");
    assert_eq!(d.item.id, "w1");
    assert_eq!(d.item.kind, MemoryKind::Working);
    assert_eq!(d.content, "full-content");
    assert!(!d.truncated);
    assert_eq!(d.embed_text.as_deref(), Some("different-embed"));
    assert_eq!(d.item.recall_count, 4);
    assert_eq!(d.item.importance, Some(0.9));
    assert_eq!(d.item.veracity.as_deref(), Some("stated"));
    assert_eq!(d.item.memory_type.as_deref(), Some("lesson"));
    assert!(d.item.consolidated && d.item.superseded);
    assert_eq!(d.item.source_session_exists, Some(true));
    assert_eq!(
        d.item.last_recalled_at.as_deref(),
        Some("2026-10-12T00:00:00.000Z")
    );
    let m = d.metadata.unwrap();
    assert_eq!(m["cwd"], "/p");
    assert!(m.get("api_key").is_none()); // 密钥键防御性删除
    assert_eq!(d.facts.len(), 2);
    assert_eq!(d.facts[0].subject.as_deref(), Some("sub-f1"));
    assert_eq!(d.facts[0].key, None);
    assert_eq!(d.facts[1].subject, None);
    assert_eq!(d.facts[1].predicate.as_deref(), Some("pref"));
    assert_eq!(d.facts[1].object.as_deref(), Some("rust"));
    assert_eq!(d.facts[1].key.as_deref(), Some("topic"));
    assert!(d.summary_of.is_empty());
    assert_eq!(d.related_edges, 2);

    let d2 = f.detail("b-1", "w2");
    assert_eq!(d2.embed_text, None); // 与正文全等 ⇒ null
    assert_eq!(d2.facts.len(), 50); // facts 上限
    let e = f.detail("b-1", "e1");
    assert_eq!(e.item.kind, MemoryKind::Episodic);
    assert!(e.item.consolidated);
    assert_eq!(e.summary_of, ["w1", "w2", "w3"]);
    let d3 = f.detail("b-1", "w3");
    assert!(d3.truncated);
    assert!(d3.content.len() <= CONTENT_CAP_BYTES);
    assert!(d3.content.len() > CONTENT_CAP_BYTES - 4);
    assert_eq!(d3.item.content_chars, 70_000);
    assert_eq!(d3.item.snippet.chars().count(), 241);
}

/// 只读路径：看得见未 checkpoint 的 WAL 数据；调用前后无新文件、文件名/大小不变。
#[test]
fn read_path_is_read_only_and_sees_wal() {
    let f = Fx::new();
    let b = f.bank("b-wal");
    let before = dir_snapshot(&f.root);
    // 写连接保持打开：数据留在 WAL，读方必须可见。
    let writer = Connection::open(b.db()).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    writer
        .execute(
            "INSERT INTO working_memory (id, content) VALUES ('w1', 'wal-only')",
            [],
        )
        .unwrap();
    f.overview();
    assert_eq!(f.list(&params("b-wal")).total, 1);
    assert_eq!(f.detail("b-wal", "w1").content, "wal-only");
    assert_eq!(f.list(&params("b-wal")).total, 1); // 关连接（自动 checkpoint）后仍可见
    drop(writer);
    // `-wal` / `-shm` 由写连接产生；只读调用自身不得新增文件或改 db 大小。
    let after = dir_snapshot(&f.root);
    let db = b.db();
    let db_bytes = |snap: &[(PathBuf, u64)]| snap.iter().find(|(p, _)| *p == db).map(|(_, n)| *n);
    assert_eq!(db_bytes(&before), db_bytes(&after));
    assert!(after.len() >= before.len());
}

/// 真实库只读回归（`cargo test --test memory -- --ignored --nocapture`）：只打印计数与耗时。
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
    let (totals, backend) = (&over.totals, &over.backend);
    println!(
        "overview: banks={} w={} e={} facts={} bytes={} never={} unconsol={} src={} missing={} backend={backend:?} {:?}",
        totals.banks,
        totals.working,
        totals.episodic,
        totals.facts,
        totals.bytes,
        totals.never_recalled,
        totals.unconsolidated,
        totals.source_sessions,
        totals.missing_source_sessions,
        t.elapsed()
    );
    if let Some(bank) = over
        .banks
        .iter()
        .find(|b| b.readable && b.working + b.episodic > 0)
    {
        let t = Instant::now();
        let page = list_impl(&root, &sessions, &params(&bank.bank)).unwrap();
        println!(
            "list({}): total={} {:?}",
            bank.bank,
            page.total,
            t.elapsed()
        );
        if let Some(item) = page.items.first() {
            let t = Instant::now();
            let d = detail_impl(&root, &sessions, &bank.bank, &item.id).unwrap();
            println!(
                "detail: chars={} trunc={} facts={} edges={} {:?}",
                d.item.content_chars,
                d.truncated,
                d.facts.len(),
                d.related_edges,
                t.elapsed()
            );
        }
    }
    assert_eq!(
        before,
        dir_snapshot(&root),
        "只读调用不得新增文件或改变文件大小"
    );
}
