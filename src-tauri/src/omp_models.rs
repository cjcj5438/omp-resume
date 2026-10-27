//! 模型与 Agent 配置（CONTRACT §4.36–§4.38）：模型列表、白名单 config 读写、
//! agent 内置默认值。
//!
//! SECURITY：
//! - 只允许写 5 个白名单 key，另有 3 个只读白名单 key（兜底开关展示用）；
//!   其余一律 `INVALID_KEY`，且绝不调用 omp；
//! - 绝不读取 `~/.omp/agent/models.yml` / `models.json` 等含凭据文件，
//!   绝不运行 `omp config list`（会输出 token 类设置）；
//! - 任何 omp 输出都不写日志。
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::model::{
    AgentDefinition, AgentDetail, AgentSource, AppError, ErrorCode, ModelConfig, ModelInfo,
    RetryStatus, UpdateModelConfigResult,
};
use crate::omp_cli::{
    omp_not_found, require_success, resolve_omp, run_omp, strip_ansi, OmpBusy, CHECK_TIMEOUT,
};

pub const KEY_MODEL_ROLES: &str = "modelRoles";
pub const KEY_AGENT_OVERRIDES: &str = "task.agentModelOverrides";
pub const KEY_DISABLED_AGENTS: &str = "task.disabledAgents";
pub const KEY_AGENT_ADVISOR: &str = "task.agentAdvisor";
pub const KEY_FALLBACK_CHAINS: &str = "retry.fallbackChains";
/// 只读白名单 key（全局兜底状态展示）：可读不可写，写入同样报 `INVALID_KEY`。
pub const KEY_MODEL_FALLBACK: &str = "retry.modelFallback";
pub const KEY_FALLBACK_ON: &str = "retry.fallbackOn";
pub const KEY_FALLBACK_REVERT_POLICY: &str = "retry.fallbackRevertPolicy";

/// 可写白名单 5 个 key 与各自的值形状（写入校验按此执行；读取只校验外层形状）。
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

