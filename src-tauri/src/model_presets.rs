//! 模型「模式」（omp `modelPresets`）：整套模型配置的快照、切换、保存与删除。
//!
//! 存储格式（定稿）：
//! ```json
//! { "A": { "modelRoles": {...}, "defaultThinkingLevel": "high",
//!          "agentModelOverrides": {...} } }
//! ```
//! 前两个字段 omp 原生支持（终端 `/modelpreset` 通用）；`agentModelOverrides`
//! 是本应用的扩展字段，omp 会忽略它，`/modelpreset save` 覆盖条目时会丢掉它。
//!
//! 健壮性约定（与 `omp_models` 一致）：
//! - 写操作先校验输入，再拿 `OmpBusy` 单写门禁，然后「读 → 与 expected 比对 →
//!   写 → 重读」，多键写入带回滚日志；
//! - 任何路径都不写日志到磁盘、不打印 omp 输出（可能含凭据）。
use std::path::Path;

use serde_json::{Map, Value};

use crate::model::{AppError, ErrorCode, ModelPreset, ModelPresetSnapshot, ModelPresetsState};
use crate::omp_cli::{omp_not_found, resolve_omp, OmpBusy};
use crate::omp_models::{
    get_raw_value, get_shaped_value, list_models_impl, set_raw_string, set_raw_value, ConfigKind,
    KEY_AGENT_OVERRIDES, KEY_MODEL_ROLES,
};

/// omp 的 `modelPresets` 配置键。
pub const KEY_MODEL_PRESETS: &str = "modelPresets";
/// 默认推理档位配置键（顶层字符串标量）。
pub const KEY_DEFAULT_THINKING_LEVEL: &str = "defaultThinkingLevel";

/// omp 接受的推理档位全集；超出即为无效条目。
pub const THINKING_LEVELS: [&str; 7] = ["minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/// 模式名长度上限（omp 只限制字符集，这里额外给 UI 一个边界）。
pub const NAME_MAX: usize = 64;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn omp_failed(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OmpFailed, message)
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/// 模式名校验：与 omp `/modelpreset` 完全一致（`^[a-zA-Z][\w-]*$`）+ 长度 ≤ 64。
/// 手写字符判断，不引入 regex 依赖。
pub fn validate_preset_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(invalid("模式名不能为空"));
    }
    if name.chars().count() > NAME_MAX {
        return Err(invalid(format!(
            "模式名不能超过 {NAME_MAX} 个字符（当前 {} 个）",
            name.chars().count()
        )));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap_or(' ');
    let head_ok = first.is_ascii_alphabetic();
    let tail_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !head_ok || !tail_ok {
        return Err(invalid(
            "模式名需以字母开头，只能包含字母、数字、- 或 _（与 omp /modelpreset 通用）",
        ));
    }
    Ok(())
}

