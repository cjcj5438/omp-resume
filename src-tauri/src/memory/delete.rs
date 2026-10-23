//! 记忆库写操作：preview / 删行 / 删 bank / 恢复 / 备份管理（CONTRACT §18.8）。
//!
//! 单行删除镜像上游 `forget`；episodic 与 working 共用同一 purge（仅 base 表不同）。
//! 破坏性步骤前必过占用门禁（删行：门禁 → 备份 → 复检门禁 → 事务）。
//! preview 与删除共用同一级联规划，保证数字一致。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior};

use super::backup::{
    backup_root, create_snapshot_backup, delete_backup_dir, describe_ref, ensure_dir_0700,
    list_backups, pick_dirname, prune_backups, resolve_backup_id, snapshot_stats, write_manifest,
    BACKUP_DB_FILENAME, MANIFEST_FILENAME, REMOVED_SUBDIR,
};
use super::gate::{bank_files, holders_for_files_with, in_use_message, ProbeFailed};
use super::{
    invalid, io, open_readonly, outside, table_schema, validate_bank, TableSchema, DB_FILENAME,
};
use crate::model::{
    AppError, ErrorCode, MemoryBackup, MemoryBackupKind, MemoryBankStatus, MemoryDeleteCascade,
    MemoryDeleteDeletable, MemoryDeletePreview, MemoryDeleteResult, MemoryRestoreResult,
    MemorySkipReason, MemorySkipped,
};
use crate::util::escape_like;

/// 单次删除 id 上限（去重后计数）。
pub const DELETE_IDS_MAX: usize = 500;

/// 占用门禁（可注入 lsof，供测试）。
#[derive(Debug, Clone)]
pub struct Gate {
    pub lsof: PathBuf,
    pub timeout: Duration,
}

impl Gate {
    pub fn production() -> Self {
        Self {
            lsof: PathBuf::from(crate::occupant::LSOF),
            timeout: crate::occupant::LSOF_TIMEOUT,
        }
    }

    fn check(&self, bank_dir: &Path) -> Result<(), AppError> {
        match holders_for_files_with(&bank_files(bank_dir), &self.lsof, self.timeout) {
            Ok(holders) if holders.is_empty() => Ok(()),
            Ok(holders) => Err(AppError::new(ErrorCode::InUse, in_use_message(&holders))),
            Err(ProbeFailed) => Err(AppError::new(
                ErrorCode::ProbeFailed,
                "占用探测失败，不敢执行写操作",
            )),
        }
    }
}

/// id 归一：去重（保首见序）+ 空/超限校验。
fn normalize_ids(ids: &[String]) -> Result<Vec<String>, AppError> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
    }
    if out.is_empty() {
        return Err(invalid("请选择要删除的记忆"));
    }
    if out.len() > DELETE_IDS_MAX {
        return Err(invalid(format!("单次最多删除 {DELETE_IDS_MAX} 条")));
    }
    Ok(out)
}

/// id 解析结果。
struct ResolvedIds {
    working: Vec<String>,
    episodic: Vec<String>,
    unsupported: Vec<String>,
    not_found: Vec<String>,
}

