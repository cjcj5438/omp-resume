//! 记忆库写操作（CONTRACT §18.8）：合成 bank + 临时备份区，不碰真实 `~/.omp`。

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{owned, Bank};
use omp_resume_lib::memory::delete::{
    backups_impl, delete_backup_impl, delete_bank_impl_with, delete_items_impl_with, preview_impl,
    restore_impl_with, status_impl_with, Gate, DELETE_IDS_MAX,
};
use omp_resume_lib::model::{ErrorCode, MemoryBackup, MemoryBackupKind, MemorySkipReason};
use rusqlite::{params, Connection};

struct Env {
    _tmp: tempfile::TempDir,
    banks: PathBuf,
    data: PathBuf,
}

impl Env {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let (banks, data) = (tmp.path().join("banks"), tmp.path().join("data"));
        for d in [&banks, &data] {
            std::fs::create_dir_all(d).unwrap();
        }
        Env {
            _tmp: tmp,
            banks,
            data,
        }
    }

    fn bank(&self, name: &str) -> Bank {
        Bank::new(&self.banks, name)
    }

    fn preview(&self, bank: &str, ids: &[&str]) -> omp_resume_lib::model::MemoryDeletePreview {
        preview_impl(&self.banks, bank, &owned(ids)).unwrap()
    }

    fn preview_err(&self, bank: &str, ids: &[&str]) -> ErrorCode {
        preview_impl(&self.banks, bank, &owned(ids))
            .unwrap_err()
            .code
    }

    fn delete(&self, bank: &str, ids: &[&str]) -> omp_resume_lib::model::MemoryDeleteResult {
        delete_items_impl_with(&self.banks, &self.data, bank, &owned(ids), &prod_gate()).unwrap()
    }

    fn delete_err(&self, bank: &str, ids: &[&str]) -> ErrorCode {
        delete_items_impl_with(&self.banks, &self.data, bank, &owned(ids), &prod_gate())
            .unwrap_err()
            .code
    }

    fn delete_bank(&self, bank: &str) -> MemoryBackup {
        delete_bank_impl_with(&self.banks, &self.data, bank, &prod_gate()).unwrap()
    }

    fn delete_bank_err(&self, bank: &str) -> ErrorCode {
        delete_bank_impl_with(&self.banks, &self.data, bank, &prod_gate())
            .unwrap_err()
            .code
    }

    fn restore(&self, id: &str) -> omp_resume_lib::model::MemoryRestoreResult {
        restore_impl_with(&self.banks, &self.data, id, &prod_gate()).unwrap()
    }

    fn restore_err(&self, id: &str) -> ErrorCode {
        restore_impl_with(&self.banks, &self.data, id, &prod_gate())
            .unwrap_err()
            .code
    }

    fn status(&self, bank: &str) -> omp_resume_lib::model::MemoryBankStatus {
        status_impl_with(&self.banks, &self.data, bank, &prod_gate()).unwrap()
    }

    fn backups(&self, bank: Option<&str>) -> Vec<MemoryBackup> {
        backups_impl(&self.data, bank)
    }
}

fn prod_gate() -> Gate {
    Gate {
        lsof: PathBuf::from("/usr/sbin/lsof"),
        timeout: Duration::from_secs(5),
    }
}

