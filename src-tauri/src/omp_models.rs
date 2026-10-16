//! 模型与 Agent 配置（CONTRACT §4.36–§4.38）：模型列表、白名单 config 读写、
//! agent 内置默认值。
//!
//! SECURITY：
//! - 只允许读写 5 个白名单 key，其余一律 `INVALID_KEY`，且绝不调用 omp；
//! - 绝不读取 `~/.omp/agent/models.yml` / `models.json` 等含凭据文件，
//!   绝不运行 `omp config list`（会输出 token 类设置）；
//! - 任何 omp 输出都不写日志。
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::model::{
    AgentDefinition, AgentSource, AppError, ErrorCode, ModelConfig, ModelInfo,
    UpdateModelConfigResult,
};
use crate::omp_cli::{
    omp_not_found, require_success, resolve_omp, run_omp, strip_ansi, OmpBusy, CHECK_TIMEOUT,
};

pub const KEY_MODEL_ROLES: &str = "modelRoles";
pub const KEY_AGENT_OVERRIDES: &str = "task.agentModelOverrides";
pub const KEY_DISABLED_AGENTS: &str = "task.disabledAgents";
pub const KEY_AGENT_ADVISOR: &str = "task.agentAdvisor";
pub const KEY_FALLBACK_CHAINS: &str = "retry.fallbackChains";

/// 白名单 5 个 key 与各自的值形状（写入校验按此执行；读取只校验外层形状）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigKind {
    /// `角色|agent → provider/model[:thinking]` 字符串对象。
    StringRecord,
    /// `agent → "on"|"off"` 对象。
    OnOffRecord,
    /// 字符串数组。
    StringArray,
    /// `角色|selector → 有序 selector 字符串数组` 对象。
    StringListRecord,
}

/// 白名单校验：不在表内的 key 一律 `INVALID_KEY`，调用方不得触碰 omp。
pub fn config_kind(key: &str) -> Result<ConfigKind, AppError> {
    match key {
        KEY_MODEL_ROLES | KEY_AGENT_OVERRIDES => Ok(ConfigKind::StringRecord),
        KEY_DISABLED_AGENTS => Ok(ConfigKind::StringArray),
        KEY_AGENT_ADVISOR => Ok(ConfigKind::OnOffRecord),
        KEY_FALLBACK_CHAINS => Ok(ConfigKind::StringListRecord),
        _ => Err(AppError::new(
            ErrorCode::InvalidKey,
            format!("不支持的配置键：{key}（只允许读写白名单的 5 个模型配置键）"),
        )),
    }
}

fn invalid(message: String) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn as_record(value: &Value) -> Result<&Map<String, Value>, AppError> {
    value
        .as_object()
        .ok_or_else(|| invalid("配置值必须是对象".into()))
}

fn as_array(value: &Value) -> Result<&Vec<Value>, AppError> {
    value
        .as_array()
        .ok_or_else(|| invalid("配置值必须是数组".into()))
}

/// 写入前的值形状校验：omp 的 `config set` 只校验外层对象/数组，
/// 内层垃圾值会被静默写坏配置，因此由本应用校验拒绝。
pub fn validate_value(kind: ConfigKind, value: &Value) -> Result<(), AppError> {
    match kind {
        ConfigKind::StringRecord => {
            for (key, item) in as_record(value)? {
                if !item.is_string() {
                    return Err(invalid(format!(
                        "{key} 的值必须是字符串（provider/model[:thinking]）"
                    )));
                }
            }
        }
        ConfigKind::OnOffRecord => {
            for (key, item) in as_record(value)? {
                if !matches!(item.as_str(), Some("on") | Some("off")) {
                    return Err(invalid(format!("{key} 的值只能是 on 或 off")));
                }
            }
        }
        ConfigKind::StringArray => {
            for item in as_array(value)? {
                if !item.is_string() {
                    return Err(invalid("禁用列表的每一项必须是 agent 名称字符串".into()));
                }
            }
        }
        ConfigKind::StringListRecord => {
            for (key, item) in as_record(value)? {
                let list = item
                    .as_array()
                    .ok_or_else(|| invalid(format!("{key} 的值必须是有序 selector 字符串数组")))?;
                for entry in list {
                    if !entry.is_string() {
                        return Err(invalid(format!("{key} 的值必须是有序 selector 字符串数组")));
                    }
                }
            }
        }
    }
    Ok(())
}