/// 解析选中 id：working 先、episodic 后（`id + session_id = bank` 才可删）；
/// vec bank 的 episodic ⇒ unsupported。
fn resolve_ids(conn: &Connection, bank: &str, ids: &[String]) -> ResolvedIds {
    let wm = table_schema(conn, "working_memory");
    let em = table_schema(conn, "episodic_memory");
    let has_vec: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = 'vec_episodes' LIMIT 1",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    // 查某表某 id 的 session：表/id 列缺失 ⇒ None；session 列缺失 ⇒ 视为域外。
    let session_of = |schema: &TableSchema, table: &str, id: &str| -> Option<Option<String>> {
        if !schema.has("id") {
            return None;
        }
        if !schema.has("session_id") {
            let exists: bool = conn
                .query_row(
                    &format!("SELECT 1 FROM \"{table}\" WHERE id = ?1"),
                    [id],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            return exists.then_some(None);
        }
        conn.query_row(
            &format!("SELECT session_id FROM \"{table}\" WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .ok()
    };
    let mut out = ResolvedIds {
        working: Vec::new(),
        episodic: Vec::new(),
        unsupported: Vec::new(),
        not_found: Vec::new(),
    };
    for id in ids {
        if let Some(session) = session_of(&wm, "working_memory", id) {
            if session.as_deref() == Some(bank) {
                out.working.push(id.clone());
            } else {
                out.unsupported.push(id.clone());
            }
            continue;
        }
        if let Some(session) = session_of(&em, "episodic_memory", id) {
            if session.as_deref() != Some(bank) || has_vec {
                out.unsupported.push(id.clone());
            } else {
                out.episodic.push(id.clone());
            }
            continue;
        }
        out.not_found.push(id.clone());
    }
    out
}

/// 附属表（表，引用列）：facts / embeddings / annotations / gists。
const ATTACH_TABLES: [(&str, &str); 4] = [
    ("facts", "source_msg_id"),
    ("memory_embeddings", "memory_id"),
    ("annotations", "memory_id"),
    ("gists", "memory_id"),
];

/// `memoria_*` 反向引用表（上游 `MEMORIA_SOURCE_TABLES` 原样）。
const MEMORIA_TABLES: [&str; 5] = [
    "memoria_facts",
    "memoria_instructions",
    "memoria_kg",
    "memoria_preferences",
    "memoria_timelines",
];

/// 级联规划（preview 与删除共用，保证数字一致）。
struct CascadePlan {
    ids: Vec<String>,
    graph_refs: Vec<String>,
}

/// 建规划：收集被引用的 `fact_id` + 图边闭包（`id ∪ gist_<id> ∪ fact_id`）。
fn build_plan(conn: &Connection, working: &[String], episodic: &[String]) -> CascadePlan {
    let ids: Vec<String> = working.iter().chain(episodic.iter()).cloned().collect();
    let mut fact_ids: Vec<String> = Vec::new();
    let facts = table_schema(conn, "facts");
    if facts.has("source_msg_id") && facts.has("fact_id") && !ids.is_empty() {
        let sql = format!(
            "SELECT fact_id FROM facts WHERE source_msg_id IN {}",
            placeholders(ids.len())
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) =
                stmt.query_map(text_params(&ids).as_slice(), |row| row.get::<_, String>(0))
            {
                fact_ids.extend(rows.flatten());
            }
        }
    }
    let mut graph_refs: Vec<String> = Vec::with_capacity(ids.len() * 2 + fact_ids.len());
    for id in &ids {
        graph_refs.push(id.clone());
        graph_refs.push(format!("gist_{id}"));
    }
    graph_refs.extend(fact_ids);
    CascadePlan { ids, graph_refs }
}

/// 占位符 `IN` 列表（空 ⇒ `IN ('')` 恒假，防 `IN ()` 非法 SQL）。
fn placeholders(n: usize) -> String {
    if n == 0 {
        "('')".to_owned()
    } else {
        format!("({})", vec!["?"; n].join(", "))
    }
}

fn text_params(ids: &[String]) -> Vec<&dyn rusqlite::ToSql> {
    ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect()
}

/// 级联计数（preview 用；与删除语句一一对应）。
fn cascade_counts(conn: &Connection, plan: &CascadePlan) -> MemoryDeleteCascade {
    let count_in = |table: &str, col: &str, params: &[&dyn rusqlite::ToSql]| -> u64 {
        if !table_schema(conn, table).has(col) {
            return 0;
        }
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM \"{table}\" WHERE \"{col}\" IN {}",
                placeholders(params.len())
            ),
            params,
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
    };
    let ids = text_params(&plan.ids);
    let refs = text_params(&plan.graph_refs);
    let edges = table_schema(conn, "graph_edges");
    let edges_n = if edges.has("source") && edges.has("target") {
        let ph = placeholders(plan.graph_refs.len());
        let mut both = refs.clone();
        both.extend(refs.iter().copied());
        conn.query_row(
            &format!("SELECT COUNT(*) FROM graph_edges WHERE source IN {ph} OR target IN {ph}"),
            both.as_slice(),
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
    } else {
        0
    };
    let n = |table: &str, col: &str| count_in(table, col, &ids);
    let mut other = n("gists", "memory_id");
    for table in MEMORIA_TABLES {
        other += n(table, "source_memory_id");
    }
    MemoryDeleteCascade {
        facts: n("facts", "source_msg_id"),
        embeddings: n("memory_embeddings", "memory_id"),
        annotations: n("annotations", "memory_id"),
        edges: edges_n,
        other,
    }
}

/// `summary_of` 引用任一选中 working id 的 episodic 行数（LIKE 精确到逗号边界）。
fn cited_by_summaries(conn: &Connection, working: &[String]) -> u64 {
    if working.is_empty() || !table_schema(conn, "episodic_memory").has("summary_of") {
        return 0;
    }
    let one = "(',' || COALESCE(summary_of, '') || ',') LIKE ? ESCAPE '\\'";
    let sql = format!(
        "SELECT COUNT(*) FROM episodic_memory WHERE {}",
        vec![one; working.len()].join(" OR ")
    );
    let params: Vec<String> = working
        .iter()
        .map(|id| format!("%,{},%", escape_like(id)))
        .collect();
    conn.query_row(&sql, text_params(&params).as_slice(), |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| n.max(0) as u64)
    .unwrap_or(0)
}

/// CONTRACT §4.45 实现：删除预览（纯只读，不设门禁）。
pub fn preview_impl(
    bank_root: &Path,
    bank: &str,
    ids: &[String],
) -> Result<MemoryDeletePreview, AppError> {
    let normalized = normalize_ids(ids)?;
    let dir = validate_bank(bank_root, bank)?;
    let db = dir.join(DB_FILENAME);
    let conn = open_readonly(&db).ok_or_else(|| io(super::unreadable_reason(&db)))?;
    // bank 名取 canonical 目录名（与删除侧 session 限定一致）。
    let bank_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or(bank);
    let resolved = resolve_ids(&conn, bank_name, &normalized);
    let plan = build_plan(&conn, &resolved.working, &resolved.episodic);
    let cascade = cascade_counts(&conn, &plan);
    let cited = cited_by_summaries(&conn, &resolved.working);
    Ok(MemoryDeletePreview {
        requested: normalized.len() as u64,
        deletable: MemoryDeleteDeletable {
            working: resolved.working.len() as u64,
            episodic: resolved.episodic.len() as u64,
        },
        unsupported: resolved.unsupported.len() as u64,
        not_found: resolved.not_found.len() as u64,
        cascade,
        cited_by_summaries: cited,
    })
}

/// 事务内执行级联删除（顺序镜像上游 purge）。
/// 失败 ⇒ 返回中文原因，调用方 drop 事务（自动回滚）。
fn execute_plan(
    tx: &Connection,
    bank: &str,
    working: &[String],
    episodic: &[String],
    plan: &CascadePlan,
) -> Result<(), String> {
    let exec = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Result<usize, String> {
        tx.execute(sql, params).map_err(|e| e.to_string())
    };
    // ① base 表（`id + session_id` 限定，与上游一致）。
    for (table, ids) in [("working_memory", working), ("episodic_memory", episodic)] {
        if ids.is_empty() {
            continue;
        }
        let mut params = text_params(ids);
        params.push(&bank as &dyn rusqlite::ToSql);
        exec(
            &format!(
                "DELETE FROM {table} WHERE id IN {} AND session_id = ?",
                placeholders(ids.len())
            ),
            &params,
        )?;
    }
    let ids = text_params(&plan.ids);
    let ph_ids = placeholders(plan.ids.len());
    // ② facts → ③ annotations → ④ embeddings → ⑤ memoria → ⑥ gists → ⑦ edges。
    // 每张表删完立即复核（之后不会再往该表写），等价于事后统一 recount。
    let remaining = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> u64 {
        tx.query_row(sql, params, |row| row.get::<_, i64>(0))
            .map(|n| n.max(0) as u64)
            .unwrap_or(u64::MAX)
    };
    let mut leftovers = 0u64;
    let mut del_in = |table: &str, col: &str| -> Result<(), String> {
        if table_schema(tx, table).has(col) {
            exec(
                &format!("DELETE FROM \"{table}\" WHERE \"{col}\" IN {ph_ids}"),
                &ids,
            )?;
            leftovers += remaining(
                &format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{col}\" IN {ph_ids}"),
                &ids,
            );
        }
        Ok(())
    };
    for (table, col) in ATTACH_TABLES {
        del_in(table, col)?;
    }
    for table in MEMORIA_TABLES {
        del_in(table, "source_memory_id")?;
    }
    if table_schema(tx, "graph_edges").has("source")
        && table_schema(tx, "graph_edges").has("target")
    {
        let refs = text_params(&plan.graph_refs);
        let mut both = refs.clone();
        both.extend(refs.iter().copied());
        let ph = placeholders(plan.graph_refs.len());
        exec(
            &format!("DELETE FROM graph_edges WHERE source IN {ph} OR target IN {ph}"),
            &both,
        )?;
    }
    // base 表复核（附属表已在删除处逐个复核）。
    for (table, side) in [("working_memory", working), ("episodic_memory", episodic)] {
        if !side.is_empty() {
            leftovers += remaining(
                &format!(
                    "SELECT COUNT(*) FROM {table} WHERE id IN {}",
                    placeholders(side.len())
                ),
                &text_params(side),
            );
        }
    }
    if leftovers > 0 {
        return Err(format!("删除校验不一致：仍有 {leftovers} 行残留"));
    }
    Ok(())
}

/// CONTRACT §4.46 实现（门禁可注入）。
pub fn delete_items_impl_with(
    bank_root: &Path,
    data_dir: &Path,
    bank: &str,
    ids: &[String],
    gate: &Gate,
) -> Result<MemoryDeleteResult, AppError> {
    let normalized = normalize_ids(ids)?;
    let dir = validate_bank(bank_root, bank)?;
    gate.check(&dir)?;
    let bank_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or(bank);
    let broot = backup_root(data_dir);
    let db = dir.join(DB_FILENAME);
    // 只读规划：无可删 id ⇒ 直接拒（不建备份、不开写连接、不修剪）。
    let planned = {
        let read_only = open_readonly(&db).ok_or_else(|| io(super::unreadable_reason(&db)))?;
        resolve_ids(&read_only, bank_name, &normalized)
    };
    if planned.working.is_empty() && planned.episodic.is_empty() {
        return Err(invalid("所选记忆均不可删除（不存在或暂不支持）"));
    }
    let backup_ref =
        create_snapshot_backup(&broot, &dir, bank_name, MemoryBackupKind::BeforeDelete)?;
    gate.check(&dir)?;
    if !db.is_file() {
        return Err(io("数据库文件缺失"));
    }
    let mut conn = Connection::open(&db).map_err(|_| io("数据库文件损坏"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|_| io("数据库忙"))?;
    // 写连接上重解一次（规划到开馆之间的竞态）；变空则报错并保留已拍的备份。
    let resolved = resolve_ids(&conn, bank_name, &normalized);
    let plan = build_plan(&conn, &resolved.working, &resolved.episodic);
    if plan.ids.is_empty() {
        return Err(invalid("所选记忆均不可删除（不存在或暂不支持）"));
    }
    {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| io(format!("删除失败：{e}")))?;
        // `execute_plan` 取 `&Connection`：rusqlite Transaction Deref 到 Connection。
        execute_plan(&tx, bank_name, &resolved.working, &resolved.episodic, &plan)
            .map_err(|e| io(format!("删除失败：{e}")))?;
        tx.commit().map_err(|e| io(format!("删除失败：{e}")))?;
    }
    drop(conn);
    // best-effort checkpoint（失败不报错）。
    if let Ok(conn) = Connection::open(&db) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
    }
    prune_backups(&broot, bank_name, MemoryBackupKind::BeforeDelete);
    // deleted/skipped 保请求序。
    let deleted_set: HashSet<&str> = plan.ids.iter().map(String::as_str).collect();
    let unsupported_set: HashSet<&str> = resolved.unsupported.iter().map(String::as_str).collect();
    let mut deleted = Vec::new();
    let mut skipped = Vec::new();
    for id in &normalized {
        if deleted_set.contains(id.as_str()) {
            deleted.push(id.clone());
        } else {
            skipped.push(MemorySkipped {
                id: id.clone(),
                reason: if unsupported_set.contains(id.as_str()) {
                    MemorySkipReason::Unsupported
                } else {
                    MemorySkipReason::NotFound
                },
            });
        }
    }
    Ok(MemoryDeleteResult {
        deleted,
        skipped,
        backup: describe_ref(&backup_ref),
    })
}

