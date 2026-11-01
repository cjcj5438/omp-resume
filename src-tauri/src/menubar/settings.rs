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

/// settings.json 的 schema 版本（只增字段时不升级，靠 `#[serde(default)]` 兼容旧文件）。
pub const SETTINGS_VERSION: u32 = 1;

/// 托盘图标旁标题的徽标样式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BadgeStyle {
    /// `{working+stuck}·{waiting}`，有卡住追加 `!`。
    #[default]
    Count,
    /// 有待处理（等待输入/卡住）为 `●`，否则 `○`。
    Dot,
    /// 不显示文字，只显示图标。
    Icon,
}

/// 菜单会话标题截断宽度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleWidth {
    /// 截断 20 字。
    Compact,
    /// 截断 32 字（旧行为）。
    #[default]
    Standard,
    /// 截断 48 字。
    Wide,
}

impl TitleWidth {
    /// 标题最大字符数。
    pub fn chars(self) -> usize {
        match self {
            TitleWidth::Compact => 20,
            TitleWidth::Standard => 32,
            TitleWidth::Wide => 48,
        }
    }
}

/// 点击托盘图标的行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClickAction {
    /// 左键打开面板（旧 `menu` 值反序列化迁移为此，见别名）。
    #[default]
    #[serde(alias = "menu")]
    Panel,
    /// 左键打开主窗口（右键仍弹原生菜单）。
    Window,
}

/// 菜单栏设置（菜单勾选项 + 菜单栏页选项；CONTRACT §17.4）。
///
/// 新增字段一律带 `#[serde(default…)]`：旧 `settings.json`（只有
/// `version/notifyOnWaiting/showDockIcon`）加载后行为不变。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 会话进入“等待输入”时发系统通知（默认开）。
    #[serde(default = "default_true")]
    pub notify_on_waiting: bool,
    /// 会话进入“可能卡住”时发系统通知（默认开；旧文件缺省时继承 `notify_on_waiting`）。
    #[serde(default = "default_true")]
    pub notify_on_stuck: bool,
    /// 会话结束时发系统通知（默认关）。
    #[serde(default)]
    pub notify_on_finish: bool,
    /// 托盘图标旁标题样式（默认计数）。
    #[serde(default)]
    pub badge_style: BadgeStyle,
    /// 菜单会话标题截断宽度（默认标准 32 字）。
    #[serde(default)]
    pub title_width: TitleWidth,
    /// 显示今日花费行（默认开）。
    #[serde(default = "default_true")]
    pub show_cost: bool,
    /// 会话行追加项目名（默认关）。
    #[serde(default)]
    pub show_project: bool,
    /// 显示空闲会话行（默认开；关时只隐藏行，头部计数不变）。
    #[serde(default = "default_true")]
    pub show_idle: bool,
    /// 精简行：只保留标题、项目名与时长（默认关）。
    #[serde(default)]
    pub compact_rows: bool,
    /// 点击托盘图标的行为（默认左键开面板）。
    #[serde(default)]
    pub click_action: ClickAction,
    /// 面板内显示搜索框（默认开）。
    #[serde(default = "default_true")]
    pub show_search: bool,
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
            notify_on_stuck: true,
            notify_on_finish: false,
            badge_style: BadgeStyle::Count,
            title_width: TitleWidth::Standard,
            show_cost: true,
            show_project: false,
            show_idle: true,
            compact_rows: false,
            click_action: ClickAction::Panel,
            show_search: true,
            show_dock_icon: false,
        }
    }
}

/// 设置补丁（`set_tray_settings` 参数）：`None` 字段不触碰。
///
/// `deny_unknown_fields`：拼错的键直接反序列化失败，前端能立刻发现。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub notify_on_waiting: Option<bool>,
    pub notify_on_stuck: Option<bool>,
    pub notify_on_finish: Option<bool>,
    pub badge_style: Option<BadgeStyle>,
    pub title_width: Option<TitleWidth>,
    pub show_cost: Option<bool>,
    pub show_project: Option<bool>,
    pub show_idle: Option<bool>,
    pub compact_rows: Option<bool>,
    pub click_action: Option<ClickAction>,
    pub show_search: Option<bool>,
    pub show_dock_icon: Option<bool>,
}