/// 可写白名单校验：不在 5 个可写 key 内的（含 3 个只读 key）一律 `INVALID_KEY`，
/// 调用方不得触碰 omp。
pub fn config_kind(key: &str) -> Result<ConfigKind, AppError> {
    match key {
        KEY_MODEL_ROLES | KEY_AGENT_OVERRIDES => Ok(ConfigKind::StringRecord),
        KEY_DISABLED_AGENTS => Ok(ConfigKind::StringArray),
        KEY_AGENT_ADVISOR => Ok(ConfigKind::OnOffRecord),
        KEY_FALLBACK_CHAINS => Ok(ConfigKind::StringListRecord),
        _ => Err(AppError::new(
            ErrorCode::InvalidKey,
            format!("不支持的配置键：{key}（只允许写白名单的 5 个模型配置键）"),
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
pub(crate) fn get_raw_value(bin: &Path, key: &str) -> Result<Value, AppError> {
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
pub(crate) fn get_shaped_value(bin: &Path, key: &str, kind: ConfigKind) -> Result<Value, AppError> {
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

/// 只读兜底状态的宽容读取：读不到或类型不符时返回 None（前端显示「未知」），
/// 不让整个 `get_model_config` 失败。
fn read_retry_status(bin: &Path) -> RetryStatus {
    let get = |key: &str| get_raw_value(bin, key).ok();
    RetryStatus {
        model_fallback: get(KEY_MODEL_FALLBACK).and_then(|v| v.as_bool()),
        fallback_on: get(KEY_FALLBACK_ON).and_then(|v| v.as_str().map(str::to_owned)),
        fallback_revert_policy: get(KEY_FALLBACK_REVERT_POLICY)
            .and_then(|v| v.as_str().map(str::to_owned)),
    }
}

/// record 类型整体覆盖写入（omp 不支持点号子键）：`omp config set <key> <紧凑 JSON>`。
pub(crate) fn set_raw_value(bin: &Path, key: &str, value: &Value) -> Result<(), AppError> {
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

/// 字符串标量整体覆盖写入：`omp config set <key> <原样字符串>`（不加 JSON 引号）。
/// 只用于 `defaultThinkingLevel` 这类枚举字符串标量，键名由调用方保证合法。
pub(crate) fn set_raw_string(bin: &Path, key: &str, value: &str) -> Result<(), AppError> {
    require_success(
        run_omp(
            bin,
            &["config", "set", key, value],
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
        let cost = |field: &str| {
            model
                .get("cost")
                .and_then(|cost| cost.get(field))
                .and_then(Value::as_f64)
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
            max_tokens: model.get("maxTokens").and_then(Value::as_u64),
            reasoning: model
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            input: model
                .get("input")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            cost_input: cost("input"),
            cost_output: cost("output"),
            cost_cache_read: cost("cacheRead"),
            cost_cache_write: cost("cacheWrite"),
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

/// agent md 的 frontmatter 抽取：只取 name / description / model / thinkingLevel /
/// tools / spawns；`output` 等嵌套结构原样忽略。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub model: Vec<String>,
    pub thinking_level: Option<String>,
    /// `None` = 未声明（omp 默认工具集）；`Some([])` = 显式无工具。
    pub tools: Option<Vec<String>>,
    /// `None` = 未声明；`Some(["*"])` = 可派生任意 agent。
    pub spawns: Option<Vec<String>>,
}

/// 需要按「块列表 / 行内列表」累积的字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListField {
    Model,
    Tools,
    Spawns,
}

/// 行内或单行列表值：`read, bash` / `["a", 'b']` → 去引号、去空项。
fn split_list(rest: &str) -> Vec<String> {
    let inner = rest
        .strip_prefix('[')
        .and_then(|r| r.strip_suffix(']'))
        .unwrap_or(rest);
    inner
        .split(',')
        .map(|item| crate::util::unquote(item.trim()))
        .filter(|item| !item.is_empty())
        .collect()
}

/// 手写轻量 frontmatter 解析：首行 `---` 到下一个 `---` 之间的顶层字段。
/// `model` 支持字符串、块列表与行内 `["a","b"]` 三种写法（字符串不按逗号拆）。
/// `tools` / `spawns` 支持块列表、逗号分隔与行内列表（`spawns: "*"` → `["*"]`）。
pub fn parse_frontmatter(text: &str) -> Option<Frontmatter> {
    // UTF-8 BOM：YAML 要求解析器忽略文件开头的 BOM，否则首行 `---` 识别失败。
    let mut lines = text.strip_prefix('\u{feff}').unwrap_or(text).lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut frontmatter = Frontmatter::default();
    let mut capture: Option<ListField> = None;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            if let Some(field) = capture {
                if let Some(item) = line.trim().strip_prefix("- ") {
                    let item = crate::util::unquote(item.trim());
                    if !item.is_empty() {
                        match field {
                            ListField::Model => frontmatter.model.push(item),
                            ListField::Tools => {
                                frontmatter.tools.get_or_insert_with(Vec::new).push(item)
                            }
                            ListField::Spawns => {
                                frontmatter.spawns.get_or_insert_with(Vec::new).push(item)
                            }
                        }
                    }
                }
            }
            continue;
        }
        capture = None;
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let rest = rest.trim();
        match key.trim() {
            "name" => {
                frontmatter.name = non_empty(crate::util::unquote(rest));
            }
            "description" => {
                frontmatter.description = non_empty(crate::util::unquote(rest));
            }
            "thinkingLevel" => {
                frontmatter.thinking_level = non_empty(crate::util::unquote(rest));
            }
            "model" => {
                if rest.is_empty() {
                    capture = Some(ListField::Model);
                } else if rest.starts_with('[') {
                    frontmatter.model = split_list(rest);
                } else {
                    frontmatter.model = vec![crate::util::unquote(rest)];
                }
            }
            "tools" => {
                if rest.is_empty() {
                    frontmatter.tools.get_or_insert_with(Vec::new);
                    capture = Some(ListField::Tools);
                } else {
                    frontmatter.tools = Some(split_list(rest));
                }
            }
            "spawns" => {
                if rest.is_empty() {
                    frontmatter.spawns.get_or_insert_with(Vec::new);
                    capture = Some(ListField::Spawns);
                } else {
                    frontmatter.spawns = Some(split_list(rest));
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

/// agent 定义（读取中间产物；输出前转成 `AgentDefinition` / `AgentDetail`）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AgentDef {
    pub name: String,
    pub description: String,
    pub model: Vec<String>,
    pub thinking_level: Option<String>,
    pub tools: Option<Vec<String>>,
    pub spawns: Option<Vec<String>>,
    /// frontmatter 之后的正文（= omp 的 `systemPrompt`）。
    pub system_prompt: String,
}

/// 系统提示词最多展示的字符数（内置 agent 都远小于此；防御异常大文件）。
const PROMPT_MAX_CHARS: usize = 64 * 1024;

/// frontmatter 之后的正文；无 frontmatter 时取全文。
fn agent_body(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    let starts_with_frontmatter = lines.next().is_some_and(|first| first.trim() == "---");
    let body = if starts_with_frontmatter {
        // 跳过首个 `---` 之后直到下一个独占一行的 `---`，其余即正文。
        let rest: Vec<&str> = lines
            .skip_while(|line| line.trim() != "---")
            .skip(1)
            .collect();
        rest.join("\n")
    } else {
        text.to_string()
    };
    let body = body.trim();
    if body.chars().count() > PROMPT_MAX_CHARS {
        let mut cut: String = body.chars().take(PROMPT_MAX_CHARS).collect();
        cut.push_str("\n…（已截断）");
        return cut;
    }
    body.to_string()
}

/// 解析单个 agent md；frontmatter 缺失/缺 name 时以文件名兜底。
pub fn parse_agent_file(text: &str, fallback_name: &str) -> AgentDef {
    let frontmatter = parse_frontmatter(text).unwrap_or_default();
    AgentDef {
        name: frontmatter.name.unwrap_or_else(|| fallback_name.to_owned()),
        description: frontmatter.description.unwrap_or_default(),
        model: frontmatter.model,
        thinking_level: frontmatter.thinking_level,
        tools: frontmatter.tools,
        spawns: frontmatter.spawns,
        system_prompt: agent_body(text),
    }
}

/// 合并内置与用户定义（读取顺序见 CONTRACT §4.37）：
/// `~/.omp/agent/agents/<name>.md` 存在则以它的 frontmatter 为默认值，
/// 否则取 unpack 出的内置定义；用户目录里多出的 agent 标记「自定义」。
pub fn merge_agent_details(builtin: &[AgentDef], user: &[AgentDef]) -> Vec<AgentDetail> {
    let detail = |def: &AgentDef, source: AgentSource| AgentDetail {
        name: def.name.clone(),
        description: def.description.clone(),
        source,
        default_model: def.model.clone(),
        default_thinking_level: def.thinking_level.clone(),
        tools: def.tools.clone(),
        spawns: def.spawns.clone(),
        system_prompt: def.system_prompt.clone(),
    };
    let mut result = Vec::new();
    for item in builtin {
        // 同名用户文件覆盖默认值，但 agent 仍算内置。
        let source = user.iter().find(|u| u.name == item.name).unwrap_or(item);
        result.push(detail(source, AgentSource::Builtin));
    }
    for item in user {
        if builtin.iter().any(|b| b.name == item.name) {
            continue;
        }
        result.push(detail(item, AgentSource::User));
    }
    result
}

/// `get_model_config` 用的精简视图：只保留展示字段（与 `merge_agent_details` 同规则）。
pub fn merge_agents(builtin: &[AgentDef], user: &[AgentDef]) -> Vec<AgentDefinition> {
    merge_agent_details(builtin, user)
        .into_iter()
        .map(AgentDefinition::from)
        .collect()
}

fn io_error(context: &str, e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("{context}：{e}"))
}

/// `omp agents unpack` 到临时目录并解析后删除临时目录。
fn unpack_builtin(bin: &Path) -> Result<Vec<AgentDef>, AppError> {
    let dir = crate::util::mk_secure_tempdir("omp-resume-agents")
        .map_err(|e| io_error("无法创建临时目录", e))?;
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

/// CONTRACT §4.37：白名单 5 个可写 key 逐个 `omp config get` + agent 默认值 +
/// 3 个只读兜底状态 key。
pub fn get_model_config_impl(bin: &Path, home: &Path) -> Result<ModelConfig, AppError> {
    let roles = read_object(bin, KEY_MODEL_ROLES)?;
    let agent_overrides = read_object(bin, KEY_AGENT_OVERRIDES)?;
    let disabled_agents = read_array(bin, KEY_DISABLED_AGENTS)?;
    let agent_advisor = read_object(bin, KEY_AGENT_ADVISOR)?;
    let fallback_chains = read_object(bin, KEY_FALLBACK_CHAINS)?;
    let retry_status = read_retry_status(bin);
    let agents = merge_agents(&builtin_agents(bin)?, &user_agents(home));
    Ok(ModelConfig {
        roles,
        agent_overrides,
        disabled_agents,
        agent_advisor,
        fallback_chains,
        retry_status,
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

/// CONTRACT §4.36：模型列表（精简字段，不含凭据）。可能较慢，前端缓存 + 刷新。
#[tauri::command]
pub async fn list_models() -> Result<Vec<ModelInfo>, AppError> {
    crate::blocking(|| {
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        list_models_impl(&bin)
    })
    .await
}

/// CONTRACT §4.37：模型角色 / agent 覆盖 / 禁用 / advisor / 回退链 + agent 默认值。
#[tauri::command]
pub async fn get_model_config() -> Result<ModelConfig, AppError> {
    crate::blocking(|| {
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        get_model_config_impl(&bin, &crate::util::home_dir())
    })
    .await
}

/// CONTRACT §4.59：agent 定义的完整只读视图（工具 / 派生 / 系统提示词）。
/// 与 `get_model_config` 共用内置定义缓存，绝不写任何 omp 配置。
#[tauri::command]
pub async fn list_agent_details() -> Result<Vec<AgentDetail>, AppError> {
    crate::blocking(|| {
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        Ok(merge_agent_details(
            &builtin_agents(&bin)?,
            &user_agents(&crate::util::home_dir()),
        ))
    })
    .await
}

/// CONTRACT §4.38：白名单 key 的读-比-写-复读。
#[tauri::command]
pub async fn update_model_config(
    app: tauri::AppHandle,
    key: String,
    value: Value,
    expected: Value,
) -> Result<UpdateModelConfigResult, AppError> {
    crate::blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        update_model_config_impl(&bin, &busy, &key, &value, &expected)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omp_fake::*;

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
        for key in [
            "nope.key",
            "modelRoles.plan",
            "apiKey",
            "",
            // 只读白名单 key：可读不可写，写入同样拒绝且不触碰 omp。
            KEY_MODEL_FALLBACK,
            KEY_FALLBACK_ON,
            KEY_FALLBACK_REVERT_POLICY,
        ] {
            assert!(config_kind(key).is_err(), "{key}");
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
    fn get_model_config_reads_retry_status_leniently() {
        let (tmp, bin) = fake_stateful();
        seed(tmp.path(), KEY_DISABLED_AGENTS, &serde_json::json!([]));
        seed(tmp.path(), KEY_MODEL_FALLBACK, &serde_json::json!(false));
        seed(
            tmp.path(),
            KEY_FALLBACK_ON,
            &serde_json::json!("usage-limit"),
        );
        seed(
            tmp.path(),
            KEY_FALLBACK_REVERT_POLICY,
            &serde_json::json!("never"),
        );
        let home = tempfile::tempdir().unwrap();
        let config = get_model_config_impl(&bin, home.path()).unwrap();
        assert_eq!(config.retry_status.model_fallback, Some(false));
        assert_eq!(
            config.retry_status.fallback_on.as_deref(),
            Some("usage-limit")
        );
        assert_eq!(
            config.retry_status.fallback_revert_policy.as_deref(),
            Some("never")
        );

        // 类型不符 → None，不让整个读取失败。
        seed(tmp.path(), KEY_MODEL_FALLBACK, &serde_json::json!("yes"));
        seed(tmp.path(), KEY_FALLBACK_ON, &serde_json::json!(42));
        let config = get_model_config_impl(&bin, home.path()).unwrap();
        assert_eq!(config.retry_status.model_fallback, None);
        assert_eq!(config.retry_status.fallback_on, None);
        // 未 seed 的 key 按假 omp 默认返回空对象 → None。
        let (tmp2, bin2) = fake_stateful();
        seed(tmp2.path(), KEY_DISABLED_AGENTS, &serde_json::json!([]));
        let config = get_model_config_impl(&bin2, tmp2.path()).unwrap();
        assert_eq!(config.retry_status.model_fallback, None);
        assert_eq!(config.retry_status.fallback_on, None);
        assert_eq!(config.retry_status.fallback_revert_policy, None);
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
        assert_eq!(models[0].max_tokens, Some(100));
        assert!(models[0].reasoning);
        assert_eq!(models[0].input, vec!["text"]);
        assert_eq!(models[0].cost_input, Some(0.3));
        assert_eq!(models[0].cost_output, Some(1.2));
        assert_eq!(models[0].cost_cache_read, Some(0.006));
        assert_eq!(models[0].cost_cache_write, Some(0.0));
        // 缺字段容忍：不猜、不报错。
        assert_eq!(models[1].thinking_levels, Vec::<String>::new());
        assert_eq!(models[1].context_window, None);
        assert_eq!(models[1].max_tokens, None);
        assert!(!models[1].reasoning);
        assert!(models[1].input.is_empty());
        assert_eq!(models[1].cost_input, None);
        assert_eq!(models[1].cost_cache_read, None);
        assert_eq!(models[1].cost_cache_write, None);
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
                ..AgentDef::default()
            },
            AgentDef {
                name: "scout".into(),
                description: "内置调研".into(),
                model: vec!["@smol".into()],
                thinking_level: Some("medium".into()),
                ..AgentDef::default()
            },
        ];
        let user = vec![
            AgentDef {
                name: "scout".into(),
                description: "用户改写".into(),
                model: vec!["5438/mimo-v2.6-pro".into()],
                thinking_level: None,
                ..AgentDef::default()
            },
            AgentDef {
                name: "deployer".into(),
                description: "用户自建".into(),
                model: vec![],
                thinking_level: None,
                ..AgentDef::default()
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
    fn frontmatter_parses_tools_and_spawns() {
        let block = parse_frontmatter(
            "---\nname: r\ntools:\n  - read\n  - grep\nspawns:\n  - scout\n---\nbody",
        )
        .unwrap();
        assert_eq!(
            block.tools,
            Some(vec!["read".to_owned(), "grep".to_owned()])
        );
        assert_eq!(block.spawns, Some(vec!["scout".to_owned()]));

        // 真实内置 `task.md` 的写法：任意派生。
        let star = parse_frontmatter("---\nname: t\nspawns: \"*\"\n---\n").unwrap();
        assert_eq!(star.spawns, Some(vec!["*".to_owned()]));
        assert_eq!(star.tools, None);

        // 逗号分隔与行内列表。
        let csv = parse_frontmatter("---\nname: c\ntools: read, bash\n---\n").unwrap();
        assert_eq!(csv.tools, Some(vec!["read".to_owned(), "bash".to_owned()]));
        let inline = parse_frontmatter("---\nname: i\ntools: [\"read\", 'lsp']\n---\n").unwrap();
        assert_eq!(
            inline.tools,
            Some(vec!["read".to_owned(), "lsp".to_owned()])
        );

        // `output` 下缩进的列表不能被吞进 tools。
        let nested = parse_frontmatter(
            "---\nname: o\ntools:\n  - read\noutput:\n  properties:\n    vague:\n      enum:\n        - correct\n---\n",
        )
        .unwrap();
        assert_eq!(nested.tools, Some(vec!["read".to_owned()]));
        assert_eq!(nested.spawns, None);
    }

    #[test]
    fn agent_file_body_is_system_prompt() {
        let def = parse_agent_file("---\nname: a\ntools:\n  - read\n---\n\nhello\n", "stem");
        assert_eq!(def.name, "a");
        assert_eq!(def.system_prompt, "hello");
        assert_eq!(def.tools, Some(vec!["read".to_owned()]));
        // 无 frontmatter：正文即全文；缺 name 用文件名。
        let plain = parse_agent_file("just text\n", "stem");
        assert_eq!(plain.name, "stem");
        assert_eq!(plain.system_prompt, "just text");
    }

    #[test]
    fn agent_file_with_bom_parses_frontmatter() {
        // 回归：UTF-8 BOM 不能破坏 frontmatter 识别（YAML 要求忽略 BOM）。
        let def = parse_agent_file(
            "\u{feff}---\nname: scout\ndescription: 调研\ntools:\n  - read\n---\n\n正文\n",
            "stem",
        );
        assert_eq!(def.name, "scout");
        assert_eq!(def.description, "调研");
        assert_eq!(def.tools, Some(vec!["read".to_owned()]));
        assert_eq!(def.system_prompt, "正文");
    }

    #[test]
    fn agent_details_merge_tools_and_prompt() {
        let builtin = vec![AgentDef {
            name: "scout".into(),
            description: "内置".into(),
            model: vec!["@smol".into()],
            tools: Some(vec!["read".into()]),
            system_prompt: "旧提示词".into(),
            ..AgentDef::default()
        }];
        let user = vec![
            AgentDef {
                name: "scout".into(),
                description: "用户改写".into(),
                tools: Some(vec!["read".into(), "grep".into()]),
                spawns: Some(vec!["*".into()]),
                system_prompt: "新提示词".into(),
                ..AgentDef::default()
            },
            AgentDef {
                name: "custom".into(),
                description: "自建".into(),
                ..AgentDef::default()
            },
        ];
        let merged = merge_agent_details(&builtin, &user);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "scout");
        assert_eq!(merged[0].source, AgentSource::Builtin);
        assert_eq!(
            merged[0].tools,
            Some(vec!["read".to_owned(), "grep".to_owned()])
        );
        assert_eq!(merged[0].spawns, Some(vec!["*".to_owned()]));
        assert_eq!(merged[0].system_prompt, "新提示词");
        assert_eq!(merged[1].name, "custom");
        assert_eq!(merged[1].source, AgentSource::User);
        assert_eq!(merged[1].tools, None);
        assert_eq!(merged[1].system_prompt, "");
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