/// 递归复制目录（常规文件；symlink/特殊文件 ⇒ 中止）。
fn copy_dir_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest)?;
        } else {
            return Err(std::io::Error::other(format!(
                "不支持的文件类型：{}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

/// 按字节比对两棵树（文件集合 + 内容全等）。
fn trees_identical(a: &Path, b: &Path) -> bool {
    let collect = |root: &Path| -> Option<Vec<(PathBuf, Vec<u8>)>> {
        let mut files = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir).ok()?;
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() {
                    let rel = path.strip_prefix(root).ok()?.to_path_buf();
                    let bytes = std::fs::read(&path).ok()?;
                    files.push((rel, bytes));
                } else {
                    return None;
                }
            }
        }
        files.sort();
        Some(files)
    };
    match (collect(a), collect(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// 移动目录（rename；跨设备 copy + 字节校验 + 删源）。
fn move_dir_verified(source: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            copy_dir_recursive(source, target)?;
            if !trees_identical(source, target) {
                let _ = std::fs::remove_dir_all(target);
                return Err(std::io::Error::other("跨设备复制校验不一致"));
            }
            std::fs::remove_dir_all(source)
        }
        Err(e) => Err(e),
    }
}

/// CONTRACT §4.47 实现（门禁可注入）：整 bank 移入备份区。
pub fn delete_bank_impl_with(
    bank_root: &Path,
    data_dir: &Path,
    bank: &str,
    gate: &Gate,
) -> Result<MemoryBackup, AppError> {
    delete_bank_impl_inner(bank_root, data_dir, bank, gate, |_| Ok(()))
}

/// 主体实现；`before_manifest` 是唯一测试注入点（生产为 no-op，仅供注入 manifest 写失败）。
///
/// 先写 manifest（此时原库未被触碰），再 `move`；任一步失败 ⇒ 清掉整个 ts 目录后报错。
fn delete_bank_impl_inner(
    bank_root: &Path,
    data_dir: &Path,
    bank: &str,
    gate: &Gate,
    before_manifest: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<MemoryBackup, AppError> {
    let dir = validate_bank(bank_root, bank)?;
    gate.check(&dir)?;
    let bank_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or(bank);
    let broot = backup_root(data_dir);
    // manifest 统计（库不可读 ⇒ 零/None，不阻止移除）。
    let db = dir.join(DB_FILENAME);
    let (working, episodic, cwd) = open_readonly(&db)
        .map(|conn| snapshot_stats(&conn))
        .unwrap_or((0, 0, None));
    let bank_backup_dir = broot.join(bank_name);
    ensure_dir_0700(&bank_backup_dir).map_err(|e| io(format!("备份失败：{e}")))?;
    let dirname = pick_dirname(&bank_backup_dir, MemoryBackupKind::BankRemoved)?;
    let ts_dir = bank_backup_dir.join(&dirname);
    ensure_dir_0700(&ts_dir).map_err(|e| io(format!("备份失败：{e}")))?;
    let discard = || {
        let _ = std::fs::remove_dir_all(&ts_dir);
    };
    if let Err(e) = before_manifest(&ts_dir) {
        discard();
        return Err(io(format!("删除记忆库失败：{e}")));
    }
    if let Err(e) = write_manifest(
        &ts_dir,
        bank_name,
        MemoryBackupKind::BankRemoved,
        &dirname,
        cwd,
        working,
        episodic,
    ) {
        discard();
        return Err(e);
    }
    if let Err(e) = gate.check(&dir) {
        discard();
        return Err(e);
    }
    let dest = ts_dir.join(REMOVED_SUBDIR);
    if let Err(e) = move_dir_verified(&dir, &dest) {
        discard();
        return Err(io(format!("删除记忆库失败：{e}")));
    }
    // 移入后硬化权限（best-effort，不回滚已成功的移动）。
    harden_tree_perms(&dest);
    let reference = resolve_backup_id(&broot, &format!("{bank_name}@{dirname}"))?;
    Ok(describe_ref(&reference))
}

/// 递归硬化备份树权限（目录 0700 / 文件 0600，逐个 best-effort）。
fn harden_tree_perms(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        let _ = std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o700));
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

/// 把快照 db 放到目标位置（先删 `-wal` / `-shm`，best-effort）。
fn place_snapshot(source: &Path, dest: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(dest.with_extension("db-wal"));
    let _ = std::fs::remove_file(dest.with_extension("db-shm"));
    std::fs::copy(source, dest).map(|_| ())
}

/// 恢复校验：只读打开 + integrity_check=ok + 行数=manifest（manifest 缺失 ⇒ 只查完整性）。
fn verify_restored(
    db: &Path,
    manifest_working: Option<u64>,
    manifest_episodic: Option<u64>,
) -> bool {
    let Some(conn) = open_readonly(db) else {
        return false;
    };
    let ok: bool = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map(|s| s.eq_ignore_ascii_case("ok"))
        .unwrap_or(false);
    if !ok {
        return false;
    }
    if manifest_working.is_none() && manifest_episodic.is_none() {
        return true;
    }
    let count = |table: &str| -> u64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|n| n.max(0) as u64)
        .unwrap_or(u64::MAX)
    };
    manifest_working.is_none_or(|m| count("working_memory") == m)
        && manifest_episodic.is_none_or(|m| count("episodic_memory") == m)
}