/// 只保留值为非空字符串的键（用于把「原值」和「预设值」放在同一口径上比较）。
pub fn non_empty_strings(value: &Value) -> Map<String, Value> {
    value
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(_, v)| v.as_str().is_some_and(|s| !s.trim().is_empty()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// selector 去掉尾部 `:thinking`（与 `src/modelConfig.ts::parseSelectorValue` 同规则）。
pub fn selector_base(value: &str) -> &str {
    match value.rfind(':') {
        Some(at) if at > 0 => {
            let tail = &value[at + 1..];
            let ok = !tail.is_empty()
                && tail
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            if ok {
                &value[..at]
            } else {
                value
            }
        }
        _ => value,
    }
}

fn string_record_reason(value: &Value) -> Option<String> {
    let map = match value.as_object() {
        Some(map) => map,
        None => return Some("不是映射".into()),
    };
    for (key, item) in map {
        match item.as_str() {
            Some(text) if !text.trim().is_empty() => {}
            _ => return Some(format!("{key} 的值不是非空字符串")),
        }
    }
    None
}

/// 宽容解析 `modelPresets`：条目格式问题记进 `invalid_reason`，绝不整体失败。
pub fn parse_presets(raw: &Value) -> Vec<ModelPreset> {
    let empty = Map::new();
    let map = raw.as_object().unwrap_or(&empty);
    let mut out: Vec<ModelPreset> = map
        .iter()
        .map(|(name, entry)| {
            let mut reason: Option<String> = None;
            let mut roles = Map::new();
            let mut thinking = None;
            let mut overrides = None;

            match entry.as_object() {
                None => reason = Some("不是映射".into()),
                Some(obj) => {
                    match obj.get("modelRoles").and_then(Value::as_object) {
                        None => reason = Some("modelRoles 缺失或不是映射".into()),
                        Some(map) => {
                            roles = map.clone();
                            if let Some(bad) =
                                map.iter().find_map(|(role, item)| match item.as_str() {
                                    Some(text) if !text.trim().is_empty() => None,
                                    _ => Some(format!("角色 {role} 的值不是模型 selector")),
                                })
                            {
                                reason = Some(bad);
                            }
                        }
                    }
                    if reason.is_none() {
                        if let Some(item) = obj.get("defaultThinkingLevel") {
                            match item.as_str() {
                                Some(level) if THINKING_LEVELS.contains(&level) => {
                                    thinking = Some(level.to_owned());
                                }
                                _ => reason = Some("defaultThinkingLevel 不是有效档位".into()),
                            }
                        }
                    }
                    if reason.is_none() {
                        if let Some(item) = obj.get("agentModelOverrides") {
                            match string_record_reason(item) {
                                None => {
                                    overrides = item.as_object().cloned();
                                }
                                Some(_) => reason = Some("agentModelOverrides 格式无效".into()),
                            }
                        }
                    }
                }
            }

            if reason.is_none() {
                if let Err(e) = validate_preset_name(name) {
                    reason = Some(format!("名称不符合 omp 规则（{}）", e.message));
                }
            }

            ModelPreset {
                name: name.clone(),
                model_roles: roles,
                default_thinking_level: thinking,
                agent_model_overrides: overrides,
                invalid_reason: reason,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// 当前配置命中的模式名：排序后第一个「角色完全一致 + 档位（若指定）+ agent 覆盖
/// （若指定）」都相等的有效预设。
pub fn find_active(presets: &[ModelPreset], current: &ModelPresetSnapshot) -> Option<String> {
    let roles = non_empty_strings(&current.model_roles);
    let overrides = non_empty_strings(&current.agent_model_overrides);
    let roles_value = Value::Object(roles);
    let overrides_value = Value::Object(overrides);
    presets
        .iter()
        .filter(|p| p.invalid_reason.is_none())
        .find(|p| {
            Value::Object(p.model_roles.clone()) == roles_value
                && match &p.default_thinking_level {
                    None => true,
                    Some(level) => {
                        Some(level.as_str()) == current.default_thinking_level.as_deref()
                    }
                }
                && match &p.agent_model_overrides {
                    None => true,
                    Some(map) => Value::Object(map.clone()) == overrides_value,
                }
        })
        .map(|p| p.name.clone())
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

fn read_raw_presets(bin: &Path) -> Result<Value, AppError> {
    // 读取失败按「未设置」处理：omp 真不可用时紧随其后的 modelRoles 读取会报错。
    let raw = get_raw_value(bin, KEY_MODEL_PRESETS).unwrap_or(Value::Null);
    match raw {
        Value::Null => Ok(Value::Object(Map::new())),
        Value::Object(map) => Ok(Value::Object(map)),
        _ => Err(omp_failed(
            "modelPresets 配置形状异常，请在终端运行 omp config get modelPresets 检查",
        )),
    }
}

fn read_current(bin: &Path) -> Result<ModelPresetSnapshot, AppError> {
    let roles = get_shaped_value(bin, KEY_MODEL_ROLES, ConfigKind::StringRecord)?;
    let overrides = get_shaped_value(bin, KEY_AGENT_OVERRIDES, ConfigKind::StringRecord)?;
    let thinking = get_raw_value(bin, KEY_DEFAULT_THINKING_LEVEL)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned));
    Ok(ModelPresetSnapshot {
        model_roles: roles,
        agent_model_overrides: overrides,
        default_thinking_level: thinking,
    })
}

/// 当前完整状态：预设列表 + 激活项 + 两份 expected。
pub fn read_presets_state(bin: &Path) -> Result<ModelPresetsState, AppError> {
    let raw = read_raw_presets(bin)?;
    let current = read_current(bin)?;
    let presets = parse_presets(&raw);
    let active = find_active(&presets, &current);
    Ok(ModelPresetsState {
        presets,
        active,
        current,
        raw_presets: raw,
    })
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/// 保存当前配置为模式（或覆盖同名模式）。
pub fn save_preset_impl(
    bin: &Path,
    busy: &OmpBusy,
    name: &str,
    overwrite: bool,
    expected_presets: &Value,
) -> Result<ModelPresetsState, AppError> {
    validate_preset_name(name)?;
    let _guard = busy.try_acquire()?;
    let state = read_presets_state(bin)?;
    if &state.raw_presets != expected_presets {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "模式列表已被外部修改，请刷新后重试",
        ));
    }
    if !overwrite && state.presets.iter().any(|p| p.name == name) {
        return Err(invalid(format!("已有同名模式「{name}」")));
    }
    let roles = non_empty_strings(&state.current.model_roles);
    if roles.is_empty() {
        return Err(invalid("当前没有任何角色模型配置，无法保存为模式"));
    }

    let mut entry = Map::new();
    entry.insert("modelRoles".into(), Value::Object(roles));
    if let Some(level) = state.current.default_thinking_level.clone() {
        entry.insert("defaultThinkingLevel".into(), Value::String(level));
    }
    let overrides = non_empty_strings(&state.current.agent_model_overrides);
    if !overrides.is_empty() {
        entry.insert("agentModelOverrides".into(), Value::Object(overrides));
    }

    let mut raw = state.raw_presets.as_object().cloned().unwrap_or_default();
    raw.insert(name.to_owned(), Value::Object(entry));
    set_raw_value(bin, KEY_MODEL_PRESETS, &Value::Object(raw))?;
    read_presets_state(bin)
}

/// 写入日志条目：键 + 写入前的原始值（用于逆序回滚）。
enum Backup {
    Json(String, Value),
    Text(String, Option<String>),
}

fn rollback(bin: &Path, backups: &[Backup]) -> Result<(), AppError> {
    let mut first: Option<AppError> = None;
    for backup in backups.iter().rev() {
        let step = match backup {
            Backup::Json(key, old) => set_raw_value(bin, key, old),
            Backup::Text(_, None) => Ok(()),
            Backup::Text(key, Some(old)) => set_raw_string(bin, key, old),
        };
        if let Err(e) = step {
            // 继续恢复其余键：尽力把配置拉回原状，只报第一个失败。
            if first.is_none() {
                first = Some(e);
            }
        }
    }
    match first {
        None => Ok(()),
        Some(e) => Err(e),
    }
}

/// 校验预设的 default 模型在 omp 可用模型列表里（`@`/`pi/` 别名跳过）。
fn ensure_default_available(bin: &Path, name: &str, preset: &ModelPreset) -> Result<(), AppError> {
    let value = match preset.model_roles.get("default").and_then(Value::as_str) {
        Some(value) => value,
        None => return Ok(()),
    };
    if value.starts_with('@') || value.starts_with("pi/") {
        return Ok(());
    }
    let models = list_models_impl(bin)?;
    let base = selector_base(value);
    if models
        .iter()
        .any(|m| m.selector == value || m.selector == base)
    {
        return Ok(());
    }
    Err(invalid(format!(
        "模式「{name}」的 default 模型 {value} 不在 omp 可用模型列表中，未切换"
    )))
}

/// 切换到某个模式：角色模型 → agent 覆盖 → 推理档位，任一步失败逆序回滚。
pub fn switch_preset_impl(
    bin: &Path,
    busy: &OmpBusy,
    name: &str,
    expected: Option<&ModelPresetSnapshot>,
) -> Result<ModelPresetsState, AppError> {
    validate_preset_name(name)?;
    let _guard = busy.try_acquire()?;
    let state = read_presets_state(bin)?;
    let preset = state
        .presets
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::NotFound,
                format!("模式「{name}」不存在（可能已被删除）"),
            )
        })?;
    if let Some(reason) = &preset.invalid_reason {
        return Err(invalid(format!("模式「{name}」格式无效：{reason}")));
    }
    if let Some(exp) = expected {
        if exp != &state.current {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "模型配置已被外部修改，请刷新后重试",
            ));
        }
    }
    ensure_default_available(bin, name, preset)?;

    let mut backups: Vec<Backup> = Vec::new();
    let applied = (|| -> Result<(), AppError> {
        let roles = Value::Object(preset.model_roles.clone());
        if non_empty_strings(&state.current.model_roles) != non_empty_strings(&roles) {
            backups.push(Backup::Json(
                KEY_MODEL_ROLES.into(),
                state.current.model_roles.clone(),
            ));
            set_raw_value(bin, KEY_MODEL_ROLES, &roles)?;
        }

        if let Some(overrides) = &preset.agent_model_overrides {
            let value = Value::Object(overrides.clone());
            if non_empty_strings(&state.current.agent_model_overrides) != non_empty_strings(&value)
            {
                backups.push(Backup::Json(
                    KEY_AGENT_OVERRIDES.into(),
                    state.current.agent_model_overrides.clone(),
                ));
                set_raw_value(bin, KEY_AGENT_OVERRIDES, &value)?;
            }
        }

        if let Some(level) = &preset.default_thinking_level {
            if state.current.default_thinking_level.as_deref() != Some(level.as_str()) {
                backups.push(Backup::Text(
                    KEY_DEFAULT_THINKING_LEVEL.into(),
                    state.current.default_thinking_level.clone(),
                ));
                set_raw_string(bin, KEY_DEFAULT_THINKING_LEVEL, level)?;
            }
        }
        Ok(())
    })();

    if let Err(e) = applied {
        return Err(match rollback(bin, &backups) {
            Ok(()) => omp_failed(format!("切换失败，已恢复原配置：{}", e.message)),
            Err(re) => omp_failed(format!(
                "切换失败且恢复原配置失败（{}），请到「管理 → 模型」检查：{}",
                re.message, e.message
            )),
        });
    }
    read_presets_state(bin)
}

