//! 用户级插件、marketplace 与 registry 技能管理；写操作共用 omp 门禁。
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use crate::model::{
    AppError, DiscoverEntry, ErrorCode, MarketplaceSummary, NpmPluginSummary, OmpOpResult,
    PluginSummary, PluginUpgradeChange, PluginsListResult, SkillSummary, SkillsListResult,
};
use crate::omp_cli::{
    require_success, run_omp, strip_ansi, OmpBusy, CHECK_TIMEOUT, UPDATE_TIMEOUT,
};

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

pub fn validate_marketplace(name: &str) -> Result<(), AppError> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::InvalidInput,
            "marketplace 名称须为 1–64 个字母、数字、点、下划线或连字符，且以字母或数字开头",
        ))
    }
}

pub fn validate_plugin_id(id: &str) -> Result<(), AppError> {
    if id
        .split_once('@')
        .is_some_and(|(name, marketplace)| valid_name(name) && valid_name(marketplace))
    {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::InvalidInput,
            "插件标识必须为 name@marketplace（两部分均为 1–64 个安全字符）",
        ))
    }
}

pub fn validate_source(source: &str) -> Result<(), AppError> {
    let invalid = || {
        AppError::new(ErrorCode::InvalidInput, "marketplace 来源须为 owner/repo、HTTP/SSH Git 地址或绝对路径/~/ 路径（不含控制字符，最多 512 字，不能以 - 开头）")
    };
    if source.is_empty()
        || source.chars().take(513).count() > 512
        || source.starts_with('-')
        || source.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let shorthand = source.split_once('/').is_some_and(|(owner, repo)| {
        !owner.is_empty()
            && owner.as_bytes()[0].is_ascii_alphanumeric()
            && !matches!(repo, "." | "..")
            && [owner, repo].iter().all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
            })
    });
    let url = ["https://", "http://", "ssh://"].iter().any(|prefix| {
        source
            .strip_prefix(prefix)
            .is_some_and(|rest| !rest.starts_with(['/', '\\']))
    }) && !source.chars().any(char::is_whitespace)
        && tauri::Url::parse(source).ok().is_some_and(|url| {
            matches!(url.scheme(), "http" | "https" | "ssh") && url.host_str().is_some()
        });
    let git = source.strip_prefix("git@").is_some_and(|rest| {
        rest.split_once(':')
            .is_some_and(|(host, path)| !host.is_empty() && !path.is_empty())
            && !rest.chars().any(char::is_whitespace)
    });
    if shorthand || url || git || Path::new(source).is_absolute() || source.starts_with("~/") {
        Ok(())
    } else {
        Err(invalid())
    }
}

fn string(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

/// marketplace 只取 user 条目；npm 容忍未知形状，最多展示名称和版本。
pub fn parse_plugins_json(
    output: &str,
) -> Result<(Vec<PluginSummary>, Vec<NpmPluginSummary>), String> {
    let value: Value = serde_json::from_str(&strip_ansi(output)).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("插件列表不是 JSON 对象".into());
    }
    let mut plugins = Vec::new();
    for item in value
        .get("marketplace")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = string(item, "id");
        let Some((name, marketplace)) = id.split_once('@') else {
            continue;
        };
        if !valid_name(name) || !valid_name(marketplace) {
            continue;
        }
        let entry = item
            .get("entries")
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.get("scope").and_then(Value::as_str) == Some("user"))
            });
        let Some(entry) = entry else {
            continue;
        };
        plugins.push(PluginSummary {
            name: name.to_owned(),
            marketplace: marketplace.to_owned(),
            id,
            version: optional_string(entry, "version"),
            enabled: entry
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            installed_at: optional_string(entry, "installedAt"),
            last_updated: optional_string(entry, "lastUpdated"),
            install_path: optional_string(entry, "installPath"),
        });
    }
    let mut npm = Vec::new();
    match value.get("npm") {
        Some(Value::Array(entries)) => {
            for entry in entries {
                let (name, version) = if let Some(name) = entry.as_str() {
                    (name.to_owned(), None)
                } else {
                    (string(entry, "name"), optional_string(entry, "version"))
                };
                if !name.is_empty() {
                    npm.push(NpmPluginSummary { name, version });
                }
            }
        }
        Some(Value::Object(entries)) => {
            for (name, entry) in entries {
                let version = entry
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| optional_string(entry, "version"));
                npm.push(NpmPluginSummary {
                    name: name.to_owned(),
                    version,
                });
            }
        }
        _ => {}
    }
    Ok((plugins, npm))
}

