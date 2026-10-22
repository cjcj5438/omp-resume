//! 模型规格编辑（CONTRACT §21 / §4.54–§4.55）：读写 omp 的
//! `models.yml`（`OMP_RESUME_MODELS_YML` 可覆盖），只改单个模型的非凭据规格字段。
//!
//! SECURITY：
//! - 该文件含明文 apiKey：绝不做 YAML 解析再整体重排（会复制/换行凭据），只做
//!   行级外科手术替换；错误信息里绝不出现文件内容、apiKey 或环境变量值；
//! - 读取只向 IPC 返回非凭据规格字段（provider/id/name/窗口/档位/input/费用）；
//! - 写入前必须先把新文本放沙箱目录，用真实 omp `models --json` 校验（fail-closed）；
//! - omp 缺失（无法校验）时拒绝写入（`OMP_NOT_FOUND`）；
//! - 写盘前先备份（0600，同目录保留最新 10 份），原子替换（同目录临时文件 +
//!   fsync + rename + 0600）。
//!
//! 注意：`omp models --json` 的 stdout/stderr 可能混有配置警告文本，解析失败或
//! 校验不匹配时只返回固定中文文案，不回显 omp 输出。

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::model::{
    AppError, ErrorCode, ModelSpec, ModelSpecPatch, ModelSpecPatchRequest, ModelSpecUpdateResult,
    ModelSpecsResult,
};
use crate::omp_cli::{omp_not_found, resolve_omp, strip_ansi, OmpBusy, CHECK_TIMEOUT};

/// 路径覆盖：`OMP_RESUME_MODELS_YML`（存在、非空）> `PI_CODING_AGENT_DIR/models.yml` >
/// `$HOME/.omp/agent/models.yml`。
pub const MODELS_YML_ENV: &str = "OMP_RESUME_MODELS_YML";
/// 沙箱校验用的 omp 环境根目录变量名（omp 读 `<dir>/models.yml`）。
pub const PI_AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
/// 文件大小上限（2 MiB）。
pub const MAX_YML_BYTES: u64 = 2 * 1024 * 1024;
/// 备份保留份数（按名倒序取最新）。
pub const BACKUP_KEEP: usize = 10;
/// 备份文件名缀。
const BACKUP_MARK: &str = ".omp-resume.";
const BACKUP_SUFFIX: &str = ".bak";
const MODELS_YML_NAME: &str = "models.yml";

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn io_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Io, message)
}

fn conflict() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "模型规格文件已被外部修改，请刷新后重试",
    )
}

/// 手动编辑提示：文件形状超出本编辑器的能力时请用户自行处理。
fn manual_edit(reason: &str) -> AppError {
    invalid(format!("{reason}，请手动编辑 models.yml"))
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 解析 models.yml 路径（`_with` 可注入环境与 HOME，便于单测）。
/// 相对路径的 `OMP_RESUME_MODELS_YML` 按当前目录 absolutize（`parent()` 为 `Some("")`
/// 会让建目录报错含糊，故此处先转绝对）。
pub fn resolve_models_yml_with(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if let Some(path) = env(MODELS_YML_ENV).filter(|p| !p.trim().is_empty()) {
        let path = PathBuf::from(path.trim());
        if path.is_absolute() {
            return path;
        }
        return std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path);
    }
    if let Some(dir) = env(PI_AGENT_DIR_ENV).filter(|p| !p.trim().is_empty()) {
        return PathBuf::from(dir.trim()).join(MODELS_YML_NAME);
    }
    home.join(".omp/agent/models.yml")
}

pub fn resolve_models_yml() -> PathBuf {
    resolve_models_yml_with(
        |key| std::env::var_os(key).map(|value| value.to_string_lossy().into_owned()),
        &home_dir(),
    )
}

/// 文件字节的 SHA256 十六进制（revision）。
pub fn revision_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 读取 models.yml（大小上限 2 MiB；缺失返回 None）。
fn read_yml(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() as u64 > MAX_YML_BYTES {
                return Err(invalid("模型规格文件过大（超过 2 MiB），请手动编辑"));
            }
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(format!("无法读取模型规格文件：{error}"))),
    }
}

// ---------------------------------------------------------------------------
// 行级 YAML 编辑（纯函数：逐行切片，不解析凭据）
// ---------------------------------------------------------------------------

/// 文本行视图：`content` 不含换行符；`newline` 为原换行（`\n` / `\r\n` / 文件尾无）。
struct Line<'a> {
    content: &'a str,
    newline: &'a str,
}

/// 按行切分，保留每行换行符（含 CRLF）；要求 UTF-8。
fn split_lines(text: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        match rest.find('\n') {
            Some(index) => {
                let (mut content, after) = (&rest[..index], &rest[index + 1..]);
                let mut newline = "\n";
                if let Some(stripped) = content.strip_suffix('\r') {
                    content = stripped;
                    newline = "\r\n";
                }
                lines.push(Line { content, newline });
                rest = after;
            }
            None => {
                lines.push(Line {
                    content: rest,
                    newline: "",
                });
                break;
            }
        }
    }
    lines
}

/// 行首空格数（只数空格；tab 视为 0，命中时由键匹配自然失败）。
fn indent_of(content: &str) -> usize {
    content.len() - content.trim_start_matches(' ').len()
}

/// 去掉行尾注释（`#` 前须有空白；引号内的 `#` 不算）。
fn strip_comment(content: &str) -> &str {
    let bytes = content.as_bytes();
    let mut quote: Option<u8> = None;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match quote {
            Some(q) => {
                if byte == q {
                    if q == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        quote = None;
                    }
                } else if q == b'"' && byte == b'\\' {
                    index += 1;
                }
            }
            None => {
                if byte == b'"' || byte == b'\'' {
                    quote = Some(byte);
                } else if byte == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
                    return content[..index].trim_end();
                }
            }
        }
        index += 1;
    }
    content.trim_end()
}

/// 剥掉成对引号（双引号处理 `\\` `\"` `\n`，单引号处理 `''`）；不成对则原文。
fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        let mut out = String::with_capacity(raw.len());
        let mut chars = raw[1..raw.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return out;
    }
    if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        return raw[1..raw.len() - 1].replace("''", "'");
    }
    raw.to_owned()
}

/// `key: value` 顶层键行解析：返回（键原文去引号后，值部分原文（去注释、去首尾空））。
/// 要求键后紧跟 `:`（`key :` 的空格容忍），值可为空（块头）。
fn parse_key_line(content: &str) -> Option<(String, &str)> {
    let trimmed = content.trim_start_matches(' ');
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("- ") || trimmed == "-"
    {
        return None;
    }
    // 键可能是 `"a b": v` / `'a': v` / `plain: v`。
    let (key_raw, after) = if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let quote = trimmed.as_bytes()[0];
        let bytes = trimmed.as_bytes();
        let mut index = 1;
        let mut end = None;
        while index < bytes.len() {
            if bytes[index] == quote {
                if quote == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                end = Some(index);
                break;
            }
            if quote == b'"' && bytes[index] == b'\\' {
                index += 1;
            }
            index += 1;
        }
        let end = end?;
        let key = &trimmed[..=end];
        let after = trimmed[end + 1..].trim_start_matches(' ');
        if !after.starts_with(':') {
            return None;
        }
        (key, after[1..].trim_start_matches(' '))
    } else {
        let colon = trimmed.find(':')?;
        let key = trimmed[..colon].trim_end_matches(' ');
        if key.is_empty() || key.contains([' ', '\t']) {
            return None;
        }
        (key, trimmed[colon + 1..].trim_start_matches(' '))
    };
    Some((unquote(key_raw), strip_comment(after).trim()))
}

/// 列表项头（`- ` / `-`）：返回横线后的剩余内容。
fn item_head(content: &str) -> Option<(usize, &str)> {
    let indent = indent_of(content);
    let trimmed = &content[indent..];
    if trimmed == "-" {
        return Some((indent, ""));
    }
    trimmed
        .strip_prefix("- ")
        .map(|rest| (indent, rest))
        .or_else(|| {
            trimmed
                .strip_prefix("-\t")
                .map(|rest| (indent, rest.trim_start_matches([' ', '\t'])))
        })
}

/// 条目首行内联键：剥掉 `- &anchor` 前缀后再解析（`- *alias` / `- {` 无键）。
fn head_key_of(rest: &str) -> Option<(String, String)> {
    let trimmed = rest.trim();
    if trimmed.is_empty() || trimmed.starts_with('*') || trimmed.starts_with('{') {
        return None;
    }
    // 锚前缀前可能有多余空格（`-   &a id: x`）：先裁再判。
    let anchored = rest.trim_start_matches([' ', '\t']);
    if let Some(after) = anchored.strip_prefix('&') {
        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
        if parts.next().unwrap_or("").is_empty() {
            return None;
        }
        let key_part = parts.next().unwrap_or("").trim_start();
        if key_part.is_empty() {
            return None;
        }
        return parse_key_line(key_part).map(|(key, value)| (key, value.to_owned()));
    }
    parse_key_line(rest).map(|(key, value)| (key, value.to_owned()))
}

/// 首行内联字段（键原文去引号后，值原文）。
type HeadKey = Option<(String, String)>;
/// 条目匹配（首行，内联键，末行）。
type ItemMatch = (usize, HeadKey, usize);
/// 条目首行内联 id 归一化：剥掉前导 `&anchor` 标记再去引号。
/// `id: &x fast` → `fast`；无锚时与 `unquote` 一致。
fn normalize_id_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(after) = trimmed.strip_prefix('&') {
        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
        let anchor = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("").trim();
        if !anchor.is_empty() && !rest.is_empty() {
            return unquote(rest);
        }
    }
    unquote(trimmed)
}