/// 恒报空闲的假门禁（WAL 测试用：绕开“测试进程自身持有”）。
fn idle_gate() -> Gate {
    let dir = std::env::temp_dir().join("omp-resume-idle-lsof");
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("lsof-idle");
    if !bin.exists() {
        std::fs::write(&bin, "#!/bin/sh\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    Gate {
        lsof: bin,
        timeout: Duration::from_secs(5),
    }
}

/// preview 数字 == 实际删除数字；两种 kind 共用 purge；审计轨迹不动；
/// 级联后 integrity/FTS/孤儿 全清。
#[test]
fn preview_equals_delete_and_purges_both_kinds() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    b.w("b-1", "w2");
    b.e("b-1", "e1", "w1");
    b.attach("w1");
    b.attach("e1");
    b.exec("INSERT INTO memory_validations (memory_id, validator, action) VALUES ('w1', 'v', 'confirm')");

    let p = env.preview("b-1", &["w1", "e1", "missing", "w1"]);
    assert_eq!(p.requested, 3); // 去重后
    assert_eq!((p.deletable.working, p.deletable.episodic), (1, 1));
    assert_eq!((p.not_found, p.unsupported), (1, 0));
    assert_eq!(p.cited_by_summaries, 1);
    let c = &p.cascade;
    assert_eq!(
        [c.facts, c.embeddings, c.annotations, c.edges, c.other],
        [2, 2, 2, 6, 4]
    );

    let before = [
        "facts",
        "memory_embeddings",
        "annotations",
        "graph_edges",
        "gists",
    ];
    let before: Vec<i64> = before.iter().map(|t| b.count(t)).collect();
    let memoria_before = b.count("memoria_facts");
    let r = env.delete("b-1", &["w1", "e1", "missing", "w1"]);
    assert_eq!(r.deleted, ["w1", "e1"]);
    assert_eq!(r.skipped.len(), 1);
    assert_eq!(r.skipped[0].reason, MemorySkipReason::NotFound);
    assert_eq!(r.backup.kind, MemoryBackupKind::BeforeDelete);
    // preview 数字 == 实际删除数字。
    let after: Vec<i64> = [
        "facts",
        "memory_embeddings",
        "annotations",
        "graph_edges",
        "gists",
    ]
    .iter()
    .map(|t| b.count(t))
    .collect();
    let delta: Vec<i64> = before.into_iter().zip(after).map(|(x, y)| x - y).collect();
    assert_eq!(delta[0], c.facts as i64);
    assert_eq!(delta[1], c.embeddings as i64);
    assert_eq!(delta[2], c.annotations as i64);
    assert_eq!(delta[3], c.edges as i64);
    let memoria_delta = memoria_before - b.count("memoria_facts");
    assert_eq!(delta[4] + memoria_delta, c.other as i64);
    // w2 不受影响；FTS 触发器已清 w1/e1；审计表不动。
    assert_eq!(b.count("working_memory"), 1);
    assert_eq!(b.count("memory_validations"), 1);
    assert!(b.fts_clean("fts_working") && b.fts_clean("fts_episodes"));
    assert!(b.integrity_ok() && b.no_orphans(&["w1", "e1"]));

    // episodic 单独删：facts/memoria/gists 可引用 episodic id，同样级联。
    b.e("b-1", "e9", "");
    b.attach("e9");
    let p = env.preview("b-1", &["e9"]);
    assert_eq!(p.deletable.episodic, 1);
    assert_eq!((p.cascade.facts, p.cascade.other), (1, 2));
    assert_eq!(env.delete("b-1", &["e9"]).deleted, ["e9"]);
    assert_eq!(b.count("episodic_memory"), 0);
    assert_eq!(b.count("facts"), 0);
    assert_eq!(b.count("memoria_facts"), 0);
    assert_eq!(b.count("gists"), 0);
    assert!(b.integrity_ok() && b.no_orphans(&["e9"]));
}