/// 删除模式（名称只要求非空，允许清理名称不合法的旧条目）。
pub fn delete_preset_impl(
    bin: &Path,
    busy: &OmpBusy,
    name: &str,
    expected_presets: &Value,
) -> Result<ModelPresetsState, AppError> {
    if name.is_empty() {
        return Err(invalid("模式名不能为空"));
    }
    let _guard = busy.try_acquire()?;
    let state = read_presets_state(bin)?;
    if &state.raw_presets != expected_presets {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "模式列表已被外部修改，请刷新后重试",
        ));
    }
    let mut raw = state.raw_presets.as_object().cloned().unwrap_or_default();
    if raw.remove(name).is_none() {
        return Err(AppError::new(
            ErrorCode::NotFound,
            format!("模式「{name}」不存在（可能已被删除）"),
        ));
    }
    set_raw_value(bin, KEY_MODEL_PRESETS, &Value::Object(raw))?;
    read_presets_state(bin)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

pub(crate) fn omp_bin() -> Result<std::path::PathBuf, AppError> {
    resolve_omp().ok_or_else(omp_not_found)
}

/// 当前预设状态（只读）。
#[tauri::command]
pub async fn list_model_presets() -> Result<ModelPresetsState, AppError> {
    crate::blocking(|| read_presets_state(&omp_bin()?)).await
}