/// 读取一个 key 的原始值（`omp config get <key> --json`）。
fn get_raw_value(bin: &Path, key: &str) -> Result<Value, AppError> {
    let output = require_success(
        run_omp(
            bin,
            &["config", "get", key, "--json"],
            CHECK_TIMEOUT,
            &mut |_| {},
        )?,
        "读取模型配置失败",
    )?;
    let parsed: Value = serde_json::from_str(&strip_ansi(&output)).map_err(|_| {
        AppError::new(
            ErrorCode::OmpFailed,
            format!("无法解析 omp config get 的输出（{key}）"),
        )
    })?;
    parsed.get("value").cloned().ok_or_else(|| {
        AppError::new(
            ErrorCode::OmpFailed,
            format!("omp config get 输出缺少 value（{key}）"),
        )
    })
}

/// 读取并校验外层形状：record 必须是对象、array 必须是数组；内层值原样保留。
fn get_shaped_value(bin: &Path, key: &str, kind: ConfigKind) -> Result<Value, AppError> {
    let value = get_raw_value(bin, key)?;
    let shape_ok = match kind {
        ConfigKind::StringArray => value.is_array(),
        _ => value.is_object(),
    };
    if !shape_ok {
        return Err(AppError::new(
            ErrorCode::OmpFailed,
            format!("{key} 的配置值形状异常，请手动检查 omp 配置"),
        ));
    }
    Ok(value)
}

fn read_object(bin: &Path, key: &str) -> Result<Map<String, Value>, AppError> {
    let value = get_shaped_value(bin, key, ConfigKind::StringRecord)?;
    Ok(value.as_object().cloned().unwrap_or_default())
}

fn read_array(bin: &Path, key: &str) -> Result<Vec<Value>, AppError> {
    let value = get_shaped_value(bin, key, ConfigKind::StringArray)?;
    Ok(value.as_array().cloned().unwrap_or_default())
}

/// record 类型整体覆盖写入（omp 不支持点号子键）：`omp config set <key> <紧凑 JSON>`。
fn set_raw_value(bin: &Path, key: &str, value: &Value) -> Result<(), AppError> {
    let compact =
        serde_json::to_string(value).map_err(|e| invalid(format!("配置值无法序列化：{e}")))?;
    require_success(
        run_omp(
            bin,
            &["config", "set", key, &compact],
            CHECK_TIMEOUT,
            &mut |_| {},
        )?,
        "写入模型配置失败",
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

/// 解析 `omp models --json` 输出的精简字段；缺字段容忍，无 selector 的条目跳过。
pub fn parse_models_json(output: &str) -> Result<Vec<ModelInfo>, String> {
    let parsed: Value = serde_json::from_str(&strip_ansi(output)).map_err(|e| e.to_string())?;
    let models = parsed
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "缺少 models 数组".to_owned())?;
    let mut list = Vec::new();
    for model in models {
        let Some(selector) = model.get("selector").and_then(Value::as_str) else {
            continue;
        };
        let text = |field: &str| {
            model
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        list.push(ModelInfo {
            selector: selector.to_owned(),
            provider: text("provider"),
            id: text("id"),
            name: text("name"),
            thinking_levels: model
                .get("thinking")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            context_window: model.get("contextWindow").and_then(Value::as_u64),
            reasoning: model
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            cost_input: model
                .get("cost")
                .and_then(|cost| cost.get("input"))
                .and_then(Value::as_f64),
            cost_output: model
                .get("cost")
                .and_then(|cost| cost.get("output"))
                .and_then(Value::as_f64),
        });
    }
    Ok(list)
}

/// `omp models --json`（只重跑 list，绝不运行 `omp models refresh`）。
pub fn list_models_impl(bin: &Path) -> Result<Vec<ModelInfo>, AppError> {
    let output = require_success(
        run_omp(bin, &["models", "--json"], CHECK_TIMEOUT, &mut |_| {})?,
        "读取模型列表失败",
    )?;
    parse_models_json(&output).map_err(|e| {
        AppError::new(
            ErrorCode::OmpFailed,
            format!("无法解析 omp models 输出：{e}"),
        )
    })
}

// ---------------------------------------------------------------------------
// agent 定义（frontmatter 轻量解析）
// ---------------------------------------------------------------------------

/// agent md 的 frontmatter 抽取：只取 name / description / model / thinkingLevel。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub model: Vec<String>,
    pub thinking_level: Option<String>,
}

/// YAML 标量：剥掉成对引号（双引号处理 `\\` `\"` `\n`，单引号处理 `''`）。
fn scalar(raw: &str) -> String {
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

/// 手写轻量 frontmatter 解析：首行 `---` 到下一个 `---` 之间的顶层字段。
/// 只处理目标 4 个键，其余键（tools/output 等嵌套结构）原样忽略。
/// `model` 支持字符串、块列表与行内 `["a","b"]` 三种写法。
pub fn parse_frontmatter(text: &str) -> Option<Frontmatter> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut frontmatter = Frontmatter::default();
    let mut capture_model = false;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            if capture_model {
                if let Some(item) = line.trim().strip_prefix("- ") {
                    frontmatter.model.push(scalar(item));
                }
            }
            continue;
        }
        capture_model = false;
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let rest = rest.trim();
        match key.trim() {
            "name" => {
                frontmatter.name = non_empty(scalar(rest));
            }
            "description" => {
                frontmatter.description = non_empty(scalar(rest));
            }
            "thinkingLevel" => {
                frontmatter.thinking_level = non_empty(scalar(rest));
            }
            "model" => {
                if rest.is_empty() {
                    capture_model = true;
                } else if let Some(items) = rest.strip_prefix('[').and_then(|r| r.strip_suffix(']'))
                {
                    frontmatter.model = items
                        .split(',')
                        .map(scalar)
                        .filter(|item| !item.is_empty())
                        .collect();
                } else {
                    frontmatter.model = vec![scalar(rest)];
                }
            }
            _ => {}
        }
    }
    Some(frontmatter)
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