/// 条目直接子字段缩进：首行有内联键则取首行键列，否则取横线后首个键行的缩进。
/// 找不到任何键行时回退 `dash + 2`（纯 `- ` 空条目）。
fn item_field_indent(lines: &[Line<'_>], item_line: usize, end_line: usize) -> usize {
    let content = lines[item_line].content;
    let dash_indent = indent_of(content);
    if let Some((_, rest)) = item_head(content) {
        if head_key_of(rest).is_some() {
            // 首行内联键的列：横线后第一个非空白字符列（锚前缀跳过）。
            let after_dash = &content[dash_indent + 1..];
            let key_rest = after_dash.trim_start_matches([' ', '\t']);
            let mut key_col = content.len() - key_rest.len();
            if let Some(after) = key_rest.strip_prefix('&') {
                // `- &anchor key:`：键在锚之后。
                let mut parts = after.splitn(2, |c: char| c.is_whitespace());
                let anchor = parts.next().unwrap_or("");
                if !anchor.is_empty() {
                    let key_part = parts.next().unwrap_or("");
                    let trimmed = key_part.trim_start();
                    key_col = content.len() - trimmed.len();
                }
            }
            // 锚头（`- &a id: x`）键列偏右：续行首个键行的缩进才是字段真相
            // （YAML 紧凑写法允许续行与首键不对齐）；无续行键或其不深于横线
            // （外来回退行）时沿用键列。
            let mut index = item_line + 1;
            while index <= end_line && index < lines.len() {
                let line = &lines[index];
                if item_head(line.content).is_some() {
                    break;
                }
                if parse_key_line(line.content).is_some() {
                    let found = indent_of(line.content);
                    if found > dash_indent {
                        return found;
                    }
                    break;
                }
                index += 1;
            }
            return key_col;
        }
    }
    let mut index = item_line + 1;
    while index <= end_line && index < lines.len() {
        let line = &lines[index];
        if item_head(line.content).is_some() {
            break;
        }
        if parse_key_line(line.content).is_some() {
            return indent_of(line.content);
        }
        index += 1;
    }
    dash_indent + 2
}

/// 模型条目在行数组中的位置。
struct ModelSpan {
    /// 列表项首行（`- ...`）下标。
    item_line: usize,
    /// 首行 `- ` 后的内联 `key: value`（如 `- id: x`），无则 None。
    head_key: HeadKey,
    /// 条目最后一行下标（含）。
    end_line: usize,
    /// 条目内字段缩进（`- ` 行的字段缩进；`- id: x` 与续行字段可能差两列）。
    field_indent: usize,
}

/// 定位 `providers:` 下某 provider 的 `models:` 列表里 `id` 匹配的条目。
/// 返回条目跨度；锚点/注释/其他 provider 均原样跳过。
fn locate_model(lines: &[Line<'_>], provider: &str, id: &str) -> Result<ModelSpan, AppError> {
    // 1) 顶层 `providers:` 块。
    let mut providers_indent = None;
    let mut providers_line = None;
    for (index, line) in lines.iter().enumerate() {
        if let Some((key, value)) = parse_key_line(line.content) {
            if indent_of(line.content) == 0 && key == "providers" && value.is_empty() {
                providers_indent = Some(0);
                providers_line = Some(index);
                break;
            }
        }
    }
    let providers_line = providers_line.ok_or_else(|| manual_edit("未找到 providers 配置块"))?;
    let _ = providers_indent;

    // 2) provider 键：缩进大于 0、小于等于其后 models 块；同级键出现即结束。
    let mut provider_indent = None;
    let mut provider_count = 0;
    let mut provider_line = None;
    for (index, line) in lines.iter().enumerate().skip(providers_line + 1) {
        let indent = indent_of(line.content);
        if indent == 0 {
            if parse_key_line(line.content).is_some() {
                break;
            }
            continue;
        }
        let Some((key, _)) = parse_key_line(line.content) else {
            continue;
        };
        match provider_indent {
            None => {
                // 第一个 provider 键确立缩进；同名计数用于判重。
                if key == provider {
                    provider_indent = Some(indent);
                    provider_count = 1;
                    provider_line = Some(index);
                } else if indent == provider_indent.unwrap_or(indent) {
                    // 首个非目标键：仍需确立缩进以便判重（取首键缩进）。
                    provider_indent = Some(indent);
                }
            }
            Some(expected) => {
                if indent < expected {
                    continue;
                }
                if indent == expected && key == provider {
                    provider_count += 1;
                    if provider_count == 1 {
                        provider_line = Some(index);
                    }
                }
            }
        }
    }
    if provider_count > 1 {
        return Err(manual_edit(
            format!("provider {provider} 在文件中出现多次").as_str(),
        ));
    }
    let provider_line = provider_line.ok_or_else(|| invalid("未找到指定的 provider"))?;
    let provider_indent =
        provider_indent.unwrap_or_else(|| indent_of(lines[provider_line].content));

    // 3) provider 块内的 `models:`（缩进大于 provider）；同级第二个 models → 手动改。
    let mut models_line = None;
    let mut models_indent_found = None;
    let mut scan = provider_line + 1;
    while scan < lines.len() {
        let line = &lines[scan];
        let indent = indent_of(line.content);
        if let Some((key, value)) = parse_key_line(line.content) {
            if indent <= provider_indent {
                break;
            }
            if indent > provider_indent && key == "models" && value.is_empty() {
                match models_line {
                    None => {
                        models_line = Some(scan);
                        models_indent_found = Some(indent);
                    }
                    Some(_) if Some(indent) == models_indent_found => {
                        return Err(manual_edit("该 provider 下 models 出现多次"));
                    }
                    Some(_) => {}
                }
            }
        }
        scan += 1;
    }
    let models_line = models_line.ok_or_else(|| manual_edit("该 provider 下未找到 models 列表"))?;
    let models_indent = indent_of(lines[models_line].content);

    // 4) 条目：缩进大于 models 的 `- ` 项；首个缩进<=models 的键行结束列表。
    // 先收集条目跨度，再逐条目按直接子字段缩进找 id（嵌套 id 永不匹配）。
    struct RawItem {
        start: usize,
        head: HeadKey,
        end: usize,
    }
    let mut items: Vec<RawItem> = Vec::new();
    let mut item_indent: Option<usize> = None;
    let mut current: Option<(usize, HeadKey)> = None;
    let mut index = models_line + 1;
    // 纯别名条目不占 current，但它的行归属上一条目跨度无关紧要（跨度只用于读 id）。
    let mut index_end = lines.len();
    while index < lines.len() {
        let line = &lines[index];
        let indent = indent_of(line.content);
        if let Some((head_indent, rest)) = item_head(line.content) {
            // 零额外缩进序列（`models:` 后横线与其同列）是合法 YAML。
            // 首项确立条目缩进；之后同条目缩进的横线（即使恰在 models 列）即新条目，
            // 只有浅于条目与 models 二者之浅者才是外来 dedent。混入的深缩进横线
            // （嵌套列表）仍由下方的 item_indent 不一致分支归入当前条目。
            if head_indent < item_indent.unwrap_or(models_indent).min(models_indent) {
                index_end = index;
                break;
            }
            if item_indent.is_none() {
                item_indent = Some(head_indent);
            }
            if Some(head_indent) != item_indent {
                // 缩进不一致的横线：可能是嵌套列表，归入当前条目。
                index += 1;
                continue;
            }
            if let Some((start, head)) = current.take() {
                items.push(RawItem {
                    start,
                    head,
                    end: index - 1,
                });
            }
            let rest_trimmed = rest.trim();
            if rest_trimmed.starts_with('{') {
                return Err(manual_edit("models 列表含行内对象写法（- {…}）"));
            }
            // 纯别名条目（`- *name`）：形状合法但无本地 id，不可编辑，跳过。
            if rest_trimmed.starts_with('*') {
                current = None;
                index += 1;
                continue;
            }
            let head = head_key_of(rest);
            // 首行非空但解析不出键（`- &` 残缺等复杂写法）→ 拒绝。
            if !rest_trimmed.is_empty() && head.is_none() && !rest_trimmed.starts_with('&') {
                return Err(manual_edit("models 列表含无法识别的条目写法"));
            }
            if head.is_none()
                && rest_trimmed.starts_with('&')
                && rest
                    .trim_start_matches([' ', '\t'])
                    .strip_prefix('&')
                    .is_some_and(|after| {
                        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
                        let anchor = parts.next().unwrap_or("");
                        let key_part = parts.next().unwrap_or("").trim_start();
                        anchor.is_empty()
                            || (!key_part.is_empty() && parse_key_line(key_part).is_none())
                    })
            {
                return Err(manual_edit("models 列表含无法识别的条目写法"));
            }
            current = Some((index, head));
            index += 1;
            continue;
        }
        // 非横线行：缩进<=models 的键行结束列表。
        if parse_key_line(line.content).is_some() && indent <= models_indent {
            index_end = index;
            break;
        }
        index += 1;
    }
    if let Some((start, head)) = current {
        items.push(RawItem {
            start,
            head,
            end: index_end.saturating_sub(1),
        });
    }
    // 逐条目收集直接子 id：首行内联 id + 与字段缩进同列的续行 id。
    // 同一条目两个不同顶层 id → 手动改；嵌套 id 永不参与匹配。
    let mut matches: Vec<ItemMatch> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut duplicate_target = false;
    for item in &items {
        let item_end = item.end.min(lines.len().saturating_sub(1));
        let field_indent = item_field_indent(lines, item.start, item_end);
        let mut found: Option<String> = None;
        let mut second: Option<String> = None;
        let mut conflict = false;
        if let Some((key, value)) = &item.head {
            if key == "id" {
                found = Some(normalize_id_value(value));
            }
        }
        let mut scan = item.start + 1;
        let mut skip_until: usize = 0;
        while scan <= item_end {
            if scan <= skip_until {
                scan += 1;
                continue;
            }
            let line = &lines[scan];
            if let Some((key, value)) = parse_key_line(line.content) {
                let indent = indent_of(line.content);
                if is_block_scalar_value(value) {
                    skip_until = block_scalar_end(lines, scan, item_end, indent);
                }
                if indent == field_indent && key == "id" {
                    let value = normalize_id_value(value);
                    match &found {
                        None => found = Some(value),
                        Some(first) if *first == value => {}
                        Some(_) => {
                            second = Some(value);
                            conflict = true;
                            break;
                        }
                    }
                }
            }
            scan += 1;
        }
        if conflict {
            // 首行与续行各一个不同的顶层 id：任一命中目标都无法确定，提示手动改。
            if found.as_deref() == Some(id) || second.as_deref() == Some(id) {
                return Err(manual_edit("该模型的 id 出现多次"));
            }
            continue;
        }
        if let Some(value) = found {
            if value == id {
                matches.push((item.start, item.head.clone(), item_end));
            }
            if !seen_ids.insert(value.clone()) && value == id {
                duplicate_target = true;
            }
        }
    }
    // （跨度在上一步已收尾；此处直接判重。）
    if duplicate_target || matches.len() > 1 {
        return Err(manual_edit(
            format!("模型 {provider}/{id} 在文件中出现多次").as_str(),
        ));
    }
    let (item_line, head_key, end_line) = matches
        .into_iter()
        .next()
        .ok_or_else(|| invalid("未找到指定的模型"))?;
    let field_indent = item_field_indent(lines, item_line, end_line);
    Ok(ModelSpan {
        item_line,
        head_key,
        end_line,
        field_indent,
    })
}

/// 从条目跨度内提取规格字段（只读非凭据键；其余键忽略）。
fn read_spec(lines: &[Line<'_>], span: &ModelSpan, provider: &str, id: &str) -> ModelSpec {
    let mut name = None;
    let mut context_window = None;
    let mut max_tokens = None;
    let mut reasoning = None;
    let mut input = None;
    let mut cost_input = None;
    let mut cost_output = None;
    let mut cost_cache_read = None;
    let mut cost_cache_write = None;

    let mut cost_indent: Option<usize> = None;
    let mut cost_child_indent: Option<usize> = None;
    // （行号，缩进，键，值）：行号用于块序列 input 体解析。
    let mut fields: Vec<(usize, usize, String, String)> = Vec::new();
    if let Some((key, value)) = &span.head_key {
        fields.push((
            span.item_line,
            span.field_indent,
            key.clone(),
            value.clone(),
        ));
    }
    let mut skip_until: usize = 0;
    for (line_no, line) in lines
        .iter()
        .enumerate()
        .take(span.end_line + 1)
        .skip(span.item_line + 1)
    {
        if line_no <= skip_until {
            continue;
        }
        if let Some((key, value)) = parse_key_line(line.content) {
            let indent = indent_of(line.content);
            if is_block_scalar_value(value) {
                skip_until = block_scalar_end(lines, line_no, span.end_line, indent);
            }
            fields.push((line_no, indent, key, value.to_owned()));
        }
    }
    let mut cost_tiered = false;
    for (line_no, indent, key, value) in &fields {
        if let Some(cost_at) = cost_indent {
            if *indent > cost_at {
                // cost 子键只收首个子缩进同列的行；更深嵌套（如 longContext 体）
                // 说明是分层价：整块标 tiered，后续不再收任何价。
                match cost_child_indent {
                    None => {
                        cost_child_indent = Some(*indent);
                    }
                    Some(child) if *indent != child => {
                        cost_tiered = true;
                        continue;
                    }
                    _ => {}
                }
                // 子键值为空/标签/行内映射 → 嵌套映射头，同样标 tiered。
                if value.is_empty() || value.starts_with('!') || value.starts_with('{') {
                    cost_tiered = true;
                    continue;
                }
                match key.as_str() {
                    "input" => cost_input = parse_cost_value(value),
                    "output" => cost_output = parse_cost_value(value),
                    "cacheRead" => cost_cache_read = parse_cost_value(value),
                    "cacheWrite" => cost_cache_write = parse_cost_value(value),
                    _ => {}
                }
                continue;
            }
            cost_indent = None;
            cost_child_indent = None;
        }
        // 只认直接子字段（与条目字段缩进同列）；嵌套键视为不透明。
        // 首行内联键已按字段缩进压入，不受此限。
        if *indent != span.field_indent {
            continue;
        }
        match key.as_str() {
            "name" => name = Some(unquote(value)),
            "contextWindow" => context_window = parse_u64_value(value),
            "maxTokens" => max_tokens = parse_u64_value(value),
            "reasoning" => reasoning = parse_bool_value(value),
            "input" => {
                // 流式 `[a, b]` 优先；空值头 + 块序列子行则读块序列。
                if let Some(items) = parse_input_value(value) {
                    input = Some(items);
                } else if value.is_empty() {
                    let items = parse_block_sequence_input(lines, *line_no, span.end_line);
                    if !items.is_empty() {
                        input = Some(items);
                    }
                }
            }
            "cost" if value.is_empty() || value.starts_with('&') => cost_indent = Some(*indent),
            _ => {}
        }
    }
    // 分层价：四费用一律 None，只留标记（绝不把层级价当基准价报）。
    if cost_tiered {
        cost_input = None;
        cost_output = None;
        cost_cache_read = None;
        cost_cache_write = None;
    }

    ModelSpec {
        provider: provider.to_owned(),
        id: id.to_owned(),
        selector: format!("{provider}/{id}"),
        name,
        context_window,
        max_tokens,
        reasoning,
        input,
        cost_input,
        cost_output,
        cost_cache_read,
        cost_cache_write,
        cost_tiered,
    }
}

/// 读出全文件所有模型的规格（`get_model_specs` 用；形状异常的 provider 跳过）。
fn read_all_specs(text: &str, validate: bool) -> Result<Vec<ModelSpec>, AppError> {
    let lines = split_lines(text);
    // 复用定位逻辑：先找 providers 块，再枚举各 provider 的 models 列表。
    let mut providers_line = None;
    for (index, line) in lines.iter().enumerate() {
        if let Some((key, value)) = parse_key_line(line.content) {
            if indent_of(line.content) == 0 && key == "providers" && value.is_empty() {
                providers_line = Some(index);
                break;
            }
        }
    }
    let Some(providers_line) = providers_line else {
        if validate {
            return Err(manual_edit("未找到 providers 配置块"));
        }
        return Ok(Vec::new());
    };
    // 收集 provider 键（首个缩进确立同级）。
    let mut provider_indent: Option<usize> = None;
    let mut providers: Vec<(String, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate().skip(providers_line + 1) {
        let Some((key, _)) = parse_key_line(line.content) else {
            continue;
        };
        let indent = indent_of(line.content);
        if indent == 0 {
            break;
        }
        match provider_indent {
            None => {
                provider_indent = Some(indent);
                providers.push((key, index));
            }
            Some(expected) => {
                if indent < expected {
                    continue;
                }
                if indent == expected {
                    providers.push((key, index));
                }
            }
        }
    }
    let mut specs = Vec::new();
    for (provider, provider_line) in &providers {
        let provider_indent = indent_of(lines[*provider_line].content);
        let mut models_line = None;
        let mut scan = provider_line + 1;
        while scan < lines.len() {
            let line = &lines[scan];
            if let Some((key, value)) = parse_key_line(line.content) {
                let indent = indent_of(line.content);
                if indent <= provider_indent {
                    break;
                }
                if key == "models" && value.is_empty() {
                    models_line = Some(scan);
                    break;
                }
            }
            scan += 1;
        }
        let Some(models_line) = models_line else {
            continue;
        };
        let models_indent = indent_of(lines[models_line].content);
        // 枚举条目跨度并逐个读 id。
        let mut item_indent: Option<usize> = None;
        let mut item_starts: Vec<usize> = Vec::new();
        let mut index = models_line + 1;
        let mut list_end = models_line;
        while index < lines.len() {
            let line = &lines[index];
            if let Some((head_indent, rest)) = item_head(line.content) {
                // 零额外缩进序列首项接受（合法 YAML）；首项确立条目缩进后同列即新条目，
                // 只有浅于条目与 models 二者之浅者才结束列表。
                if head_indent < item_indent.unwrap_or(models_indent).min(models_indent) {
                    break;
                }
                if item_indent.is_none() {
                    item_indent = Some(head_indent);
                }
                if Some(head_indent) == item_indent {
                    let trimmed = rest.trim();
                    if trimmed.starts_with('{') {
                        if validate {
                            return Err(manual_edit("models 列表含行内对象写法（- {…}）"));
                        }
                        // 宽容读：跳过该流式项，继续收后项（不隐藏整 provider）。
                        list_end = index;
                        index += 1;
                        continue;
                    }
                    // 纯别名条目（`- *name`）无本地字段，读侧跳过。
                    if !trimmed.starts_with('*') {
                        item_starts.push(index);
                    }
                }
                list_end = index;
                index += 1;
                continue;
            }
            if let Some((_, _)) = parse_key_line(line.content) {
                if indent_of(line.content) <= models_indent {
                    break;
                }
            }
            list_end = index;
            index += 1;
        }
        for (position, start) in item_starts.iter().enumerate() {
            let end = item_starts
                .get(position + 1)
                .map(|next| next - 1)
                .unwrap_or(list_end);
            let head_key = item_head(lines[*start].content).and_then(|(_, rest)| head_key_of(rest));
            let span = ModelSpan {
                item_line: *start,
                head_key,
                end_line: end,
                field_indent: item_field_indent(&lines, *start, end),
            };
            // 只认直接子 id（首行内联 + 同列续行）；嵌套 id 永不匹配。
            let mut found = String::new();
            if let Some((key, value)) = &span.head_key {
                if key == "id" {
                    found = normalize_id_value(value);
                }
            }
            if found.is_empty() {
                let mut skip_until: usize = 0;
                for (line_no, line) in lines.iter().enumerate().take(end + 1).skip(start + 1) {
                    if line_no <= skip_until {
                        continue;
                    }
                    if let Some((key, value)) = parse_key_line(line.content) {
                        let indent = indent_of(line.content);
                        if is_block_scalar_value(value) {
                            skip_until = block_scalar_end(&lines, line_no, end, indent);
                        }
                        if indent == span.field_indent && key == "id" {
                            found = normalize_id_value(value);
                            break;
                        }
                    }
                }
            }
            // id 缺失的条目跳过（omp 会 fail-closed，但读侧宽容）。
            if found.is_empty() {
                continue;
            }
            let mut spec = read_spec(&lines, &span, provider, &found);
            spec.id = found.clone();
            spec.selector = format!("{provider}/{found}");
            specs.push(spec);
        }
    }
    Ok(specs)
}

fn parse_u64_value(raw: &str) -> Option<u64> {
    let value = unquote(raw);
    if value.is_empty() {
        return None;
    }
    value.parse::<u64>().ok()
}

fn parse_bool_value(raw: &str) -> Option<bool> {
    match unquote(raw).as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// `input` 支持行内 `[text, image]`（含引号变体）与空值。
fn parse_input_value(raw: &str) -> Option<Vec<String>> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let inner = value.strip_prefix('[')?.strip_suffix(']')?;
    let mut items = Vec::new();
    for part in inner.split(',') {
        let item = unquote(part.trim());
        if item.is_empty() {
            continue;
        }
        items.push(item);
    }
    Some(items)
}

fn parse_cost_value(raw: &str) -> Option<f64> {
    let value = unquote(raw);
    if value.is_empty() {
        return None;
    }
    value.parse::<f64>().ok().filter(|v| v.is_finite())
}

// ---------------------------------------------------------------------------
// 补丁校验与格式化
// ---------------------------------------------------------------------------

/// 校验补丁值（正数/有限数/白名单 input）；错误绝不回显文件内容。
fn validate_patch(patch: &ModelSpecPatch) -> Result<(), AppError> {
    // omp/JSON 数字经 f64：超 2^53 精度丢失，写前直接拒。
    const MAX_SAFE_INT: u64 = (1 << 53) - 1;
    if let Some(name) = &patch.name {
        if name.trim().is_empty() {
            return Err(invalid("模型名称不能为空"));
        }
        if name.chars().count() > 200 {
            return Err(invalid("模型名称过长（最多 200 个字符）"));
        }
        if name.contains(['\n', '\r']) {
            return Err(invalid("模型名称不能换行"));
        }
        // 控制字符（含 NUL/制表符）与 YAML 换行符一律拒（写进引号也危险）。
        if name
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{0085}'))
        {
            return Err(invalid("模型名称包含非法字符"));
        }
    }
    if let Some(window) = patch.context_window {
        if window == 0 {
            return Err(invalid("上下文窗口必须大于 0"));
        }
        if window > MAX_SAFE_INT {
            return Err(invalid("上下文窗口过大（最多 2^53-1）"));
        }
    }
    if let Some(tokens) = patch.max_tokens {
        if tokens == 0 {
            return Err(invalid("最大输出必须大于 0"));
        }
        if tokens > MAX_SAFE_INT {
            return Err(invalid("最大输出过大（最多 2^53-1）"));
        }
    }
    if let Some(input) = &patch.input {
        if input.is_empty() {
            return Err(invalid("输入类型不能为空"));
        }
        if input.len() > 8 {
            return Err(invalid("输入类型过多（最多 8 个）"));
        }
        let mut seen = std::collections::HashSet::new();
        for item in input {
            if item != "text" && item != "image" {
                return Err(invalid(format!("不支持的输入类型：{item}")));
            }
            if !seen.insert(item) {
                return Err(invalid("输入类型不能重复"));
            }
        }
    }
    if let Some(cost) = &patch.cost {
        for (label, value) in [
            ("输入价格", cost.input),
            ("输出价格", cost.output),
            ("缓存读取价格", cost.cache_read),
            ("缓存写入价格", cost.cache_write),
        ] {
            if !value.is_finite() || value < 0.0 || value > 1e9 {
                return Err(invalid(format!("{label}必须是非负有限数")));
            }
            // 非零值若格式化成 "0"（精度 < 1e-6），写后沙箱必 mismatch：提前拒。
            if value != 0.0 && format_cost(value) == "0" {
                return Err(invalid(format!("{label}过小，精度不足")));
            }
        }
    }
    Ok(())
}

/// 校验 provider/id 定位键（非空、无换行、无 `/` 歧义）。
fn validate_target(provider: &str, id: &str) -> Result<(), AppError> {
    for (label, value) in [("provider", provider), ("模型 id", id)] {
        if value.trim().is_empty() {
            return Err(invalid(format!("{label}不能为空")));
        }
        if value.chars().count() > 200 {
            return Err(invalid(format!("{label}过长（最多 200 个字符）")));
        }
        if value.contains(['\n', '\r']) {
            return Err(invalid(format!("{label}不能换行")));
        }
    }
    if provider.contains('/') || id.contains('/') {
        return Err(invalid("provider 与模型 id 不能包含 /"));
    }
    Ok(())
}

/// name 双引号转义（`\\` 与 `"`）。
fn quote_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    out.push('"');
    for c in name.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 费用数字：最多 6 位小数，去尾零（`0.300000` → `0.3`，`0` → `0`）。
fn format_cost(value: f64) -> String {
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    let mut text = format!("{rounded:.6}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    if text == "-0" {
        text = "0".to_owned();
    }
    text
}

fn format_input(items: &[String]) -> String {
    format!("[{}]", items.join(", "))
}

// ---------------------------------------------------------------------------
// 行级补丁应用（纯函数）
// ---------------------------------------------------------------------------

/// 块标量头判定：`parse_key_line` 已去注释，值段形如 `|`/`>`/`|-`/`>+`/`|2`。
fn is_block_scalar_value(value: &str) -> bool {
    let value = value.trim();
    let mut chars = value.chars();
    match chars.next() {
        Some('|') | Some('>') => {}
        _ => return false,
    }
    let rest = &value[1..];
    let rest = rest.strip_prefix(['+', '-']).unwrap_or(rest);
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    rest.trim().is_empty()
}

/// 列表项行判定（`- ` / `-` / `-\t`，去掉前导空格后看）。
fn is_sequence_item(content: &str) -> bool {
    let trimmed = content.trim_start_matches(' ');
    trimmed == "-" || trimmed.starts_with("- ") || trimmed.starts_with("-\t")
}

/// 块序列子行收集：从 `header + 1` 起，连续的序列项行（缩进大于头缩进，
/// 或与头同列的零缩进 `- ` 行）都归属该头；夹在序列项之间的注释/空行
/// 一并归属（删头时同删，避免悬空）。
fn block_sequence_children(
    lines: &[Line<'_>],
    header: usize,
    end_line: usize,
    header_indent: usize,
) -> Vec<usize> {
    let mut owned = Vec::new();
    let mut pending_blank: Vec<usize> = Vec::new();
    let mut index = header + 1;
    let limit = end_line.min(lines.len().saturating_sub(1));
    while index <= limit {
        let content = lines[index].content;
        let trimmed = content.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            pending_blank.push(index);
            index += 1;
            continue;
        }
        let indent = indent_of(content);
        if is_sequence_item(content) && indent >= header_indent {
            owned.append(&mut pending_blank);
            owned.push(index);
            index += 1;
            continue;
        }
        break;
    }
    owned
}

/// 块标量体跳过：从 `header + 1` 起，缩进大于头缩进的行与空行都属标量体。
/// 返回体末行下标（含）；无体返回 `header`。
fn block_scalar_end(
    lines: &[Line<'_>],
    header: usize,
    end_line: usize,
    header_indent: usize,
) -> usize {
    let mut last = header;
    let mut index = header + 1;
    let limit = end_line.min(lines.len().saturating_sub(1));
    while index <= limit {
        let content = lines[index].content;
        if content.trim().is_empty() {
            last = index;
            index += 1;
            continue;
        }
        if indent_of(content) > header_indent {
            last = index;
            index += 1;
            continue;
        }
        break;
    }
    last
}

/// 块序列 `input` 体解析：`input:` 空值头 + 后续子行 `- text`/`- image`。
/// 子项去引号；复杂项跳过。
fn parse_block_sequence_input(lines: &[Line<'_>], header: usize, end_line: usize) -> Vec<String> {
    let header_indent = indent_of(lines[header].content);
    let mut items = Vec::new();
    for child in block_sequence_children(lines, header, end_line, header_indent) {
        let content = lines[child].content;
        let trimmed = content.trim_start_matches(' ');
        let rest = trimmed
            .strip_prefix('-')
            .unwrap_or(trimmed)
            .trim_start_matches([' ', '\t']);
        let rest = strip_comment(rest).trim();
        if rest.is_empty() {
            continue;
        }
        // `- {…}` 等复杂项：只取纯标量。
        if rest.starts_with('{') || rest.starts_with('[') || rest.starts_with('*') {
            continue;
        }
        let item = unquote(rest);
        if !item.is_empty() {
            items.push(item);
        }
    }
    items
}

/// 替换行内 `key:` 后的值段（保留缩进、键原文、行尾注释与换行）。
/// 返回新行 content（不含换行）。
fn replace_value(content: &str, key_end: usize, new_value: &str) -> String {
    // key_end 为 `:` 在 content 中的字节下标。
    let (head, after) = content.split_at(key_end + 1);
    // after = ` 旧值 # 注释`：找到注释起点（`#` 前有空白、引号外）。
    let bytes = after.as_bytes();
    let mut quote: Option<u8> = None;
    let mut index = 0;
    let mut comment_at = None;
    while index < bytes.len() {
        let byte = bytes[index];
        match quote {
            Some(q) => {
                if byte == q {
                    if q == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        quote = None;
                    }
                } else if q == b'"' && byte == b'\\' {
                    index += 1;
                }
            }
            None => {
                if byte == b'"' || byte == b'\'' {
                    quote = Some(byte);
                } else if byte == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
                    comment_at = Some(index);
                    break;
                }
            }
        }
        index += 1;
    }
    let mut out = String::with_capacity(content.len() + new_value.len());
    out.push_str(head);
    out.push(' ');
    out.push_str(new_value);
    if let Some(at) = comment_at {
        // 保留注释前的空白（至少一空格）与注释原文。
        let comment = &after[at..];
        let gap = &after[..at];
        let spaces = gap.len() - gap.trim_end().len();
        for _ in 0..spaces.max(1) {
            out.push(' ');
        }
        out.push_str(comment.trim_end());
    }
    out
}

/// 在 content 中找顶层 `key:` 的 `:` 下标（与 `parse_key_line` 同规则）。
fn key_colon(content: &str) -> Option<usize> {
    let trimmed = content.trim_start_matches(' ');
    let base = content.len() - trimmed.len();
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let quote = trimmed.as_bytes()[0];
        let bytes = trimmed.as_bytes();
        let mut index = 1;
        while index < bytes.len() {
            if bytes[index] == quote {
                if quote == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                let after = &trimmed[index + 1..];
                let spaces = after.len() - after.trim_start_matches(' ').len();
                if after[spaces..].starts_with(':') {
                    return Some(base + index + 1 + spaces);
                }
                return None;
            }
            if quote == b'"' && bytes[index] == b'\\' {
                index += 1;
            }
            index += 1;
        }
        return None;
    }
    let colon = trimmed.find(':')?;
    Some(base + colon)
}

/// 首行 `- ` 内联字段的 `:` 下标（content 内字节下标；`- &anchor` 前缀先剥掉）。
fn head_colon(content: &str, dash_indent: usize) -> Option<usize> {
    let after_dash = content
        .get(dash_indent + 1..)?
        .trim_start_matches([' ', '\t']);
    let key_part = after_dash.strip_prefix('&').and_then(|after| {
        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
        if parts.next().unwrap_or("").is_empty() {
            return None;
        }
        Some(parts.next().unwrap_or("").trim_start())
    });
    match key_part {
        Some("") | None if after_dash.trim_start().starts_with('&') => {
            // `- &name` bare 头：内联无键，不应走到替换。
            None
        }
        Some(part) => {
            let base = content.len() - after_dash.len() + (after_dash.len() - part.len());
            key_colon(part).map(|colon| base + colon)
        }
        None => {
            let base = content.len() - after_dash.len();
            key_colon(after_dash).map(|colon| base + colon)
        }
    }
}

/// 锚名字符集（YAML 子集）：字母数字 + `_-.:%` + 非 ASCII。
fn is_anchor_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '%' | '/')
}

/// 从 `&...` 后取锚名（到首个非锚字符止）。
fn anchor_name_of(after: &str) -> String {
    after.chars().take_while(|c| is_anchor_char(*c)).collect()
}

/// 行内别名引用扫描：`*name` 完整名比对（`code` 已去注释；遇引号内疑似
/// 别名仍按引用算，fail-closed）。
fn line_references_alias(code: &str, anchor: &str) -> bool {
    let bytes = code.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'*' {
            index += 1;
            continue;
        }
        let rest = &code[index + 1..];
        let name: String = rest.chars().take_while(|c| is_anchor_char(*c)).collect();
        if name == anchor {
            return true;
        }
        index += 1;
    }
    false
}