#[tauri::command]
pub async fn save_model_preset(
    app: tauri::AppHandle,
    name: String,
    overwrite: bool,
    expected_presets: Value,
) -> Result<ModelPresetsState, AppError> {
    crate::blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let state = save_preset_impl(&omp_bin()?, &busy, &name, overwrite, &expected_presets)?;
        crate::menubar::tray::publish_modes(&app, &state);
        Ok(state)
    })
    .await
}

#[tauri::command]
pub async fn switch_model_preset(
    app: tauri::AppHandle,
    name: String,
    expected: ModelPresetSnapshot,
) -> Result<ModelPresetsState, AppError> {
    crate::blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let state = switch_preset_impl(&omp_bin()?, &busy, &name, Some(&expected))?;
        crate::menubar::tray::publish_modes(&app, &state);
        Ok(state)
    })
    .await
}

#[tauri::command]
pub async fn delete_model_preset(
    app: tauri::AppHandle,
    name: String,
    expected_presets: Value,
) -> Result<ModelPresetsState, AppError> {
    crate::blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let state = delete_preset_impl(&omp_bin()?, &busy, &name, &expected_presets)?;
        crate::menubar::tray::publish_modes(&app, &state);
        Ok(state)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omp_fake::{fake_stateful, fake_with_marker, seed, set_log};
    use serde_json::json;

    fn roles() -> Value {
        json!({"default": "acme/big", "smol": "acme/small", "slow": "acme/deep"})
    }

    fn overrides() -> Value {
        json!({"task": "acme/big", "scout": "acme/small"})
    }

    fn models_json() -> Value {
        json!({"models": [
            {"selector": "acme/big", "provider": "acme", "id": "big", "name": "Big"},
            {"selector": "acme/small", "provider": "acme", "id": "small", "name": "Small"},
            {"selector": "acme/deep", "provider": "acme", "id": "deep", "name": "Deep"}
        ]})
    }

    fn seed_models(tmp: &Path) {
        std::fs::write(
            tmp.join("state").join("models.json"),
            models_json().to_string(),
        )
        .unwrap();
    }

    fn seed_current(tmp: &Path) {
        seed(tmp, KEY_MODEL_ROLES, &roles());
        seed(tmp, KEY_AGENT_OVERRIDES, &overrides());
        seed(tmp, KEY_DEFAULT_THINKING_LEVEL, &json!("high"));
        seed_models(tmp);
    }

    fn seed_presets(tmp: &Path, raw: Value) {
        seed(tmp, KEY_MODEL_PRESETS, &raw);
    }

    #[test]
    fn name_bounds() {
        for ok in ["A", "a-1_b", "abcDEF_9-"] {
            assert!(validate_preset_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "1a", "中文", "_a", "-a", "a b", "a.b"] {
            assert_eq!(
                validate_preset_name(bad).unwrap_err().code,
                ErrorCode::InvalidInput,
                "{bad}"
            );
        }
        let long = "a".repeat(NAME_MAX + 1);
        assert_eq!(
            validate_preset_name(&long).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(validate_preset_name(&"a".repeat(NAME_MAX)).is_ok());
    }

    #[test]
    fn parse_flags_each_kind_of_invalid_entry() {
        let raw = json!({
            "good": {"modelRoles": {"default": "a/b"}, "defaultThinkingLevel": "high"},
            "notmap": 3,
            "noroles": {"modelRoles": "x"},
            "badrole": {"modelRoles": {"default": ""}},
            "badlevel": {"modelRoles": {"default": "a/b"}, "defaultThinkingLevel": "ultra"},
            "badoverrides": {"modelRoles": {"default": "a/b"}, "agentModelOverrides": {"task": 1}},
            "1bad": {"modelRoles": {"default": "a/b"}}
        });
        let presets = parse_presets(&raw);
        let reason = |name: &str| {
            presets
                .iter()
                .find(|p| p.name == name)
                .unwrap()
                .invalid_reason
                .clone()
        };
        assert_eq!(reason("good"), None);
        assert_eq!(reason("notmap").unwrap(), "不是映射");
        assert_eq!(reason("noroles").unwrap(), "modelRoles 缺失或不是映射");
        assert_eq!(
            reason("badrole").unwrap(),
            "角色 default 的值不是模型 selector"
        );
        assert_eq!(
            reason("badlevel").unwrap(),
            "defaultThinkingLevel 不是有效档位"
        );
        assert_eq!(
            reason("badoverrides").unwrap(),
            "agentModelOverrides 格式无效"
        );
        assert!(reason("1bad").unwrap().contains("名称不符合 omp 规则"));
        // 排序：先比小写再比原文。
        let names: Vec<&str> = presets.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "1bad",
                "badlevel",
                "badoverrides",
                "badrole",
                "good",
                "noroles",
                "notmap"
            ]
        );
    }

    #[test]
    fn parse_accepts_null_and_sorts_mixed_case() {
        assert!(parse_presets(&Value::Null).is_empty());
        let presets = parse_presets(&json!({
            "b": {"modelRoles": {"default": "a/b"}},
            "A": {"modelRoles": {"default": "a/b"}},
            "a": {"modelRoles": {"default": "a/b"}}
        }));
        let names: Vec<&str> = presets.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["A", "a", "b"]);
    }

    #[test]
    fn find_active_requires_thinking_and_overrides_match() {
        let current = ModelPresetSnapshot {
            model_roles: roles(),
            agent_model_overrides: overrides(),
            default_thinking_level: Some("high".into()),
        };
        let base = |name: &str, level: Option<&str>, ov: Option<Value>| ModelPreset {
            name: name.into(),
            model_roles: roles().as_object().unwrap().clone(),
            default_thinking_level: level.map(str::to_owned),
            agent_model_overrides: ov.map(|v| v.as_object().unwrap().clone()),
            invalid_reason: None,
        };
        // thinking 不同 → 不命中。
        let only_low = vec![base("A", Some("low"), Some(overrides()))];
        assert_eq!(find_active(&only_low, &current), None);
        // overrides 不同 → 不命中。
        let other_ov = vec![base("A", Some("high"), Some(json!({"task": "acme/deep"})))];
        assert_eq!(find_active(&other_ov, &current), None);
        // 不带 thinking / overrides 的预设视为通配。
        let wildcards = vec![base("A", None, None), base("B", Some("high"), None)];
        assert_eq!(find_active(&wildcards, &current), Some("A".into()));
    }

    #[test]
    fn read_state_reports_presets_and_active() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let mut big = roles().as_object().unwrap().clone();
        big.insert("default".into(), json!("acme/small"));
        seed_presets(
            tmp.path(),
            json!({
                "A": {"modelRoles": roles(), "defaultThinkingLevel": "high",
                      "agentModelOverrides": overrides()},
                "B": {"modelRoles": big}
            }),
        );
        let state = read_presets_state(&bin).unwrap();
        assert_eq!(state.presets.len(), 2);
        assert_eq!(state.active.as_deref(), Some("A"));
        assert_eq!(
            state.current.default_thinking_level.as_deref(),
            Some("high")
        );
        assert!(set_log(tmp.path()).is_empty(), "只读路径不得写入");
    }

    #[test]
    fn read_state_rejects_malformed_model_presets() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        seed_presets(tmp.path(), json!([1, 2]));
        let err = read_presets_state(&bin).unwrap_err();
        assert_eq!(err.code, ErrorCode::OmpFailed);
        assert!(err.message.contains("modelPresets"));
    }

    #[test]
    fn save_creates_entry_and_rejects_duplicates() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        let empty = json!({});
        let state = save_preset_impl(&bin, &busy, "A", false, &empty).unwrap();
        assert_eq!(state.presets.len(), 1);
        let preset = &state.presets[0];
        assert_eq!(preset.default_thinking_level.as_deref(), Some("high"));
        assert_eq!(
            preset.agent_model_overrides.as_ref().unwrap().len(),
            2,
            "agent 覆盖必须一起入模式"
        );
        assert_eq!(state.active.as_deref(), Some("A"));

        // 同名且未覆盖 → InvalidInput，且不再写。
        let before = set_log(tmp.path());
        let err = save_preset_impl(&bin, &busy, "A", false, &state.raw_presets).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(set_log(tmp.path()), before);

        // 覆盖成功。
        let state = save_preset_impl(&bin, &busy, "A", true, &state.raw_presets).unwrap();
        assert_eq!(state.presets.len(), 1);
    }

    #[test]
    fn save_detects_external_change_and_empty_roles() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        let stale = json!({"old": {"modelRoles": {"default": "a/b"}}});
        let err = save_preset_impl(&bin, &busy, "A", false, &stale).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);

        seed(tmp.path(), KEY_MODEL_ROLES, &json!({}));
        let fresh = read_presets_state(&bin).unwrap().raw_presets;
        let err = save_preset_impl(&bin, &busy, "A", false, &fresh).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("没有任何角色模型配置"));
    }

    #[test]
    fn switch_writes_roles_overrides_then_thinking() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        seed_presets(
            tmp.path(),
            json!({
                "A": {"modelRoles": {"default": "acme/small"},
                      "defaultThinkingLevel": "low",
                      "agentModelOverrides": {"task": "acme/small"}}
            }),
        );
        let _ = std::fs::remove_file(tmp.path().join("sets.log"));
        let state = read_presets_state(&bin).unwrap();
        let next = switch_preset_impl(&bin, &busy, "A", Some(&state.current)).unwrap();
        assert_eq!(next.active.as_deref(), Some("A"));
        let log = set_log(tmp.path());
        let keys: Vec<&str> = log
            .lines()
            .map(|l| l.split(' ').next().unwrap_or_default())
            .collect();
        assert_eq!(
            keys,
            vec![
                KEY_MODEL_ROLES,
                KEY_AGENT_OVERRIDES,
                KEY_DEFAULT_THINKING_LEVEL
            ]
        );
    }

    #[test]
    fn switch_rejects_conflict_missing_invalid_and_unknown_default() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        seed_presets(
            tmp.path(),
            json!({
                "A": {"modelRoles": {"default": "acme/missing"}},
                "bad": {"modelRoles": "nope"},
                "ok": {"modelRoles": {"default": "acme/big"}}
            }),
        );
        let stale = ModelPresetSnapshot {
            model_roles: json!({}),
            agent_model_overrides: json!({}),
            default_thinking_level: None,
        };
        let err = switch_preset_impl(&bin, &busy, "ok", Some(&stale)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(set_log(tmp.path()).is_empty(), "冲突时不得写入");

        let err = switch_preset_impl(&bin, &busy, "nope", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);

        let err = switch_preset_impl(&bin, &busy, "bad", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("格式无效"));

        let err = switch_preset_impl(&bin, &busy, "A", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("不在 omp 可用模型列表"));
        assert!(set_log(tmp.path()).is_empty());
    }

    #[test]
    fn switch_skips_alias_default_and_rolls_back_on_failure() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        seed_presets(
            tmp.path(),
            json!({
                "Alias": {"modelRoles": {"default": "@task", "smol": "acme/small"},
                          "defaultThinkingLevel": "low",
                          "agentModelOverrides": {"task": "acme/small"}}
            }),
        );
        // 注入 agent 覆盖写入失败：roles 必须被写回旧值，且 thinking 一次都不写。
        std::fs::write(
            tmp.path()
                .join("state")
                .join("fail-set-task.agentModelOverrides"),
            b"1",
        )
        .unwrap();
        let err = switch_preset_impl(&bin, &busy, "Alias", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::OmpFailed);
        assert!(err.message.contains("已恢复原配置"), "{}", err.message);
        let restored = read_presets_state(&bin).unwrap();
        assert_eq!(
            non_empty_strings(&restored.current.model_roles),
            non_empty_strings(&roles())
        );
        assert_eq!(
            non_empty_strings(&restored.current.agent_model_overrides),
            non_empty_strings(&overrides())
        );
        let log = set_log(tmp.path());
        assert!(log.contains(KEY_MODEL_ROLES), "roles 写过一次：{log}");
        assert!(
            !log.contains(KEY_DEFAULT_THINKING_LEVEL),
            "失败前不得触碰 thinking：{log}"
        );
    }

    #[test]
    fn switch_reports_failed_rollback() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        seed_presets(
            tmp.path(),
            json!({
                "A": {"modelRoles": {"default": "acme/small"},
                      "defaultThinkingLevel": "low"}
            }),
        );
        // thinking 写入失败后，回滚 thinking 同样失败 → 组合错误文案。
        std::fs::write(
            tmp.path()
                .join("state")
                .join("fail-set-defaultThinkingLevel"),
            b"2",
        )
        .unwrap();
        let err = switch_preset_impl(&bin, &busy, "A", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::OmpFailed);
        assert!(err.message.contains("恢复原配置失败"), "{}", err.message);
        assert!(err.message.contains("管理 → 模型"), "{}", err.message);
        // roles 已被回滚。
        let restored = read_presets_state(&bin).unwrap();
        assert_eq!(
            non_empty_strings(&restored.current.model_roles),
            non_empty_strings(&roles())
        );
    }

    #[test]
    fn delete_removes_entry_and_handles_missing() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        seed_presets(
            tmp.path(),
            json!({
                "A": {"modelRoles": {"default": "acme/big"}},
                "1bad": {"modelRoles": {"default": "acme/big"}}
            }),
        );
        let state = read_presets_state(&bin).unwrap();
        let next = delete_preset_impl(&bin, &busy, "A", &state.raw_presets).unwrap();
        assert_eq!(next.presets.len(), 1);
        // 名称不合法的旧条目也能删。
        let next = delete_preset_impl(&bin, &busy, "1bad", &next.raw_presets).unwrap();
        assert!(next.presets.is_empty());

        let err = delete_preset_impl(&bin, &busy, "A", &next.raw_presets).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);

        let err = delete_preset_impl(&bin, &busy, "", &next.raw_presets).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn delete_detects_external_change() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        seed_presets(
            tmp.path(),
            json!({"A": {"modelRoles": {"default": "acme/big"}}}),
        );
        let busy = OmpBusy::default();
        let err = delete_preset_impl(&bin, &busy, "A", &json!({})).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
    }

    #[test]
    fn busy_gate_rejects_second_writer() {
        let (tmp, bin) = fake_stateful();
        seed_current(tmp.path());
        let busy = OmpBusy::default();
        let guard = busy.try_acquire().unwrap();
        let err = save_preset_impl(&bin, &busy, "A", false, &json!({})).unwrap_err();
        assert_eq!(err.code, ErrorCode::Busy);
        drop(guard);
        assert!(save_preset_impl(&bin, &busy, "A", false, &json!({})).is_ok());
    }

    #[test]
    fn selector_base_strips_thinking_only() {
        assert_eq!(selector_base("p/m:high"), "p/m");
        assert_eq!(selector_base("p/m"), "p/m");
        assert_eq!(selector_base("p/m:"), "p/m:");
        assert_eq!(selector_base("p/m:high:low"), "p/m:high");
    }

    #[test]
    fn save_never_touches_omp_with_bad_name() {
        let (_tmp, bin, marker) = fake_with_marker();
        let err =
            save_preset_impl(&bin, &OmpBusy::default(), "9bad", false, &json!({})).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(!marker.exists());
    }
}
