//! 记忆库引用关系图（CONTRACT §18.10，只读）：边只取真实有行的数据——
//! `episodic_memory.summary_of`（摘要→原记忆）、`graph_edges`（`ctx`→context，
//! 其余→related），端点须为记忆 id（`gist_*`/`fact_*` 伪节点自动排除）。
//! `superseded_by` 全库无行、`session_id` 单库唯一、facts 共享主体多为泛词，均不建边。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::Connection;

use super::{
    GRAPH_NODE_CAP, GRAPH_SNIPPET_CHARS, col_or_null, io, iso_millis_opt, make_snippet_with,
    open_readonly, parse_memory_ts, table_schema, validate_bank, DB_FILENAME,
};
use crate::model::{
    AppError, MemoryGraph, MemoryGraphEdge, MemoryGraphEdgeKind, MemoryGraphNode, MemoryKind,
};

/// bank 库只读打开（校验语义同 `rows::open_bank_db`）。
fn open_bank_db(root: &Path, bank: &str) -> Result<Connection, AppError> {
    let dir = validate_bank(root, bank)?;
    let db = dir.join(DB_FILENAME);
    open_readonly(&db).ok_or_else(|| io(super::unreadable_reason(&db)))
}

/// 可选三列查询：SQL 失败 ⇒ 空（缺表/列时降级）；坏行跳过。
fn col3(conn: &Connection, sql: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare(sql) else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return out;
    };
    out.extend(rows.flatten());
    out
}

/// id → (kind, snippet, created_at, recall_count, importance, 排序用时间戳)。
type NodeInfo = (MemoryKind, String, Option<String>, i64, Option<f64>, i64);

/// CONTRACT §18.10 实现（同步，调用方包 `spawn_blocking`）。
pub fn graph_impl(root: &Path, bank: &str) -> Result<MemoryGraph, AppError> {
    let conn = open_bank_db(root, bank)?;
    let wm = table_schema(&conn, "working_memory");
    let em = table_schema(&conn, "episodic_memory");
    if !wm.exists && !em.exists {
        return Err(io("缺少记忆表"));
    }
    let mut nodes: HashMap<String, NodeInfo> = HashMap::new();
    for (table, kind, schema) in [
        ("working_memory", MemoryKind::Working, &wm),
        ("episodic_memory", MemoryKind::Episodic, &em),
    ] {
        if !(schema.exists && schema.has("id") && schema.has("content")) {
            continue;
        }
        let cols = ["timestamp", "recall_count", "importance"].map(|c| col_or_null(schema, c));
        let sql = format!(
            "SELECT id, substr(content, 1, 128) AS prefix, LENGTH(content) AS content_len, {} \
             FROM \"{table}\"",
            cols.join(", "),
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<f64>>(5)?,
            ))
        }) else {
            continue;
        };
        for (id, prefix, content_len, ts, recall, importance) in rows.flatten() {
            nodes.insert(
                id,
                (
                    kind,
                    make_snippet_with(&prefix, content_len.max(0) as u64, GRAPH_SNIPPET_CHARS),
                    iso_millis_opt(ts.as_deref()),
                    recall.unwrap_or(0),
                    importance.filter(|v| v.is_finite()),
                    ts.as_deref()
                        .and_then(parse_memory_ts)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(i64::MIN),
                ),
            );
        }
    }
    if nodes.is_empty() {
        return Ok(MemoryGraph {
            nodes: Vec::new(),
            edges: Vec::new(),
            truncated: false,
            total_nodes: 0,
            total_edges: 0,
            unlinked_count: 0,
        });
    }
    let mut edges: Vec<MemoryGraphEdge> = Vec::new();
    let mut seen: HashSet<(String, String, u8)> = HashSet::new();
    let mut push = |source: &str, target: &str, kind: MemoryGraphEdgeKind| {
        if source == target || !nodes.contains_key(source) || !nodes.contains_key(target) {
            return;
        }
        let tag = kind as u8;
        if seen.insert((source.to_owned(), target.to_owned(), tag)) {
            edges.push(MemoryGraphEdge {
                source: source.to_owned(),
                target: target.to_owned(),
                kind,
            });
        }
    };
    if em.exists && em.has("summary_of") && em.has("id") {
        for (id, summary_of, _) in col3(
            &conn,
            "SELECT id, summary_of, '' FROM episodic_memory WHERE summary_of IS NOT NULL AND summary_of <> ''",
        ) {
            for target in summary_of.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                push(&id, target, MemoryGraphEdgeKind::Summary);
            }
        }
    }
    let ge = table_schema(&conn, "graph_edges");
    if ge.exists && ge.has("source") && ge.has("target") && ge.has("edge_type") {
        for (source, target, edge_type) in
            col3(&conn, "SELECT source, target, edge_type FROM graph_edges")
        {
            push(
                &source,
                &target,
                if edge_type == "ctx" {
                    MemoryGraphEdgeKind::Context
                } else {
                    MemoryGraphEdgeKind::Related
                },
            );
        }
    }
    let total_edges = edges.len() as u64;
    // 关联度降序 → 新近 → id 取前 N；只留存活端点间的边；孤点不渲染。
    let mut degree: HashMap<String, u64> = HashMap::new();
    for e in &edges {
        *degree.entry(e.source.clone()).or_default() += 1;
        *degree.entry(e.target.clone()).or_default() += 1;
    }
    let mut linked: Vec<(String, u64, i64)> = nodes
        .iter()
        .filter_map(|(id, v)| degree.get(id).map(|d| (id.clone(), *d, v.5)))
        .collect();
    linked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| a.0.cmp(&b.0))
    });
    let truncated = linked.len() > GRAPH_NODE_CAP;
    linked.truncate(GRAPH_NODE_CAP);
    let kept: HashSet<&str> = linked.iter().map(|(id, _, _)| id.as_str()).collect();
    edges.retain(|e| kept.contains(e.source.as_str()) && kept.contains(e.target.as_str()));
    let mut shown: HashMap<&str, u64> = HashMap::new();
    for e in &edges {
        *shown.entry(e.source.as_str()).or_default() += 1;
        *shown.entry(e.target.as_str()).or_default() += 1;
    }
    let mut out: Vec<MemoryGraphNode> = linked
        .iter()
        .map(|(id, _, _)| {
            let (kind, snippet, created, recall, importance, _) = &nodes[id.as_str()];
            MemoryGraphNode {
                id: id.clone(),
                kind: *kind,
                snippet: snippet.clone(),
                created_at: created.clone(),
                recall_count: *recall,
                importance: *importance,
                degree: shown.get(id.as_str()).copied().unwrap_or(0),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.degree
            .cmp(&a.degree)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(MemoryGraph {
        nodes: out,
        edges,
        truncated,
        total_nodes: nodes.len() as u64,
        total_edges,
        unlinked_count: nodes.len() as u64 - degree.len() as u64,
    })
}