/// id 分类：session 不符 / vec bank episodic ⇒ unsupported；not_found 不 abort 其余；保请求序。
#[test]
fn id_classification_and_order() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.exec("INSERT INTO working_memory (id, content, session_id) VALUES ('wX', 'x', 'other-bank')");
    let p = env.preview("b-1", &["wX"]);
    assert_eq!((p.unsupported, p.deletable.working), (1, 0));
    // 全部 unsupported ⇒ INVALID_INPUT，行与备份区均不动。
    assert_eq!(env.delete_err("b-1", &["wX"]), ErrorCode::InvalidInput);
    assert!(env.backups(Some("b-1")).is_empty());
    assert_eq!(b.count("working_memory"), 1);
    // 混合：可删 + unsupported ⇒ 成功，unsupported 进 skipped。
    b.w("b-1", "w-ok");
    let r = env.delete("b-1", &["w-ok", "wX"]);
    assert_eq!(r.deleted, ["w-ok"]);
    assert_eq!(r.skipped[0].id, "wX");
    assert_eq!(r.skipped[0].reason, MemorySkipReason::Unsupported);

    // vec bank（`sqlite_master` 有 `vec_episodes` 即触发守卫）：episodic 不可删，working 照常。
    let v = env.bank("b-vec");
    v.exec("CREATE TABLE vec_episodes (rowid INTEGER)");
    v.w("b-vec", "w1");
    v.e("b-vec", "e1", "");
    let p = env.preview("b-vec", &["w1", "e1"]);
    assert_eq!(
        (p.deletable.working, p.deletable.episodic, p.unsupported),
        (1, 0, 1)
    );
    let r = env.delete("b-vec", &["w1", "e1"]);
    assert_eq!(r.deleted, ["w1"]);
    assert_eq!(r.skipped[0].reason, MemorySkipReason::Unsupported);
    assert_eq!(v.count("episodic_memory"), 1);

    // not_found 不 abort 其余；deleted/skipped 保请求序。
    let o = env.bank("b-2");
    o.w("b-2", "w1");
    o.w("b-2", "w2");
    let r = env.delete("b-2", &["no-a", "w2", "no-b", "w1"]);
    assert_eq!(r.deleted, ["w2", "w1"]);
    let skipped: Vec<&str> = r.skipped.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(skipped, ["no-a", "no-b"]);
    assert_eq!(o.count("working_memory"), 0);
}

/// 非法输入（空/超限/去重/全不可删）⇒ INVALID_INPUT，不建备份、不修剪、不写库；
/// 最小 schema（无 FTS 与附属表）也能删。
#[test]
fn invalid_inputs_and_minimal_schema() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    assert_eq!(env.preview_err("b-1", &[]), ErrorCode::InvalidInput);
    assert_eq!(env.delete_err("b-1", &[]), ErrorCode::InvalidInput);
    // 超限（501 个互不相同）。
    let many: Vec<String> = (0..=DELETE_IDS_MAX).map(|i| format!("id-{i}")).collect();
    let err = delete_items_impl_with(&env.banks, &env.data, "b-1", &many, &prod_gate());
    assert_eq!(err.unwrap_err().code, ErrorCode::InvalidInput);
    // 去重：同一 id 传 3 次 ⇒ requested=1，删一次。
    assert_eq!(env.preview("b-1", &["w1", "w1", "w1"]).requested, 1);
    assert_eq!(env.delete("b-1", &["w1", "w1", "w1"]).deleted, ["w1"]);
    // 全不可删 ⇒ 不建备份、不修剪、内容不变。
    b.exec("INSERT INTO working_memory (id, content, session_id) VALUES ('wX', 'x', 'other')");
    let keep = env.backups(Some("b-1"));
    assert_eq!(keep.len(), 1);
    let snap = b.snapshot();
    let digest = b.sha256();
    for ids in [
        &["nope"][..],
        &["nope", "nope2"][..],
        &["w1"][..],
        &["wX"][..],
    ] {
        assert_eq!(
            env.delete_err("b-1", ids),
            ErrorCode::InvalidInput,
            "{ids:?}"
        );
    }
    // 备份列表/过滤/删除/ID 校验（此时 b-1 已有 1 份 before-delete）。
    assert_eq!(env.backups(None).len(), 1);
    assert_eq!(env.backups(Some("b-1")), keep);
    assert!(env.backups(Some("other")).is_empty());
    assert!(keep[0].created_at.ends_with('Z'));
    let last = keep[0].id.clone();
    delete_backup_impl(&env.data, &last).unwrap();
    assert!(env.backups(None).is_empty());
    assert_eq!(
        delete_backup_impl(&env.data, &last).unwrap_err().code,
        ErrorCode::NotFound
    );
    for bad in ["nope", "b-1@evil", "../x@20261020T120000Z-before-delete"] {
        assert_eq!(
            delete_backup_impl(&env.data, bad).unwrap_err().code,
            ErrorCode::OutsideRoot
        );
        assert_eq!(env.restore_err(bad), ErrorCode::OutsideRoot);
    }
    assert_eq!(b.snapshot(), snap);
    assert_eq!(b.sha256(), digest);

    // 最小 schema：只有 working_memory，删除照常。
    let thin_dir = env.banks.join("thin-1");
    std::fs::create_dir_all(&thin_dir).unwrap();
    Connection::open(thin_dir.join("mnemopi.db"))
        .unwrap()
        .execute_batch(
            "CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, session_id TEXT);
             INSERT INTO working_memory VALUES ('w1', 'x', 'thin-1');",
        )
        .unwrap();
    let p = env.preview("thin-1", &["w1"]);
    assert_eq!((p.deletable.working, p.cascade.facts), (1, 0));
    assert_eq!(env.delete("thin-1", &["w1"]).deleted, ["w1"]);
    let thin = Bank { dir: thin_dir };
    assert_eq!(thin.count("working_memory"), 0);
    assert!(thin.integrity_ok());
}