/// 目标条目锚引用检查：条目首行 `- &name` 或条目内 `cost: &name` 定义的锚，
/// 若正文他处出现 `*name` 引用则拒绝（改锚会静默波及引用者）。
fn reject_aliased_target(lines: &[Line<'_>], span: &ModelSpan) -> Result<(), AppError> {
    let mut anchors: Vec<String> = Vec::new();
    if let Some((_, rest)) = item_head(lines[span.item_line].content) {
        if let Some(after) = rest.trim_start_matches([' ', '\t']).strip_prefix('&') {
            let name = anchor_name_of(after);
            if !name.is_empty() {
                anchors.push(name);
            }
        }
    }
    for line in lines.iter().take(span.end_line + 1).skip(span.item_line) {
        if let Some((key, value)) = parse_key_line(line.content) {
            if key == "cost" && value.starts_with('&') {
                let name = anchor_name_of(&value[1..]);
                if !name.is_empty() {
                    anchors.push(name);
                }
            }
        }
    }
    if anchors.is_empty() {
        return Ok(());
    }
    for (index, line) in lines.iter().enumerate() {
        if index >= span.item_line && index <= span.end_line {
            continue;
        }
        let code = strip_comment(line.content);
        for anchor in &anchors {
            if line_references_alias(code, anchor) {
                return Err(manual_edit(
                    format!("该模型被别名 *{anchor} 引用，改它会影响其他条目").as_str(),
                ));
            }
        }
    }
    Ok(())
}

/// 对单个模型条目应用补丁，返回新全文。
/// 只替换已存在的标量行或在 `- ` 行后插入缺失字段；其余字节不动。
fn apply_patch_to_text(
    text: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
) -> Result<String, AppError> {
    let lines = split_lines(text);
    let span = locate_model(&lines, provider, id)?;
    // 别名引用检查：目标条目若定义了锚（`- &name` / `cost: &name`）且正文中有
    // `*name` 引用，改它会静默波及其他引用者 → 拒绝，请手动改。
    reject_aliased_target(&lines, &span)?;
    struct FieldRow {
        line: usize,
        key: String,
        head: bool,
    }
    let mut rows: Vec<FieldRow> = Vec::new();
    if let Some((key, _)) = &span.head_key {
        rows.push(FieldRow {
            line: span.item_line,
            key: key.clone(),
            head: true,
        });
    }
    // cost 块范围（行号区间）与子键行。
    let mut cost_block: Option<(usize, usize)> = None;
    let mut cost_rows: Vec<FieldRow> = Vec::new();
    let mut cost_indent: Option<usize> = None;
    let mut cost_child_indent: Option<usize> = None;
    let mut cost_header_line: Option<usize> = None;
    let mut skip_until: usize = 0;
    for (offset, line) in lines
        .iter()
        .enumerate()
        .take(span.end_line + 1)
        .skip(span.item_line + 1)
    {
        let line_no = offset;
        // 块标量体行：跳过（永不解析为字段）。
        if line_no <= skip_until {
            continue;
        }
        let content = line.content;
        let Some((key, value)) = parse_key_line(content) else {
            continue;
        };
        let indent = indent_of(content);
        // 块标量头：记体末行，后续体行跳过。
        if is_block_scalar_value(value) {
            skip_until = block_scalar_end(&lines, line_no, span.end_line, indent);
        }
        if let Some(cost_at) = cost_indent {
            if indent > cost_at {
                // cost 子键只收首个子缩进同列的行；更深嵌套/空值子头
                // 说明是分层价：整模型拒改（连非 cost 补丁也拒，保持可预测）。
                match cost_child_indent {
                    None => {
                        cost_child_indent = Some(indent);
                    }
                    Some(child) if indent != child => {
                        return Err(invalid(
                            "该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml",
                        ));
                    }
                    _ => {}
                }
                if value.is_empty() || value.starts_with('!') || value.starts_with('{') {
                    return Err(invalid(
                        "该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml",
                    ));
                }
                cost_rows.push(FieldRow {
                    line: line_no,
                    key,
                    head: false,
                });
                continue;
            }
            let header = cost_header_line.unwrap_or(line_no);
            cost_block = Some((header, line_no - 1));
            cost_indent = None;
            cost_child_indent = None;
            cost_header_line = None;
        }
        // 只收直接子字段；嵌套键视为不透明（防错行替换）。
        if indent != span.field_indent {
            continue;
        }
        if key == "cost" && (value.is_empty() || value.starts_with('&')) {
            // `cost:` 块头（含 `cost: &anchor` 锚）；行内值另行拒绝。
            cost_indent = Some(indent);
            cost_header_line = Some(line_no);
            continue;
        }
        rows.push(FieldRow {
            line: line_no,
            key,
            head: false,
        });
    }
    if let Some(header) = cost_header_line {
        cost_block = Some((header, span.end_line));
    }
    // cost 行内写法（`cost: {...}` / `cost: 1`）：不支持，提示手动改。
    // 锚头（`cost: &x`）是合法块头，不在此拒绝。
    for (line_no, line) in lines
        .iter()
        .enumerate()
        .take(span.end_line + 1)
        .skip(span.item_line + 1)
    {
        // 只看直接子 cost 头；嵌套 cost（如 compat 下）与本条目 cost 无关。
        if indent_of(line.content) != span.field_indent {
            continue;
        }
        if let Some((key, value)) = parse_key_line(line.content) {
            if key == "cost"
                && !value.is_empty()
                && !value.starts_with('&')
                && cost_header_line.is_none_or(|header| header != line_no)
            {
                return Err(manual_edit("该模型的 cost 不是块写法"));
            }
        }
    }
    if let Some((key, _)) = &span.head_key {
        if key == "cost" {
            return Err(manual_edit("该模型的 cost 不是块写法"));
        }
    }

    // 简单字段：(键, 新值)。有行则替换，无行则插入。
    let mut simple: Vec<(&str, String)> = Vec::new();
    if let Some(name) = &patch.name {
        simple.push(("name", quote_name(name)));
    }
    if let Some(window) = patch.context_window {
        simple.push(("contextWindow", window.to_string()));
    }
    if let Some(tokens) = patch.max_tokens {
        simple.push(("maxTokens", tokens.to_string()));
    }
    if let Some(reasoning) = patch.reasoning {
        simple.push(("reasoning", reasoning.to_string()));
    }
    if let Some(input) = &patch.input {
        simple.push(("input", format_input(input)));
    }

    // 新行数组（content 可变，换行保留）。
    let mut contents: Vec<String> = lines.iter().map(|line| line.content.to_owned()).collect();
    let newlines: Vec<&str> = lines.iter().map(|line| line.newline).collect();
    // 条目内同键重复（脏文件）→ 提示手动改。
    let mut seen_simple = std::collections::HashSet::new();
    for row in &rows {
        if ["name", "contextWindow", "maxTokens", "reasoning", "input"].contains(&row.key.as_str())
            && !seen_simple.insert(row.key.clone())
        {
            return Err(manual_edit(
                format!("该模型的 {} 出现多次", row.key).as_str(),
            ));
        }
    }
    let mut seen_cost = std::collections::HashSet::new();
    for row in &cost_rows {
        if ["input", "output", "cacheRead", "cacheWrite"].contains(&row.key.as_str())
            && !seen_cost.insert(row.key.clone())
        {
            return Err(manual_edit(
                format!("该模型的 cost.{} 出现多次", row.key).as_str(),
            ));
        }
    }

    // 替换简单字段：先判现有值形状。
    // 标量/流式 → 原地替换；块序列 input → 头改流式 + 删子行；
    // 块标量或其他非标量形 → 手动改（绝不悬空体）。
    let mut remove_lines: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut need_insert: Vec<(&str, String)> = Vec::new();
    for (key, value) in &simple {
        let mut found = None;
        for row in &rows {
            if &row.key == key {
                found = Some(row);
                break;
            }
        }
        if let Some(row) = found {
            if row.head {
                // 首行内联值必为单行标量/流式：原地替换。
                let dash = indent_of(&contents[row.line]);
                let colon = head_colon(&contents[row.line], dash)
                    .ok_or_else(|| manual_edit("该模型的条目首行无法识别"))?;
                contents[row.line] = replace_value(&contents[row.line].clone(), colon, value);
                continue;
            }
            let content = contents[row.line].clone();
            let (_, old_value) =
                parse_key_line(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
            if is_block_scalar_value(old_value) {
                return Err(manual_edit(format!("该模型的 {key} 是多行文本").as_str()));
            }
            if old_value.is_empty() {
                // 空值头：input 允许块序列（改头 + 删子行），其余键看后继形状。
                let header_indent = indent_of(&content);
                let children =
                    block_sequence_children(&lines, row.line, span.end_line, header_indent);
                if *key == "input" && !children.is_empty() {
                    let colon =
                        key_colon(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
                    contents[row.line] = replace_value(&content, colon, value);
                    remove_lines.extend(children);
                    continue;
                }
                if children.is_empty() {
                    // 空值且无块序列子行：后继若有更深缩进的键行，
                    // 说明是映射块头而非标量 → 手动改。
                    let mut scan = row.line + 1;
                    let limit = span.end_line.min(lines.len().saturating_sub(1));
                    let mut is_map = false;
                    while scan <= limit {
                        let next = lines[scan].content;
                        if next.trim().is_empty() {
                            scan += 1;
                            continue;
                        }
                        if indent_of(next) > header_indent && parse_key_line(next).is_some() {
                            is_map = true;
                        }
                        break;
                    }
                    if is_map {
                        return Err(manual_edit(format!("该模型的 {key} 不是单行写法").as_str()));
                    }
                    let colon =
                        key_colon(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
                    contents[row.line] = replace_value(&content, colon, value);
                    continue;
                }
                // 非 input 键挂着块序列子行 → 手动改。
                return Err(manual_edit(format!("该模型的 {key} 不是单行写法").as_str()));
            }
            let colon = key_colon(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
            contents[row.line] = replace_value(&content, colon, value);
        } else {
            need_insert.push((key, value.clone()));
        }
    }

    // cost 块。
    let mut need_cost_block = false;
    if let Some(cost) = &patch.cost {
        let pairs = [
            ("input", format_cost(cost.input)),
            ("output", format_cost(cost.output)),
            ("cacheRead", format_cost(cost.cache_read)),
            ("cacheWrite", format_cost(cost.cache_write)),
        ];
        if cost_block.is_some() {
            for (key, value) in &pairs {
                let mut found = None;
                for row in &cost_rows {
                    if &row.key == key {
                        found = Some(row);
                        break;
                    }
                }
                if let Some(row) = found {
                    let colon = key_colon(&contents[row.line])
                        .ok_or_else(|| manual_edit("该模型的 cost 行无法识别"))?;
                    contents[row.line] = replace_value(&contents[row.line].clone(), colon, value);
                } else {
                    // cost 块缺子键：omp fail-closed 要求四键齐全，
                    // 缺键说明文件已坏，不猜位置，提示手动修。
                    return Err(manual_edit("该模型的 cost 缺少子键"));
                }
            }
        } else {
            need_cost_block = true;
            // 插入完整四键块时，把 pairs 暂存到 need_insert 之后处理。
            for (key, value) in pairs {
                need_insert.push((
                    match key {
                        "input" => "cost.input",
                        "output" => "cost.output",
                        "cacheRead" => "cost.cacheRead",
                        _ => "cost.cacheWrite",
                    },
                    value,
                ));
            }
        }
    }

    // 插入缺失字段：紧随 `- ` 行之后（id 优先——id 行永存，
    // 故新字段插在首行之后即位于条目前部，不干扰锚点）。
    if !need_insert.is_empty() {
        let dash = indent_of(&contents[span.item_line]);
        let field_indent = " ".repeat(span.field_indent);
        let insert_at = span.item_line + 1;
        let mut insert_lines: Vec<String> = Vec::new();
        let mut cost_lines: Vec<(String, String)> = Vec::new();
        for (key, value) in &need_insert {
            if let Some(sub) = key.strip_prefix("cost.") {
                cost_lines.push((sub.to_owned(), value.clone()));
            } else {
                insert_lines.push(format!("{field_indent}{key}: {value}"));
            }
        }
        if need_cost_block {
            // cost 块缩进与普通字段同级，子键再深两格。
            insert_lines.push(format!("{field_indent}cost:"));
            let child = " ".repeat(span.field_indent + 2);
            for (sub, value) in &cost_lines {
                insert_lines.push(format!("{child}{sub}: {value}"));
            }
        }
        let _ = dash;
        // 插入行的换行符沿用 `- ` 行的换行（无换行则用 `\n`）。
        let newline = if newlines[span.item_line].is_empty() {
            "\n"
        } else {
            newlines[span.item_line]
        };
        let mut new_contents: Vec<String> = Vec::with_capacity(contents.len() + insert_lines.len());
        let mut new_newlines: Vec<&str> = Vec::with_capacity(newlines.len() + insert_lines.len());
        // 若插入点前一行原文无换行（EOF 无尾换行），先给它补上换行，
        // 否则插入行会与横线行连成一行。
        let mut fixed_newlines: Vec<&str> = newlines.clone();
        if insert_at > 0 && fixed_newlines[insert_at - 1].is_empty() {
            fixed_newlines[insert_at - 1] = newline;
        }
        for (index, content) in contents.iter().enumerate() {
            if index == insert_at {
                for line in &insert_lines {
                    new_contents.push(line.clone());
                    new_newlines.push(newline);
                }
            }
            new_contents.push(content.clone());
            new_newlines.push(fixed_newlines[index]);
        }
        if insert_at >= contents.len() {
            for line in &insert_lines {
                new_contents.push(line.clone());
                new_newlines.push(newline);
            }
        }
        let mut out = String::with_capacity(text.len() + insert_lines.join("\n").len() + 32);
        for (content, newline) in new_contents.iter().zip(new_newlines.iter()) {
            out.push_str(content);
            out.push_str(newline);
        }
        return Ok(out);
    }

    let mut out = String::with_capacity(text.len() + 64);
    for (index, (content, newline)) in contents.iter().zip(newlines.iter()).enumerate() {
        // 块序列 input 子行随头一并删除。
        if remove_lines.contains(&index) {
            continue;
        }
        out.push_str(content);
        out.push_str(newline);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 沙箱校验（真实 omp `models --json`）
// ---------------------------------------------------------------------------

/// 校验输出是否含 omp 的配置失败警告（合并输出，不区分 stdout/stderr）。
fn has_validation_warning(output: &str) -> bool {
    output.contains("validation failed") || output.contains("Failed to load config file models")
}

/// 从合并输出提取第一个 JSON 值（`omp models --json` 前可能有警告行）。
fn json_start(output: &str) -> Option<&str> {
    let mut index = 0;
    for segment in output.split_inclusive('\n') {
        if segment.starts_with('{') {
            return Some(&output[index..]);
        }
        index += segment.len();
    }
    None
}

/// 沙箱校验：新文本写入 `<tmp>/agent/models.yml`（0600），跑真实 omp
/// `models --json`（`PI_CODING_AGENT_DIR=<tmp>/agent`，60 秒，退出码忽略）。
/// 通过条件：无失败警告、JSON 里有 `provider/id`、补丁数字字段一致。
fn sandbox_validate(
    bin: &Path,
    new_text: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
) -> Result<(), AppError> {
    validate_with(bin, new_text, provider, id, patch, run_sandbox_omp)
}

/// 沙箱根目录守卫：任何路径（含 panic）都删除沙箱目录。
struct SandboxGuard {
    root: PathBuf,
}

impl Drop for SandboxGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// 可注入 omp 执行体的校验内核（单测用假 omp）。
fn validate_with(
    bin: &Path,
    new_text: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
    run: impl FnOnce(&Path, &Path) -> Result<String, AppError>,
) -> Result<(), AppError> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = std::env::temp_dir().join(format!(
        "omp-resume-specvalidate-{}-{nanos}",
        std::process::id()
    ));
    let agent_dir = root.join("agent");
    // 沙箱目录 0700：先建目录再设权限，写文件前完成。
    if let Err(error) = fs::create_dir_all(&agent_dir)
        .and_then(|()| fs::set_permissions(&root, fs::Permissions::from_mode(0o700)))
        .and_then(|()| fs::set_permissions(&agent_dir, fs::Permissions::from_mode(0o700)))
    {
        let _ = fs::remove_dir_all(&root);
        return Err(io_error(format!("无法创建校验沙箱：{error}")));
    }
    // Drop 守卫：run  panic 时同样清理（含明文副本的目录不泄漏）。
    let _guard = SandboxGuard { root: root.clone() };
    let yml = agent_dir.join(MODELS_YML_NAME);
    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&yml)?;
        file.write_all(new_text.as_bytes())?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        return Err(io_error(format!("无法写入校验沙箱：{error}")));
    }
    let output = run(bin, &agent_dir)?;
    check_sandbox_output(&output, provider, id, patch)
}

/// 真实 omp 执行：不经 shell，`PI_CODING_AGENT_DIR` 指向沙箱（不继承用户值）。
fn run_sandbox_omp(bin: &Path, agent_dir: &Path) -> Result<String, AppError> {
    // 独立进程组、合并输出、60 秒超时（语义见 `run_omp_with_env`）。
    run_omp_with_env(bin, agent_dir, CHECK_TIMEOUT)
}

/// 带 `PI_CODING_AGENT_DIR` 的 omp 调用（`run_omp` 不支持 env，故单列；不记日志）。
fn run_omp_with_env(bin: &Path, agent_dir: &Path, timeout: Duration) -> Result<String, AppError> {
    use std::io::Read;
    use std::sync::mpsc::{self, RecvTimeoutError};
    let mut path = std::ffi::OsString::from("/opt/homebrew/bin:/usr/local/bin:");
    if let Some(home) = std::env::var_os("HOME") {
        path.push(PathBuf::from(home).join(".local/bin"));
    }
    path.push(":");
    path.push(std::env::var_os("PATH").unwrap_or_default());
    path.push(":/usr/bin:/bin:/usr/sbin:/sbin");
    let mut command = if bin.is_absolute() {
        std::process::Command::new(bin)
    } else {
        std::process::Command::new(Path::new(".").join(bin))
    };
    command
        .args(["models", "--json"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("NO_COLOR", "1")
        .env("PATH", path)
        .env(PI_AGENT_DIR_ENV, agent_dir);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法启动 omp：{e}")))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // 两路 reader 线程：每路上限 8 MiB（超限停读并判失败，防恶意输出 OOM）；
    // 句柄保留，子进程收割后 join，不泄漏线程。
    const PIPE_CAP: usize = 8 * 1024 * 1024;
    let (sender, receiver) = mpsc::channel::<(Vec<u8>, bool)>();
    let mut readers = Vec::new();
    for pipe in [
        stdout.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        stderr.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ] {
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut capped = false;
            if let Some(mut pipe) = pipe {
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            let room = PIPE_CAP.saturating_sub(bytes.len());
                            if room == 0 {
                                capped = true;
                                break;
                            }
                            bytes.extend_from_slice(&chunk[..n.min(room)]);
                            if n > room {
                                capped = true;
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
            }
            let _ = sender.send((bytes, capped));
        }));
    }
    drop(sender);
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| AppError::new(ErrorCode::Io, format!("等待 omp 失败：{e}")))?
        {
            break status;
        }
        if started.elapsed() > timeout {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::new(ErrorCode::Timeout, "omp 校验超时"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let _ = status;
    // 退出码忽略：fail-closed 的配置错误也可能带非零码，看输出内容判定。
    let mut merged = String::new();
    let mut capped = false;
    // 子进程已退，管道即将关闭：最多再等 2 秒收两路输出。
    // OmpBusy 最坏持有 = 校验超时 60s + 本段 ≤2s。
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut got = 0;
    while got < 2 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok((bytes, hit_cap)) => {
                capped |= hit_cap;
                merged.push_str(&strip_ansi(&String::from_utf8_lossy(&bytes)));
                if !merged.ends_with('\n') {
                    merged.push('\n');
                }
                got += 1;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // 收割 reader 线程（子进程已退，读端会结束；join 不再阻塞太久）。
    for reader in readers {
        let _ = reader.join();
    }
    if capped {
        return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
    }
    Ok(merged)
}

/// 判定沙箱输出（纯函数，可单测）：警告/缺模型/数字不一致 → `INVALID_INPUT`。
fn check_sandbox_output(
    output: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
) -> Result<(), AppError> {
    if has_validation_warning(output) {
        return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
    }
    let Some(json_text) = json_start(output) else {
        return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
    };
    let mut stream = serde_json::Deserializer::from_str(json_text).into_iter::<Value>();
    let value: Value = stream
        .next()
        .ok_or_else(|| invalid("新规格未通过 omp 校验，请检查后重试"))?
        .map_err(|_| invalid("新规格未通过 omp 校验，请检查后重试"))?;
    let selector = format!("{provider}/{id}");
    let models = value.get("models").and_then(Value::as_array);
    let found = models
        .into_iter()
        .flatten()
        .find(|model| model.get("selector").and_then(Value::as_str) == Some(selector.as_str()));
    let Some(found) = found else {
        return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
    };
    // 补丁字段必须与 omp 读回一致（防编辑器错位写到别的行）。
    // name 精确比对，reasoning 布尔比对，input 无序集合比对；
    // 读回缺字段一律拒绝（fail-closed）。
    if let Some(name) = &patch.name {
        if found.get("name").and_then(Value::as_str) != Some(name.as_str()) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(reasoning) = patch.reasoning {
        if found.get("reasoning").and_then(Value::as_bool) != Some(reasoning) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(input) = &patch.input {
        let Some(actual) = found.get("input").and_then(Value::as_array) else {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        };
        let mut got: Vec<&str> = actual.iter().filter_map(Value::as_str).collect();
        let mut want: Vec<&str> = input.iter().map(String::as_str).collect();
        got.sort_unstable();
        want.sort_unstable();
        if got != want {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(window) = patch.context_window {
        if found.get("contextWindow").and_then(Value::as_u64) != Some(window) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(tokens) = patch.max_tokens {
        if found.get("maxTokens").and_then(Value::as_u64) != Some(tokens) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(cost) = &patch.cost {
        let actual = |key: &str| {
            found
                .get("cost")
                .and_then(|block| block.get(key))
                .and_then(Value::as_f64)
        };
        for (key, expected) in [
            ("input", cost.input),
            ("output", cost.output),
            ("cacheRead", cost.cache_read),
            ("cacheWrite", cost.cache_write),
        ] {
            match actual(key) {
                Some(got) if (got - expected).abs() <= 1e-9 => {}
                _ => return Err(invalid("新规格未通过 omp 校验，请检查后重试")),
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 备份与原子写入
// ---------------------------------------------------------------------------

/// 备份文件名时间戳：UTC 紧凑 `YYYYMMDDTHHMMSSZ`（同秒冲突递增）。
fn pick_backup_name(dir: &Path) -> Result<String, AppError> {
    let mut moment = chrono::Utc::now();
    for _ in 0..120 {
        let name = format!(
            "{MODELS_YML_NAME}{BACKUP_MARK}{}Z.bak",
            moment.format("%Y%m%dT%H%M%S")
        );
        // 形如 `models.yml.omp-resume.20261021T120000Z.bak`。
        if fs::symlink_metadata(dir.join(&name)).is_err() {
            return Ok(name);
        }
        moment += chrono::Duration::seconds(1);
    }
    Err(io_error("无法生成备份文件名"))
}

/// 备份现有文件（0600），保留最新 10 份（按名倒序），返回备份路径。
fn backup_existing(path: &Path, bytes: &[u8]) -> Result<PathBuf, AppError> {
    let dir = path.parent().ok_or_else(|| io_error("模型规格路径无效"))?;
    let name = pick_backup_name(dir)?;
    let backup = dir.join(&name);
    (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&backup)?;
        file.write_all(bytes)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        Ok(())
    })()
    .map_err(|e| io_error(format!("无法备份模型规格文件：{e}")))?;
    prune_backups(dir);
    Ok(backup)
}

/// 剪掉旧备份（同目录 `models.yml.omp-resume.*.bak` 只留最新 10 个；失败静默）。
fn prune_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{MODELS_YML_NAME}{BACKUP_MARK}");
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| name.starts_with(&prefix) && name.ends_with(BACKUP_SUFFIX))
        .collect();
    names.sort();
    names.reverse();
    for extra in names.into_iter().skip(BACKUP_KEEP) {
        let _ = fs::remove_file(dir.join(extra));
    }
}

struct PendingFile(PathBuf);

impl Drop for PendingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// 写目标前置检查：符号链接与只读一律拒绝（update 入口与 atomic_write 双处设防）。
fn check_write_target(path: &Path) -> Result<(), AppError> {
    // 符号链接拒绝：rename 会把链接换成普通文件，不断用户 dotfiles 布局。
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(io_error("models.yml 是符号链接，请手动编辑或改用真实路径"));
    }
    // 只读目标拒绝：尊重用户的锁定意图，不静默覆盖。
    if fs::metadata(path).is_ok_and(|meta| meta.permissions().readonly()) {
        return Err(io_error("模型规格文件为只读，请手动解除后重试"));
    }
    Ok(())
}

/// 原子替换：同目录临时文件（0600）+ fsync + rename + 0600。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    // 纵深设防：与 update 入口同一检查（备份后仍可能被换链/加锁，写前复检）。
    check_write_target(path)?;
    let dir = path.parent().ok_or_else(|| io_error("模型规格路径无效"))?;
    let (mut file, pending) = loop {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = dir.join(format!(".models.yml.{}.{sequence}.tmp", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&candidate)
        {
            Ok(file) => break (file, PendingFile(candidate)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(format!("无法创建规格临时文件：{error}"))),
        }
    };
    file.write_all(bytes)
        .map_err(|e| io_error(format!("无法写入模型规格：{e}")))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|e| io_error(format!("无法设置规格文件权限：{e}")))?;
    file.sync_all()
        .map_err(|e| io_error(format!("无法同步模型规格：{e}")))?;
    drop(file);
    fs::rename(&pending.0, path).map_err(|e| io_error(format!("无法原子替换模型规格：{e}")))?;
    // 临时文件创建即 0600，rename 保留权限：此 chmod 尽力而为，失败不报错。
    let _ = fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    std::mem::forget(pending);
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

/// CONTRACT §4.54：读规格快照。文件缺失 → `available=false` 正常空状态；
/// 超大/不可读/形状异常 → `available=true` + `error` 中文说明（specs 为空）。
pub fn get_model_specs_impl(path: &Path) -> ModelSpecsResult {
    let display = path.to_string_lossy().into_owned();
    match read_yml(path) {
        Ok(None) => ModelSpecsResult {
            path: display,
            available: false,
            revision: "absent".to_owned(),
            specs: Vec::new(),
            error: None,
        },
        Ok(Some(bytes)) => {
            let revision = revision_of(&bytes);
            match String::from_utf8(bytes) {
                Err(_) => ModelSpecsResult {
                    path: display,
                    available: true,
                    revision,
                    specs: Vec::new(),
                    error: Some("模型规格文件不是合法 UTF-8，请手动修复".to_owned()),
                },
                Ok(text) => match read_all_specs(&text, false) {
                    Ok(specs) => ModelSpecsResult {
                        path: display,
                        available: true,
                        revision,
                        specs,
                        error: None,
                    },
                    Err(error) => ModelSpecsResult {
                        path: display,
                        available: true,
                        revision,
                        specs: Vec::new(),
                        error: Some(error.message),
                    },
                },
            }
        }
        Err(error) => ModelSpecsResult {
            path: display,
            available: true,
            revision: "unreadable".to_owned(),
            specs: Vec::new(),
            error: Some(error.message),
        },
    }
}

/// CONTRACT §4.55：读-比-沙箱校验-备份-原子写-复读。整体持有 `OmpBusy`。
pub fn update_model_spec_impl(
    bin: &Path,
    busy: &OmpBusy,
    path: &Path,
    request: &ModelSpecPatchRequest,
) -> Result<ModelSpecUpdateResult, AppError> {
    // 拒写前置：备份之前先排除符号链接与只读目标，不留无用 .bak。
    check_write_target(path)?;
    validate_target(&request.provider, &request.id)?;
    validate_patch(&request.patch)?;
    if request.expected_revision.trim().is_empty() {
        return Err(invalid("缺少 revision，请刷新后重试"));
    }
    // 读侧哨兵串（absent/unreadable）不是可用版本：报 INVALID 而非误导性 CONFLICT。
    if request.expected_revision == "absent" || request.expected_revision == "unreadable" {
        return Err(invalid("当前没有可用的规格文件版本，请刷新后重试"));
    }
    let _guard = busy.try_acquire()?;
    let existing = read_yml(path)?.ok_or_else(|| invalid("模型规格文件不存在"))?;
    if revision_of(&existing) != request.expected_revision {
        return Err(conflict());
    }
    let text = String::from_utf8(existing.clone())
        .map_err(|_| invalid("模型规格文件不是合法 UTF-8，请手动修复"))?;
    let new_text = apply_patch_to_text(&text, &request.provider, &request.id, &request.patch)?;
    // 无变化（补丁值与现值一致）→ 直接返回现规格，不写盘。
    if new_text == text {
        let spec = read_all_specs(&text, true)?
            .into_iter()
            .find(|spec| spec.provider == request.provider && spec.id == request.id)
            .ok_or_else(|| invalid("未找到指定的模型"))?;
        return Ok(ModelSpecUpdateResult {
            revision: request.expected_revision.clone(),
            spec,
            backup_path: String::new(),
        });
    }
    // 写前沙箱校验（omp 缺失由调用方保证 bin 存在；此处只做校验）。
    sandbox_validate(
        bin,
        &new_text,
        &request.provider,
        &request.id,
        &request.patch,
    )?;
    // 二次 revision 门（校验耗时，防并发外部改）。
    let recheck = read_yml(path)?.ok_or_else(|| invalid("模型规格文件不存在"))?;
    if revision_of(&recheck) != request.expected_revision {
        return Err(conflict());
    }
    let backup = backup_existing(path, &existing)?;
    if let Err(error) = atomic_write(path, new_text.as_bytes()) {
        // 写失败尽力保留备份（不回滚已建备份，由用户手动恢复）。
        let _ = backup;
        return Err(error);
    }
    let reread = read_yml(path)?.ok_or_else(|| io_error("写后复读失败：文件消失"))?;
    let revision = revision_of(&reread);
    let text =
        String::from_utf8(reread).map_err(|_| io_error("写后复读失败：文件不是合法 UTF-8"))?;
    let spec = read_all_specs(&text, true)?
        .into_iter()
        .find(|spec| spec.provider == request.provider && spec.id == request.id)
        .ok_or_else(|| io_error("写后复读失败：模型消失"))?;
    Ok(ModelSpecUpdateResult {
        revision,
        spec,
        backup_path: backup.to_string_lossy().into_owned(),
    })
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

fn join_error(error: impl std::fmt::Display) -> AppError {
    io_error(format!("后台任务失败：{error}"))
}

/// CONTRACT §4.54：模型规格快照（只读，不占写门禁）。
#[tauri::command]
pub async fn get_model_specs() -> Result<ModelSpecsResult, AppError> {
    tauri::async_runtime::spawn_blocking(|| get_model_specs_impl(&resolve_models_yml()))
        .await
        .map_err(join_error)
}

/// CONTRACT §4.55：单个模型规格的读-比-校验-写。omp 缺失时拒绝写入。
#[tauri::command]
pub async fn update_model_spec(
    app: tauri::AppHandle,
    provider: String,
    id: String,
    patch: ModelSpecPatch,
    expected_revision: String,
) -> Result<ModelSpecUpdateResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        let request = ModelSpecPatchRequest {
            provider,
            id,
            patch,
            expected_revision,
        };
        update_model_spec_impl(&bin, &busy, &resolve_models_yml(), &request)
    })
    .await
    .map_err(join_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ModelCostPatch;
    use std::os::unix::fs::PermissionsExt;

    const SECRET: &str = "sk-secret-值-必须永不出现";

    // F1/F4 回归：嵌套同名键永不遮蔽直接子字段；id 只认直接子。
    fn nested_shadow_sample() -> &'static str {
        r#"providers:
  acme:
    models:
      - id: fast
        name: Real
        contextWindow: 1000
        x-meta:
          name: Inner
        compat:
          contextWindow: 2
        inputLimits:
          images:
            input: sneaky
"#
    }

    #[test]
    fn nested_keys_never_shadow_direct_fields() {
        // 读侧：嵌套值不遮蔽。
        let lines = split_lines(nested_shadow_sample());
        let span = locate_model(&lines, "acme", "fast").unwrap();
        let spec = read_spec(&lines, &span, "acme", "fast");
        assert_eq!(spec.name.as_deref(), Some("Real"));
        assert_eq!(spec.context_window, Some(1000));
        assert_eq!(spec.input, None);
        // 写 name：改顶层行，嵌套行不动。
        let out = apply_patch_to_text(
            nested_shadow_sample(),
            "acme",
            "fast",
            &ModelSpecPatch {
                name: Some("New".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        name: \"New\"\n"), "{out}");
        assert!(out.contains("          name: Inner\n"), "{out}");
        // 写 input：顶层缺 input → 插入新行，嵌套 input 行不动。
        let out = apply_patch_to_text(
            nested_shadow_sample(),
            "acme",
            "fast",
            &ModelSpecPatch {
                input: Some(vec!["text".to_owned()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        input: [text]\n"), "{out}");
        assert!(out.contains("            input: sneaky\n"), "{out}");
        // 写 contextWindow：改顶层行，compat 嵌套行不动。
        let out = apply_patch_to_text(
            nested_shadow_sample(),
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        contextWindow: 5\n"), "{out}");
        assert!(out.contains("          contextWindow: 2\n"), "{out}");
    }

    #[test]
    fn nested_reasoning_shadow_inserts_top_level() {
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        x-meta:\n          reasoning: true\n";
        // 读侧：嵌套 reasoning 不算。
        let lines = split_lines(yml);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        assert_eq!(read_spec(&lines, &span, "acme", "fast").reasoning, None);
        // 写侧：插入顶层行，嵌套行不动。
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                reasoning: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        reasoning: false\n"), "{out}");
        assert!(out.contains("          reasoning: true\n"), "{out}");
    }

    #[test]
    fn id_matching_ignores_nested_and_handles_anchors() {
        // 仅有嵌套 id 的条目不可定位。
        let yml = "providers:\n  acme:\n    models:\n      - name: beta\n        nested:\n          id: fast\n        contextWindow: 2\n";
        let error = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("未找到"), "{}", error.message);
        // 锚值 id 可定位：`id: &x fast`。
        let yml =
            "providers:\n  acme:\n    models:\n      - id: &x fast\n        contextWindow: 1000\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("contextWindow: 5"), "{out}");
        // 同一条目两个不同的顶层 id → 手动改。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        id: slow\n        contextWindow: 1\n";
        let error = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("手动"), "{}", error.message);
        // 目标命中第二个 id 同样手动改（不静默选首个）。
        let error = apply_patch_to_text(
            yml,
            "acme",
            "slow",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        let yml = "providers:\n  acme:\n    models:\n      - id: real\n        nested:\n          id: ghost\n        contextWindow: 1\n";
        let specs = read_all_specs(yml, true).unwrap();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].id, "real");
    }

    fn sample() -> &'static str {
        r#"# 顶部注释
providers:
  acme: # 行尾注释
    baseUrl: https://example.test
    api: openai
    apiKey: sk-secret-值-必须永不出现
    models:
      - id: fast # 内联注释
        name: "Fast One"
        contextWindow: 1000
        maxTokens: 100
        reasoning: true
        input: [text, image]
        cost: &u5438
          input: 0.3
          output: 1.2
          cacheRead: 0.006
          cacheWrite: 0
      - name: Slow
        id: slow
        contextWindow: 2000
  "quoted-prov":
    apiKey: sk-secret-值-必须永不出现
    models:
      - id: q1
"#
    }

    fn patch_all() -> ModelSpecPatch {
        ModelSpecPatch {
            name: Some("快 \"新\" \\ 名".to_owned()),
            context_window: Some(2000),
            max_tokens: Some(200),
            reasoning: Some(false),
            input: Some(vec!["text".to_owned()]),
            cost: Some(ModelCostPatch {
                input: 0.5,
                output: 2.0,
                cache_read: 0.01,
                cache_write: 0.0,
            }),
        }
    }

    #[test]
    fn samples_use_realistic_secret_marker() {
        // 本文件所有错误断言都扫 SECRET，确保凭据永不进错误文本。
        assert!(sample().contains(SECRET));
    }

    #[test]
    fn path_resolution_priority_and_size_cap() {
        let home = Path::new("/home/u");
        assert_eq!(
            resolve_models_yml_with(|_| None, home),
            home.join(".omp/agent/models.yml")
        );
        assert_eq!(
            resolve_models_yml_with(
                |key| (key == PI_AGENT_DIR_ENV).then(|| "/tmp/agent".to_owned()),
                home
            ),
            PathBuf::from("/tmp/agent/models.yml")
        );
        // 空白覆盖值视为未设置，落到下一级。
        assert_eq!(
            resolve_models_yml_with(
                |key| match key {
                    MODELS_YML_ENV => Some("   ".to_owned()),
                    PI_AGENT_DIR_ENV => Some("/tmp/agent".to_owned()),
                    _ => None,
                },
                home
            ),
            PathBuf::from("/tmp/agent/models.yml")
        );
        assert_eq!(
            resolve_models_yml_with(
                |key| (key == MODELS_YML_ENV).then(|| "/tmp/custom.yml".to_owned()),
                home
            ),
            PathBuf::from("/tmp/custom.yml")
        );
        // 大小上限：超 2 MiB 拒绝。
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("models.yml");
        fs::write(&big, vec![b'x'; MAX_YML_BYTES as usize + 1]).unwrap();
        let error = read_yml(&big).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(read_yml(&dir.path().join("missing.yml")).unwrap().is_none());
        // revision 为字节 SHA256。
        assert_eq!(
            revision_of(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn replace_existing_scalars_preserves_rest_bytes() {
        let text = sample();
        let out = apply_patch_to_text(text, "acme", "fast", &patch_all()).unwrap();
        // 替换值正确（含 name 转义、费用 6 位小数修剪）。
        assert!(out.contains("name: \"快 \\\"新\\\" \\\\ 名\""), "{out}");
        assert!(out.contains("contextWindow: 2000"), "{out}");
        assert!(out.contains("maxTokens: 200"), "{out}");
        assert!(out.contains("reasoning: false"), "{out}");
        assert!(out.contains("input: [text]"), "{out}");
        assert!(out.contains("input: 0.5"), "{out}");
        assert!(out.contains("cacheWrite: 0\n"), "{out}");
        // 注释/锚点/凭据行原样保留。
        assert!(out.contains("# 顶部注释"), "{out}");
        assert!(out.contains("acme: # 行尾注释"), "{out}");
        assert!(out.contains("- id: fast # 内联注释"), "{out}");
        assert!(out.contains("cost: &u5438"), "{out}");
        assert!(out.contains(&format!("apiKey: {SECRET}")), "{out}");
        // 未触碰的模型行逐字节一致。
        for needle in ["- name: Slow", "id: slow", "\"quoted-prov\":", "- id: q1"] {
            assert_eq!(
                out.matches(needle).count(),
                text.matches(needle).count(),
                "{needle}"
            );
        }
        // 读回规格一致。
        let lines = split_lines(&out);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        let spec = read_spec(&lines, &span, "acme", "fast");
        assert_eq!(spec.name.as_deref(), Some("快 \"新\" \\ 名"));
        assert_eq!(spec.context_window, Some(2000));
        assert_eq!(spec.max_tokens, Some(200));
        assert_eq!(spec.reasoning, Some(false));
        assert_eq!(spec.input, Some(vec!["text".to_owned()]));
        assert_eq!(spec.cost_input, Some(0.5));
        assert_eq!(spec.cost_cache_write, Some(0.0));
    }

    #[test]
    fn insert_missing_fields_and_cost_block_after_dash() {
        let out = apply_patch_to_text(sample(), "acme", "slow", &patch_all()).unwrap();
        // 缺失字段插在条目内（`id: slow` 所在条目、下一 provider 之前）。
        let slow_at = out.find("id: slow").unwrap();
        let quoted_at = out.find("\"quoted-prov\"").unwrap();
        // 条目起点为 id 行之上最近的 `- ` 行。
        let dash_at = out[..slow_at].rfind("- name:").unwrap();
        let block = &out[dash_at..quoted_at];
        assert!(block.contains("maxTokens: 200"), "{block}");
        assert!(block.contains("reasoning: false"), "{block}");
        assert!(block.contains("cost:"), "{block}");
        assert!(block.contains("cacheRead: 0.01"), "{block}");
        // cost 块四键齐全、顺序固定。
        let cost_at = block.find("cost:\n").unwrap();
        let cost_block = &block[cost_at..];
        let order = [
            "input: 0.5",
            "output: 2",
            "cacheRead: 0.01",
            "cacheWrite: 0",
        ];
        let mut last = 0;
        for needle in order {
            let at = cost_block.find(needle).unwrap();
            assert!(at > last, "{needle} in {cost_block}");
            last = at;
        }
        // 已存在的 name/contextWindow 被替换而非重复插入。
        assert_eq!(block.matches("name:").count(), 1, "{block}");
        assert_eq!(block.matches("contextWindow:").count(), 1, "{block}");
        // id 在第二行的条目形式可定位。
        let lines = split_lines(&out);
        let span = locate_model(&lines, "acme", "slow").unwrap();
        let spec = read_spec(&lines, &span, "acme", "slow");
        assert_eq!(spec.max_tokens, Some(200));
        assert_eq!(spec.cost_output, Some(2.0));
    }

    #[test]
    fn quoted_keys_and_head_id_form() {
        // 引号 provider + `- id: x` 首行内联形式。
        let out = apply_patch_to_text(
            sample(),
            "quoted-prov",
            "q1",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("- id: q1"), "{out}");
        assert!(out.contains("contextWindow: 5"), "{out}");
        // 单引号 id 匹配。
        let single = sample().replace("- id: q1", "- id: 'q1'");
        let out = apply_patch_to_text(
            &single,
            "quoted-prov",
            "q1",
            &ModelSpecPatch {
                max_tokens: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("maxTokens: 7"), "{out}");
    }

    #[test]
    fn crlf_comments_and_flow_style() {
        let crlf = sample().replace('\n', "\r\n");
        let out = apply_patch_to_text(
            &crlf,
            "acme",
            "fast",
            &ModelSpecPatch {
                max_tokens: Some(300),
                ..Default::default()
            },
        )
        .unwrap();
        // CRLF 保留：替换行与插入行均为 \r\n，且无裸 \n。
        assert!(out.contains("maxTokens: 300\r\n"), "{out:?}");
        for line in out.split("\r\n") {
            assert!(!line.contains('\n'), "{line:?}");
        }
        // 注释保留。
        assert!(out.contains("# 内联注释\r\n"), "{out:?}");
        // 流式条目拒绝。
        let flow = sample().replace("- id: fast # 内联注释", "- {id: fast}");
        let error = apply_patch_to_text(
            &flow,
            "acme",
            "fast",
            &ModelSpecPatch {
                max_tokens: Some(1),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("手动"), "{}", error.message);
        assert!(!error.message.contains(SECRET), "{}", error.message);
    }

    #[test]
    fn anchor_heads_alias_items_and_alias_guard() {
        let anchored = r#"providers:
  acme:
    apiKey: sk-secret-值-必须永不出现
    models:
      - &spark
        id: fast
        contextWindow: 1000
      - id: slow
        contextWindow: 2000
  alias-prov:
    apiKey: sk-secret-值-必须永不出现
    models:
      - *spark
"#;
        // `- &name` 锚条目可定位；但它被他处 `*spark` 引用 → 写时拒绝。
        let lines = split_lines(anchored);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        assert_eq!(
            read_spec(&lines, &span, "acme", "fast").context_window,
            Some(1000)
        );
        let error = apply_patch_to_text(
            anchored,
            "acme",
            "fast",
            &ModelSpecPatch {
                max_tokens: Some(1),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("别名"), "{}", error.message);
        assert!(!error.message.contains(SECRET), "{}", error.message);
        // 无引用的锚条目可写。
        let unreferenced = anchored.replace("      - *spark\n", "      - id: other\n");
        let out = apply_patch_to_text(
            &unreferenced,
            "acme",
            "fast",
            &ModelSpecPatch {
                max_tokens: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("- &spark"), "{out}");
        assert!(out.contains("maxTokens: 5"), "{out}");
        // 读侧跳过纯别名条目（无本地 id）。
        let specs = read_all_specs(anchored, true).unwrap();
        assert_eq!(specs.len(), 2);
        assert!(specs.iter().all(|s| !s.id.is_empty()));
        // cost 锚被引用同样拒绝。
        let cost_anchor = r#"providers:
  acme:
    models:
      - id: fast
        cost: &c0
          input: 0.1
          output: 0.2
          cacheRead: 0.003
          cacheWrite: 0
      - id: slow
        cost: *c0
"#;
        let error = apply_patch_to_text(
            cost_anchor,
            "acme",
            "fast",
            &ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: 1.0,
                    output: 1.0,
                    cache_read: 1.0,
                    cache_write: 1.0,
                }),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("别名"), "{}", error.message);
    }

    #[test]
    fn missing_duplicate_and_manual_shapes() {
        let patch = ModelSpecPatch {
            max_tokens: Some(1),
            ..Default::default()
        };
        // 缺 provider / 缺模型。
        for (provider, id) in [("nope", "fast"), ("acme", "nope")] {
            let error = apply_patch_to_text(sample(), provider, id, &patch).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{provider}/{id}");
            assert!(!error.message.contains(SECRET), "{}", error.message);
        }
        // 重复 provider。
        let dup_provider = sample().replace(
            "  \"quoted-prov\":",
            "  acme:\n    models:\n      - id: other\n  \"quoted-prov\":",
        );
        let error = apply_patch_to_text(&dup_provider, "acme", "fast", &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("手动"), "{}", error.message);
        // 重复 id。
        let dup_id = sample().replace("- name: Slow\n        id: slow", "id: fast");
        let error = apply_patch_to_text(&dup_id, "acme", "fast", &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("手动"), "{}", error.message);
        // cost 行内写法。
        let inline_cost = sample().replace("cost: &u5438", "cost: {input: 1}");
        let error = apply_patch_to_text(
            &inline_cost,
            "acme",
            "fast",
            &ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: 1.0,
                    output: 1.0,
                    cache_read: 1.0,
                    cache_write: 1.0,
                }),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(!error.message.contains(SECRET), "{}", error.message);
        // cost 缺子键。
        let missing_sub = sample().replace("          cacheWrite: 0\n", "");
        let error = apply_patch_to_text(
            &missing_sub,
            "acme",
            "fast",
            &ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: 1.0,
                    output: 1.0,
                    cache_read: 1.0,
                    cache_write: 1.0,
                }),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn atomic_write_refuses_symlink_and_readonly() {
        // F10 回归：符号链接与只读目标拒绝写入。
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.yml");
        fs::write(&real, b"real").unwrap();
        let link = dir.path().join("models.yml");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let error = atomic_write(&link, b"new").unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert!(error.message.contains("符号链接"), "{}", error.message);
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"real");
        // 只读文件拒绝。
        let ro = dir.path().join("ro.yml");
        fs::write(&ro, b"old").unwrap();
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o444)).unwrap();
        let error = atomic_write(&ro, b"new").unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert!(error.message.contains("只读"), "{}", error.message);
        assert_eq!(fs::read(&ro).unwrap(), b"old");
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn revision_sentinels_dup_models_and_flow_continue() {
        // F12 回归：哨兵 revision → INVALID；重复 models → 手动改；流式项跳过不断读。
        let dir = tempfile::tempdir().unwrap();
        let yml = dir.path().join("models.yml");
        fs::write(&yml, sample()).unwrap();
        let busy = OmpBusy::default();
        for sentinel in ["absent", "unreadable"] {
            let error = update_model_spec_impl(
                dir.path(),
                &busy,
                &yml,
                &ModelSpecPatchRequest {
                    provider: "acme".to_owned(),
                    id: "fast".to_owned(),
                    patch: ModelSpecPatch {
                        max_tokens: Some(1),
                        ..Default::default()
                    },
                    expected_revision: sentinel.to_owned(),
                },
            )
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{sentinel}");
            assert!(error.message.contains("刷新"), "{}", error.message);
        }
        // 同一 provider 下第二个 models。
        let dup = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1\n    models:\n      - id: fast\n        contextWindow: 2\n";
        let error = apply_patch_to_text(
            dup,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("手动"), "{}", error.message);
        // 流式首项后仍读到后项。
        let yml = "providers:\n  acme:\n    models:\n      - {id: skip}\n      - id: fast\n        contextWindow: 1\n";
        let specs = read_all_specs(yml, false).unwrap();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].id, "fast");
        // 200 汉字（600 字节）不超限。
        assert!(validate_target(&"中".repeat(200), "x").is_ok());
        assert!(validate_target(&"中".repeat(201), "x").is_err());
    }

    #[test]
    fn alias_guard_token_aware_and_wide_charset() {
        // F13 回归：`*c0x` 不误伤 `&c0`；`&a.b` 全名参与比对。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        cost: &c0\n          input: 0.1\n          output: 0.2\n          cacheRead: 0.003\n          cacheWrite: 0\n      - id: slow\n        cost: *c0x\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("contextWindow: 5"), "{out}");
        // 真引用仍拒绝（含合并键导入）。
        let yml = "providers:\n  acme:\n    models:\n      - &tgt\n        id: fast\n        contextWindow: 1\n  b:\n    models:\n      - <<: *tgt\n        id: other\n";
        let error = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(error.message.contains("别名"), "{}", error.message);
        // 点号锚名不截断：`*a` 不误伤 `&a.b`。
        let yml = "providers:\n  acme:\n    models:\n      - &a.b id: fast\n        contextWindow: 1\n  b:\n    models:\n      - *a\n        contextWindow: 2\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("contextWindow: 5"), "{out}");
    }

    #[test]
    fn relative_models_yml_absolutized() {
        // F14 回归：相对覆盖转绝对，不再 `Some("")`。
        let home = Path::new("/home/u");
        let resolved = resolve_models_yml_with(
            |key| (key == MODELS_YML_ENV).then(|| "rel.yml".to_owned()),
            home,
        );
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("rel.yml"));
    }

    #[test]
    fn patch_validation_rejects_bad_values() {
        let cost = || ModelCostPatch {
            input: 1.0,
            output: 1.0,
            cache_read: 1.0,
            cache_write: 1.0,
        };
        let cases: Vec<ModelSpecPatch> = vec![
            ModelSpecPatch {
                name: Some("  ".to_owned()),
                ..Default::default()
            },
            ModelSpecPatch {
                context_window: Some(0),
                ..Default::default()
            },
            ModelSpecPatch {
                max_tokens: Some(0),
                ..Default::default()
            },
            ModelSpecPatch {
                input: Some(vec![]),
                ..Default::default()
            },
            ModelSpecPatch {
                input: Some(vec!["video".to_owned()]),
                ..Default::default()
            },
            ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: f64::NAN,
                    ..cost()
                }),
                ..Default::default()
            },
            ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    output: -1.0,
                    ..cost()
                }),
                ..Default::default()
            },
            // F11：超 2^53。
            ModelSpecPatch {
                context_window: Some((1 << 53) - 1 + 1),
                ..Default::default()
            },
            ModelSpecPatch {
                max_tokens: Some(u64::MAX),
                ..Default::default()
            },
            // F11：控制字符 / YAML 换行符。
            ModelSpecPatch {
                name: Some("a\0b".to_owned()),
                ..Default::default()
            },
            ModelSpecPatch {
                name: Some("a\tb".to_owned()),
                ..Default::default()
            },
            ModelSpecPatch {
                name: Some("a b".to_owned()),
                ..Default::default()
            },
            // F11：超 1e9 / 精度不足。
            ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: 1e10,
                    ..cost()
                }),
                ..Default::default()
            },
            ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: 1e-7,
                    ..cost()
                }),
                ..Default::default()
            },
            // F11：重复 input。
            ModelSpecPatch {
                input: Some(vec!["text".to_owned(), "text".to_owned()]),
                ..Default::default()
            },
        ];
        for patch in cases {
            assert_eq!(
                validate_patch(&patch).unwrap_err().code,
                ErrorCode::InvalidInput
            );
        }
        assert!(validate_target("", "x").is_err());
        assert!(validate_target("a/b", "x").is_err());
        assert!(validate_target("a", "x/y").is_err());
        validate_patch(&patch_all()).unwrap();
        assert_eq!(format_cost(0.3000004), "0.3");
        assert_eq!(format_cost(0.0), "0");
        assert_eq!(format_cost(2.0), "2");
        assert_eq!(format_cost(0.006), "0.006");
    }

    #[test]
    fn block_sequence_input_replace_and_read() {
        // F3 回归：真实块序列形 input 可读可写。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        input:\n          - text\n          - image\n        contextWindow: 1000\n";
        let lines = split_lines(yml);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        assert_eq!(
            read_spec(&lines, &span, "acme", "fast").input,
            Some(vec!["text".to_owned(), "image".to_owned()])
        );
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                input: Some(vec!["text".to_owned()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        input: [text]\n"), "{out}");
        assert!(!out.contains("- image"), "{out}");
        // 零缩进 `- ` 子行同样归属头。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        input:\n        - text\n        - image\n        contextWindow: 1000\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                input: Some(vec!["text".to_owned()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        input: [text]\n"), "{out}");
        assert!(!out.contains("- image"), "{out}");
    }

    #[test]
    fn block_scalar_values_refuse_manual_edit() {
        // F3 回归：块标量体永不悬空，一律手动改。
        for header in [
            "        name: |",
            "        name: >-",
            "        contextWindow: |2",
            "        input: |",
        ] {
            let yml = format!(
                "providers:\n  acme:\n    models:\n      - id: fast\n{header}\n          body line\n        maxTokens: 100\n"
            );
            let patch = if header.contains("contextWindow") {
                ModelSpecPatch {
                    context_window: Some(5),
                    ..Default::default()
                }
            } else if header.contains("input:") {
                ModelSpecPatch {
                    input: Some(vec!["text".to_owned()]),
                    ..Default::default()
                }
            } else {
                ModelSpecPatch {
                    name: Some("N".to_owned()),
                    ..Default::default()
                }
            };
            let error = apply_patch_to_text(&yml, "acme", "fast", &patch).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{header}");
            assert!(
                error.message.contains("手动"),
                "{header}: {}",
                error.message
            );
        }
        // 头后带行内注释的空值 input 仍可识别为块序列。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        input: # 注释\n          - text\n        contextWindow: 1000\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                input: Some(vec!["text".to_owned(), "image".to_owned()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("input: [text, image]"), "{out}");
        assert!(!out.contains("- text\n          -"), "{out}");
    }

    #[test]
    fn sandbox_output_checks_name_reasoning_input() {
        // F2 回归：name/reasoning/input 读回不一致或缺字段 → 拒绝。
        let patch = ModelSpecPatch {
            name: Some("New".to_owned()),
            reasoning: Some(false),
            input: Some(vec!["text".to_owned(), "image".to_owned()]),
            ..Default::default()
        };
        let good = "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
            \"reasoning\":false,\"input\":[\"text\",\"image\"]}]}\n";
        check_sandbox_output(good, "acme", "fast", &patch).unwrap();
        // input 无序也算一致。
        let shuffled = "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
            \"reasoning\":false,\"input\":[\"image\",\"text\"]}]}\n";
        check_sandbox_output(shuffled, "acme", "fast", &patch).unwrap();
        for bad in [
            // name 不一致。
            "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"fast\",\
            \"reasoning\":false,\"input\":[\"text\",\"image\"]}]}\n",
            // reasoning 不一致。
            "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
            \"reasoning\":true,\"input\":[\"text\",\"image\"]}]}\n",
            // input 集合不一致（缺 image）。
            "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
            \"reasoning\":false,\"input\":[\"text\"]}]}\n",
            // input 缺字段。
            "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
            \"reasoning\":false}]}\n",
            // name 缺字段。
            "{\"models\":[{\"selector\":\"acme/fast\",\
            \"reasoning\":false,\"input\":[\"text\",\"image\"]}]}\n",
        ] {
            let error = check_sandbox_output(bad, "acme", "fast", &patch).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{bad}");
            assert_eq!(error.message, "新规格未通过 omp 校验，请检查后重试");
        }
        // 未打补丁的字段不参与比对：缺字段也通过。
        check_sandbox_output(
            "{\"models\":[{\"selector\":\"acme/fast\"}]}\n",
            "acme",
            "fast",
            &ModelSpecPatch::default(),
        )
        .unwrap();
    }

    #[test]
    fn tiered_cost_reads_none_and_refuses_write() {
        // 分层价回归：真实 longContext 形 → 四费用 None + 标记，写侧整模型拒改。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        cost:\n          input: 0.1\n          output: 0.5\n          cacheRead: 0.01\n          cacheWrite: 0.125\n          longContext:\n            inputThreshold: 100000\n            input: 0.5\n            output: 2.5\n            cacheRead: 0.05\n            cacheWrite: 0.625\n";
        let lines = split_lines(yml);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        let spec = read_spec(&lines, &span, "acme", "fast");
        assert!(spec.cost_tiered);
        assert_eq!(spec.cost_input, None);
        assert_eq!(spec.cost_output, None);
        assert_eq!(spec.cost_cache_read, None);
        assert_eq!(spec.cost_cache_write, None);
        // 连非 cost 补丁也拒（可预测）。
        for patch in [
            ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
            ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: 1.0,
                    output: 1.0,
                    cache_read: 1.0,
                    cache_write: 1.0,
                }),
                ..Default::default()
            },
        ] {
            let error = apply_patch_to_text(yml, "acme", "fast", &patch).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput);
            assert_eq!(
                error.message,
                "该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml"
            );
        }
        // 普通四键 cost 照常读写。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        cost:\n          input: 0.1\n          output: 0.2\n          cacheRead: 0.003\n          cacheWrite: 0\n";
        let lines = split_lines(yml);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        let spec = read_spec(&lines, &span, "acme", "fast");
        assert!(!spec.cost_tiered);
        assert_eq!(spec.cost_input, Some(0.1));
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        contextWindow: 5\n"), "{out}");
        // compat 嵌套的四键 cost 不是真 cost：忽略，不标 tiered。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        compat:\n          cost:\n            input: 9\n            output: 9\n            cacheRead: 9\n            cacheWrite: 9\n";
        let lines = split_lines(yml);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        let spec = read_spec(&lines, &span, "acme", "fast");
        assert!(!spec.cost_tiered);
        assert_eq!(spec.cost_input, None);
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        contextWindow: 5\n"), "{out}");
        assert!(out.contains("            input: 9\n"), "{out}");
    }

    #[test]
    fn block_scalar_bodies_never_parse_as_fields() {
        // F5 回归：标量体里的 `contextWindow: 999` 永不解析为字段。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        description: |\n          contextWindow: 999\n          name: oldinner\n        maxTokens: 100\n";
        let lines = split_lines(yml);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        let spec = read_spec(&lines, &span, "acme", "fast");
        assert_eq!(spec.context_window, None);
        assert_eq!(spec.name, None);
        // 写 contextWindow → 插入顶层行，体行不动。
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("        contextWindow: 5\n"), "{out}");
        assert!(out.contains("          contextWindow: 999\n"), "{out}");
        // 折叠式 `>` 同理。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        description: >\n          folded\n          contextWindow: 999\n        maxTokens: 100\n";
        let lines = split_lines(yml);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        assert_eq!(
            read_spec(&lines, &span, "acme", "fast").context_window,
            None
        );
    }

    #[test]
    fn eof_without_newline_inserts_cleanly() {
        // F7 回归：EOF 无尾换行时插入不粘连。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                max_tokens: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            out.contains("- id: fast\n        maxTokens: 7\n"),
            "{out:?}"
        );
        // cost 块插入同理。
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                cost: Some(ModelCostPatch {
                    input: 1.0,
                    output: 1.0,
                    cache_read: 1.0,
                    cache_write: 1.0,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("- id: fast\n        cost:\n"), "{out:?}");
        // CRLF 变体：横线行无换行，插入用 LF 亦不粘连。
        let yml = "providers:\r\n  acme:\r\n    models:\r\n      - id: fast";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                max_tokens: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            out.contains("- id: fast\n        maxTokens: 7\n"),
            "{out:?}"
        );
    }

    #[test]
    fn zero_indent_sequence_and_spaced_anchor_head() {
        // F8a 回归：`models:` 后横线同列可定位。
        let yml = "providers:\n  acme:\n    models:\n    - id: fast\n      contextWindow: 1000\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("contextWindow: 5"), "{out}");
        assert_eq!(read_all_specs(yml, true).unwrap().len(), 1);
        // F8b 回归：`-   &a id: x` 多余空格可定位。
        let yml =
            "providers:\n  acme:\n    models:\n      -   &a id: fast\n        contextWindow: 1\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.contains("contextWindow: 5"), "{out}");
    }

    #[test]
    fn sandbox_output_checks_warnings_presence_and_numbers() {
        let patch = ModelSpecPatch {
            context_window: Some(2000),
            max_tokens: Some(200),
            cost: Some(ModelCostPatch {
                input: 0.5,
                output: 2.0,
                cache_read: 0.01,
                cache_write: 0.0,
            }),
            ..Default::default()
        };
        let good = |window: u64, cost_input: f64| {
            format!(
                "{{\"models\":[{{\"selector\":\"acme/fast\",\"contextWindow\":{window},\"maxTokens\":200,\
                 \"cost\":{{\"input\":{cost_input},\"output\":2.0,\"cacheRead\":0.01,\"cacheWrite\":0}}}}]}}\n"
            )
        };
        check_sandbox_output(&good(2000, 0.5), "acme", "fast", &patch).unwrap();
        // 警告行 → 拒绝。
        for warning in [
            "config validation failed: bad\n".to_owned() + &good(2000, 0.5),
            "Failed to load config file models: boom\n".to_owned() + &good(2000, 0.5),
        ] {
            let error = check_sandbox_output(&warning, "acme", "fast", &patch).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput);
            assert!(!error.message.contains("boom"), "{}", error.message);
        }
        // 缺模型 / 数字不一致 / 无 JSON → 拒绝，且文案固定不回显输出。
        for bad in [
            good(2000, 0.5).replace("acme/fast", "acme/other"),
            good(999, 0.5),
            good(2000, 0.6),
            "not json at all\n".to_owned(),
        ] {
            let error = check_sandbox_output(&bad, "acme", "fast", &patch).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput);
            assert_eq!(error.message, "新规格未通过 omp 校验，请检查后重试");
        }
    }

    #[test]
    fn validate_with_fake_omp_writes_sandbox_and_checks() {
        let _guard = crate::omp_cli::subprocess_test_guard();
        let dir = tempfile::tempdir().unwrap();
        let seen = dir.path().join("seen");
        let bin = dir.path().join("omp");
        // 假 omp：断言沙箱 env 与文件存在，回固定 JSON。
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\ntest -f \"$PI_CODING_AGENT_DIR/models.yml\" && echo ok > \"{}\"\
                 \nprintf '%s\\n' '{{\"models\":[{{\"selector\":\"acme/fast\",\"name\":\"快 \\\"新\\\" \\\\ 名\",\
                 \"contextWindow\":2000,\"maxTokens\":200,\"reasoning\":false,\"input\":[\"text\"],\
                 \"cost\":{{\"input\":0.5,\"output\":2,\"cacheRead\":0.01,\"cacheWrite\":0}}}}]}}'\n",
                seen.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let new_text = apply_patch_to_text(sample(), "acme", "fast", &patch_all()).unwrap();
        validate_with(
            &bin,
            &new_text,
            "acme",
            "fast",
            &patch_all(),
            |bin, agent_dir| run_omp_with_env(bin, agent_dir, Duration::from_secs(10)),
        )
        .unwrap();
        assert!(seen.exists(), "假 omp 应看到沙箱 models.yml");
    }

    #[test]
    fn update_end_to_end_backups_and_atomic_rewrite() {
        let _guard = crate::omp_cli::subprocess_test_guard();
        let dir = tempfile::tempdir().unwrap();
        let yml = dir.path().join("models.yml");
        fs::write(&yml, sample()).unwrap();
        let revision = revision_of(sample().as_bytes());
        // 旧备份 12 份：写后只留最新 10 份。
        for day in 1..=12 {
            fs::write(
                dir.path()
                    .join(format!("models.yml.omp-resume.202610{day:02}T120000Z.bak")),
                b"old",
            )
            .unwrap();
        }
        let request = ModelSpecPatchRequest {
            provider: "acme".to_owned(),
            id: "fast".to_owned(),
            patch: ModelSpecPatch {
                max_tokens: Some(300),
                ..Default::default()
            },
            expected_revision: revision.clone(),
        };
        // 先行校验逻辑等价：用纯函数链模拟 update（真 update 会调 sandbox_validate）。
        let text = String::from_utf8(fs::read(&yml).unwrap()).unwrap();
        let new_text = apply_patch_to_text(&text, "acme", "fast", &request.patch).unwrap();
        check_sandbox_output(
            "{\"models\":[{\"selector\":\"acme/fast\",\"contextWindow\":1000,\"maxTokens\":300,\
             \"cost\":{\"input\":0.3,\"output\":1.2,\"cacheRead\":0.006,\"cacheWrite\":0}}]}\n",
            "acme",
            "fast",
            &request.patch,
        )
        .unwrap();
        let backup = backup_existing(&yml, text.as_bytes()).unwrap();
        atomic_write(&yml, new_text.as_bytes()).unwrap();
        // 备份内容为原文、0600；新文件 0600；旧备份被剪到 10 份。
        assert_eq!(fs::read(&backup).unwrap(), sample().as_bytes());
        assert_eq!(
            backup.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(yml.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter(|name| name.ends_with(".bak"))
            .collect();
        assert_eq!(backups.len(), 10, "{backups:?}");
        assert!(backups
            .iter()
            .all(|name| name.as_str() > "models.yml.omp-resume.20261002T120000Z.bak"));
        // revision 变化且读回一致。
        let reread = fs::read(&yml).unwrap();
        assert_ne!(revision_of(&reread), revision);
        let text = String::from_utf8(reread).unwrap();
        let lines = split_lines(&text);
        let span = locate_model(&lines, "acme", "fast").unwrap();
        assert_eq!(
            read_spec(&lines, &span, "acme", "fast").max_tokens,
            Some(300)
        );
        // CONFLICT：revision 对不上拒绝。
        let busy = OmpBusy::default();
        let bin = dir.path().join("no-omp-here");
        let error = update_model_spec_impl(
            &bin,
            &busy,
            &yml,
            &ModelSpecPatchRequest {
                expected_revision: revision,
                ..request.clone()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        // BUSY：门禁被占拒绝。
        let _held = busy.try_acquire().unwrap();
        let current = revision_of(&fs::read(&yml).unwrap());
        let error = update_model_spec_impl(
            &bin,
            &busy,
            &yml,
            &ModelSpecPatchRequest {
                expected_revision: current,
                ..request.clone()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Busy);
    }

    #[test]
    fn zero_indent_multi_item_list_reads_and_patches_each() {
        // N1：零额外缩进多项不再截断列表；逐项可读可写、互不串改。
        let yml = "providers:\n  acme:\n    models:\n    - id: a\n      contextWindow: 1\n    - id: b\n      contextWindow: 2\n    - id: c\n      contextWindow: 3\n";
        let specs = read_all_specs(yml, true).unwrap();
        assert_eq!(
            specs.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        for (id, old, new) in [("b", 2u64, 20u64), ("c", 3u64, 30u64)] {
            let out = apply_patch_to_text(
                yml,
                "acme",
                id,
                &ModelSpecPatch {
                    context_window: Some(new),
                    ..Default::default()
                },
            )
            .unwrap();
            // 仅目标行变化，其余逐行一致。
            let old_lines: Vec<&str> = yml.lines().collect();
            let new_lines: Vec<&str> = out.lines().collect();
            assert_eq!(old_lines.len(), new_lines.len(), "{out}");
            let mut changed = 0;
            for (a, b) in old_lines.iter().zip(new_lines.iter()) {
                if a != b {
                    changed += 1;
                    assert_eq!(*a, format!("      contextWindow: {old}"));
                    assert_eq!(*b, format!("      contextWindow: {new}"));
                }
            }
            assert_eq!(changed, 1, "{out}");
            // 读回新值。
            let specs = read_all_specs(&out, true).unwrap();
            assert_eq!(specs.len(), 3);
            assert_eq!(
                specs.iter().find(|s| s.id == id).unwrap().context_window,
                Some(new)
            );
        }
        // 正常深缩进列表行为不变：三项全读、改中间项只动一行。
        let yml = "providers:\n  acme:\n    models:\n      - id: a\n        contextWindow: 1\n      - id: b\n        contextWindow: 2\n      - id: c\n        contextWindow: 3\n";
        assert_eq!(read_all_specs(yml, true).unwrap().len(), 3);
        let out = apply_patch_to_text(
            yml,
            "acme",
            "b",
            &ModelSpecPatch {
                context_window: Some(20),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.matches("contextWindow: 20").count(), 1, "{out}");
        assert!(out.contains("        contextWindow: 1\n"), "{out}");
        assert!(out.contains("        contextWindow: 3\n"), "{out}");
    }

    #[test]
    fn anchored_inline_head_uses_continuation_indent() {
        // N2：`- &a id: fast` + 10 列字段（横线后两格紧凑对齐）→ 替换现行，不插重复行。
        let yml = "providers:\n  acme:\n    models:\n        - &a id: fast\n          contextWindow: 1\n          maxTokens: 100\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.matches("contextWindow").count(), 1, "{out}");
        assert!(out.contains("          contextWindow: 5\n"), "{out}");
        let specs = read_all_specs(&out, true).unwrap();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].id, "fast");
        assert_eq!(specs[0].context_window, Some(5));
        assert_eq!(specs[0].max_tokens, Some(100));
        // 规范形（`- id: x` + 横线后两格字段）行为不变。
        let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1\n";
        let out = apply_patch_to_text(
            yml,
            "acme",
            "fast",
            &ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.matches("contextWindow").count(), 1, "{out}");
        assert!(out.contains("        contextWindow: 5\n"), "{out}");
    }

    #[test]
    fn update_refuses_unsafe_target_before_backup() {
        // N4：符号链接/只读在备份前拒绝（假 omp 全程可用验证走到备份前），不留 .bak。
        let _guard = crate::omp_cli::subprocess_test_guard();
        let dir = tempfile::tempdir().unwrap();
        let json = dir.path().join("models.json");
        std::fs::write(
            &json,
            "{\"models\":[{\"selector\":\"acme/fast\",\"contextWindow\":1000,\"maxTokens\":300,\
             \"cost\":{\"input\":0.3,\"output\":1.2,\"cacheRead\":0.006,\"cacheWrite\":0}}]}\n",
        )
        .unwrap();
        let bin = dir.path().join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\ncat \"{}\"\n", json.display())).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let busy = OmpBusy::default();
        let revision = revision_of(sample().as_bytes());
        let request = || ModelSpecPatchRequest {
            provider: "acme".to_owned(),
            id: "fast".to_owned(),
            patch: ModelSpecPatch {
                max_tokens: Some(300),
                ..Default::default()
            },
            expected_revision: revision.clone(),
        };
        let bak_count = |dir: &Path| {
            fs::read_dir(dir)
                .unwrap()
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.ends_with(".bak"))
                .count()
        };
        // 符号链接：特定文案 + 无 .bak。
        let real = dir.path().join("real-models.yml");
        fs::write(&real, sample()).unwrap();
        let link = dir.path().join("models.yml");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // （同一 dir 内假 omp 产物不影响 .bak 计数：只统计 *.bak。）
        let error = update_model_spec_impl(&bin, &busy, &link, &request()).unwrap_err();
        assert_eq!(error.code, ErrorCode::Io, "{error:?}");
        assert!(error.message.contains("符号链接"), "{}", error.message);
        assert_eq!(bak_count(dir.path()), 0);
        assert_eq!(fs::read(&real).unwrap(), sample().as_bytes());
        // 只读目标：特定文案 + 无 .bak。
        let ro = dir.path().join("ro-models.yml");
        fs::write(&ro, sample()).unwrap();
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o444)).unwrap();
        let error = update_model_spec_impl(&bin, &busy, &ro, &request()).unwrap_err();
        assert_eq!(error.code, ErrorCode::Io, "{error:?}");
        assert!(error.message.contains("只读"), "{}", error.message);
        assert_eq!(bak_count(dir.path()), 0);
        assert_eq!(fs::read(&ro).unwrap(), sample().as_bytes());
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o644)).unwrap();
    }
}
