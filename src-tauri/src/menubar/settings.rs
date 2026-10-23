//! 菜单栏设置：`<data_dir>/settings.json`（CONTRACT §17.5）。
//!
//! - 与 `meta.json` 同目录（`OMP_RESUME_DATA_DIR` 可覆盖），版本字段 + 原子写入
//!   + 新文件 0600 的写法复用 `meta.rs` 思路；
//! - 与 meta 不同：损坏/版本不兼容时**回落默认且不覆盖损坏文件**（设置丢了
//!   可重选，备注丢了不行）；
//! - 无 revision：唯一写者是托盘菜单勾选（主线程串行），不做跨进程协同。

#[cfg(test)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// settings.json 的 schema 版本。
pub const SETTINGS_VERSION: u32 = 1;

/// 菜单栏设置（菜单勾选项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 会话进入“等待输入”时发系统通知（默认开）。
    #[serde(default = "default_true")]
    pub notify_on_waiting: bool,
    /// 在 Dock 显示图标（默认关：隐藏主窗口时 Dock 图标也隐藏）。
    #[serde(default)]
    pub show_dock_icon: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            notify_on_waiting: true,
            show_dock_icon: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    version: u32,
    #[serde(flatten)]
    settings: Settings,
}

/// settings.json 路径。
pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

/// 读取设置：文件不存在/损坏/版本不兼容 → 默认值（**绝不**写回覆盖）。
pub fn load(data_dir: &Path) -> Settings {
    let path = settings_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(_) => return Settings::default(),
    };
    let file: SettingsFile = match serde_json::from_slice(&bytes) {
        Ok(f) => f,
        Err(_) => return Settings::default(),
    };
    if file.version != SETTINGS_VERSION {
        return Settings::default();
    }
    file.settings
}

/// 原子保存：同目录独占建临时文件（0600）→ 写 → 同步 → rename。
/// 已有文件保留原权限位（与 `meta.rs` 同口径）。
pub fn save(data_dir: &Path, settings: &Settings) -> std::io::Result<()> {
    let path = settings_path(data_dir);
    std::fs::create_dir_all(data_dir)?;
    let existing_permissions = std::fs::metadata(&path).ok().map(|md| md.permissions());
    let file = SettingsFile {
        version: SETTINGS_VERSION,
        settings: settings.clone(),
    };
    let mut bytes = serde_json::to_vec_pretty(&file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    bytes.push(b'\n');
    let pending =
        crate::util::PendingAtomic::stage(&path, &bytes, "settings.json", existing_permissions)
            .map_err(|(_, e)| e)?;
    pending.commit(&path).map_err(|(_, e)| e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        let s = Settings {
            notify_on_waiting: false,
            show_dock_icon: true,
        };
        save(dir.path(), &s).unwrap();
        assert_eq!(load(dir.path()), s);
        // 文件形状：版本 + camelCase。
        let raw = std::fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(raw.contains("\"version\": 1"), "{raw}");
        assert!(raw.contains("notifyOnWaiting"), "{raw}");
    }

    #[test]
    fn corrupt_falls_back_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(settings_path(dir.path()), "{not json").unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        assert_eq!(
            std::fs::read(settings_path(dir.path())).unwrap(),
            b"{not json"
        );
        // 版本不兼容同样回落。
        std::fs::write(
            settings_path(dir.path()),
            r#"{"version":99,"notifyOnWaiting":false,"showDockIcon":true}"#,
        )
        .unwrap();
        assert_eq!(load(dir.path()), Settings::default());
    }

    #[test]
    fn new_file_is_0600() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &Settings::default()).unwrap();
        let mode = std::fs::metadata(settings_path(dir.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "mode={mode:o}");
    }

    #[test]
    fn missing_fields_take_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(settings_path(dir.path()), r#"{"version":1}"#).unwrap();
        assert_eq!(load(dir.path()), Settings::default());
    }
}
