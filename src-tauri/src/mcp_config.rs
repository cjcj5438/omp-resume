//! OMP 原生 MCP JSON 配置（CONTRACT §4.30–§4.35）。
//! 纯逻辑入口注入 HOME；列表只返回 secret 键名，变更不调用 omp。

use std::fs::{self, Permissions};
use std::io::ErrorKind;
#[cfg(test)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::model::{
    AppError, AppResult, ErrorCode, McpDeleteServerRequest, McpFileInfo, McpListResult,
    McpSaveResult, McpSaveServerRequest, McpScope, McpServer, McpServerRaw, McpSetEnabledRequest,
    McpShadowedBy, McpTransport,
};

pub const MCP_SCHEMA: &str = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
const ABSENT: &str = "absent";

/// Tauri 只管理一个实例；克隆仍共享同一把锁，不与 omp 子进程门禁混用。
#[derive(Clone, Default)]
pub struct McpWriteState(Arc<Mutex<()>>);

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn io(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Io, message)
}

fn conflict() -> AppError {
    AppError::new(ErrorCode::Conflict, "文件已被外部修改，请刷新后重试")
}

fn require_writable_revision(expected: &str) -> AppResult<()> {
    if expected == "unreadable" {
        return Err(io("配置文件无法读取，请先修复读取权限并刷新"));
    }
    Ok(())
}

fn not_found() -> AppError {
    AppError::new(ErrorCode::NotFound, "MCP 服务器不存在")
}

fn project_dir(home: &Path, project: Option<&str>) -> AppResult<Option<PathBuf>> {
    project
        .map(|project| {
            let path = Path::new(project);
            if !path.is_absolute() {
                return Err(invalid("项目路径必须是绝对路径"));
            }
            let path = fs::canonicalize(path).map_err(|_| invalid("项目路径不存在或无法访问"))?;
            if !path.is_dir() {
                return Err(invalid("项目路径必须是目录"));
            }
            let home = fs::canonicalize(home).map_err(|_| io("无法读取 HOME 目录"))?;
            if path == home {
                return Err(invalid("HOME 目录不能作为 MCP 项目目录"));
            }
            Ok(path)
        })
        .transpose()
}

fn file_path(home: &Path, scope: McpScope, project: Option<&str>) -> AppResult<PathBuf> {
    let project = project_dir(home, project)?;
    match scope {
        McpScope::User => Ok(home.join(".omp/agent/mcp.json")),
        McpScope::Project => project
            .map(|path| path.join(".omp/mcp.json"))
            .ok_or_else(|| invalid("项目级 MCP 配置需要项目路径")),
    }
}

/// 变更写穿软链接：目标 `mcp.json` 本身是软链接（dotfiles 常见做法）时，
/// 解析到最终目标并在目标目录做临时文件 + rename，链接本身保持不动；
/// 失效链接拒绝写入，不替用户创建目标。
fn resolve_write_path(path: &Path) -> AppResult<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            fs::canonicalize(path).map_err(|_| io("配置文件是一个失效的软链接，请先修复"))
        }
        _ => Ok(path.to_owned()),
    }
}

fn read_bytes(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(format!("无法读取 MCP 配置文件：{error}"))),
    }
}

fn revision(bytes: Option<&[u8]>) -> String {
    match bytes {
        Some(bytes) => format!("{:x}", Sha256::digest(bytes)),
        None => ABSENT.to_owned(),
    }
}

fn parse_document(bytes: &[u8]) -> AppResult<Value> {
    // 不附解析器上下文，避免错误信息意外携带配置中的 secret。
    let document: Value =
        serde_json::from_slice(bytes).map_err(|_| io("配置文件不是合法 JSON，请先手动修复"))?;
    if !document.is_object() {
        return Err(io("配置文件顶层必须是对象，请先手动修复"));
    }
    if document
        .get("mcpServers")
        .is_some_and(|map| !map.is_object())
    {
        return Err(io("配置文件的 mcpServers 必须是对象，请先手动修复"));
    }
    Ok(document)
}