pub fn parse_marketplaces(output: &str) -> Vec<MarketplaceSummary> {
    let output = strip_ansi(output);
    let mut configured = false;
    let mut marketplaces = Vec::new();
    for line in output.lines() {
        if line.trim() == "Configured Marketplaces:" {
            configured = true;
            continue;
        }
        if !configured || !line.starts_with("  ") {
            continue;
        }
        let Some((name, source)) = line.trim().split_once(char::is_whitespace) else {
            continue;
        };
        if valid_name(name) && !source.trim().is_empty() {
            marketplaces.push(MarketplaceSummary {
                name: name.to_owned(),
                source: source.trim().to_owned(),
            });
        }
    }
    marketplaces
}

pub fn parse_discover(output: &str) -> Vec<DiscoverEntry> {
    let output = strip_ansi(output);
    let mut entries: Vec<DiscoverEntry> = Vec::new();
    // 只有最近一个 2 缩进行解析成功时，深缩进描述行才有归属；
    // 解析失败的 2 缩进行必须断开归属，避免孤儿描述贴到上一条目。
    let mut attachable = false;
    for line in output.lines() {
        let text = line.trim();
        let indent = line.len() - line.trim_start().len();
        if indent == 2 {
            if let Some((name, version)) = text.split_once('@') {
                if valid_name(name)
                    && !version.is_empty()
                    && !version.chars().any(char::is_whitespace)
                {
                    entries.push(DiscoverEntry {
                        name: name.to_owned(),
                        version: version.to_owned(),
                        description: String::new(),
                    });
                    attachable = true;
                    continue;
                }
            }
            attachable = false;
        } else if indent > 2 && !text.is_empty() {
            if !attachable {
                continue;
            }
            if let Some(entry) = entries.last_mut() {
                if !entry.description.is_empty() {
                    entry.description.push('\n');
                }
                entry.description.push_str(text);
            }
        }
    }
    entries
}

pub fn parse_upgrade_changes(output: &str) -> Vec<PluginUpgradeChange> {
    let output = strip_ansi(output);
    let mut changes: Vec<PluginUpgradeChange> = Vec::new();
    for line in output.lines().map(str::trim) {
        let parsed = if let Some(line) = line.strip_prefix("Upgraded ") {
            line.split_once(" to ").map(|(left, to)| (left, None, to))
        } else {
            line.split_once(": ").and_then(|(left, versions)| {
                versions
                    .split_once(" -> ")
                    .map(|(from, to)| (left, Some(from), to))
            })
        };
        let Some((left, from, to)) = parsed else {
            continue;
        };
        let Some((id, scope)) = left.split_once(" (") else {
            continue;
        };
        let Some(scope) = scope.strip_suffix(')') else {
            continue;
        };
        if scope != "user" || validate_plugin_id(id).is_err() || to.is_empty() {
            continue;
        }
        if let Some(change) = changes
            .iter_mut()
            .find(|change| change.id == id && change.scope == scope)
        {
            if change.from.is_none() {
                change.from = from.map(str::to_owned);
            }
            change.to = to.to_owned();
        } else {
            changes.push(PluginUpgradeChange {
                id: id.to_owned(),
                scope: scope.to_owned(),
                from: from.map(str::to_owned),
                to: to.to_owned(),
            });
        }
    }
    changes
}

