//! Superagent 启用开关：`<data_dir>/superagent.json`。
//!
//! - 与 `meta.json` 同目录（`OMP_RESUME_DATA_DIR` 可覆盖），版本字段 + 原子写入
//!   + 新文件 0600 的写法复用 `meta.rs` 思路；
//! - 与 meta 不同：损坏/版本不兼容时**回落默认（禁用）且不覆盖损坏文件**
//!   （设置丢了可重选，备注丢了不行；与 `menubar/settings.rs` 同口径）；
//! - 无 revision：唯一写者是服务页开关（经命令串行），不做跨进程协同。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{AppError, AppResult, ErrorCode};

/// superagent.json 的 schema 版本。
pub const SETTINGS_VERSION: u32 = 1;

/// Superagent 开关设置。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperagentSettings {
    /// 是否启用 Superagent 守护进程。
    #[serde(default)]
    pub enabled: bool,
}

/// 磁盘文件形状。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    version: u32,
    enabled: bool,
}

/// superagent.json 路径。
pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("superagent.json")
}

/// 读取设置：文件不存在/损坏/版本不兼容 → 默认值（禁用，**绝不**写回覆盖）。
///
/// 损坏口径：读失败、非 UTF-8/非法 JSON、缺少字段、类型不对、版本非 1。
/// `enabled` 缺失时按 false 处理（与 `#[serde(default)]` 一致），但
/// `version` 缺失视为损坏（旧文件无版本号，不可与 v1 混认）。
pub fn load(data_dir: &Path) -> SuperagentSettings {
    let path = settings_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return SuperagentSettings::default(),
    };
    // 空文件/纯空白视为损坏（不断言 JSON 错误文案，只回落默认）。
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return SuperagentSettings::default();
    }
    let raw: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return SuperagentSettings::default(),
    };
    // version 必须存在且为 1；enabled 缺失默认为 false。
    let version = raw.get("version").and_then(serde_json::Value::as_u64);
    if version != Some(u64::from(SETTINGS_VERSION)) {
        return SuperagentSettings::default();
    }
    let enabled = raw
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    SuperagentSettings { enabled }
}

/// 原子保存：先落盘再由调用方启停进程；建目录失败或写入失败报 `IO`。
/// 新文件 0600；已有文件保留原权限位（与 `meta.rs` 同口径）。
pub fn save(data_dir: &Path, settings: &SuperagentSettings) -> AppResult<()> {
    let path = settings_path(data_dir);
    std::fs::create_dir_all(data_dir)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法创建数据目录：{e}")))?;
    let existing_permissions = std::fs::metadata(&path).ok().map(|md| md.permissions());
    let file = SettingsFile {
        version: SETTINGS_VERSION,
        enabled: settings.enabled,
    };
    let mut bytes = serde_json::to_vec_pretty(&file)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法序列化 Superagent 设置：{e}")))?;
    bytes.push(b'\n');
    let pending = crate::util::PendingAtomic::stage(
        &path,
        &bytes,
        "superagent.json",
        existing_permissions,
    )
    .map_err(|(_, e)| AppError::new(ErrorCode::Io, format!("无法保存 Superagent 设置：{e}")))?;
    pending
        .commit(&path)
        .map_err(|(_, e)| AppError::new(ErrorCode::Io, format!("无法保存 Superagent 设置：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_defaults_to_disabled() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(load(t.path()), SuperagentSettings { enabled: false });
        // 不回写。
        assert!(!settings_path(t.path()).exists());
    }

    #[test]
    fn corrupt_file_reads_as_disabled_without_rewrite() {
        let t = tempfile::tempdir().unwrap();
        let path = settings_path(t.path());
        for content in [
            "{ 不是合法 json",
            "",
            "   \n  ",
            r#"{"version":99,"enabled":true}"#,
            r#"{"enabled":true}"#,
            r#"{"version":"1","enabled":true}"#,
            r#"{"version":1,"enabled":"yes"}"#,
            "[1,2]",
            "null",
        ] {
            std::fs::write(&path, content).unwrap();
            assert_eq!(
                load(t.path()),
                SuperagentSettings { enabled: false },
                "{content:?}"
            );
            // 绝不回写覆盖损坏文件。
            assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
        }
        // 非 UTF-8 字节同样回落默认。
        std::fs::write(&path, b"\xff\xfe").unwrap();
        assert_eq!(load(t.path()), SuperagentSettings { enabled: false });
    }

    #[test]
    fn missing_enabled_defaults_to_false() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(settings_path(t.path()), r#"{"version":1}"#).unwrap();
        assert_eq!(load(t.path()), SuperagentSettings { enabled: false });
    }
    #[test]
    fn roundtrip_save_load() {
        let t = tempfile::tempdir().unwrap();
        save(t.path(), &SuperagentSettings { enabled: true }).unwrap();
        assert_eq!(load(t.path()), SuperagentSettings { enabled: true });
        let raw = std::fs::read(settings_path(t.path())).unwrap();
        assert!(raw.ends_with(b"\n"));
        // 新文件 0600。
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(settings_path(t.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