fn string_list(document: &Value, key: &str) -> Vec<String> {
    document
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn read_list_file(scope: McpScope, path: PathBuf) -> (McpFileInfo, Option<Value>) {
    let mut info = McpFileInfo {
        scope,
        path: path.to_string_lossy().into_owned(),
        exists: false,
        read_error: None,
        revision: ABSENT.to_owned(),
        disabled_servers: Vec::new(),
        enabled_servers: Vec::new(),
    };
    match read_bytes(&path) {
        Ok(None) => (info, None),
        Ok(Some(bytes)) => {
            info.exists = true;
            info.revision = revision(Some(&bytes));
            match parse_document(&bytes) {
                Ok(document) => {
                    if scope == McpScope::User {
                        info.disabled_servers = string_list(&document, "disabledServers");
                        info.enabled_servers = string_list(&document, "enabledServers");
                    }
                    (info, Some(document))
                }
                Err(error) => {
                    info.read_error = Some(error.message);
                    (info, None)
                }
            }
        }
        Err(error) => {
            info.exists = true;
            info.revision = "unreadable".to_owned();
            info.read_error = Some(error.message);
            (info, None)
        }
    }
}

fn transport(config: &Value) -> McpTransport {
    match config.get("type") {
        Some(Value::String(kind)) => match kind.as_str() {
            "stdio" => McpTransport::Stdio,
            "http" => McpTransport::Http,
            "sse" => McpTransport::Sse,
            _ => McpTransport::Unknown,
        },
        Some(_) => McpTransport::Unknown,
        None if config.get("command").is_some() => McpTransport::Stdio,
        None if config.get("url").is_some() => McpTransport::Http,
        None => McpTransport::Unknown,
    }
}

/// 名称优先级与开关规则的纯函数；denylist 对同名落败项也优先。
pub fn effectiveness(
    scope: McpScope,
    project_has_name: bool,
    enabled: bool,
    denied: bool,
    allowed: bool,
) -> (bool, Option<McpShadowedBy>) {
    if denied {
        (false, Some(McpShadowedBy::DisabledServers))
    } else if scope == McpScope::User && project_has_name {
        (false, Some(McpShadowedBy::Project))
    } else if !enabled && !allowed {
        (false, Some(McpShadowedBy::Disabled))
    } else {
        (true, None)
    }
}

fn object_keys(config: &Value, key: &str) -> Vec<String> {
    config
        .get(key)
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

pub fn mcp_list_impl(home: &Path, project: Option<&str>) -> AppResult<McpListResult> {
    let project = project_dir(home, project)?;
    let mut sources = vec![read_list_file(
        McpScope::User,
        home.join(".omp/agent/mcp.json"),
    )];
    if let Some(project) = project {
        sources.push(read_list_file(
            McpScope::Project,
            project.join(".omp/mcp.json"),
        ));
    }
    let user = &sources[0].0;
    let project_servers = sources
        .get(1)
        .and_then(|(_, document)| document.as_ref())
        .and_then(|document| document.get("mcpServers"))
        .and_then(Value::as_object);
    let mut servers = Vec::new();
    for (info, document) in &sources {
        let Some(map) = document
            .as_ref()
            .and_then(|document| document.get("mcpServers"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (name, config) in map {
            let enabled = config
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let (effective, shadowed_by) = effectiveness(
                info.scope,
                project_servers.is_some_and(|map| map.contains_key(name)),
                enabled,
                user.disabled_servers.contains(name),
                user.enabled_servers.contains(name),
            );
            servers.push(McpServer {
                scope: info.scope,
                name: name.clone(),
                transport: transport(config),
                command: config
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                arg_count: config
                    .get("args")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len),
                url: config.get("url").and_then(Value::as_str).map(str::to_owned),
                enabled,
                effective,
                shadowed_by,
                env_keys: object_keys(config, "env"),
                header_keys: object_keys(config, "headers"),
                has_auth: ["auth", "oauth"]
                    .iter()
                    .any(|key| config.get(key).is_some_and(|value| !value.is_null())),
            });
        }
    }
    Ok(McpListResult {
        files: sources.into_iter().map(|(info, _)| info).collect(),
        servers,
    })
}

pub fn mcp_get_server_impl(
    home: &Path,
    scope: McpScope,
    project: Option<&str>,
    name: &str,
) -> AppResult<McpServerRaw> {
    validate_name(name)?;
    let path = file_path(home, scope, project)?;
    let bytes = read_bytes(&path)?.ok_or_else(not_found)?;
    let document = parse_document(&bytes)?;
    let config = document
        .get("mcpServers")
        .and_then(|servers| servers.get(name))
        .cloned()
        .ok_or_else(not_found)?;
    Ok(McpServerRaw {
        config,
        revision: revision(Some(&bytes)),
    })
}

fn validate_name(name: &str) -> AppResult<()> {
    if name.is_empty()
        || name.len() > 100
        || name.starts_with(' ')
        || name.ends_with(' ')
        || name.contains("  ")
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-.: ".contains(c))
    {
        return Err(invalid(
            "服务器名称须为 1–100 个字母、数字或 _ - . :，名称段之间仅允许单个空格",
        ));
    }
    Ok(())
}

fn validate_config(config: &Value) -> AppResult<()> {
    let object = config
        .as_object()
        .ok_or_else(|| invalid("服务器配置必须是 JSON 对象"))?;
    if object.contains_key("command") && object.contains_key("url") {
        return Err(invalid("command 与 url 不能同时设置"));
    }
    let kind = match transport(config) {
        McpTransport::Unknown if !object.contains_key("type") => McpTransport::Stdio,
        McpTransport::Unknown => return Err(invalid("type 仅支持 stdio、http 或 sse")),
        kind => kind,
    };
    let required = if kind == McpTransport::Stdio {
        "command"
    } else {
        "url"
    };
    if config
        .get(required)
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err(invalid(format!("{required} 必须是非空字符串")));
    }
    if let Some(args) = config.get("args") {
        if args
            .as_array()
            .is_none_or(|args| !args.iter().all(Value::is_string))
        {
            return Err(invalid("args 必须是字符串数组"));
        }
    }
    for field in ["env", "headers"] {
        if let Some(values) = config.get(field) {
            let values = values
                .as_object()
                .ok_or_else(|| invalid(format!("{field} 必须是字符串值对象")))?;
            for (key, value) in values {
                let value = value
                    .as_str()
                    .ok_or_else(|| invalid(format!("{field}.{key} 必须是字符串")))?;
                if !value.is_empty() && value.chars().all(|c| c == '•') {
                    return Err(invalid(format!(
                        "{field}.{key} 不能是掩码占位符，请填写真实值"
                    )));
                }
            }
        }
    }
    if config
        .get("enabled")
        .is_some_and(|enabled| !enabled.is_boolean())
    {
        return Err(invalid("enabled 必须是布尔值"));
    }
    if config
        .get("timeout")
        .is_some_and(|timeout| timeout.as_f64().is_none_or(|n| n < 0.0))
    {
        return Err(invalid("timeout 必须是非负数"));
    }
    Ok(())
}

fn atomic_write(
    path: &Path,
    bytes: &[u8],
    permissions: Option<Permissions>,
    expected: &str,
) -> AppResult<()> {
    use crate::util::AtomicStage;
    let parent = path.parent().ok_or_else(|| io("MCP 配置路径无效"))?;
    fs::create_dir_all(parent).map_err(|error| io(format!("无法创建 MCP 配置目录：{error}")))?;
    let pending = crate::util::PendingAtomic::stage(path, bytes, "mcp.json", permissions).map_err(
        |(stage, error)| match stage {
            AtomicStage::Create => io(format!("无法创建 MCP 临时文件：{error}")),
            AtomicStage::Write => io(format!("无法写入 MCP 配置：{error}")),
            AtomicStage::Chmod => io(format!("无法设置 MCP 配置权限：{error}")),
            AtomicStage::Sync => io(format!("无法同步 MCP 配置：{error}")),
            AtomicStage::Rename => io(format!("无法原子替换 MCP 配置：{error}")),
        },
    )?;
    // 缩小外部 /mcp add 与本应用读改写之间的竞态窗口。
    if revision(read_bytes(path)?.as_deref()) != expected {
        return Err(conflict());
    }
    pending
        .commit(path)
        .map_err(|(_, error)| io(format!("无法原子替换 MCP 配置：{error}")))
}

fn modify_file(
    home: &Path,
    scope: McpScope,
    project: Option<&str>,
    expected: &str,
    modify: impl FnOnce(&mut Map<String, Value>) -> AppResult<()>,
) -> AppResult<McpSaveResult> {
    let path = resolve_write_path(&file_path(home, scope, project)?)?;
    let bytes = read_bytes(&path)?;
    if revision(bytes.as_deref()) != expected {
        return Err(conflict());
    }
    let mut document = match &bytes {
        Some(bytes) => parse_document(bytes)?,
        None => serde_json::json!({ "$schema": MCP_SCHEMA, "mcpServers": {} }),
    };
    let permissions = if bytes.is_some() {
        Some(
            fs::metadata(&path)
                .map_err(|error| io(format!("无法读取 MCP 配置权限：{error}")))?
                .permissions(),
        )
    } else {
        None
    };
    let servers = document
        .as_object_mut()
        .ok_or_else(|| io("配置文件顶层必须是对象，请先手动修复"))?
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| io("配置文件的 mcpServers 必须是对象，请先手动修复"))?;
    modify(servers)?;
    let mut output = serde_json::to_vec_pretty(&document).map_err(|_| io("无法序列化 MCP 配置"))?;
    output.push(b'\n');
    atomic_write(&path, &output, permissions, expected)?;
    Ok(McpSaveResult {
        revision: revision(Some(&output)),
    })
}

pub fn mcp_save_server_impl(
    home: &Path,
    request: McpSaveServerRequest,
) -> AppResult<McpSaveResult> {
    require_writable_revision(&request.expected_revision)?;
    modify_file(
        home,
        request.scope,
        request.project.as_deref(),
        &request.expected_revision,
        |servers| {
            validate_name(&request.name)?;
            validate_config(&request.config)?;
            if let Some(original) = &request.original_name {
                validate_name(original)?;
            }
            if let Some(original) = &request.original_name {
                if !servers.contains_key(original) {
                    return Err(not_found());
                }
                if original != &request.name {
                    if servers.contains_key(&request.name) {
                        return Err(invalid("服务器名称已存在，不能覆盖其他服务器"));
                    }
                    // preserve_order 下 remove 会交换末项，必须使用 shift_remove。
                    servers.shift_remove(original);
                }
            }
            servers.insert(request.name, request.config);
            Ok(())
        },
    )
}

pub fn mcp_set_enabled_impl(
    home: &Path,
    request: &McpSetEnabledRequest,
) -> AppResult<McpSaveResult> {
    require_writable_revision(&request.expected_revision)?;
    modify_file(
        home,
        request.scope,
        request.project.as_deref(),
        &request.expected_revision,
        |servers| {
            validate_name(&request.name)?;
            let config = servers.get_mut(&request.name).ok_or_else(not_found)?;
            let object = config
                .as_object_mut()
                .ok_or_else(|| invalid("服务器配置必须是 JSON 对象"))?;
            if request.enabled {
                object.shift_remove("enabled");
            } else {
                object.insert("enabled".to_owned(), Value::Bool(false));
            }
            validate_config(config)
        },
    )
}

pub fn mcp_delete_server_impl(
    home: &Path,
    request: &McpDeleteServerRequest,
) -> AppResult<McpSaveResult> {
    require_writable_revision(&request.expected_revision)?;
    modify_file(
        home,
        request.scope,
        request.project.as_deref(),
        &request.expected_revision,
        |servers| {
            validate_name(&request.name)?;
            servers.shift_remove(&request.name).ok_or_else(not_found)?;
            Ok(())
        },
    )
}

#[tauri::command]
pub async fn mcp_list(project: Option<String>) -> AppResult<McpListResult> {
    crate::blocking(move || mcp_list_impl(&crate::util::home_dir_strict()?, project.as_deref()))
        .await
}

#[tauri::command]
pub async fn mcp_get_server(
    scope: McpScope,
    project: Option<String>,
    name: String,
) -> AppResult<McpServerRaw> {
    crate::blocking(move || {
        mcp_get_server_impl(
            &crate::util::home_dir_strict()?,
            scope,
            project.as_deref(),
            &name,
        )
    })
    .await
}

async fn mutate<T: Send + 'static>(
    state: McpWriteState,
    operation: impl FnOnce(&Path) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    crate::blocking(move || {
        let _guard = state.0.lock().map_err(|_| io("MCP 配置写入锁不可用"))?;
        operation(&crate::util::home_dir_strict()?)
    })
    .await
}