pub fn parse_skills_json(output: &str) -> Result<SkillsListResult, String> {
    let value: Value = serde_json::from_str(&strip_ansi(output)).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("技能列表不是 JSON 对象".into());
    }
    let skills = value
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.is_object())
        .map(|item| SkillSummary {
            name: string(item, "name"),
            description: string(item, "description"),
            file_path: string(item, "filePath"),
            base_dir: string(item, "baseDir"),
            source: string(item, "source"),
            hide: item.get("hide").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect();
    let warnings = value
        .get("warnings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    Ok(SkillsListResult { skills, warnings })
}

fn execute(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
    on_line: &mut dyn FnMut(&str),
) -> Result<String, AppError> {
    require_success(run_omp(bin, args, timeout, on_line)?, "omp 操作失败")
}

/// 两次查询互不遮蔽：任意一个失败仍返回另一半与告警。
pub fn plugins_list_impl(bin: &Path) -> PluginsListResult {
    let mut result = PluginsListResult {
        plugins: Vec::new(),
        npm: Vec::new(),
        marketplaces: Vec::new(),
        warnings: Vec::new(),
    };
    match execute(
        bin,
        &["plugin", "list", "--json", "--scope", "user"],
        CHECK_TIMEOUT,
        &mut |_| {},
    ) {
        Ok(output) => match parse_plugins_json(&output) {
            Ok((plugins, npm)) => {
                result.plugins = plugins;
                result.npm = npm;
            }
            Err(e) => result.warnings.push(format!("解析插件列表失败：{e}")),
        },
        Err(e) => result
            .warnings
            .push(format!("读取插件列表失败：{}", e.message)),
    }
    match execute(
        bin,
        &["plugin", "marketplace", "list", "--scope", "user"],
        CHECK_TIMEOUT,
        &mut |_| {},
    ) {
        Ok(output) => result.marketplaces = parse_marketplaces(&output),
        Err(e) => result
            .warnings
            .push(format!("读取 marketplace 列表失败：{}", e.message)),
    }
    result
}

pub fn discover_impl(bin: &Path, marketplace: &str) -> Result<Vec<DiscoverEntry>, AppError> {
    validate_marketplace(marketplace)?;
    let output = execute(
        bin,
        &["plugin", "discover", marketplace, "--scope", "user"],
        CHECK_TIMEOUT,
        &mut |_| {},
    )?;
    Ok(parse_discover(&output))
}

pub fn skills_list_impl(bin: &Path) -> Result<SkillsListResult, AppError> {
    let output = execute(
        bin,
        &["skill", "list", "-g", "--json"],
        CHECK_TIMEOUT,
        &mut |_| {},
    )?;
    parse_skills_json(&output)
        .map_err(|e| AppError::new(ErrorCode::OmpFailed, format!("解析 omp 技能列表失败：{e}")))
}

/// 固定的用户级写操作，不向前端暴露自由参数。
pub enum Operation {
    Install(String),
    Uninstall(String),
    SetEnabled { id: String, enabled: bool },
    Upgrade(Option<String>),
    MarketplaceUpdate(Option<String>),
    MarketplaceAdd(String),
    MarketplaceRemove(String),
    SkillsUpdate,
}

pub fn run_operation(
    bin: &Path,
    busy: &OmpBusy,
    operation: Operation,
    on_line: &mut dyn FnMut(&str),
) -> Result<OmpOpResult, AppError> {
    let _guard = busy.try_acquire()?;
    let output = match operation {
        Operation::Install(id) => {
            validate_plugin_id(&id)?;
            execute(
                bin,
                &["plugin", "install", &id, "--scope", "user"],
                UPDATE_TIMEOUT,
                on_line,
            )?
        }
        Operation::Uninstall(id) => {
            validate_plugin_id(&id)?;
            execute(
                bin,
                &["plugin", "uninstall", &id, "--scope", "user"],
                UPDATE_TIMEOUT,
                on_line,
            )?
        }
        Operation::SetEnabled { id, enabled } => {
            validate_plugin_id(&id)?;
            execute(
                bin,
                &[
                    "plugin",
                    if enabled { "enable" } else { "disable" },
                    &id,
                    "--scope",
                    "user",
                ],
                UPDATE_TIMEOUT,
                on_line,
            )?
        }
        Operation::Upgrade(id) => {
            if let Some(id) = id {
                validate_plugin_id(&id)?;
                execute(
                    bin,
                    &["plugin", "upgrade", &id, "--scope", "user"],
                    UPDATE_TIMEOUT,
                    on_line,
                )?
            } else {
                execute(
                    bin,
                    &["plugin", "upgrade", "--scope", "user"],
                    UPDATE_TIMEOUT,
                    on_line,
                )?
            }
        }
        Operation::MarketplaceUpdate(name) => {
            if let Some(name) = name {
                validate_marketplace(&name)?;
                execute(
                    bin,
                    &["plugin", "marketplace", "update", &name, "--scope", "user"],
                    UPDATE_TIMEOUT,
                    on_line,
                )?
            } else {
                execute(
                    bin,
                    &["plugin", "marketplace", "update", "--scope", "user"],
                    UPDATE_TIMEOUT,
                    on_line,
                )?
            }
        }
        Operation::MarketplaceAdd(source) => {
            validate_source(&source)?;
            execute(
                bin,
                &["plugin", "marketplace", "add", &source, "--scope", "user"],
                UPDATE_TIMEOUT,
                on_line,
            )?
        }
        Operation::MarketplaceRemove(name) => {
            validate_marketplace(&name)?;
            execute(
                bin,
                &["plugin", "marketplace", "remove", &name, "--scope", "user"],
                UPDATE_TIMEOUT,
                on_line,
            )?
        }
        Operation::SkillsUpdate => {
            execute(bin, &["skill", "update", "-g"], UPDATE_TIMEOUT, on_line)?
        }
    };
    Ok(OmpOpResult { output })
}

async fn operation_command(
    app: tauri::AppHandle,
    on_line: tauri::ipc::Channel<String>,
    operation: Operation,
) -> Result<OmpOpResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let bin = crate::omp_cli::resolve_omp().ok_or_else(crate::omp_cli::omp_not_found)?;
        run_operation(&bin, &busy, operation, &mut |line| {
            let _ = on_line.send(line.to_owned());
        })
    })
    .await
    .map_err(crate::io_join_error)?
}