/// agent 定义（读取中间产物；输出前转成 `AgentDefinition`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDef {
    pub name: String,
    pub description: String,
    pub model: Vec<String>,
    pub thinking_level: Option<String>,
}

/// 解析单个 agent md；frontmatter 缺失/缺 name 时以文件名兜底。
pub fn parse_agent_file(text: &str, fallback_name: &str) -> AgentDef {
    let frontmatter = parse_frontmatter(text).unwrap_or_default();
    AgentDef {
        name: frontmatter.name.unwrap_or_else(|| fallback_name.to_owned()),
        description: frontmatter.description.unwrap_or_default(),
        model: frontmatter.model,
        thinking_level: frontmatter.thinking_level,
    }
}

/// 合并内置与用户定义（读取顺序见 CONTRACT §4.37）：
/// `~/.omp/agent/agents/<name>.md` 存在则以它的 frontmatter 为默认值，
/// 否则取 unpack 出的内置定义；用户目录里多出的 agent 标记「自定义」。
pub fn merge_agents(builtin: &[AgentDef], user: &[AgentDef]) -> Vec<AgentDefinition> {
    let mut result = Vec::new();
    for item in builtin {
        let source = user.iter().find(|u| u.name == item.name).unwrap_or(item);
        result.push(AgentDefinition {
            name: item.name.clone(),
            description: source.description.clone(),
            source: AgentSource::Builtin,
            default_model: source.model.clone(),
            default_thinking_level: source.thinking_level.clone(),
        });
    }
    for item in user {
        if builtin.iter().any(|b| b.name == item.name) {
            continue;
        }
        result.push(AgentDefinition {
            name: item.name.clone(),
            description: item.description.clone(),
            source: AgentSource::User,
            default_model: item.model.clone(),
            default_thinking_level: item.thinking_level.clone(),
        });
    }
    result
}

fn io_error(context: &str, e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("{context}：{e}"))
}

