//! 会话扫描 / 解析 / 列表 / 会话内容 / 树（CONTRACT §4.2–§4.5、§5、§9）。
//!
//! 模块布局：`parse`（单遍解析 + 树索引）、`list`、`conversation`、`tree`。
//! 占用探测在顶层 [`crate::lock`]，删除 / 标记 / iTerm 在 `ops`（另一 worker）。

use std::collections::HashSet;
use std::io::BufRead;
use std::path::Path;

use crate::config::Config;
use crate::model::{AppError, CheckSessionResult, ErrorCode};

pub mod conversation;
pub mod list;
pub mod parse;
pub mod tree;

// ---------------------------------------------------------------------------
// CONTRACT §9 常量
// ---------------------------------------------------------------------------

/// toolResult / bashExecution 文本截断（UTF-8 字节，字符边界）。
pub const MAX_TEXT_BYTES: usize = 8000;
/// 截断尾标记。
pub const TRUNC_SUFFIX: &str = "…[已截断]";
/// 无标题时首用户消息截断（字符）。
pub const TITLE_FALLBACK_CHARS: usize = 60;
/// `firstUserMessage` 字段截断（字符）。
pub const FIRST_USER_MESSAGE_CHARS: usize = 200;
/// `other` 条目文本截断（字符）。
pub const OTHER_TEXT_CHARS: usize = 2000;
/// 树节点 preview 截断（字符）。
pub const TREE_PREVIEW_CHARS: usize = 80;
/// 无标题兜底。
pub const UNTITLED: &str = "(无标题)";

// ---------------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------------

/// 按字符数截断，超长时保留前 n-1 字 + `…`（总长 ≤ n）。
pub fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else if n == 0 {
        String::new()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    }
}

/// `content`（字符串或块数组）抽出全部 text 块，以 `\n` 拼接；
/// image 块记为 `[图片]`。
pub fn joined_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for b in arr {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    parts.push(t.to_string());
                }
            }
            Some("image") => parts.push("[图片]".to_string()),
            _ => {}
        }
    }
    parts.join("\n")
}

/// 文件 mtime → ISO-8601 UTC 毫秒字符串。
pub fn mtime_iso(path: &Path) -> Result<String, AppError> {
    let meta = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                ErrorCode::NotFound,
                format!("文件不存在：{}", path.display()),
            )
        } else {
            AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
        }
    })?;
    let mtime = meta.modified().map_err(|e| {
        AppError::new(
            ErrorCode::Io,
            format!("无法读取 {} mtime：{e}", path.display()),
        )
    })?;
    let dt: chrono::DateTime<chrono::Utc> = mtime.into();
    Ok(dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// 文件字节数。
pub fn file_size(path: &Path) -> Result<u64, AppError> {
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display())))
}

// ---------------------------------------------------------------------------
// ops worker 依赖的接口（签名冻结）
// ---------------------------------------------------------------------------

/// 会话 header 摘要（廉价读取）。
#[derive(Debug, Clone)]
pub struct HeaderInfo {
    pub id: String,
    pub cwd: Option<String>,
    pub version: Option<u32>,
    pub parent_session: Option<String>,
}

/// 廉价读取 header：只读文件前几行。`path` 须已通过
/// [`crate::config::validate_session_path`] 校验。无合法 header → `IO`。
pub fn header_info(path: &Path) -> Result<HeaderInfo, AppError> {
    let io_err = |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                ErrorCode::NotFound,
                format!("会话文件不存在：{}", path.display()),
            )
        } else {
            AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
        }
    };
    let file = std::fs::File::open(path).map_err(io_err)?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().take(8) {
        let line = line.map_err(io_err)?;
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(&line).map_err(|_| {
            AppError::new(ErrorCode::Io, format!("会话文件头损坏：{}", path.display()))
        })?;
        if v.get("type").and_then(|t| t.as_str()) != Some("session") {
            continue; // title 首行等
        }
        let id = v
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AppError::new(ErrorCode::Io, format!("header 缺少 id：{}", path.display()))
            })?
            .to_string();
        return Ok(HeaderInfo {
            id,
            cwd: v.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string()),
            version: v.get("version").and_then(|v| v.as_u64()).map(|n| n as u32),
            parent_session: v
                .get("parentSession")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    Err(AppError::new(
        ErrorCode::Io,
        format!("缺少 session header：{}", path.display()),
    ))
}

/// marker 追加所需的树上下文（供 ops worker）。
#[derive(Debug, Clone)]
pub struct MarkerContext {
    pub session_id: String,
    pub leaf_id: Option<String>,
    /// 保留节点 id 集（nodeId 合法性校验用）。
    pub kept_ids: HashSet<String>,
    /// 文件内全部条目 id（含跳过类型，marker id 唯一性用）。
    pub all_ids: HashSet<String>,
}

/// 计算 marker 上下文：非 v3 → `UNSUPPORTED_FORMAT`。
pub fn marker_context(path: &Path) -> Result<MarkerContext, AppError> {
    let parsed = parse::parse_file(path)?;
    let version = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("version"))
        .and_then(|v| v.as_u64());
    if version != Some(3) {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            "仅支持 version 3 会话",
        ));
    }
    let session_id = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::new(ErrorCode::Io, "header 缺少 id".to_string()))?
        .to_string();
    let idx = parse::build_index(&parsed);
    Ok(MarkerContext {
        session_id,
        leaf_id: idx.leaf_id.clone(),
        kept_ids: idx.kept_pos.keys().cloned().collect(),
        all_ids: idx.all_ids.clone(),
    })
}

// ---------------------------------------------------------------------------
// check_session（CONTRACT §4.5）
// ---------------------------------------------------------------------------

/// 占用探测：`path` 须已校验。header 不可读 → 错误透出（无法确定 id 则
/// 不敢断言空闲，见 CONTRACT §3）。
pub fn check_session(validated_path: &Path, cfg: &Config) -> Result<CheckSessionResult, AppError> {
    let info = header_info(validated_path)?;
    let p = crate::lock::probe(&cfg.owners_dir, &info.id);
    Ok(CheckSessionResult {
        in_use: p.in_use,
        probe_ok: p.probe_ok,
    })
}

/// 文件 stem（去 `.jsonl`），header 缺 id 时的回退会话 id。
pub fn stem_id(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.strip_suffix(".jsonl").unwrap_or(&name).to_string()
}

/// 规范化的会话 id 来源：header.id，缺失回退文件 stem。
pub fn session_id_of(parsed: &parse::ParsedFile, path: &Path) -> String {
    parsed
        .header
        .as_ref()
        .and_then(|h| h.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| stem_id(path))
}