#[tauri::command]
pub async fn omp_plugins_list() -> Result<PluginsListResult, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin = crate::omp_cli::resolve_omp().ok_or_else(crate::omp_cli::omp_not_found)?;
        Ok(plugins_list_impl(&bin))
    })
    .await
    .map_err(crate::io_join_error)?
}

#[tauri::command]
pub async fn omp_plugin_discover(marketplace: String) -> Result<Vec<DiscoverEntry>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = crate::omp_cli::resolve_omp().ok_or_else(crate::omp_cli::omp_not_found)?;
        discover_impl(&bin, &marketplace)
    })
    .await
    .map_err(crate::io_join_error)?
}

#[tauri::command]
pub async fn omp_plugin_install(
    app: tauri::AppHandle,
    id: String,
    on_line: tauri::ipc::Channel<String>,
) -> Result<OmpOpResult, AppError> {
    operation_command(app, on_line, Operation::Install(id)).await
}

#[tauri::command]
pub async fn omp_plugin_uninstall(
    app: tauri::AppHandle,
    id: String,
    on_line: tauri::ipc::Channel<String>,
) -> Result<OmpOpResult, AppError> {
    operation_command(app, on_line, Operation::Uninstall(id)).await
}

#[tauri::command]
pub async fn omp_plugin_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
    on_line: tauri::ipc::Channel<String>,
) -> Result<OmpOpResult, AppError> {
    operation_command(app, on_line, Operation::SetEnabled { id, enabled }).await
}