/// 事务内 recount 与计划不一致（触发器静默吞掉删除）⇒ 整个事务回滚。
#[test]
fn recount_mismatch_rolls_back() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    b.w("b-1", "w2");
    b.attach("w1");
    b.exec(
        "CREATE TRIGGER wm_block BEFORE DELETE ON working_memory BEGIN SELECT RAISE(IGNORE); END",
    );
    let before = b.snapshot();
    assert_eq!(env.delete_err("b-1", &["w1"]), ErrorCode::Io);
    assert_eq!(b.snapshot(), before);
    assert!(b.integrity_ok() && b.fts_clean("fts_working") && b.fts_clean("fts_episodes"));
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
    for _ in 0..50 {
        if env.status(bank).in_use {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("lsof 未能看到 tail 持有者");
}

/// 真 lsof 门禁：按住 db 或 `-wal` ⇒ 删行/删 bank 全拒（message 含 pid + 命令名），
/// status 报占用；preview 不设门禁；松开后恢复。
#[test]
fn gate_refuses_writes_when_held() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    b.exec("PRAGMA journal_mode=WAL"); // 确保 -wal 文件存在
    let wal = b.db().with_extension("db-wal");

    let mut tail = hold_with_tail(&b.db());
    wait_held(&env, "b-1");
    let status = env.status("b-1");
    assert!(status.in_use && !status.probe_failed && status.holders.len() == 1);
    assert_eq!(status.holders[0].pid, tail.id());
    assert_eq!(status.holders[0].command, "tail");
    let err = delete_items_impl_with(&env.banks, &env.data, "b-1", &owned(&["w1"]), &prod_gate());
    let err = err.unwrap_err();
    assert_eq!(err.code, ErrorCode::InUse);
    assert!(err.message.contains(&tail.id().to_string()) && err.message.contains("tail"));
    assert_eq!(env.delete_bank_err("b-1"), ErrorCode::InUse);
    // preview 纯只读 ⇒ 不设门禁。
    assert_eq!(env.preview("b-1", &["w1"]).deletable.working, 1);
    let _ = tail.kill();
    let _ = tail.wait();

    let mut tail = hold_with_tail(&wal);
    wait_held(&env, "b-1");
    assert_eq!(env.delete_err("b-1", &["w1"]), ErrorCode::InUse);
    let _ = tail.kill();
    let _ = tail.wait();
    assert!(!env.status("b-1").in_use);
    assert_eq!(b.count("working_memory"), 1);
}