/// 读备份 manifest 的行数（缺失/损坏 ⇒ None）。
fn manifest_counts(dir: &Path) -> (Option<u64>, Option<u64>) {
    let counts: Option<serde_json::Value> = std::fs::read(dir.join(MANIFEST_FILENAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let get = |key: &str| -> Option<u64> { counts.as_ref()?.get(key)?.as_u64() };
    (get("working"), get("episodic"))
}

/// CONTRACT §4.48 实现（门禁可注入）。
pub fn restore_impl_with(
    bank_root: &Path,
    data_dir: &Path,
    backup_id: &str,
    gate: &Gate,
) -> Result<MemoryRestoreResult, AppError> {
    let broot = backup_root(data_dir);
    let reference = resolve_backup_id(&broot, backup_id)?;
    let bank = reference.bank.clone();
    if bank.is_empty() {
        return Err(outside("非法的备份标识"));
    }
    let target_dir = bank_root.join(&bank);
    // 目标若存在必须仍在根内（防根被替换）。
    if let Ok(canon_root) = bank_root.canonicalize() {
        if let Ok(canon_target) = target_dir.canonicalize() {
            if !canon_target.starts_with(&canon_root) {
                return Err(outside("记忆库路径越界"));
            }
        }
    }
    gate.check(&target_dir)?;
    let target_existed = target_dir.is_dir();
    if target_dir.exists() && !target_existed {
        return Err(io("恢复目标被文件占用"));
    }
    // 目标存在 ⇒ 先 before-restore 快照。
    let safety: Option<super::backup::BackupRef> = if target_existed {
        Some(create_snapshot_backup(
            &broot,
            &target_dir,
            &bank,
            MemoryBackupKind::BeforeRestore,
        )?)
    } else {
        None
    };
    gate.check(&target_dir)?;
    let failed = |e: AppError| {
        fail_restore(
            &target_dir,
            target_existed,
            reference.kind,
            safety.as_ref(),
            e.message,
        )
    };
    // 放置：bank-removed 到已存在目标 ⇒ 先清空；快照类 ⇒ 删边车后覆盖 db。
    if target_existed && reference.kind == MemoryBackupKind::BankRemoved {
        if let Err(e) = std::fs::remove_dir_all(&target_dir) {
            return Err(failed(io(format!("恢复失败：{e}"))));
        }
    }
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        return Err(failed(io(format!("恢复失败：{e}"))));
    }
    let placed: Result<(), AppError> = match reference.kind {
        MemoryBackupKind::BankRemoved => {
            copy_dir_recursive(&reference.dir.join(REMOVED_SUBDIR), &target_dir)
                .map_err(|e| io(format!("恢复失败：{e}")))
        }
        _ => {
            let source = reference.dir.join(BACKUP_DB_FILENAME);
            if !source.is_file() {
                Err(io("恢复失败：备份快照缺失"))
            } else {
                place_snapshot(&source, &target_dir.join(DB_FILENAME))
                    .map_err(|e| io(format!("恢复失败：{e}")))
            }
        }
    };
    if let Err(e) = placed {
        return Err(failed(e));
    }
    let (mw, me) = manifest_counts(&reference.dir);
    if !verify_restored(&target_dir.join(DB_FILENAME), mw, me) {
        return Err(failed(io("恢复失败：校验不一致")));
    }
    prune_backups(&broot, &bank, MemoryBackupKind::BeforeRestore);
    Ok(MemoryRestoreResult {
        bank,
        restored_from: describe_ref(&reference),
        safety_backup: safety.as_ref().map(describe_ref),
    })
}

/// 恢复失败收尾：回滚目标；回滚经校验后删除已冗余的 `before-restore` 安全快照；
/// 回滚无法验证 ⇒ 保留安全快照（改动前数据的唯一副本）并在错误里点名。
/// 失败路径**不修剪**任何备份。`bank-removed` 回滚前整目录重建（不留杂散文件）。
fn fail_restore(
    target_dir: &Path,
    target_existed: bool,
    kind: MemoryBackupKind,
    safety: Option<&super::backup::BackupRef>,
    reason: String,
) -> AppError {
    match (target_existed, safety) {
        (true, Some(safety_ref)) => {
            // bank-removed 路径已删目标（可能拷回一半）：整目录重建；快照类目录原样保留。
            if kind == MemoryBackupKind::BankRemoved {
                let _ = std::fs::remove_dir_all(target_dir);
            }
            let _ = std::fs::create_dir_all(target_dir);
            let dest = target_dir.join(DB_FILENAME);
            let copied = place_snapshot(&safety_ref.dir.join(BACKUP_DB_FILENAME), &dest).is_ok();
            let (sw, se) = manifest_counts(&safety_ref.dir);
            if copied && verify_restored(&dest, sw, se) {
                let _ = std::fs::remove_dir_all(&safety_ref.dir);
                io(format!("{reason}，已回滚"))
            } else {
                io(format!(
                    "{reason}；回滚未能验证，请从安全快照 {}@{} 手动恢复",
                    safety_ref.bank, safety_ref.dirname
                ))
            }
        }
        (true, None) => io(reason),
        (false, _) => {
            let _ = std::fs::remove_dir_all(target_dir);
            io(format!("{reason}，已回滚"))
        }
    }
}

/// CONTRACT §4.49 实现：永久删除一个备份（备份区内）。
pub fn delete_backup_impl(data_dir: &Path, backup_id: &str) -> Result<(), AppError> {
    delete_backup_dir(&backup_root(data_dir), backup_id)
}

/// CONTRACT §4.43 实现（门禁可注入）：lsof 失败 ⇒ probe_failed，非错误。
pub fn status_impl_with(
    bank_root: &Path,
    data_dir: &Path,
    bank: &str,
    gate: &Gate,
) -> Result<MemoryBankStatus, AppError> {
    let dir = validate_bank(bank_root, bank)?;
    let bank_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or(bank);
    let (in_use, probe_failed, holders) =
        match holders_for_files_with(&bank_files(&dir), &gate.lsof, gate.timeout) {
            Ok(h) => (!h.is_empty(), false, h),
            Err(ProbeFailed) => (false, true, Vec::new()),
        };
    let backups = list_backups(&backup_root(data_dir), Some(bank_name));
    Ok(MemoryBankStatus {
        bank: bank_name.to_owned(),
        in_use,
        probe_failed,
        holders,
        backups,
    })
}

/// CONTRACT §4.44 实现：备份列表（`bank=None` ⇒ 全部）。
pub fn backups_impl(data_dir: &Path, bank: Option<&str>) -> Vec<MemoryBackup> {
    list_backups(&backup_root(data_dir), bank)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 恒报空闲的假 lsof（exit 1 = 无命中）。
    fn idle_gate(dir: &Path) -> Gate {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("lsof-idle");
        std::fs::write(&bin, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        Gate {
            lsof: bin,
            timeout: Duration::from_secs(5),
        }
    }

    /// manifest 写失败 ⇒ 原库分毫未动，备份区不留残留目录。
    #[test]
    fn bank_remove_manifest_failure_leaves_bank_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let banks = tmp.path().join("banks");
        let bank_dir = banks.join("b-1");
        std::fs::create_dir_all(&bank_dir).unwrap();
        let db = bank_dir.join(DB_FILENAME);
        Connection::open(&db)
            .unwrap()
            .execute_batch(
                "CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, session_id TEXT); \
                 INSERT INTO working_memory VALUES ('w1', 'x', 'b-1');",
            )
            .unwrap();
        let before = std::fs::read(&db).unwrap();
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        // 让 manifest 写入必然失败：在 manifest.json 处占一个同名目录。
        let err = delete_bank_impl_inner(&banks, &data, "b-1", &idle_gate(tmp.path()), |ts_dir| {
            std::fs::create_dir(ts_dir.join(MANIFEST_FILENAME))
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(std::fs::read(&db).unwrap(), before);
        // 备份区无残留：ts 目录整个被清掉，且不可列出。
        let leftovers: Vec<_> = std::fs::read_dir(data.join("memory-backups").join("b-1"))
            .unwrap()
            .flatten()
            .collect();
        assert!(leftovers.is_empty());
        assert!(backups_impl(&data, Some("b-1")).is_empty());
    }
}