impl SettingsPatch {
    /// 把 `Some` 字段写入设置（`None` 不动）。
    pub fn apply(&self, s: &mut Settings) {
        if let Some(v) = self.notify_on_waiting {
            s.notify_on_waiting = v;
        }
        if let Some(v) = self.notify_on_stuck {
            s.notify_on_stuck = v;
        }
        if let Some(v) = self.notify_on_finish {
            s.notify_on_finish = v;
        }
        if let Some(v) = self.badge_style {
            s.badge_style = v;
        }
        if let Some(v) = self.title_width {
            s.title_width = v;
        }
        if let Some(v) = self.show_cost {
            s.show_cost = v;
        }
        if let Some(v) = self.show_project {
            s.show_project = v;
        }
        if let Some(v) = self.show_idle {
            s.show_idle = v;
        }
        if let Some(v) = self.compact_rows {
            s.compact_rows = v;
        }
        if let Some(v) = self.click_action {
            s.click_action = v;
        }
        if let Some(v) = self.show_search {
            s.show_search = v;
        }
        if let Some(v) = self.show_dock_icon {
            s.show_dock_icon = v;
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
///
/// 旧文件（只有 `version/notifyOnWaiting/showDockIcon`）缺 `notifyOnStuck` 时，
/// 令其继承 `notifyOnWaiting`：卡住通知过去由等待输入总开关控制，继承后行为不变。
pub fn load(data_dir: &Path) -> Settings {
    let path = settings_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(_) => return Settings::default(),
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Settings::default(),
    };
    let stuck_missing = value.get("notifyOnStuck").is_none();
    let file: SettingsFile = match serde_json::from_value(value) {
        Ok(f) => f,
        Err(_) => return Settings::default(),
    };
    if file.version != SETTINGS_VERSION {
        return Settings::default();
    }
    let mut settings = file.settings;
    if stuck_missing {
        settings.notify_on_stuck = settings.notify_on_waiting;
    }
    settings
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
            badge_style: BadgeStyle::Dot,
            title_width: TitleWidth::Wide,
            click_action: ClickAction::Window,
            show_dock_icon: true,
            ..Settings::default()
        };
        save(dir.path(), &s).unwrap();
        assert_eq!(load(dir.path()), s);
        // 文件形状：版本 + camelCase。
        let raw = std::fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(raw.contains("\"version\": 1"), "{raw}");
        assert!(raw.contains("notifyOnWaiting"), "{raw}");
        assert!(raw.contains("badgeStyle"), "{raw}");
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

    #[test]
    fn legacy_file_inherits_stuck_from_waiting() {
        let dir = tempfile::tempdir().unwrap();
        // 旧文件：只有 version/notifyOnWaiting/showDockIcon。
        std::fs::write(
            settings_path(dir.path()),
            r#"{"version":1,"notifyOnWaiting":false,"showDockIcon":true}"#,
        )
        .unwrap();
        let s = load(dir.path());
        assert!(!s.notify_on_waiting);
        assert!(!s.notify_on_stuck);
        assert!(s.show_dock_icon);
        // 其余字段取新默认值（行为与旧版一致）。
        let d = Settings::default();
        assert_eq!(s.notify_on_finish, d.notify_on_finish);
        assert_eq!(s.badge_style, d.badge_style);
        assert_eq!(s.title_width, d.title_width);
        assert_eq!(s.show_cost, d.show_cost);
        assert_eq!(s.show_project, d.show_project);
        assert_eq!(s.show_idle, d.show_idle);
        assert_eq!(s.compact_rows, d.compact_rows);
        assert_eq!(s.click_action, d.click_action);
        assert_eq!(s.show_search, d.show_search);
        // 开着等待通知时继承开。
        std::fs::write(
            settings_path(dir.path()),
            r#"{"version":1,"notifyOnWaiting":true}"#,
        )
        .unwrap();
        assert!(load(dir.path()).notify_on_stuck);
        // 显式写了 notifyOnStuck 则不继承。
        std::fs::write(
            settings_path(dir.path()),
            r#"{"version":1,"notifyOnWaiting":true,"notifyOnStuck":false}"#,
        )
        .unwrap();
        assert!(!load(dir.path()).notify_on_stuck);
    }

    #[test]
    fn legacy_menu_click_action_migrates_to_panel() {
        // 旧值 `menu` 反序列化为 Panel（serde alias）；序列化写 `panel`。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            settings_path(dir.path()),
            r#"{"version":1,"clickAction":"menu"}"#,
        )
        .unwrap();
        let s = load(dir.path());
        assert_eq!(s.click_action, ClickAction::Panel);
        let raw = serde_json::to_string(&s).unwrap();
        assert!(raw.contains(r#""clickAction":"panel""#), "{raw}");
        // 新值 roundtrip。
        assert_eq!(
            serde_json::from_str::<ClickAction>(r#""panel""#).unwrap(),
            ClickAction::Panel
        );
        assert_eq!(
            serde_json::from_str::<ClickAction>(r#""window""#).unwrap(),
            ClickAction::Window
        );
        // showSearch 缺省开。
        assert!(load(dir.path()).show_search);
        let patch: SettingsPatch = serde_json::from_str(r#"{"showSearch":false}"#).unwrap();
        let mut s = Settings::default();
        patch.apply(&mut s);
        assert!(!s.show_search);
    }

    #[test]
    fn patch_rejects_unknown_keys_and_applies_only_given() {
        // 未知键反序列化失败。
        let bad: Result<SettingsPatch, _> =
            serde_json::from_str(r#"{"showCost":false,"typo":true}"#);
        assert!(bad.is_err(), "{bad:?}");
        // 只改传入的字段。
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"showCost":false,"badgeStyle":"dot"}"#).unwrap();
        let mut s = Settings::default();
        patch.apply(&mut s);
        assert!(!s.show_cost);
        assert_eq!(s.badge_style, BadgeStyle::Dot);
        assert_eq!(
            s,
            Settings {
                show_cost: false,
                badge_style: BadgeStyle::Dot,
                ..Settings::default()
            }
        );
    }
}