/// `omp agents unpack` 到临时目录并解析后删除临时目录。
fn unpack_builtin(bin: &Path) -> Result<Vec<AgentDef>, AppError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir =
        std::env::temp_dir().join(format!("omp-resume-agents-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| io_error("无法创建临时目录", e))?;
    let dir_arg = dir.to_string_lossy().into_owned();
    let run = run_omp(
        bin,
        &["agents", "unpack", "--dir", &dir_arg, "--json"],
        CHECK_TIMEOUT,
        &mut |_| {},
    );
    let result = run.and_then(|output| require_success(output, "导出内置 agent 定义失败"));
    let defs = result.and_then(|_| read_agent_dir(&dir));
    let _ = std::fs::remove_dir_all(&dir);
    defs
}

fn read_agent_dir(dir: &Path) -> Result<Vec<AgentDef>, AppError> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| io_error("读取 agent 目录失败", e))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .collect();
    paths.sort();
    let mut defs = Vec::new();
    for path in &paths {
        let text = std::fs::read_to_string(path).map_err(|e| io_error("读取 agent 定义失败", e))?;
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        defs.push(parse_agent_file(&text, &stem));
    }
    Ok(defs)
}

/// 用户自建 / 覆盖的 agent 定义（`~/.omp/agent/agents/*.md`，仅 user scope）。
/// 目录不存在或读取失败时静默为空，不影响内置定义。
fn user_agents(home: &Path) -> Vec<AgentDef> {
    let Ok(entries) = std::fs::read_dir(home.join(".omp/agent/agents")) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .collect();
    paths.sort();
    paths
        .iter()
        .filter_map(|path| {
            let text = std::fs::read_to_string(path).ok()?;
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            Some(parse_agent_file(&text, &stem))
        })
        .collect()
}

/// 内置定义按 omp 版本（与二进制路径）缓存在进程内，避免重复 unpack。
static BUILTIN_CACHE: Mutex<Option<(String, Vec<AgentDef>)>> = Mutex::new(None);

fn builtin_agents(bin: &Path) -> Result<Vec<AgentDef>, AppError> {
    let version = crate::omp_cli::omp_version_impl(Some(bin))?
        .version
        .unwrap_or_default();
    let cache_key = format!("{}|{version}", bin.display());
    if let Ok(cache) = BUILTIN_CACHE.lock() {
        if let Some((key, defs)) = &*cache {
            if *key == cache_key {
                return Ok(defs.clone());
            }
        }
    }
    let defs = unpack_builtin(bin)?;
    if let Ok(mut cache) = BUILTIN_CACHE.lock() {
        *cache = Some((cache_key, defs.clone()));
    }
    Ok(defs)
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

/// CONTRACT §4.37：白名单 5 个 key 逐个 `omp config get` + agent 默认值。
pub fn get_model_config_impl(bin: &Path, home: &Path) -> Result<ModelConfig, AppError> {
    let roles = read_object(bin, KEY_MODEL_ROLES)?;
    let agent_overrides = read_object(bin, KEY_AGENT_OVERRIDES)?;
    let disabled_agents = read_array(bin, KEY_DISABLED_AGENTS)?;
    let agent_advisor = read_object(bin, KEY_AGENT_ADVISOR)?;
    let fallback_chains = read_object(bin, KEY_FALLBACK_CHAINS)?;
    let agents = merge_agents(&builtin_agents(bin)?, &user_agents(home));
    Ok(ModelConfig {
        roles,
        agent_overrides,
        disabled_agents,
        agent_advisor,
        fallback_chains,
        agents,
    })
}

/// CONTRACT §4.38：复读该 key 与 `expected` 深度比较，一致才整体覆盖写入，
/// 写后再读校验并返回新值。整体持有 `OmpBusy` 单写门禁（多余请求报 `BUSY`）。
pub fn update_model_config_impl(
    bin: &Path,
    busy: &OmpBusy,
    key: &str,
    value: &Value,
    expected: &Value,
) -> Result<UpdateModelConfigResult, AppError> {
    let kind = config_kind(key)?;
    validate_value(kind, value)?;
    let _guard = busy.try_acquire()?;
    let current = get_shaped_value(bin, key, kind)?;
    if &current != expected {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "配置已被外部修改，请刷新后重试",
        ));
    }
    set_raw_value(bin, key, value)?;
    let new_value = get_shaped_value(bin, key, kind)?;
    Ok(UpdateModelConfigResult {
        key: key.to_owned(),
        value: new_value,
    })
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// CONTRACT §4.36：模型列表（精简字段，不含凭据）。可能较慢，前端缓存 + 刷新。
#[tauri::command]
pub async fn list_models() -> Result<Vec<ModelInfo>, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        list_models_impl(&bin)
    })
    .await
    .map_err(crate::io_join_error)?
}