#[tauri::command]
pub async fn omp_plugin_upgrade(
    app: tauri::AppHandle,
    id: Option<String>,
    on_line: tauri::ipc::Channel<String>,
) -> Result<crate::model::PluginUpgradeResult, AppError> {
    let result = operation_command(app, on_line, Operation::Upgrade(id)).await?;
    Ok(crate::model::PluginUpgradeResult {
        changes: parse_upgrade_changes(&result.output),
        output: result.output,
    })
}

#[tauri::command]
pub async fn omp_marketplace_update(
    app: tauri::AppHandle,
    name: Option<String>,
    on_line: tauri::ipc::Channel<String>,
) -> Result<OmpOpResult, AppError> {
    operation_command(app, on_line, Operation::MarketplaceUpdate(name)).await
}

#[tauri::command]
pub async fn omp_marketplace_add(
    app: tauri::AppHandle,
    source: String,
    on_line: tauri::ipc::Channel<String>,
) -> Result<OmpOpResult, AppError> {
    operation_command(app, on_line, Operation::MarketplaceAdd(source)).await
}

#[tauri::command]
pub async fn omp_marketplace_remove(
    app: tauri::AppHandle,
    name: String,
    on_line: tauri::ipc::Channel<String>,
) -> Result<OmpOpResult, AppError> {
    operation_command(app, on_line, Operation::MarketplaceRemove(name)).await
}

#[tauri::command]
pub async fn omp_skills_list() -> Result<SkillsListResult, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin = crate::omp_cli::resolve_omp().ok_or_else(crate::omp_cli::omp_not_found)?;
        skills_list_impl(&bin)
    })
    .await
    .map_err(crate::io_join_error)?
}