#[tauri::command]
pub async fn mcp_save_server(
    state: tauri::State<'_, McpWriteState>,
    scope: McpScope,
    project: Option<String>,
    name: String,
    config: Value,
    expected_revision: String,
    original_name: Option<String>,
) -> AppResult<McpSaveResult> {
    let request = McpSaveServerRequest {
        scope,
        project,
        name,
        config,
        expected_revision,
        original_name,
    };
    mutate(state.inner().clone(), move |home| {
        mcp_save_server_impl(home, request)
    })
    .await
}

#[tauri::command]
pub async fn mcp_set_enabled(
    state: tauri::State<'_, McpWriteState>,
    scope: McpScope,
    project: Option<String>,
    name: String,
    enabled: bool,
    expected_revision: String,
) -> AppResult<McpSaveResult> {
    let request = McpSetEnabledRequest {
        scope,
        project,
        name,
        enabled,
        expected_revision,
    };
    mutate(state.inner().clone(), move |home| {
        mcp_set_enabled_impl(home, &request)
    })
    .await
}

#[tauri::command]
pub async fn mcp_delete_server(
    state: tauri::State<'_, McpWriteState>,
    scope: McpScope,
    project: Option<String>,
    name: String,
    expected_revision: String,
) -> AppResult<McpSaveResult> {
    let request = McpDeleteServerRequest {
        scope,
        project,
        name,
        expected_revision,
    };
    mutate(state.inner().clone(), move |home| {
        mcp_delete_server_impl(home, &request)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn write_config(home: &Path, content: &[u8]) -> PathBuf {
        let path = home.join(".omp/agent/mcp.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    fn save_request(name: &str, config: Value, expected: &str) -> McpSaveServerRequest {
        McpSaveServerRequest {
            scope: McpScope::User,
            project: None,
            name: name.to_owned(),
            config,
            expected_revision: expected.to_owned(),
            original_name: None,
        }
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn keys(value: &Value) -> Vec<&str> {
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn effectiveness_exhaustive_truth_table() {
        for scope in [McpScope::User, McpScope::Project] {
            for project in [false, true] {
                for enabled in [false, true] {
                    for denied in [false, true] {
                        for allowed in [false, true] {
                            let result = effectiveness(scope, project, enabled, denied, allowed);
                            let expected = match (denied, scope, project, enabled, allowed) {
                                (true, _, _, _, _) => (false, Some(McpShadowedBy::DisabledServers)),
                                (false, McpScope::User, true, _, _) => {
                                    (false, Some(McpShadowedBy::Project))
                                }
                                (false, _, _, false, false) => {
                                    (false, Some(McpShadowedBy::Disabled))
                                }
                                _ => (true, None),
                            };
                            assert_eq!(
                                result, expected,
                                "{scope:?} {project} {enabled} {denied} {allowed}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn list_masks_nothing_and_leaks_no_secret_values() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        write_config(home.path(), br#"{
          "mcpServers": {
            "shared": {"command":"npx", "args":["private-argument"], "env":{"TOKEN":"private-env"}},
            "denied": {"type":"sse","url":"https://example.test/sse","headers":{"Authorization":"private-header"},"oauth":{"clientSecret":"private-oauth"}},
            "forced": {"command":"node", "enabled":false, "auth":{"clientSecret":"private-auth"}},
            "unknown": {"type":"future","auth":null}
          },
          "disabledServers":["denied"], "enabledServers":["denied","forced"]
        }"#);
        let project_path = project.path().join(".omp/mcp.json");
        fs::create_dir_all(project_path.parent().unwrap()).unwrap();
        fs::write(project_path, br#"{"mcpServers":{"shared":{"type":"http","url":"https://example.test/mcp","enabled":false},"denied":{"command":"node"}},"disabledServers":["forced"],"enabledServers":["shared"]}"#).unwrap();
        let list = mcp_list_impl(home.path(), project.path().to_str()).unwrap();
        let serialized = serde_json::to_string(&list).unwrap();
        for secret in [
            "private-argument",
            "private-env",
            "private-header",
            "private-oauth",
            "private-auth",
            "••••",
        ] {
            assert!(!serialized.contains(secret));
        }
        assert_eq!(list.servers[0].env_keys, ["TOKEN"]);
        assert_eq!(list.servers[0].arg_count, 1);
        assert_eq!(list.servers[0].shadowed_by, Some(McpShadowedBy::Project));
        assert_eq!(list.servers[1].header_keys, ["Authorization"]);
        assert_eq!(
            list.servers[1].shadowed_by,
            Some(McpShadowedBy::DisabledServers)
        );
        assert!(list.servers[1].has_auth);
        assert!(list.servers[2].effective);
        assert!(!list.servers[2].enabled);
        assert_eq!(list.servers[3].transport, McpTransport::Unknown);
        assert!(!list.servers[3].has_auth);
        assert_eq!(list.servers[4].shadowed_by, Some(McpShadowedBy::Disabled));
        assert_eq!(
            list.servers[5].shadowed_by,
            Some(McpShadowedBy::DisabledServers)
        );
        assert!(list.files[1].disabled_servers.is_empty());
        assert!(list.files[1].enabled_servers.is_empty());
    }

    #[test]
    fn list_absent_invalid_and_unreadable_files_are_per_file_results() {
        let home = tempdir().unwrap();
        let absent = mcp_list_impl(home.path(), None).unwrap();
        assert_eq!(absent.files[0].revision, ABSENT);
        assert!(!absent.files[0].exists);
        assert!(absent.servers.is_empty());
        let path = write_config(home.path(), b"not-json-secret");
        let invalid = mcp_list_impl(home.path(), None).unwrap();
        assert!(invalid.files[0].exists);
        assert_eq!(
            invalid.files[0].revision,
            revision(Some(b"not-json-secret"))
        );
        assert_eq!(
            invalid.files[0].read_error.as_deref(),
            Some("配置文件不是合法 JSON，请先手动修复")
        );
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let unreadable = mcp_list_impl(home.path(), None).unwrap();
        assert!(unreadable.files[0].read_error.is_some());
        assert!(unreadable.servers.is_empty());
    }

    #[test]
    fn unreadable_revision_and_unreadable_bytes_refuse_all_mutations() {
        struct RestorePermissions(PathBuf, Permissions);
        impl Drop for RestorePermissions {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, self.1.clone());
            }
        }
        let home = tempdir().unwrap();
        let original = br#"{"mcpServers":{"target":{"command":"node"}}}"#;
        let path = write_config(home.path(), original);
        let restore = RestorePermissions(path.clone(), fs::metadata(&path).unwrap().permissions());
        let toggle = |expected: &str| McpSetEnabledRequest {
            scope: McpScope::User,
            project: None,
            name: "target".to_owned(),
            enabled: false,
            expected_revision: expected.to_owned(),
        };
        let deletion = |expected: &str| McpDeleteServerRequest {
            scope: McpScope::User,
            project: None,
            name: "target".to_owned(),
            expected_revision: expected.to_owned(),
        };
        // 即使当前可读，来自旧列表的 unreadable 也必须先拒绝，而不是报冲突。
        assert_eq!(
            mcp_save_server_impl(
                home.path(),
                save_request("target", json!(null), "unreadable")
            )
            .unwrap_err()
            .code,
            ErrorCode::Io
        );
        assert_eq!(
            mcp_set_enabled_impl(home.path(), &toggle("unreadable"))
                .unwrap_err()
                .code,
            ErrorCode::Io
        );
        assert_eq!(
            mcp_delete_server_impl(home.path(), &deletion("unreadable"))
                .unwrap_err()
                .code,
            ErrorCode::Io
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::set_permissions(&path, Permissions::from_mode(0o000)).unwrap();
        let list = mcp_list_impl(home.path(), None).unwrap();
        assert_eq!(list.files[0].revision, "unreadable");
        assert!(list.files[0].read_error.is_some());
        assert!(list.servers.is_empty());
        let expected = revision(Some(original));
        assert_eq!(
            mcp_save_server_impl(
                home.path(),
                save_request("target", json!({"command":"node"}), &expected)
            )
            .unwrap_err()
            .code,
            ErrorCode::Io
        );
        assert_eq!(
            mcp_set_enabled_impl(home.path(), &toggle(&expected))
                .unwrap_err()
                .code,
            ErrorCode::Io
        );
        assert_eq!(
            mcp_delete_server_impl(home.path(), &deletion(&expected))
                .unwrap_err()
                .code,
            ErrorCode::Io
        );
        assert_eq!(
            mcp_save_server_impl(
                home.path(),
                save_request("invalid/name", json!(null), &expected)
            )
            .unwrap_err()
            .code,
            ErrorCode::Io
        );
        drop(restore);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        let absent_home = tempdir().unwrap();
        assert_eq!(
            mcp_save_server_impl(
                absent_home.path(),
                save_request("target", json!({"command":"node"}), "unreadable")
            )
            .unwrap_err()
            .code,
            ErrorCode::Io
        );
        assert!(!absent_home.path().join(".omp").exists());
    }

    #[test]
    fn add_missing_file_creates_schema_directories_revision_and_0600() {
        let home = tempdir().unwrap();
        let result = mcp_save_server_impl(
            home.path(),
            save_request("local", json!({"command":"npx"}), ABSENT),
        )
        .unwrap();
        let path = home.path().join(".omp/agent/mcp.json");
        let bytes = fs::read(&path).unwrap();
        assert_eq!(result.revision, revision(Some(&bytes)));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let document = read_json(&path);
        assert_eq!(keys(&document), ["$schema", "mcpServers"]);
        assert_eq!(document["$schema"], MCP_SCHEMA);
        assert_eq!(document["mcpServers"]["local"]["command"], "npx");
        assert!(bytes.ends_with(b"\n"));
        assert!(String::from_utf8(bytes)
            .unwrap()
            .starts_with("{\n  \"$schema\""));
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn save_preserves_unknown_content_order_and_existing_permissions() {
        let home = tempdir().unwrap();
        let original = br#"{"zUnknown":{"y":1,"a":2},"mcpServers":{"z":{"command":"z","extension":{"z":1,"a":2}},"a":{"type":"http","url":"https://example.test"}},"$schema":"custom","disabledServers":["leftover"],"enabledServers":["other"],"aUnknown":true}"#;
        let path = write_config(home.path(), original);
        fs::set_permissions(&path, Permissions::from_mode(0o640)).unwrap();
        let result = mcp_save_server_impl(
            home.path(),
            save_request(
                "new",
                json!({"command":"node", "custom": [1,2]}),
                &revision(Some(original)),
            ),
        )
        .unwrap();
        let after = read_json(&path);
        let before: Value = serde_json::from_slice(original).unwrap();
        assert_eq!(keys(&after), keys(&before));
        assert_eq!(keys(&after["mcpServers"]), ["z", "a", "new"]);
        assert_eq!(keys(&after["zUnknown"]), ["y", "a"]);
        assert_eq!(keys(&after["mcpServers"]["z"]["extension"]), ["z", "a"]);
        let mut restored = after;
        restored["mcpServers"]
            .as_object_mut()
            .unwrap()
            .shift_remove("new");
        assert_eq!(restored, before);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(result.revision, revision(Some(&fs::read(&path).unwrap())));
    }

    #[test]
    fn edit_rename_round_trip_and_rename_collision() {
        let home = tempdir().unwrap();
        let path = write_config(home.path(), br#"{"mcpServers":{"first":{"command":"node","env":{"TOKEN":"real-secret"},"headers":{"X":"real-header"},"args":["real-arg"],"oauth":{"clientSecret":"real-oauth"},"extra":true},"second":{"command":"npx"}},"unknown":7}"#);
        let before = read_json(&path);
        let raw = mcp_get_server_impl(home.path(), McpScope::User, None, "first").unwrap();
        assert_eq!(raw.config["env"]["TOKEN"], "real-secret");
        let saved = mcp_save_server_impl(
            home.path(),
            save_request("first", raw.config, &raw.revision),
        )
        .unwrap();
        assert_eq!(read_json(&path), before);
        let mut request = save_request(
            "renamed",
            json!({"type":"sse","url":"https://example.test/sse"}),
            &saved.revision,
        );
        request.original_name = Some("first".to_owned());
        let renamed = mcp_save_server_impl(home.path(), request).unwrap();
        let after = read_json(&path);
        assert!(after["mcpServers"].get("first").is_none());
        assert_eq!(keys(&after["mcpServers"]), ["second", "renamed"]);
        assert_eq!(
            after["mcpServers"]["second"],
            before["mcpServers"]["second"]
        );
        let bytes = fs::read(&path).unwrap();
        let mut collision = save_request("second", json!({"command":"bad"}), &renamed.revision);
        collision.original_name = Some("renamed".to_owned());
        assert_eq!(
            mcp_save_server_impl(home.path(), collision)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn rejects_placeholder_values_without_touching_file() {
        let home = tempdir().unwrap();
        let original = br#"{"mcpServers":{"secret":{"command":"node","env":{"TOKEN":"keep-me"}}}}"#;
        let path = write_config(home.path(), original);
        for field in ["env", "headers"] {
            for mask in ["•", "••••", "••••••"] {
                let mut config = json!({"command":"node"});
                config[field] = json!({"TOKEN":mask});
                let error = mcp_save_server_impl(
                    home.path(),
                    save_request("secret", config, &revision(Some(original))),
                )
                .unwrap_err();
                assert_eq!(error.code, ErrorCode::InvalidInput);
                assert!(error.message.contains(&format!("{field}.TOKEN")));
                assert_eq!(fs::read(&path).unwrap(), original);
            }
        }
    }

    #[test]
    fn validates_every_requested_field_and_name_rule() {
        for name in ["a", "a_b-c.d:e", "MaaS Slack", &"a".repeat(100)] {
            assert!(validate_name(name).is_ok(), "{name}");
        }
        for name in [
            "",
            " leading",
            "trailing ",
            "two  spaces",
            "a/b",
            "a\\b",
            "a\tb",
            "中文",
            "a@b",
            &"a".repeat(101),
        ] {
            assert_eq!(
                validate_name(name).unwrap_err().code,
                ErrorCode::InvalidInput
            );
        }
        for config in [
            json!(null),
            json!([]),
            json!({}),
            json!({"type":"future","command":"x"}),
            json!({"type":3,"command":"x"}),
            json!({"command":" "}),
            json!({"command":1}),
            json!({"type":"http"}),
            json!({"type":"sse","url":""}),
            json!({"type":"http","url":1}),
            json!({"command":"x","url":"https://example.test"}),
            json!({"command":"x","args":"bad"}),
            json!({"command":"x","args":[1]}),
            json!({"command":"x","env":[]}),
            json!({"command":"x","env":{"TOKEN":3}}),
            json!({"command":"x","headers":[]}),
            json!({"command":"x","headers":{"X":false}}),
            json!({"command":"x","enabled":1}),
            json!({"command":"x","timeout":-1}),
            json!({"command":"x","timeout":"0"}),
        ] {
            assert_eq!(
                validate_config(&config).unwrap_err().code,
                ErrorCode::InvalidInput
            );
        }
        for config in [
            json!({"command":"node","args":[],"env":{"EMPTY":"","MIXED":"•real"},"timeout":0}),
            json!({"type":"http","url":"https://example.test","headers":{"X":"value"},"enabled":true,"timeout":0.5}),
            json!({"type":"sse","url":"https://example.test/sse"}),
            json!({"url":"https://example.test","unknown":{"z":1,"a":2}}),
        ] {
            validate_config(&config).unwrap();
        }
    }

    #[test]
    fn rejects_stale_revision_and_invalid_json_without_writing() {
        let home = tempdir().unwrap();
        let path = write_config(home.path(), br#"{"mcpServers":{}}"#);
        let listed = mcp_list_impl(home.path(), None)
            .unwrap()
            .files
            .remove(0)
            .revision;
        fs::write(&path, br#"{"mcpServers":{},"external":true}"#).unwrap();
        let external = fs::read(&path).unwrap();
        let error = mcp_save_server_impl(
            home.path(),
            save_request("new", json!({"command":"node"}), &listed),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(fs::read(&path).unwrap(), external);
        for broken in [
            b"invalid JSON".as_slice(),
            b"[]".as_slice(),
            br#"{"mcpServers":[]}"#.as_slice(),
        ] {
            fs::write(&path, broken).unwrap();
            let error = mcp_save_server_impl(
                home.path(),
                save_request("new", json!({"command":"node"}), &revision(Some(broken))),
            )
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::Io);
            assert_eq!(fs::read(&path).unwrap(), broken);
        }
    }

    #[test]
    fn enable_disable_and_delete_keep_overrides_and_other_order() {
        let home = tempdir().unwrap();
        let path = write_config(home.path(), br#"{"mcpServers":{"before":{"command":"a"},"target":{"command":"node","enabled":true,"extra":7},"after":{"command":"b"}},"disabledServers":["target"],"enabledServers":["target"]}"#);
        let mut request = McpSetEnabledRequest {
            scope: McpScope::User,
            project: None,
            name: "target".to_owned(),
            enabled: false,
            expected_revision: revision(Some(&fs::read(&path).unwrap())),
        };
        let disabled = mcp_set_enabled_impl(home.path(), &request).unwrap();
        assert_eq!(read_json(&path)["mcpServers"]["target"]["enabled"], false);
        request.enabled = true;
        request.expected_revision = disabled.revision;
        let enabled = mcp_set_enabled_impl(home.path(), &request).unwrap();
        let after = read_json(&path);
        assert!(after["mcpServers"]["target"].get("enabled").is_none());
        assert_eq!(after["mcpServers"]["target"]["extra"], 7);
        assert_eq!(keys(&after["mcpServers"]), ["before", "target", "after"]);
        assert!(!mcp_list_impl(home.path(), None).unwrap().servers[1].effective);
        let deletion = McpDeleteServerRequest {
            scope: McpScope::User,
            project: None,
            name: "target".to_owned(),
            expected_revision: enabled.revision,
        };
        mcp_delete_server_impl(home.path(), &deletion).unwrap();
        let after = read_json(&path);
        assert_eq!(keys(&after["mcpServers"]), ["before", "after"]);
        assert_eq!(after["disabledServers"], json!(["target"]));
        assert_eq!(after["enabledServers"], json!(["target"]));
    }

    #[test]
    fn missing_entries_and_revisions_fail_without_creating_files() {
        let home = tempdir().unwrap();
        assert_eq!(
            mcp_get_server_impl(home.path(), McpScope::User, None, "missing")
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let toggle = McpSetEnabledRequest {
            scope: McpScope::User,
            project: None,
            name: "missing".to_owned(),
            enabled: false,
            expected_revision: ABSENT.to_owned(),
        };
        assert_eq!(
            mcp_set_enabled_impl(home.path(), &toggle).unwrap_err().code,
            ErrorCode::NotFound
        );
        let deletion = McpDeleteServerRequest {
            scope: McpScope::User,
            project: None,
            name: "missing".to_owned(),
            expected_revision: ABSENT.to_owned(),
        };
        assert_eq!(
            mcp_delete_server_impl(home.path(), &deletion)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let request = save_request("new", json!({"command":"node"}), "wrong");
        assert_eq!(
            mcp_save_server_impl(home.path(), request).unwrap_err().code,
            ErrorCode::Conflict
        );
        assert!(!home.path().join(".omp").exists());
    }

    #[test]
    fn add_creates_missing_server_map_without_reordering_existing_keys() {
        let home = tempdir().unwrap();
        let original = br#"{"z":1,"$schema":"custom","a":{"y":2,"x":1}}"#;
        let path = write_config(home.path(), original);
        mcp_save_server_impl(
            home.path(),
            save_request("new", json!({"command":"node"}), &revision(Some(original))),
        )
        .unwrap();
        let document = read_json(&path);
        assert_eq!(keys(&document), ["z", "$schema", "a", "mcpServers"]);
        assert_eq!(keys(&document["a"]), ["y", "x"]);
        assert_eq!(document["$schema"], "custom");
    }

    #[test]
    fn stale_toggle_and_delete_and_missing_rename_leave_bytes_identical() {
        let home = tempdir().unwrap();
        let original = br#"{"mcpServers":{"target":{"command":"node"}}}"#;
        let path = write_config(home.path(), original);
        let toggle = McpSetEnabledRequest {
            scope: McpScope::User,
            project: None,
            name: "target".to_owned(),
            enabled: false,
            expected_revision: "old".to_owned(),
        };
        assert_eq!(
            mcp_set_enabled_impl(home.path(), &toggle).unwrap_err().code,
            ErrorCode::Conflict
        );
        let deletion = McpDeleteServerRequest {
            scope: McpScope::User,
            project: None,
            name: "target".to_owned(),
            expected_revision: "old".to_owned(),
        };
        assert_eq!(
            mcp_delete_server_impl(home.path(), &deletion)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let mut request = save_request("new", json!({"command":"node"}), &revision(Some(original)));
        request.original_name = Some("missing".to_owned());
        assert_eq!(
            mcp_save_server_impl(home.path(), request).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn validates_project_path_and_canonicalizes_before_creating_config() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        let plain_file = project.path().join("plain");
        fs::write(&plain_file, b"x").unwrap();
        let missing = project.path().join("missing");
        for path in [
            Some("relative"),
            missing.to_str(),
            plain_file.to_str(),
            home.path().to_str(),
        ] {
            assert_eq!(
                mcp_list_impl(home.path(), path).unwrap_err().code,
                ErrorCode::InvalidInput
            );
        }
        assert_eq!(
            file_path(home.path(), McpScope::Project, None)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        let mut request = save_request("project", json!({"command":"node"}), ABSENT);
        request.scope = McpScope::Project;
        request.project = Some(project.path().join(".").to_string_lossy().into_owned());
        mcp_save_server_impl(home.path(), request).unwrap();
        let canonical = fs::canonicalize(project.path())
            .unwrap()
            .join(".omp/mcp.json");
        assert!(canonical.exists());
        assert_eq!(
            fs::metadata(canonical).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!home.path().join(".omp").exists());
    }

    #[test]
    fn mcp_model_uses_camel_case_lowercase_and_error_codes() {
        assert_eq!(
            serde_json::to_value(ErrorCode::InvalidInput).unwrap(),
            "INVALID_INPUT"
        );
        assert_eq!(
            serde_json::to_value(ErrorCode::Conflict).unwrap(),
            "CONFLICT"
        );
        let request = McpSaveServerRequest {
            scope: McpScope::Project,
            project: None,
            name: "x".to_owned(),
            config: json!({"command":"node"}),
            expected_revision: ABSENT.to_owned(),
            original_name: None,
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["scope"], "project");
        assert_eq!(value["expectedRevision"], ABSENT);
        assert_eq!(value["originalName"], Value::Null);
        assert_eq!(
            serde_json::to_value(McpShadowedBy::DisabledServers).unwrap(),
            "disabledServers"
        );
    }

    #[test]
    fn save_through_symlink_preserves_link_and_updates_target() {
        use std::os::unix::fs::symlink;
        use std::os::unix::fs::PermissionsExt;
        let home = tempdir().unwrap();
        let dotfiles = tempdir().unwrap();
        let target = dotfiles.path().join("mcp.json");
        let original = br#"{"zUnknown":{"y":1},"mcpServers":{"z":{"command":"z"},"a":{"type":"http","url":"https://example.test"}},"aUnknown":true}"#;
        fs::write(&target, original).unwrap();
        fs::set_permissions(&target, Permissions::from_mode(0o640)).unwrap();
        let link = home.path().join(".omp/agent/mcp.json");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&target, &link).unwrap();
        // 读 revision 走链接与目标一致。
        let listed = mcp_list_impl(home.path(), None).unwrap();
        assert_eq!(listed.files[0].revision, revision(Some(original)));
        let result = mcp_save_server_impl(
            home.path(),
            save_request("new", json!({"command":"node"}), &revision(Some(original))),
        )
        .unwrap();
        // 链接本身保持不动，目标文件拿到新内容。
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), target);
        let target_bytes = fs::read(&target).unwrap();
        let after: Value = serde_json::from_slice(&target_bytes).unwrap();
        assert_eq!(after["mcpServers"]["new"]["command"], "node");
        let before: Value = serde_json::from_slice(original).unwrap();
        assert_eq!(keys(&after), keys(&before));
        assert_eq!(keys(&after["mcpServers"]), ["z", "a", "new"]);
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(result.revision, revision(Some(&target_bytes)));
        // 两边目录都不留临时文件。
        assert_eq!(fs::read_dir(link.parent().unwrap()).unwrap().count(), 1);
        assert_eq!(fs::read_dir(dotfiles.path()).unwrap().count(), 1);
    }

    #[test]
    fn dangling_symlink_refuses_all_mutations_without_creating() {
        use std::os::unix::fs::symlink;
        let home = tempdir().unwrap();
        let link = home.path().join(".omp/agent/mcp.json");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let missing = home.path().join("missing-target.json");
        symlink(&missing, &link).unwrap();
        let error = mcp_save_server_impl(
            home.path(),
            save_request("new", json!({"command":"node"}), ABSENT),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(error.message, "配置文件是一个失效的软链接，请先修复");
        let toggle = McpSetEnabledRequest {
            scope: McpScope::User,
            project: None,
            name: "new".to_owned(),
            enabled: false,
            expected_revision: ABSENT.to_owned(),
        };
        let error = mcp_set_enabled_impl(home.path(), &toggle).unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(error.message, "配置文件是一个失效的软链接，请先修复");
        let deletion = McpDeleteServerRequest {
            scope: McpScope::User,
            project: None,
            name: "new".to_owned(),
            expected_revision: ABSENT.to_owned(),
        };
        let error = mcp_delete_server_impl(home.path(), &deletion).unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert!(!missing.exists());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn save_through_symlink_project_scope() {
        use std::os::unix::fs::symlink;
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        let dotfiles = tempdir().unwrap();
        let target = dotfiles.path().join("project-mcp.json");
        let original = br#"{"mcpServers":{"old":{"command":"old"}}}"#;
        fs::write(&target, original).unwrap();
        let link = project.path().join(".omp/mcp.json");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&target, &link).unwrap();
        let mut request = save_request("new", json!({"command":"node"}), &revision(Some(original)));
        request.scope = McpScope::Project;
        request.project = Some(project.path().to_string_lossy().into_owned());
        mcp_save_server_impl(home.path(), request).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let after: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(after["mcpServers"]["new"]["command"], "node");
        assert_eq!(after["mcpServers"]["old"]["command"], "old");
    }
}