/// 探针失败 / 备份失败 ⇒ 拒绝写操作，原库分毫不动；status 的探针失败 ⇒ probeFailed。
#[test]
fn probe_and_backup_failures_refuse() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    let bad_gate = Gate {
        lsof: PathBuf::from("/nonexistent/lsof-probe"),
        timeout: Duration::from_secs(2),
    };
    let ids = owned(&["w1"]);
    let err = delete_items_impl_with(&env.banks, &env.data, "b-1", &ids, &bad_gate).unwrap_err();
    assert_eq!(err.code, ErrorCode::ProbeFailed);
    let err = delete_bank_impl_with(&env.banks, &env.data, "b-1", &bad_gate).unwrap_err();
    assert_eq!(err.code, ErrorCode::ProbeFailed);
    let status = status_impl_with(&env.banks, &env.data, "b-1", &bad_gate).unwrap();
    assert!(status.probe_failed && !status.in_use && status.holders.is_empty());
    assert_eq!(b.count("working_memory"), 1);

    // data_dir 是文件 ⇒ 备份根建不出 ⇒ 备份失败，原库字节不变。
    let file_as_data = env.data.join("not-a-dir");
    std::fs::write(&file_as_data, b"x").unwrap();
    let digest = b.sha256();
    let err = delete_items_impl_with(&env.banks, &file_as_data, "b-1", &ids, &prod_gate());
    assert_eq!(err.unwrap_err().code, ErrorCode::Io);
    assert_eq!(b.sha256(), digest);
    let err = delete_bank_impl_with(&env.banks, &file_as_data, "b-1", &prod_gate());
    assert_eq!(err.unwrap_err().code, ErrorCode::Io);
    assert!(b.dir.is_dir());
}

/// 留存：before-delete 只留最新 5（newest first）；bank-removed 永不剪；
/// 无 manifest 残留不列出、不占名额、不被剪，恢复它 ⇒ 明确失败。
#[test]
fn retention_and_leftover() {
    let env = Env::new();
    let b = env.bank("b-1");
    for i in 0..12 {
        b.w("b-1", &format!("w{i:02}"));
    }
    env.bank("b-2");
    let leftover = env
        .data
        .join("memory-backups/b-1/20991231T235959Z-before-delete");
    std::fs::create_dir_all(&leftover).unwrap();
    std::fs::write(leftover.join("mnemopi.db"), b"partial").unwrap();
    assert!(env.backups(Some("b-1")).is_empty());
    for i in 0..7 {
        env.delete("b-1", &[&format!("w{i:02}")]);
    }
    let items = env.backups(Some("b-1"));
    assert_eq!(items.len(), 5);
    assert!(items
        .iter()
        .all(|b| b.kind == MemoryBackupKind::BeforeDelete && b.working.is_some()));
    for pair in items.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        assert!((a.created_at.clone(), a.id.clone()) >= (b.created_at.clone(), b.id.clone()));
    }
    assert!(leftover.is_dir() && !items.iter().any(|b| b.id.contains("20991231")));
    // 恢复残留 ⇒ 明确失败且原库不变。
    let guard = b.snapshot();
    assert_eq!(
        env.restore_err("b-1@20991231T235959Z-before-delete"),
        ErrorCode::Io
    );
    assert_eq!(b.snapshot(), guard);
    // bank-removed 永不剪。
    env.delete_bank("b-2");
    for i in 7..12 {
        env.delete("b-1", &[&format!("w{i:02}")]);
    }
    let all = env.backups(None);
    assert!(all.iter().any(|b| b.kind == MemoryBackupKind::BankRemoved));
    assert_eq!(all.iter().filter(|b| b.bank == "b-1").count(), 5);
}