/// CONTRACT §4.37：模型角色 / agent 覆盖 / 禁用 / advisor / 回退链 + agent 默认值。
#[tauri::command]
pub async fn get_model_config() -> Result<ModelConfig, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        get_model_config_impl(&bin, &home_dir())
    })
    .await
    .map_err(crate::io_join_error)?
}

/// CONTRACT §4.38：白名单 key 的读-比-写-复读。
#[tauri::command]
pub async fn update_model_config(
    app: tauri::AppHandle,
    key: String,
    value: Value,
    expected: Value,
) -> Result<UpdateModelConfigResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        update_model_config_impl(&bin, &busy, &key, &value, &expected)
    })
    .await
    .map_err(crate::io_join_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn write_fake(dir: &Path, body: &str) -> PathBuf {
        let bin = dir.join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    /// 有状态假 omp：`config get/set` 以临时目录内文件模拟 config，
    /// 并把每次 set 的参数记入日志；`agents unpack` 写两个 agent md；
    /// `--version` 固定；任何未识别子命令都失败。返回 (状态目录, 二进制)。
    fn fake_stateful() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        let log = dir.path().join("sets.log");
        let body = format!(
            r#"STATE="{state}"
LOG="{log}"
if [ "$1" = "--version" ]; then echo "omp/99.0.0-test"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  if [ -f "$STATE/$3" ]; then cat "$STATE/$3"; else printf '{{"key":"%s","value":{{}},"type":"record"}}' "$3"; fi
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "set" ]; then
  printf '{{"key":"%s","value":%s,"type":"x"}}' "$3" "$4" > "$STATE/$3"
  printf '%s %s\n' "$3" "$4" >> "$LOG"
  exit 0
fi
if [ "$1" = "agents" ]; then
  mkdir -p "$4"
  printf '%s\n' '---' 'name: task' 'description: 总控' 'model:' '  - "@task"' 'thinkingLevel: auto' '---' 'body' > "$4/task.md"
  printf '%s\n' '---' 'name: scout' 'description: 调研' 'model: "@smol"' 'thinkingLevel: medium' '---' 'body' > "$4/scout.md"
  printf '{{"targetDir":"%s","total":2,"written":[],"skipped":[]}}\n' "$4"
  exit 0
fi
echo "unexpected: $*" >&2
exit 1"#,
            state = state.display(),
            log = log.display(),
        );
        let bin = dir.path().join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, bin)
    }

    /// 被调用即在 `invoked` 文件留痕，用于断言「绝不触碰 omp」。
    fn fake_with_marker() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("invoked");
        let body = format!("echo invoked >> \"{}\"", marker.display());
        let bin = write_fake(dir.path(), &body);
        (dir, bin, marker)
    }

    fn seed(tmp: &Path, key: &str, value: &Value) {
        std::fs::write(
            tmp.join("state").join(key),
            serde_json::json!({"key": key, "value": value, "type": "record"}).to_string(),
        )
        .unwrap();
    }

    fn set_log(tmp: &Path) -> String {
        std::fs::read_to_string(tmp.join("sets.log")).unwrap_or_default()
    }

    #[test]
    fn whitelist_rejects_unknown_keys_without_touching_omp() {
        for key in [
            KEY_MODEL_ROLES,
            KEY_AGENT_OVERRIDES,
            KEY_DISABLED_AGENTS,
            KEY_AGENT_ADVISOR,
            KEY_FALLBACK_CHAINS,
        ] {
            assert!(config_kind(key).is_ok(), "{key}");
        }
        let (_tmp, bin, marker) = fake_with_marker();
        for key in ["nope.key", "modelRoles.plan", "apiKey", ""] {
            let err = update_model_config_impl(
                &bin,
                &OmpBusy::default(),
                key,
                &serde_json::json!({}),
                &serde_json::json!({}),
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidKey, "{key}");
        }
        assert!(!marker.exists(), "白名单拒绝后不得调用 omp");
    }

    #[test]
    fn update_detects_conflict_and_preserves_unknown_record_keys() {
        let (tmp, bin) = fake_stateful();
        seed(
            tmp.path(),
            KEY_MODEL_ROLES,
            &serde_json::json!({"default": "a/b"}),
        );

        // expected 与现值不一致 → CONFLICT，且绝不写入。
        let err = update_model_config_impl(
            &bin,
            &OmpBusy::default(),
            KEY_MODEL_ROLES,
            &serde_json::json!({"default": "c/d"}),
            &serde_json::json!({"default": "zz"}),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(set_log(tmp.path()), "");

        // expected 一致 → 整体覆盖写入；不认识的 key 原样保留。
        let written =
            serde_json::json!({"default": "c/d:high", "custom-role": "typesafe/jev-latest"});
        let result = update_model_config_impl(
            &bin,
            &OmpBusy::default(),
            KEY_MODEL_ROLES,
            &written,
            &serde_json::json!({"default": "a/b"}),
        )
        .unwrap();
        assert_eq!(result.key, KEY_MODEL_ROLES);
        assert_eq!(result.value, written, "写后复读应等于写入值");
        let log = set_log(tmp.path());
        assert_eq!(log.lines().count(), 1);
        assert!(
            log.contains("\"custom-role\":\"typesafe/jev-latest\""),
            "{log}"
        );

        // 旧 expected 再写 → CONFLICT（现值已是新值）。
        let err = update_model_config_impl(
            &bin,
            &OmpBusy::default(),
            KEY_MODEL_ROLES,
            &written,
            &serde_json::json!({"default": "a/b"}),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(set_log(tmp.path()).lines().count(), 1);
    }

    #[test]
    fn write_rejects_bad_values_before_touching_omp() {
        let (_tmp, bin, marker) = fake_with_marker();
        let cases = [
            (KEY_MODEL_ROLES, serde_json::json!({"a": 1}), "字符串"),
            (KEY_MODEL_ROLES, serde_json::json!(["a"]), "对象"),
            (
                KEY_AGENT_OVERRIDES,
                serde_json::json!({"a": {"b": 1}}),
                "字符串",
            ),
            (KEY_AGENT_ADVISOR, serde_json::json!({"a": "bogus"}), "on"),
            (KEY_AGENT_ADVISOR, serde_json::json!({"a": 1}), "on"),
            (KEY_DISABLED_AGENTS, serde_json::json!({"a": 1}), "数组"),
            (
                KEY_DISABLED_AGENTS,
                serde_json::json!(["a", 1]),
                "agent 名称",
            ),
            (KEY_FALLBACK_CHAINS, serde_json::json!({"a": "b"}), "数组"),
            (
                KEY_FALLBACK_CHAINS,
                serde_json::json!({"a": ["b", 2]}),
                "数组",
            ),
        ];
        for (key, value, expect) in cases {
            let err = update_model_config_impl(
                &bin,
                &OmpBusy::default(),
                key,
                &value,
                &serde_json::json!({}),
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{key} {value}");
            assert!(
                err.message.contains(expect),
                "{key} {value} {}",
                err.message
            );
        }
        for (key, value) in [
            (KEY_MODEL_ROLES, serde_json::json!({"a": "@smol"})),
            (
                KEY_AGENT_ADVISOR,
                serde_json::json!({"a": "on", "b": "off"}),
            ),
            (KEY_DISABLED_AGENTS, serde_json::json!(["sonic"])),
            (
                KEY_FALLBACK_CHAINS,
                serde_json::json!({"default": ["a/b", "c/d:high"]}),
            ),
        ] {
            validate_value(config_kind(key).unwrap(), &value).unwrap();
        }
        assert!(!marker.exists(), "非法值拒绝后不得调用 omp");
    }

    #[test]
    fn busy_gate_rejects_second_writer() {
        let (tmp, bin) = fake_stateful();
        seed(tmp.path(), KEY_DISABLED_AGENTS, &serde_json::json!([]));
        let busy = OmpBusy::default();
        let guard = busy.try_acquire().unwrap();
        let err = update_model_config_impl(
            &bin,
            &busy,
            KEY_DISABLED_AGENTS,
            &serde_json::json!([]),
            &serde_json::json!([]),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Busy);
        drop(guard);
    }

    #[test]
    fn parse_models_json_keeps_brief_fields_and_tolerates_missing() {
        let json = r#"{"models":[
            {"provider":"p1","kind":"chat","id":"m1","selector":"p1/m1","name":"M1",
             "contextWindow":1000,"maxTokens":100,"reasoning":true,
             "thinking":["low","high"],"input":["text"],
             "cost":{"input":0.3,"output":1.2,"cacheRead":0.006,"cacheWrite":0},
             "pricingStatus":"fixed"},
            {"selector":"p2/m2"},
            {"id":"no-selector"}
        ]}"#;
        let models = parse_models_json(json).unwrap();
        assert_eq!(models.len(), 2, "无 selector 条目跳过");
        assert_eq!(models[0].selector, "p1/m1");
        assert_eq!(models[0].thinking_levels, vec!["low", "high"]);
        assert_eq!(models[0].context_window, Some(1000));
        assert!(models[0].reasoning);
        assert_eq!(models[0].cost_input, Some(0.3));
        assert_eq!(models[0].cost_output, Some(1.2));
        // 缺字段容忍：不猜、不报错。
        assert_eq!(models[1].thinking_levels, Vec::<String>::new());
        assert_eq!(models[1].context_window, None);
        assert!(!models[1].reasoning);
        assert_eq!(models[1].cost_input, None);
        assert!(parse_models_json("{\"oops\":1}").is_err());
        assert!(parse_models_json("not json").is_err());
    }

    #[test]
    fn frontmatter_parses_model_as_string_or_array() {
        let string_form = parse_frontmatter(
            "---\nname: scout\ndescription: \"快: 调研\"\nmodel: \"@smol\"\nthinkingLevel: medium\n---\nbody",
        )
        .unwrap();
        assert_eq!(string_form.name.as_deref(), Some("scout"));
        assert_eq!(string_form.description.as_deref(), Some("快: 调研"));
        assert_eq!(string_form.model, vec!["@smol"]);
        assert_eq!(string_form.thinking_level.as_deref(), Some("medium"));

        let array_form = parse_frontmatter(
            "---\nname: task\ndescription: 'it''s fine'\nmodel:\n  - \"@task\"\n  - 5438/mimo-v2.6-pro\n---\nbody",
        )
        .unwrap();
        assert_eq!(array_form.description.as_deref(), Some("it's fine"));
        assert_eq!(
            array_form.model,
            vec!["@task".to_owned(), "5438/mimo-v2.6-pro".to_owned()]
        );
        assert_eq!(array_form.thinking_level, None);

        let inline_form = parse_frontmatter("---\nname: x\nmodel: [\"@a\", '@b']\n---\n").unwrap();
        assert_eq!(inline_form.model, vec!["@a", "@b"]);

        let none_form =
            parse_frontmatter("---\nname: y\ntools:\n  - read\n  - bash\n---\n").unwrap();
        assert_eq!(none_form.model, Vec::<String>::new());
        assert_eq!(parse_frontmatter("no frontmatter"), None);
    }

    #[test]
    fn agent_defaults_follow_user_override_then_builtin() {
        let builtin = vec![
            AgentDef {
                name: "task".into(),
                description: "内置总控".into(),
                model: vec!["@task".into()],
                thinking_level: Some("auto".into()),
            },
            AgentDef {
                name: "scout".into(),
                description: "内置调研".into(),
                model: vec!["@smol".into()],
                thinking_level: Some("medium".into()),
            },
        ];
        let user = vec![
            AgentDef {
                name: "scout".into(),
                description: "用户改写".into(),
                model: vec!["5438/mimo-v2.6-pro".into()],
                thinking_level: None,
            },
            AgentDef {
                name: "deployer".into(),
                description: "用户自建".into(),
                model: vec![],
                thinking_level: None,
            },
        ];
        let merged = merge_agents(&builtin, &user);
        assert_eq!(merged.len(), 3);
        // 内置顺序保持；用户文件覆盖默认值但 agent 仍是内置。
        assert_eq!(merged[0].name, "task");
        assert_eq!(merged[0].source, AgentSource::Builtin);
        assert_eq!(merged[0].default_model, vec!["@task"]);
        assert_eq!(merged[0].default_thinking_level.as_deref(), Some("auto"));
        assert_eq!(merged[1].name, "scout");
        assert_eq!(merged[1].source, AgentSource::Builtin);
        assert_eq!(merged[1].description, "用户改写");
        assert_eq!(merged[1].default_model, vec!["5438/mimo-v2.6-pro"]);
        assert_eq!(merged[1].default_thinking_level, None);
        // 用户自建 agent 排在内置之后并标「自定义」。
        assert_eq!(merged[2].name, "deployer");
        assert_eq!(merged[2].source, AgentSource::User);
    }

    #[test]
    fn model_config_reads_whitelist_and_agent_defaults() {
        let (tmp, bin) = fake_stateful();
        let dir = tmp.path();
        seed(
            dir,
            KEY_MODEL_ROLES,
            &serde_json::json!({"default": "@smol", "judge": "typesafe/jev-latest"}),
        );
        seed(
            dir,
            KEY_AGENT_OVERRIDES,
            &serde_json::json!({"sonic": "5438/mimo-v2.6-pro"}),
        );
        seed(dir, KEY_DISABLED_AGENTS, &serde_json::json!(["scout"]));
        seed(dir, KEY_AGENT_ADVISOR, &serde_json::json!({"sonic": "on"}));
        seed(
            dir,
            KEY_FALLBACK_CHAINS,
            &serde_json::json!({"default": ["5438/mimo-v2.6-pro", "factory-droid/gpt-6.1-sol"]}),
        );
        // 用户 HOME：覆盖 scout、新增 deployer。
        let home = dir.join("home");
        std::fs::create_dir_all(home.join(".omp/agent/agents")).unwrap();
        std::fs::write(
            home.join(".omp/agent/agents/scout.md"),
            "---\nname: scout\ndescription: 用户改写\nmodel: \"5438/mimo-v2.6-pro\"\nthinkingLevel: high\n---\n",
        )
        .unwrap();
        std::fs::write(
            home.join(".omp/agent/agents/deployer.md"),
            "---\nname: deployer\ndescription: 用户自建\nmodel:\n  - \"@smol\"\n---\n",
        )
        .unwrap();

        let config = get_model_config_impl(&bin, &home).unwrap();
        // 未知/别名值原样保留，不做任何改写。
        assert_eq!(config.roles["default"], serde_json::json!("@smol"));
        assert_eq!(
            config.roles["judge"],
            serde_json::json!("typesafe/jev-latest")
        );
        assert_eq!(config.disabled_agents, vec![serde_json::json!("scout")]);
        assert_eq!(
            config.fallback_chains["default"],
            serde_json::json!(["5438/mimo-v2.6-pro", "factory-droid/gpt-6.1-sol"])
        );
        // agent：内置 unpack 两个 + 用户自建一个；scout 默认值来自用户文件。
        let names: Vec<&str> = config.agents.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["scout", "task", "deployer"]);
        let scout = config.agents.iter().find(|a| a.name == "scout").unwrap();
        assert_eq!(scout.source, AgentSource::Builtin);
        assert_eq!(scout.description, "用户改写");
        assert_eq!(scout.default_model, vec!["5438/mimo-v2.6-pro"]);
        assert_eq!(scout.default_thinking_level.as_deref(), Some("high"));
        let task = config.agents.iter().find(|a| a.name == "task").unwrap();
        assert_eq!(task.default_model, vec!["@task"]);
        assert_eq!(task.default_thinking_level.as_deref(), Some("auto"));
        let deployer = config.agents.iter().find(|a| a.name == "deployer").unwrap();
        assert_eq!(deployer.source, AgentSource::User);
        assert_eq!(deployer.default_model, vec!["@smol"]);

        // 形状异常的外层值报 OmpFailed，不猜。
        seed(
            dir,
            KEY_DISABLED_AGENTS,
            &serde_json::json!({"not": "array"}),
        );
        let err = get_model_config_impl(&bin, &home).unwrap_err();
        assert_eq!(err.code, ErrorCode::OmpFailed);
        assert!(err.message.contains(KEY_DISABLED_AGENTS), "{}", err.message);
    }
}