#[tauri::command]
pub async fn omp_skills_update(
    app: tauri::AppHandle,
    on_line: tauri::ipc::Channel<String>,
) -> Result<OmpOpResult, AppError> {
    operation_command(app, on_line, Operation::SkillsUpdate).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake(body: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, bin)
    }

    #[test]
    fn validates_ids_names_and_sources_without_shell() {
        for id in [
            "hello-plugin@probe-mkt",
            "A.b_1@M-2",
            &format!("{}@{}", "a".repeat(64), "b".repeat(64)),
        ] {
            validate_plugin_id(id).unwrap();
        }
        for id in [
            "",
            "hello",
            "-bad@market",
            "a@-bad",
            "a@@b",
            "a;b@m",
            "a@m\nevil",
            "$(bad)@m",
            &format!("{}@m", "a".repeat(65)),
        ] {
            assert_eq!(
                validate_plugin_id(id).unwrap_err().code,
                ErrorCode::InvalidInput
            );
        }
        for name in ["probe-mkt", "A.b_1"] {
            validate_marketplace(name).unwrap();
        }
        for name in ["", "-m", "a/b", "a;b", "a\nb", "$(bad)", &"a".repeat(65)] {
            assert!(validate_marketplace(name).is_err());
        }
        for source in [
            "owner/repo",
            "owner/repo.git",
            "owner/.github",
            "owner/-repository",
            "https://example.com/repo.git",
            "http://localhost:3000/repo",
            "git@github.com:owner/repo.git",
            "ssh://git@host/repo",
            "/tmp/a b;literal",
            "~/plugins",
        ] {
            validate_source(source).unwrap();
        }
        validate_source(&format!("/{}", "字".repeat(511))).unwrap();
        for source in [
            "",
            "-danger",
            "--help",
            "owner/repo;echo",
            "owner/repo/extra",
            "owner/..",
            "owner/.",
            "relative",
            "./relative",
            "owner/repo\nevil",
            "/tmp/a\0b",
            "https://",
            "http:///repo",
            "git@host",
            "https://host/a b",
            &format!("/{}", "字".repeat(512)),
        ] {
            assert!(validate_source(source).is_err(), "{source:?}");
        }
    }

    #[test]
    fn plugin_json_user_scope_enabled_and_npm_shapes() {
        let json = serde_json::json!({"marketplace": [
            {"id":"one@m", "entries":[{"scope":"project","version":"9"},{"scope":"user","version":"1","installedAt":"at","lastUpdated":"later","installPath":"/tmp/plugin"}]},
            {"id":"two@m", "entries":[{"scope":"user","enabled":false}]},
            {"id":"three@m", "entries":[{"scope":"user","enabled":true}]},
            {"id":"skip@m", "entries":[{"scope":"project"}]},
            {"id":"invalid", "entries":[{"scope":"user"}]}
        ], "npm":[{"name":"omp-enforce-uv","version":"0.3.0","path":"/sandbox/plugin","manifest":{"extensions":["./index.ts"]},"enabledFeatures":null,"enabled":true}, null, 7, {}, "a-package"]});
        let (plugins, npm) = parse_plugins_json(&json.to_string()).unwrap();
        assert_eq!(plugins.len(), 3);
        assert!(plugins[0].enabled && !plugins[1].enabled && plugins[2].enabled);
        assert_eq!(plugins[0].name, "one");
        assert_eq!(plugins[0].marketplace, "m");
        assert_eq!(plugins[0].version.as_deref(), Some("1"));
        assert_eq!(plugins[0].installed_at.as_deref(), Some("at"));
        assert_eq!(plugins[0].last_updated.as_deref(), Some("later"));
        assert_eq!(plugins[0].install_path.as_deref(), Some("/tmp/plugin"));
        assert_eq!(npm.len(), 2);
        assert_eq!(npm[0].version.as_deref(), Some("0.3.0"));
        for npm in [
            serde_json::json!(42),
            serde_json::json!(null),
            serde_json::json!({"named":"1.0", "unknown":{}}),
        ] {
            assert!(parse_plugins_json(&serde_json::json!({"npm":npm}).to_string()).is_ok());
        }
        assert!(parse_plugins_json("garbage").is_err());
        assert!(parse_plugins_json("[]").is_err());
    }

    #[test]
    fn marketplace_and_discover_observed_outputs() {
        let list = parse_marketplaces("\x1b[32mConfigured Marketplaces:\x1b[0m\r\n\r\n  probe-mkt  /tmp/omp-mkt\r\n  git-mkt  https://host/repo\n");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "probe-mkt");
        assert_eq!(list[0].source, "/tmp/omp-mkt");
        for output in [
            "✔ Added marketplace: /tmp/omp-mkt",
            "No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>",
            "unknown",
            "  probe-mkt  /tmp/not-a-list",
            "",
        ] {
            assert!(parse_marketplaces(output).is_empty());
        }
        let entries = parse_discover("Available Plugins:\n\n  hello-plugin@1.0.0\n    Probe plugin\n  next@2.0-canary\n    First line\n    second line\n");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "hello-plugin");
        assert_eq!(entries[0].version, "1.0.0");
        assert_eq!(entries[0].description, "Probe plugin");
        assert_eq!(entries[1].description, "First line\nsecond line");
        assert!(parse_discover("garbage\n  missing-version\n").is_empty());
    }
    #[test]
    fn discover_orphan_description_after_invalid_entry_is_dropped() {
        let entries = parse_discover("  ok@1.0\n  not-an-entry\n    orphan\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "ok");
        assert!(entries[0].description.is_empty());
        // 正常归属不受影响。
        let entries = parse_discover("  name@1.0.0\n    Probe plugin\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].description, "Probe plugin");
    }

    #[test]
    fn upgrade_lines_and_unknown_outputs() {
        let changes = parse_upgrade_changes("  hello-plugin@probe-mkt (user): 1.0.0 -> 1.1.0\r\n\x1b[32mUpgraded hello-plugin@probe-mkt (user) to 1.1.0\x1b[0m\nUpgraded next@probe-mkt (user) to 2.0.0\n  skip@m (project): 1 -> 2\n");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].id, "hello-plugin@probe-mkt");
        assert_eq!(changes[0].scope, "user");
        assert_eq!(changes[0].from.as_deref(), Some("1.0.0"));
        assert_eq!(changes[0].to, "1.1.0");
        assert!(changes[1].from.is_none());
        for output in [
            "All marketplace plugins are up to date.",
            "unknown",
            "",
            "Upgraded bad-id (user) to 2",
        ] {
            assert!(parse_upgrade_changes(output).is_empty());
        }
    }

    #[test]
    fn skill_json_preserves_fields_and_tolerates_missing() {
        let result = parse_skills_json(r#"{"skills":[{"name":"skill","description":"desc","filePath":"/a/SKILL.md","baseDir":"/a","source":"agents:user","hide":true,"extra":1},{},7],"warnings":["warning",7],"extra":true}"#).unwrap();
        assert_eq!(result.skills.len(), 2);
        let skill = &result.skills[0];
        assert_eq!(
            (
                skill.name.as_str(),
                skill.description.as_str(),
                skill.file_path.as_str(),
                skill.base_dir.as_str(),
                skill.source.as_str()
            ),
            ("skill", "desc", "/a/SKILL.md", "/a", "agents:user")
        );
        assert!(skill.hide);
        assert!(!result.skills[1].hide);
        assert_eq!(result.warnings, ["warning"]);
        assert!(parse_skills_json("{}").unwrap().skills.is_empty());
        assert!(parse_skills_json("garbage").is_err());
    }

    #[test]
    fn exact_mutating_argv_streaming_and_busy_release() {
        let _processes = crate::omp_cli::subprocess_test_guard();
        let (dir, bin) = fake("printf '%s\\n' \"$@\" > \"$0.argv\"\nprintf '\\033[32m✔ Added marketplace: /tmp/omp-mkt\\033[0m\\n'");
        let busy = OmpBusy::default();
        let operations = [
            (
                Operation::Install("hello@m".into()),
                vec!["plugin", "install", "hello@m", "--scope", "user"],
            ),
            (
                Operation::Uninstall("hello@m".into()),
                vec!["plugin", "uninstall", "hello@m", "--scope", "user"],
            ),
            (
                Operation::SetEnabled {
                    id: "hello@m".into(),
                    enabled: false,
                },
                vec!["plugin", "disable", "hello@m", "--scope", "user"],
            ),
            (
                Operation::SetEnabled {
                    id: "hello@m".into(),
                    enabled: true,
                },
                vec!["plugin", "enable", "hello@m", "--scope", "user"],
            ),
            (
                Operation::Upgrade(Some("hello@m".into())),
                vec!["plugin", "upgrade", "hello@m", "--scope", "user"],
            ),
            (
                Operation::Upgrade(None),
                vec!["plugin", "upgrade", "--scope", "user"],
            ),
            (
                Operation::MarketplaceUpdate(Some("m".into())),
                vec!["plugin", "marketplace", "update", "m", "--scope", "user"],
            ),
            (
                Operation::MarketplaceUpdate(None),
                vec!["plugin", "marketplace", "update", "--scope", "user"],
            ),
            (
                Operation::MarketplaceAdd("/tmp/a b;literal".into()),
                vec![
                    "plugin",
                    "marketplace",
                    "add",
                    "/tmp/a b;literal",
                    "--scope",
                    "user",
                ],
            ),
            (
                Operation::MarketplaceRemove("m".into()),
                vec!["plugin", "marketplace", "remove", "m", "--scope", "user"],
            ),
            (Operation::SkillsUpdate, vec!["skill", "update", "-g"]),
        ];
        for (operation, expected) in operations {
            let mut lines = Vec::new();
            let result = run_operation(&bin, &busy, operation, &mut |line| {
                lines.push(line.to_owned())
            })
            .unwrap();
            assert_eq!(
                std::fs::read_to_string(dir.path().join("omp.argv")).unwrap(),
                format!("{}\n", expected.join("\n"))
            );
            assert_eq!(result.output, "✔ Added marketplace: /tmp/omp-mkt\n");
            assert_eq!(lines, ["✔ Added marketplace: /tmp/omp-mkt"]);
        }
        let guard = busy.try_acquire().unwrap();
        assert_eq!(
            run_operation(&bin, &busy, Operation::SkillsUpdate, &mut |_| {})
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        drop(guard);
        for operation in [
            Operation::Install("--bad".into()),
            Operation::Uninstall("name;echo@m".into()),
            Operation::SetEnabled {
                id: "bad".into(),
                enabled: true,
            },
            Operation::Upgrade(Some("bad\n@m".into())),
            Operation::MarketplaceUpdate(Some("-bad".into())),
            Operation::MarketplaceAdd("owner/repo;echo".into()),
            Operation::MarketplaceRemove("bad/name".into()),
        ] {
            assert_eq!(
                run_operation(&bin, &busy, operation, &mut |_| {})
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidInput
            );
            assert_eq!(
                std::fs::read_to_string(dir.path().join("omp.argv")).unwrap(),
                "skill\nupdate\n-g\n"
            );
            assert!(busy.try_acquire().is_ok());
        }
        let (_dir, failing) = fake("echo 'failure tail' >&2; exit 1");
        let error =
            run_operation(&failing, &busy, Operation::SkillsUpdate, &mut |_| {}).unwrap_err();
        assert_eq!(error.code, ErrorCode::OmpFailed);
        assert!(error.message.contains("failure tail"));
        assert!(busy.try_acquire().is_ok());
    }

    #[test]
    fn list_partial_failures_do_not_hide_other_data() {
        let _processes = crate::omp_cli::subprocess_test_guard();
        for plugin_failure in [true, false] {
            let body = if plugin_failure {
                "if [ \"$2\" = list ]; then echo 'plugin failure' >&2; exit 1; fi\nprintf 'Configured Marketplaces:\\n\\n  m  /tmp/omp-mkt\\n'"
            } else {
                "if [ \"$2\" = list ]; then printf '{\"marketplace\":[{\"id\":\"hello@m\",\"entries\":[{\"scope\":\"user\"}]}],\"npm\":[]}'; else echo 'marketplace failure' >&2; exit 1; fi"
            };
            let (_dir, bin) = fake(body);
            let result = plugins_list_impl(&bin);
            assert_eq!(result.warnings.len(), 1);
            assert_eq!(result.plugins.len(), usize::from(!plugin_failure));
            assert_eq!(result.marketplaces.len(), usize::from(plugin_failure));
        }
        let (_dir, bin) = fake(
            "if [ \"$2\" = list ]; then echo garbage; else echo 'No marketplaces configured'; fi",
        );
        assert_eq!(plugins_list_impl(&bin).warnings.len(), 1);
    }

    #[test]
    fn readonly_argv_and_discover_validation() {
        let _processes = crate::omp_cli::subprocess_test_guard();
        let (dir, bin) = fake("printf '%s\\n' \"$@\" > \"$0.argv\"\nif [ \"$1\" = skill ]; then echo '{\"skills\":[],\"warnings\":[]}'; else printf 'Available Plugins:\\n\\n  hello@1.0\\n    Description\\n'; fi");
        assert_eq!(discover_impl(&bin, "m").unwrap().len(), 1);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("omp.argv")).unwrap(),
            "plugin\ndiscover\nm\n--scope\nuser\n"
        );
        assert!(discover_impl(&bin, "-bad").is_err());
        assert!(skills_list_impl(&bin).unwrap().skills.is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("omp.argv")).unwrap(),
            "skill\nlist\n-g\n--json\n"
        );
    }
}