/// bank-removed 往返（内容全等、无 safety、备份仍在）与快照往返（含 safety）。
#[test]
fn restore_roundtrips() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    b.e("b-1", "e1", "w1");
    b.attach("w1");
    let before = b.snapshot();
    let removed = env.delete_bank("b-1");
    assert_eq!(removed.kind, MemoryBackupKind::BankRemoved);
    assert_eq!((removed.working, removed.episodic), (Some(1), Some(1)));
    assert!(!b.dir.exists());
    let entries: Vec<_> = std::fs::read_dir(env.data.join("memory-backups/b-1"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(entries.len(), 1);
    let ts_dir = entries[0].path();
    assert!(ts_dir.join("bank/mnemopi.db").is_file() && ts_dir.join("manifest.json").is_file());
    let restored = env.restore(&removed.id);
    assert_eq!(restored.bank, "b-1");
    assert!(restored.safety_backup.is_none()); // 目标原先不存在
    let back = Bank { dir: b.dir.clone() };
    assert_eq!(back.snapshot(), before);
    assert!(back.integrity_ok());
    assert!(ts_dir.join("bank/mnemopi.db").is_file()); // 恢复是复制非搬回

    // 快照往返：删 w1（备份 A = 完整态）→ 恢复 A ⇒ 完整态 + safety → 恢复 safety ⇒ 删除后态。
    let c = env.bank("b-2");
    c.w("b-2", "w1");
    c.w("b-2", "w2");
    let full = c.snapshot();
    let deleted = env.delete("b-2", &["w1"]);
    let partial = c.snapshot();
    assert_ne!(full, partial);
    let r1 = env.restore(&deleted.backup.id);
    assert_eq!(r1.restored_from.id, deleted.backup.id);
    let safety = r1.safety_backup.unwrap();
    assert_eq!(safety.kind, MemoryBackupKind::BeforeRestore);
    assert_eq!(c.snapshot(), full);
    let r2 = env.restore(&safety.id);
    assert!(r2.safety_backup.is_some());
    assert_eq!(c.snapshot(), partial);
}

/// 恢复失败（损坏备份 / 快照文件缺失）⇒ 回滚、原库不变、不修剪、不留冗余 safety。
#[test]
fn restore_failure_rolls_back() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    // 5 个 before-delete + 1 次成功恢复：失败恢复若误剪/误留会暴露。
    let mut first = None;
    for i in 0..5 {
        b.w("b-1", &format!("pad{i}"));
        first.get_or_insert(env.delete("b-1", &[&format!("pad{i}")]).backup.id);
    }
    assert!(env.restore(&first.unwrap()).safety_backup.is_some());
    let before = b.snapshot();
    let listing = env.backups(Some("b-1"));

    // 伪造备份：合法形状 + manifest（`db` 为 None ⇒ 快照文件缺失）。
    let forge = |stamp: &str, working: u64, db: Option<&[u8]>| {
        let dir = env
            .data
            .join(format!("memory-backups/b-1/{stamp}-before-delete"));
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(bytes) = db {
            std::fs::write(dir.join("mnemopi.db"), bytes).unwrap();
        }
        let manifest = format!(
            r#"{{"bank":"b-1","kind":"before-delete","createdAt":"2026-10-20T12:00:00.000Z","cwd":null,"working":{working},"episodic":0,"sourceBankDirName":"b-1"}}"#
        );
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
        format!("b-1@{stamp}-before-delete")
    };
    let corrupt = forge("20261020T120000Z", 99, Some(b"garbage-not-sqlite"));
    let bad_listing = env.backups(Some("b-1"));
    assert_eq!(env.restore_err(&corrupt), ErrorCode::Io);
    assert_eq!(b.snapshot(), before);
    assert!(b.integrity_ok());
    assert_eq!(env.backups(Some("b-1")), bad_listing); // 失败不修剪
    assert_eq!(bad_listing.len(), listing.len() + 1);

    let missing = forge("20261020T120001Z", 1, None);
    assert_eq!(env.restore_err(&missing), ErrorCode::Io);
    assert_eq!(b.snapshot(), before);
    // 两次失败都未留冗余 before-restore（目录数 == 列表数）。
    let restores = |list: &[MemoryBackup]| {
        list.iter()
            .filter(|b| b.kind == MemoryBackupKind::BeforeRestore)
            .count()
    };
    let after = env.backups(Some("b-1"));
    assert_eq!(restores(&after), restores(&listing));
    let dirs = std::fs::read_dir(env.data.join("memory-backups/b-1"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with("before-restore"))
        .count();
    assert_eq!(dirs, restores(&listing));
}

/// bank-removed 恢复到已存在的库、整目录拷回中途失败：回滚前整目录重建，
/// 不留杂散文件；安全快照经校验后被删除（已冗余）。
#[test]
#[cfg(unix)]
fn restore_bank_removed_partial_copy_rolls_back_clean() {
    let env = Env::new();
    let b = env.bank("b-1");
    b.w("b-1", "w1");
    let removed = env.delete_bank("b-1");
    let backup_bank = env
        .data
        .join("memory-backups/b-1")
        .join(removed.id.rsplit_once('@').unwrap().1)
        .join("bank");
    // 目标库重建（“已存在”路径 ⇒ 会拍 before-restore 安全快照）。
    let c = env.bank("b-1");
    c.w("b-1", "w2");
    let before = c.snapshot();
    // 弄坏备份：多一个普通文件 + 一个符号链接 ⇒ 复制中途失败。
    std::fs::write(backup_bank.join("extra.txt"), b"stray").unwrap();
    std::os::unix::fs::symlink("/etc/hosts", backup_bank.join("evil")).unwrap();
    assert_eq!(env.restore_err(&removed.id), ErrorCode::Io);
    // 回滚后目录只含安全快照的 db（没有 extra.txt / evil）。
    let mut names: Vec<String> = std::fs::read_dir(&c.dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["mnemopi.db"]);
    assert_eq!(c.snapshot(), before);
    assert!(c.integrity_ok());
    // 回滚已验证 ⇒ 冗余安全快照被删；失败路径不修剪其它备份。
    let listing = env.backups(Some("b-1"));
    assert!(!listing
        .iter()
        .any(|b| b.kind == MemoryBackupKind::BeforeRestore));
    assert!(listing.iter().any(|b| b.id == removed.id));
}

/// bank 名穿越与根外 symlink ⇒ OUTSIDE_ROOT（preview/status/删行/删库一致）。
#[test]
fn traversal_and_symlink_rejected() {
    let env = Env::new();
    for bad in ["..", "../x", "a/b", "a\\b", ""] {
        assert_eq!(
            env.preview_err(bad, &["w1"]),
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
        assert_eq!(
            env.delete_err(bad, &["w1"]),
            ErrorCode::OutsideRoot,
            "{bad:?}"
        );
        assert_eq!(env.delete_bank_err(bad), ErrorCode::OutsideRoot, "{bad:?}");
        let status = status_impl_with(&env.banks, &env.data, bad, &prod_gate());
        assert_eq!(status.unwrap_err().code, ErrorCode::OutsideRoot, "{bad:?}");
    }
    #[cfg(unix)]
    {
        let outside = env._tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, env.banks.join("evil")).unwrap();
        assert_eq!(env.delete_err("evil", &["w1"]), ErrorCode::OutsideRoot);
    }
}

/// WAL 里未 checkpoint 的数据必须进备份；恢复后回到删除前。
#[test]
fn wal_only_data_backed_up_and_restored() {
    let env = Env::new();
    let b = env.bank("b-wal");
    let writer = Connection::open(b.db()).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    for id in ["w1", "w2"] {
        writer
            .execute(
                "INSERT INTO working_memory (id, content, session_id) VALUES (?1, 'wal-row', 'b-wal')",
                params![id],
            )
            .unwrap();
    }
    assert!(b.db().with_extension("db-wal").exists());
    // 真门禁下：测试进程自身持有 ⇒ IN_USE（lsof 能看到自己）。
    assert!(env.status("b-wal").in_use);
    // 假空闲门禁下删除 ⇒ 备份必须含 WAL 行。
    let ids = owned(&["w1"]);
    let r = delete_items_impl_with(&env.banks, &env.data, "b-wal", &ids, &idle_gate()).unwrap();
    assert_eq!(r.deleted, ["w1"]);
    let entry: Vec<_> = std::fs::read_dir(env.data.join("memory-backups/b-wal"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(entry.len(), 1);
    let snap = Bank {
        dir: entry[0].path(),
    };
    assert_eq!(snap.count("working_memory"), 2);
    drop(writer);
    // 恢复 ⇒ w1 回来。
    env.restore(&r.backup.id);
    assert_eq!(b.count("working_memory"), 2);
}

/// 真实库副本端到端（`cargo test --test memory_write -- --ignored e2e_on_real_copy --nocapture`）：
/// 源库只读 `VACUUM INTO` 到临时目录，源目录名称/大小/mtime 不变；只打印计数与耗时。
#[test]
#[ignore]
fn e2e_on_real_copy() {
    use rusqlite::OpenFlags;
    use std::time::Instant;
    const W3: &str = "SELECT id FROM working_memory WHERE session_id = ?1 LIMIT 3";
    const E1: &str = "SELECT id FROM episodic_memory WHERE session_id = ?1 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'vec_episodes') LIMIT 1";
    let home = std::env::var("HOME").unwrap();
    let real_root = PathBuf::from(format!("{home}/.omp/agent/memories/mnemopi/banks"));
    let rd = std::fs::read_dir(&real_root);
    let mut names: Vec<String> = Vec::new();
    for e in rd.into_iter().flatten().flatten() {
        names.push(e.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    let ro = |db: &Path| Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok();
    let env = Env::new();
    let (mut bank, mut ids) = (String::new(), Vec::new());
    for name in names {
        let s = status_impl_with(&real_root, &env.data, &name, &prod_gate());
        let Ok(s) = s else { continue };
        if s.in_use || s.probe_failed {
            continue;
        }
        let c = ro(&real_root.join(&name).join("mnemopi.db"));
        let Some(c) = c else { continue };
        let mut st = c.prepare(W3).unwrap();
        let rows = st.query_map(params![name], |r| r.get(0)).unwrap();
        let w: Vec<String> = rows.flatten().collect();
        if w.len() >= 3 {
            (bank, ids) = (name, w);
            let e = c.query_row(E1, params![bank], |r| r.get::<_, String>(0));
            ids.extend(e.ok()); // 有 vec_episodes 表时 E1 恒为空
            break;
        }
    }
    if bank.is_empty() {
        return println!("SKIP: no real bank");
    }
    let src_dir = real_root.join(&bank);
    let snap = || {
        let mut v = Vec::new();
        for e in std::fs::read_dir(&src_dir).unwrap().flatten() {
            let m = e.metadata().unwrap();
            let f = e.file_name().to_string_lossy().into_owned();
            let t = (!f.ends_with("-shm")).then(|| m.modified().unwrap());
            v.push((f, m.len(), t));
        }
        v.sort();
        v
    };
    let before = snap();
    let dir = env.banks.join(&bank);
    std::fs::create_dir_all(&dir).unwrap();
    let b = Bank { dir };
    let t = Instant::now();
    let target = b.db().to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{target}'");
    let src = ro(&src_dir.join("mnemopi.db")).unwrap();
    src.execute(&sql, []).unwrap();
    println!("copy bank={bank} {:?}", t.elapsed());
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let p = env.preview(&bank, &refs);
    assert_eq!((p.deletable.working, p.unsupported, p.not_found), (3, 0, 0));
    assert_eq!(p.deletable.episodic as usize, ids.len() - 3);
    println!("preview {p:?}");
    let orig = b.snapshot();
    let t = Instant::now();
    let r = env.delete(&bank, &refs);
    assert_eq!(r.deleted, ids);
    println!("deleted={} {:?}", r.deleted.len(), t.elapsed());
    assert!(b.integrity_ok() && b.no_orphans(&refs));
    assert!(b.fts_clean("fts_working") && b.fts_clean("fts_episodes"));
    let t = Instant::now();
    assert!(env.restore(&r.backup.id).safety_backup.is_some());
    assert_eq!(b.snapshot(), orig);
    println!("snapshot restore ok {:?}", t.elapsed());
    let rb = env.delete_bank(&bank);
    assert!(!b.dir.join("mnemopi.db").exists());
    env.restore(&rb.id);
    assert_eq!(b.snapshot(), orig);
    assert_eq!(before, snap(), "source dir changed");
    println!("source untouched (names+sizes+mtimes, -shm mtime exempt)");
}
