//! 菜单栏下拉菜单的纯数据模型（CONTRACT §17.4）。
//!
//! 输入快照 → 输出全部展示字符串。[`MenuModel`] 派生 `PartialEq`：
//! 轮询只在模型变化时重建原生菜单。展示细节（排序、截断、计数文案）
//! 全部由本模块单测锁定，`tray` 只做机械装配。

use super::classify::SessionStatus;
use super::settings::{BadgeStyle, Settings};

/// 首屏最多会话行数，超出进「更多…」子菜单。
pub const MAX_ROWS: usize = 8;
/// 行内标题最大字符数（超出截断加 `…`；只留给 `recent_entry`，会话行按设置宽度截断）。
pub const TITLE_MAX_CHARS: usize = 32;
/// 托盘「最近会话」子菜单最多条目数。
pub const RECENT_LIMIT: usize = 5;
/// 托盘「新建会话」子菜单最多项目数。
pub const PROJECT_LIMIT: usize = 5;
/// 今日花费菜单项 id，同时作为就地更新器的键（会话 id 不会与之冲突）。
pub const COST_ITEM_ID: &str = "today-cost";

/// 单个会话行的输入快照（由轮询组装）。
#[derive(Debug, Clone)]
pub struct RowInput {
    pub session_id: String,
    pub title: String,
    pub status: SessionStatus,
    /// 项目名（cwd 末个非空段；未知时 None）。
    pub project: Option<String>,
    /// 占用应用展示名（未知时 None）。
    pub app_label: Option<String>,
    /// 占用者 PID（应用未知时展示用）。
    pub pid: Option<u32>,
    /// 是否可聚焦（iTerm 占用 + tty 已知）。
    pub focusable: bool,
    /// 不可聚焦的原因（`focusable == false` 时展示，如“仅 iTerm 可聚焦”）。
    pub focus_block_reason: Option<String>,
    pub subagents_running: u32,
    /// 距最后活动秒数。
    pub idle_secs: i64,
}

/// 单个会话行的展示数据。
///
/// 行文本拆成 时长前/时长/时长后 三段：时长是唯一高频变化的部分，
/// 其余任一字段变化都算结构性变化（见 [`MenuModel::same_structure`]）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowModel {
    pub session_id: String,
    /// 运行状态（装配时映射为原生状态图标）。
    pub status: SessionStatus,
    /// 时长之前（标题、应用名、状态文字；已截断，未做 `&` 转义）。
    pub head: String,
    /// 时长文字（唯一高频变化的部分）。
    pub duration_text: String,
    /// 时长之后（子代理计数、不可聚焦原因）。
    pub tail: String,
    pub enabled: bool,
}

impl RowModel {
    /// 完整行文本（装配时经 [`menu_text`] 转义）。
    pub fn text(&self) -> String {
        let mut s = self.head.clone();
        s.push_str(&self.duration_text);
        s.push_str(&self.tail);
        s
    }

    /// 形状相同 = 只可能差时长文字（可就地 `set_text`，不重建菜单）。
    fn same_shape(&self, other: &RowModel) -> bool {
        self.session_id == other.session_id
            && self.status == other.status
            && self.head == other.head
            && self.tail == other.tail
            && self.enabled == other.enabled
    }
}

/// 整个托盘菜单 + 图标标题的展示数据（变化检测用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuModel {
    /// 头部禁用项文本。
    pub header: String,
    pub rows: Vec<RowModel>,
    pub overflow: Vec<RowModel>,
    /// 图标旁标题（无占用时 None = 只显示图标）。
    pub tray_title: Option<String>,
    pub tooltip: String,
    /// 构建本模型的设置快照（任一字段变化都算结构性变化）。
    pub settings: Settings,
    /// 需要用户处理的会话数（等待输入 + 疑似卡住），Dock 角标用；0 = 无角标。
    pub badge_count: usize,
    /// 模型模式列表；`None` = 尚未读到或读取失败（菜单不显示「模式」子菜单）。
    pub modes: Option<Vec<ModeEntry>>,
    /// 附加数据；None = 尚未统计（不显示花费行与最近会话）。
    pub extras: Option<Extras>,
}

/// 托盘「模式」子菜单的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeEntry {
    pub name: String,
    pub active: bool,
    pub enabled: bool,
}

/// 托盘「最近会话」子菜单的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentEntry {
    pub session_id: String,
    pub path: String,
    pub text: String,
}

/// 托盘「新建会话」子菜单的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectEntry {
    pub cwd: String,
    pub text: String,
}

/// 60 秒慢刷新的附加数据。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extras {
    pub cost_text: Option<String>,
    pub recent: Vec<RecentEntry>,
    pub projects: Vec<ProjectEntry>,
}

impl MenuModel {
    /// 结构性变化检测：会话增减 / 状态 / 排序 / 标题 / 设置勾选任一变化即 false
    /// （头部与图标标题含计数，状态变化必改它们；行的形状含标题与状态文字）。
    /// 花费行是否出现算结构变化，但其金额数字的变化不算（由 [`refresh_decision`]
    /// 就地更新文字）。返回 true 时两个模型只可能差行内时长文字与花费文字。
    pub fn same_structure(&self, other: &MenuModel) -> bool {
        self.header == other.header
            && self.tray_title == other.tray_title
            && self.tooltip == other.tooltip
            && self.settings == other.settings
            && self.badge_count == other.badge_count
            && self.modes == other.modes
            && self.rows.len() == other.rows.len()
            && self.overflow.len() == other.overflow.len()
            && self
                .rows
                .iter()
                .zip(&other.rows)
                .all(|(a, b)| a.same_shape(b))
            && self
                .overflow
                .iter()
                .zip(&other.overflow)
                .all(|(a, b)| a.same_shape(b))
            && self
                .extras
                .as_ref()
                .map(|e| (&e.recent, &e.projects, e.cost_text.is_some()))
                == other
                    .extras
                    .as_ref()
                    .map(|e| (&e.recent, &e.projects, e.cost_text.is_some()))
    }
}

/// 轮询刷新决策（纯函数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refresh {
    /// 模型一致：不动菜单。
    None,
    /// 结构不变、文字变化：`(项 id, 新完整文本)`，就地 `set_text`
    /// 更新（NSMenu 展开时改文字安全，不关闭菜单）。
    /// 会话行用会话 id，花费行用 [`COST_ITEM_ID`]。
    Texts(Vec<(String, String)>),
    /// 结构性变化：整体重建菜单（`set_menu`，会关闭已展开的菜单）。
    Rebuild,
}

/// 决定菜单如何刷新：仅时长文字变化不重建，避免把用户正看着的菜单关掉。
pub fn refresh_decision(prev: Option<&MenuModel>, new: &MenuModel) -> Refresh {
    let Some(prev) = prev else {
        return Refresh::Rebuild;
    };
    if prev == new {
        return Refresh::None;
    }
    if !prev.same_structure(new) {
        return Refresh::Rebuild;
    }
    let mut texts = Vec::new();
    for (a, b) in prev
        .rows
        .iter()
        .zip(&new.rows)
        .chain(prev.overflow.iter().zip(&new.overflow))
    {
        if a.text() != b.text() {
            texts.push((b.session_id.clone(), b.text()));
        }
    }
    if new.settings.show_cost {
        if let (Some(a), Some(b)) = (
            prev.extras.as_ref().and_then(|e| e.cost_text.as_ref()),
            new.extras.as_ref().and_then(|e| e.cost_text.as_ref()),
        ) {
            if a != b {
                texts.push((COST_ITEM_ID.to_string(), b.clone()));
            }
        }
    }
    Refresh::Texts(texts)
}

/// 托盘标题用的状态计数。
pub struct StatusCounts {
    pub total: usize,
    pub working: usize,
    pub waiting: usize,
    pub stuck: usize,
}

/// 托盘图标旁标题（`None` = 只显示图标）。
pub fn tray_title(style: BadgeStyle, c: &StatusCounts) -> Option<String> {
    if c.total == 0 {
        return None;
    }
    match style {
        // `{在工作}·{在等我}`，在工作含疑似卡住；有卡住追加 `!`。
        BadgeStyle::Count => {
            let mut t = format!("{}·{}", c.working + c.stuck, c.waiting);
            if c.stuck > 0 {
                t.push('!');
            }
            Some(t)
        }
        BadgeStyle::Dot => Some(if c.waiting + c.stuck > 0 {
            "●".to_string()
        } else {
            "○".to_string()
        }),
        BadgeStyle::Icon => None,
    }
}

/// 徽标样式预览样例：固定计数下各状态的标题。
pub fn badge_samples(style: BadgeStyle) -> Vec<(SessionStatus, Option<String>)> {
    [
        (
            SessionStatus::Working,
            StatusCounts {
                total: 2,
                working: 2,
                waiting: 0,
                stuck: 0,
            },
        ),
        (
            SessionStatus::WaitingInput,
            StatusCounts {
                total: 1,
                working: 0,
                waiting: 1,
                stuck: 0,
            },
        ),
        (
            SessionStatus::Idle,
            StatusCounts {
                total: 1,
                working: 0,
                waiting: 0,
                stuck: 0,
            },
        ),
        (
            SessionStatus::Stuck,
            StatusCounts {
                total: 1,
                working: 0,
                waiting: 0,
                stuck: 1,
            },
        ),
    ]
    .into_iter()
    .map(|(status, counts)| (status, tray_title(style, &counts)))
    .collect()
}

/// 构建菜单模型（纯函数）。
pub fn build_model(inputs: Vec<RowInput>, settings: &Settings) -> MenuModel {
    let mut inputs = inputs;
    inputs.sort_by(|a, b| {
        (a.status.sort_rank(), a.title.clone(), a.session_id.clone()).cmp(&(
            b.status.sort_rank(),
            b.title.clone(),
            b.session_id.clone(),
        ))
    });
    let total = inputs.len();
    let working = inputs
        .iter()
        .filter(|r| r.status == SessionStatus::Working)
        .count();
    let waiting = inputs
        .iter()
        .filter(|r| r.status == SessionStatus::WaitingInput)
        .count();
    let stuck = inputs
        .iter()
        .filter(|r| r.status == SessionStatus::Stuck)
        .count();

    let header = if total == 0 {
        "没有运行中的 omp 会话".to_string()
    } else {
        let mut h = format!("omp 会话 · 占用 {total} · 工作中 {working} · 等待输入 {waiting}");
        if stuck > 0 {
            h.push_str(&format!(" · 疑似卡住 {stuck}"));
        }
        h
    };
    let tray_title = tray_title(
        settings.badge_style,
        &StatusCounts {
            total,
            working,
            waiting,
            stuck,
        },
    );

    let mut rows = Vec::new();
    let mut overflow = Vec::new();
    for input in inputs
        .iter()
        .filter(|r| settings.show_idle || r.status != SessionStatus::Idle)
    {
        let (head, duration_text, tail) = row_parts(input, settings);
        let row = RowModel {
            session_id: input.session_id.clone(),
            status: input.status,
            head,
            duration_text,
            tail,
            enabled: input.focusable,
        };
        if rows.len() < MAX_ROWS {
            rows.push(row);
        } else {
            overflow.push(row);
        }
    }
    MenuModel {
        tooltip: header.clone(),
        header,
        rows,
        overflow,
        tray_title,
        settings: settings.clone(),
        badge_count: waiting + stuck,
        modes: None,
        extras: None,
    }
}

/// 行文本三段：(时长前、时长、时长后)。见 [`RowModel`]。
///
/// 默认格式：`{标题}[ · {项目}] · [{应用} · ]{状态} · {距最后活动} [· 子代理 N][（原因）]`；
/// iTerm2 占用不写应用名（默认情形），状态图标由装配层加原生点。
/// `compact_rows` 时只保留「前缀 + 时长」：`{标题}[ · {项目}] · {距最后活动}`。
fn row_parts(input: &RowInput, settings: &Settings) -> (String, String, String) {
    let title = crate::sessions::truncate_chars(&input.title, settings.title_width.chars());
    let mut prefix = title;
    if settings.show_project {
        if let Some(project) = &input.project {
            prefix.push_str(&format!(" · {project}"));
        }
    }
    if settings.compact_rows {
        return (
            format!("{prefix} · "),
            format_duration(input.idle_secs),
            String::new(),
        );
    }
    let mut head = format!("{prefix} · ");
    match (&input.app_label, input.pid) {
        (Some(app), _) if app == "iTerm2" => {}
        (Some(app), _) => head.push_str(&format!("{app} · ")),
        (None, Some(pid)) => head.push_str(&format!("PID {pid} · ")),
        (None, None) => head.push_str("占用中 · "),
    }
    head.push_str(&format!("{} · ", input.status.label()));
    let mut tail = String::new();
    if input.subagents_running > 0 {
        tail.push_str(&format!(" · 子代理 {}", input.subagents_running));
    }
    if !input.focusable {
        if let Some(reason) = &input.focus_block_reason {
            tail.push_str(&format!("（{reason}）"));
        }
    }
    (head, format_duration(input.idle_secs), tail)
}
/// 距最后活动展示：`刚刚` / `X分` / `X小时Y分` / `X天`。
pub fn format_duration(secs: i64) -> String {
    let secs = secs.max(0);
    if secs < 60 {
        "刚刚".to_string()
    } else if secs < 3600 {
        format!("{}分", secs / 60)
    } else if secs < 86400 {
        let hours = secs / 3600;
        let mins = (secs % 3600) / 60;
        if mins == 0 {
            format!("{hours}小时")
        } else {
            format!("{hours}小时{mins}分")
        }
    } else {
        format!("{}天", secs / 86400)
    }
}

/// 菜单文本转义：muda 把 `&` 当助记符前缀，展示原文需写 `&&`。
pub fn menu_text(s: &str) -> String {
    s.replace('&', "&&")
}

/// 预设状态 → 子菜单条目：无效条目标记不可切换，命中激活名的标勾。
pub fn mode_entries(state: &crate::model::ModelPresetsState) -> Vec<ModeEntry> {
    state
        .presets
        .iter()
        .map(|p| ModeEntry {
            name: p.name.clone(),
            active: state.active.as_deref() == Some(p.name.as_str()),
            enabled: p.invalid_reason.is_none(),
        })
        .collect()
}

/// 今日花费行文本。
pub fn cost_text(total_usd: f64) -> String {
    format!("今日花费 ${total_usd:.2}")
}

/// 会话摘要 → 「最近会话」条目（标题截断 + 项目末级目录名）。
pub fn recent_entry(s: &crate::model::SessionSummary) -> RecentEntry {
    let mut text = crate::sessions::truncate_chars(&s.title, TITLE_MAX_CHARS);
    if !s.cwd.is_empty() {
        if let Some(last) = s.cwd.rsplit('/').next().filter(|c| !c.is_empty()) {
            text.push_str(&format!(" · {last}"));
        }
    }
    RecentEntry {
        session_id: s.id.clone(),
        path: s.path.clone(),
        text,
    }
}

/// 项目目录 → 「新建会话」条目（`$HOME` 缩写为 `~` 后截断 48 字）。
pub fn project_entry(cwd: &str, home: Option<&str>) -> ProjectEntry {
    let short = match home {
        Some(h) if !h.is_empty() && cwd == h => "~".to_string(),
        Some(h) if !h.is_empty() => match cwd.strip_prefix(&format!("{h}/")) {
            Some(rest) => format!("~/{rest}"),
            None => cwd.to_string(),
        },
        _ => cwd.to_string(),
    };
    ProjectEntry {
        cwd: cwd.to_string(),
        text: crate::sessions::truncate_chars(&short, 48),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, status: SessionStatus) -> RowInput {
        RowInput {
            session_id: id.to_string(),
            title: format!("会话{id}"),
            status,
            project: None,
            app_label: Some("iTerm2".to_string()),
            pid: Some(100),
            focusable: true,
            focus_block_reason: None,
            subagents_running: 0,
            idle_secs: 150,
        }
    }

    #[test]
    fn empty_model() {
        let m = build_model(vec![], &Settings::default());
        assert_eq!(m.header, "没有运行中的 omp 会话");
        assert_eq!(m.tray_title, None);
        assert!(m.rows.is_empty() && m.overflow.is_empty());
        assert_eq!(m.tooltip, m.header);
    }

    #[test]
    fn sorting_and_header_counts() {
        let m = build_model(
            vec![
                row("idle", SessionStatus::Idle),
                row("work", SessionStatus::Working),
                row("wait", SessionStatus::WaitingInput),
                row("stuck", SessionStatus::Stuck),
            ],
            &Settings::default(),
        );
        let ids: Vec<&str> = m.rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["stuck", "wait", "work", "idle"]);
        assert_eq!(
            m.header,
            "omp 会话 · 占用 4 · 工作中 1 · 等待输入 1 · 疑似卡住 1"
        );
        assert_eq!(m.tray_title, Some("2·1!".to_string()));
    }

    #[test]
    fn tray_title_no_stuck() {
        let m = build_model(
            vec![
                row("a", SessionStatus::Working),
                row("b", SessionStatus::Idle),
            ],
            &Settings::default(),
        );
        assert_eq!(m.header, "omp 会话 · 占用 2 · 工作中 1 · 等待输入 0");
        assert_eq!(m.tray_title, Some("1·0".to_string()));
    }

    #[test]
    fn overflow_goes_to_more() {
        let inputs: Vec<RowInput> = (0..10)
            .map(|i| row(&format!("s{i:02}"), SessionStatus::Working))
            .collect();
        let m = build_model(inputs, &Settings::default());
        assert_eq!(m.rows.len(), MAX_ROWS);
        assert_eq!(m.overflow.len(), 2);
        assert_eq!(m.overflow[0].session_id, "s08");
    }

    #[test]
    fn row_text_shape() {
        let mut r = row("x", SessionStatus::Working);
        r.title = "加长标题测试会话".to_string();
        r.subagents_running = 2;
        r.idle_secs = 3700;
        let m = build_model(vec![r], &Settings::default());
        assert_eq!(
            m.rows[0].text(),
            "加长标题测试会话 · 工作中 · 1小时1分 · 子代理 2"
        );
        assert!(m.rows[0].enabled);
        assert_eq!(m.rows[0].status, SessionStatus::Working);
    }

    #[test]
    fn non_focusable_row_disabled_with_reason() {
        let mut r = row("v", SessionStatus::WaitingInput);
        r.app_label = Some("VS Code".to_string());
        r.focusable = false;
        r.focus_block_reason = Some("仅 iTerm 可聚焦".to_string());
        let m = build_model(vec![r], &Settings::default());
        assert!(!m.rows[0].enabled);
        assert!(m.rows[0].text().contains("VS Code"), "{}", m.rows[0].text());
        assert!(
            m.rows[0].text().contains("（仅 iTerm 可聚焦）"),
            "{}",
            m.rows[0].text()
        );
    }

    #[test]
    fn unknown_app_falls_back_to_pid_then_marker() {
        let mut r = row("u", SessionStatus::Idle);
        r.app_label = None;
        r.pid = Some(4242);
        r.focusable = false;
        r.focus_block_reason = Some("未找到占用进程".to_string());
        let m = build_model(vec![r], &Settings::default());
        assert!(
            m.rows[0].text().contains("PID 4242"),
            "{}",
            m.rows[0].text()
        );

        let mut r = row("u2", SessionStatus::Idle);
        r.app_label = None;
        r.pid = None;
        r.focusable = false;
        r.focus_block_reason = Some("未找到占用进程".to_string());
        let m = build_model(vec![r], &Settings::default());
        assert!(
            m.rows[0].text().contains(" · 占用中 · "),
            "{}",
            m.rows[0].text()
        );
    }

    #[test]
    fn title_truncation() {
        let mut r = row("t", SessionStatus::Idle);
        r.title =
            "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四".to_string();
        assert!(r.title.chars().count() > TITLE_MAX_CHARS);
        let m = build_model(vec![r], &Settings::default());
        let text = m.rows[0].text();
        let title_part = text.split(" · ").next().unwrap().to_string();
        assert_eq!(title_part.chars().count(), TITLE_MAX_CHARS);
        assert!(title_part.ends_with('…'), "{title_part}");
        assert!(text.starts_with(&format!("{title_part} · ")), "{text}");
    }

    #[test]
    fn durations() {
        assert_eq!(format_duration(0), "刚刚");
        assert_eq!(format_duration(59), "刚刚");
        assert_eq!(format_duration(60), "1分");
        assert_eq!(format_duration(3600), "1小时");
        assert_eq!(format_duration(3660), "1小时1分");
        assert_eq!(format_duration(90000), "1天");
        assert_eq!(format_duration(-5), "刚刚");
    }

    #[test]
    fn mnemonic_escape() {
        assert_eq!(menu_text("R&D 会话"), "R&&D 会话");
        assert_eq!(menu_text("无特殊"), "无特殊");
    }

    #[test]
    fn row_text_parts() {
        let mut r = row("x", SessionStatus::Working);
        r.subagents_running = 1;
        r.idle_secs = 3660;
        let m = build_model(vec![r], &Settings::default());
        let row = &m.rows[0];
        assert_eq!(row.head, "会话x · 工作中 · ");
        assert_eq!(row.duration_text, "1小时1分");
        assert_eq!(row.tail, " · 子代理 1");
        assert_eq!(row.text(), "会话x · 工作中 · 1小时1分 · 子代理 1");
    }

    #[test]
    fn duration_only_change_is_text_update() {
        let mut a = row("a", SessionStatus::Working);
        a.idle_secs = 3590;
        let mut b = row("b", SessionStatus::Idle);
        b.idle_secs = 3590;
        let old = build_model(vec![a.clone(), b.clone()], &Settings::default());
        a.idle_secs = 3660; // 只有 a 跨分钟/小时边界，文本变化
        let new = build_model(vec![a, b], &Settings::default());
        assert!(old.same_structure(&new));
        assert_eq!(
            refresh_decision(Some(&old), &new),
            Refresh::Texts(vec![(
                "a".to_string(),
                "会话a · 工作中 · 1小时1分".to_string()
            )])
        );
    }

    #[test]
    fn overflow_duration_update_included() {
        let inputs: Vec<RowInput> = (0..9)
            .map(|i| row(&format!("s{i:02}"), SessionStatus::Working))
            .collect();
        let mut old_inputs = inputs.clone();
        old_inputs[8].idle_secs = 59;
        let old = build_model(old_inputs, &Settings::default());
        let mut new_inputs = inputs;
        new_inputs[8].idle_secs = 120;
        let new = build_model(new_inputs, &Settings::default());
        assert!(old.same_structure(&new));
        match refresh_decision(Some(&old), &new) {
            Refresh::Texts(texts) => {
                assert_eq!(texts.len(), 1);
                assert_eq!(texts[0].0, "s08"); // 溢出行的时长更新也要给到
                assert!(texts[0].1.contains("2分"), "{}", texts[0].1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn structural_changes_rebuild() {
        let old = build_model(vec![row("a", SessionStatus::Idle)], &Settings::default());
        // 状态变化（头部计数、行状态文字与原生图标都变）。
        let new = build_model(vec![row("a", SessionStatus::Working)], &Settings::default());
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
        // 标题变化。
        let mut t = row("a", SessionStatus::Idle);
        t.title = "改了名".to_string();
        let new = build_model(vec![t], &Settings::default());
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
        // 会话增减。
        let new = build_model(
            vec![row("a", SessionStatus::Idle), row("b", SessionStatus::Idle)],
            &Settings::default(),
        );
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
        // 设置变化（任一字段都算结构变化）。
        let changed = Settings {
            notify_on_waiting: false,
            ..Settings::default()
        };
        let new = build_model(vec![row("a", SessionStatus::Idle)], &changed);
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
        // 子代理数变化（行形状变化）。
        let mut s = row("a", SessionStatus::Idle);
        s.subagents_running = 2;
        let new = build_model(vec![s], &Settings::default());
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
    }

    #[test]
    fn identical_or_unseen_models() {
        let m = build_model(vec![row("a", SessionStatus::Working)], &Settings::default());
        assert_eq!(refresh_decision(Some(&m), &m.clone()), Refresh::None);
        assert_eq!(refresh_decision(None, &m), Refresh::Rebuild);
    }

    #[test]
    fn badge_count_is_waiting_plus_stuck() {
        // 空模型 = 0（无角标）。
        let m = build_model(vec![], &Settings::default());
        assert_eq!(m.badge_count, 0);
        // 工作中/空闲不计入。
        let m = build_model(
            vec![
                row("w", SessionStatus::Working),
                row("i", SessionStatus::Idle),
            ],
            &Settings::default(),
        );
        assert_eq!(m.badge_count, 0);
        // 等待输入 + 疑似卡住求和。
        let m = build_model(
            vec![
                row("w", SessionStatus::Working),
                row("a", SessionStatus::WaitingInput),
                row("b", SessionStatus::WaitingInput),
                row("c", SessionStatus::Stuck),
                row("i", SessionStatus::Idle),
            ],
            &Settings::default(),
        );
        assert_eq!(m.badge_count, 3);
        // badge_count 参与 same_structure（仅它不同也算结构变化）。
        let mut other = m.clone();
        other.badge_count += 1;
        assert!(!m.same_structure(&other));
    }

    #[test]
    fn iterm_app_omitted_other_app_shown() {
        // iTerm2 是默认情形，不写应用名。
        let m = build_model(vec![row("a", SessionStatus::Working)], &Settings::default());
        assert_eq!(m.rows[0].text(), "会话a · 工作中 · 2分");
        // 非 iTerm 应用保留在标题与状态之间。
        let mut r = row("v", SessionStatus::WaitingInput);
        r.app_label = Some("VS Code".to_string());
        r.focusable = false;
        r.focus_block_reason = Some("仅 iTerm 可聚焦".to_string());
        let m = build_model(vec![r], &Settings::default());
        assert_eq!(
            m.rows[0].text(),
            "会话v · VS Code · 等待输入 · 2分（仅 iTerm 可聚焦）"
        );
    }

    #[test]
    fn tray_title_styles() {
        let counts = |total: usize, working: usize, waiting: usize, stuck: usize| StatusCounts {
            total,
            working,
            waiting,
            stuck,
        };
        // 空集都为 None。
        let empty = counts(0, 0, 0, 0);
        assert_eq!(tray_title(BadgeStyle::Count, &empty), None);
        assert_eq!(tray_title(BadgeStyle::Dot, &empty), None);
        assert_eq!(tray_title(BadgeStyle::Icon, &empty), None);
        // Count：现行格式。
        assert_eq!(
            tray_title(BadgeStyle::Count, &counts(3, 1, 1, 1)),
            Some("2·1!".to_string())
        );
        assert_eq!(
            tray_title(BadgeStyle::Count, &counts(2, 1, 0, 0)),
            Some("1·0".to_string())
        );
        // Dot：有待处理为 ●，否则 ○。
        assert_eq!(
            tray_title(BadgeStyle::Dot, &counts(1, 0, 1, 0)),
            Some("●".to_string())
        );
        assert_eq!(
            tray_title(BadgeStyle::Dot, &counts(1, 0, 0, 1)),
            Some("●".to_string())
        );
        assert_eq!(
            tray_title(BadgeStyle::Dot, &counts(2, 1, 0, 0)),
            Some("○".to_string())
        );
        // Icon：恒为 None。
        assert_eq!(tray_title(BadgeStyle::Icon, &counts(3, 1, 1, 1)), None);
        // 样例覆盖四态。
        let samples = badge_samples(BadgeStyle::Count);
        assert_eq!(samples.len(), 4);
        assert_eq!(samples[0].0, SessionStatus::Working);
        assert_eq!(samples[0].1, Some("2·0".to_string()));
        assert_eq!(samples[1].1, Some("0·1".to_string()));
        assert_eq!(samples[2].1, Some("0·0".to_string()));
        assert_eq!(samples[3].1, Some("1·0!".to_string()));
        let dots: Vec<Option<String>> = badge_samples(BadgeStyle::Dot)
            .into_iter()
            .map(|(_, t)| t)
            .collect();
        assert_eq!(
            dots,
            vec![
                Some("○".to_string()),
                Some("●".to_string()),
                Some("○".to_string()),
                Some("●".to_string()),
            ]
        );
    }

    #[test]
    fn hide_idle_keeps_header_counts() {
        let s = Settings {
            show_idle: false,
            ..Settings::default()
        };
        let m = build_model(
            vec![
                row("w", SessionStatus::Working),
                row("i", SessionStatus::Idle),
            ],
            &s,
        );
        assert_eq!(m.rows.len(), 1);
        assert_eq!(m.rows[0].session_id, "w");
        assert!(m.overflow.is_empty());
        // 头部计数照常包含空闲行。
        assert_eq!(m.header, "omp 会话 · 占用 2 · 工作中 1 · 等待输入 0");
        assert_eq!(m.tray_title, Some("1·0".to_string()));
    }

    #[test]
    fn row_options_project_compact_width() {
        // show_project：标题后追加项目名。
        let s = Settings {
            show_project: true,
            ..Settings::default()
        };
        let mut r = row("p", SessionStatus::Working);
        r.project = Some("omp-resume".to_string());
        let m = build_model(vec![r], &s);
        assert_eq!(m.rows[0].text(), "会话p · omp-resume · 工作中 · 2分");
        // 项目未知时不追加。
        let m = build_model(vec![row("q", SessionStatus::Working)], &s);
        assert_eq!(m.rows[0].text(), "会话q · 工作中 · 2分");
        // compact_rows：只保留标题与时长。
        let s = Settings {
            compact_rows: true,
            show_project: true,
            ..Settings::default()
        };
        let mut r = row("c", SessionStatus::WaitingInput);
        r.project = Some("proj".to_string());
        r.subagents_running = 3;
        let m = build_model(vec![r], &s);
        assert_eq!(m.rows[0].text(), "会话c · proj · 2分");
        // title_width：截断长度可调。
        let s = Settings {
            title_width: super::super::settings::TitleWidth::Compact,
            ..Settings::default()
        };
        let mut r = row("t", SessionStatus::Idle);
        r.title = "一二三四五六七八九十一二三四五六七八九十一二".to_string();
        assert!(r.title.chars().count() > 20);
        let m = build_model(vec![r], &s);
        let title_part = m.rows[0].text().split(" · ").next().unwrap().to_string();
        assert_eq!(title_part.chars().count(), 20);
        assert!(title_part.ends_with('…'), "{title_part}");
    }

    #[test]
    fn hidden_cost_skips_text_update() {
        let s = Settings {
            show_cost: false,
            ..Settings::default()
        };
        let mut old = build_model(vec![], &s);
        old.extras = Some(Extras {
            cost_text: Some("今日花费 $1.20".to_string()),
            recent: vec![],
            projects: vec![],
        });
        let mut new = old.clone();
        new.extras.as_mut().unwrap().cost_text = Some("今日花费 $1.50".to_string());
        assert!(old.same_structure(&new));
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Texts(vec![]));
    }
}

#[cfg(test)]
mod modes_tests {
    use super::*;
    use crate::model::{ModelPreset, ModelPresetSnapshot, ModelPresetsState};

    fn preset(name: &str, reason: Option<&str>) -> ModelPreset {
        ModelPreset {
            name: name.into(),
            model_roles: serde_json::Map::new(),
            default_thinking_level: None,
            agent_model_overrides: None,
            invalid_reason: reason.map(str::to_owned),
        }
    }

    fn state(presets: Vec<ModelPreset>, active: Option<&str>) -> ModelPresetsState {
        ModelPresetsState {
            presets,
            active: active.map(str::to_owned),
            current: ModelPresetSnapshot {
                model_roles: serde_json::json!({}),
                agent_model_overrides: serde_json::json!({}),
                default_thinking_level: None,
            },
            raw_presets: serde_json::json!({}),
        }
    }

    #[test]
    fn mode_entries_marks_active_and_disabled() {
        let entries = mode_entries(&state(
            vec![preset("A", None), preset("bad", Some("不是映射"))],
            Some("A"),
        ));
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0],
            ModeEntry {
                name: "A".into(),
                active: true,
                enabled: true
            }
        );
        assert_eq!(
            entries[1],
            ModeEntry {
                name: "bad".into(),
                active: false,
                enabled: false
            }
        );
    }

    #[test]
    fn modes_change_rebuilds_menu() {
        let base = build_model(vec![], &Settings::default());
        let mut with_modes = base.clone();
        with_modes.modes = Some(vec![ModeEntry {
            name: "A".into(),
            active: true,
            enabled: true,
        }]);
        assert!(!base.same_structure(&with_modes));
        assert_eq!(refresh_decision(Some(&base), &with_modes), Refresh::Rebuild);
        // 勾选态变化同样属于结构变化。
        let mut toggled = with_modes.clone();
        toggled.modes = Some(vec![ModeEntry {
            name: "A".into(),
            active: false,
            enabled: true,
        }]);
        assert!(!with_modes.same_structure(&toggled));
        assert_eq!(
            refresh_decision(Some(&with_modes), &toggled),
            Refresh::Rebuild
        );
        assert_eq!(
            refresh_decision(Some(&with_modes), &with_modes),
            Refresh::None
        );
    }
}

#[cfg(test)]
mod extras_tests {
    use super::*;

    fn extras(cost: &str) -> Extras {
        Extras {
            cost_text: Some(cost.to_string()),
            recent: vec![RecentEntry {
                session_id: "s1".into(),
                path: "/tmp/s1.jsonl".into(),
                text: "标题一 · proj".into(),
            }],
            projects: vec![ProjectEntry {
                cwd: "/tmp/proj".into(),
                text: "/tmp/proj".into(),
            }],
        }
    }

    #[test]
    fn cost_change_is_text_update() {
        let mut old = build_model(vec![], &Settings::default());
        old.extras = Some(extras("今日花费 $1.20"));
        let mut new = old.clone();
        new.extras = Some(extras("今日花费 $1.50"));
        assert!(old.same_structure(&new));
        assert_eq!(
            refresh_decision(Some(&old), &new),
            Refresh::Texts(vec![("today-cost".into(), "今日花费 $1.50".into())])
        );
    }

    #[test]
    fn recent_change_rebuilds() {
        let mut old = build_model(vec![], &Settings::default());
        old.extras = Some(extras("今日花费 $1.50"));
        // 最近会话变化 → 重建。
        let mut new = old.clone();
        new.extras.as_mut().unwrap().recent.clear();
        assert!(!old.same_structure(&new));
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
        // 项目变化 → 重建。
        let mut new = old.clone();
        new.extras.as_mut().unwrap().projects.clear();
        assert!(!old.same_structure(&new));
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
        // 花费行出现/消失 → 重建（但金额变化只就地更新）。
        let mut new = old.clone();
        new.extras.as_mut().unwrap().cost_text = None;
        assert!(!old.same_structure(&new));
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
        let mut new = old.clone();
        new.extras = None;
        assert!(!old.same_structure(&new));
        assert_eq!(refresh_decision(Some(&old), &new), Refresh::Rebuild);
    }

    #[test]
    fn project_entry_abbreviates_home() {
        let home = Some("/Users/x");
        assert_eq!(project_entry("/Users/x", home).text, "~");
        assert_eq!(project_entry("/Users/x/proj", home).text, "~/proj");
        // 同前缀但不是 home 子目录：不缩写。
        assert_eq!(project_entry("/Users/xy", home).text, "/Users/xy");
        assert_eq!(project_entry("/tmp/proj", home).text, "/tmp/proj");
        // home 缺失：原文。
        assert_eq!(project_entry("/Users/x/proj", None).text, "/Users/x/proj");
        // 超长截断 48 字。
        let long = format!("/Users/x/{}", "a".repeat(60));
        let e = project_entry(&long, home);
        assert_eq!(e.cwd, long);
        assert_eq!(e.text.chars().count(), 48);
    }

    #[test]
    fn recent_entry_appends_project_name() {
        let s = crate::model::SessionSummary {
            id: "s1".into(),
            path: "/tmp/s1.jsonl".into(),
            cwd: "/Users/x/my/omp-resume".into(),
            cwd_exists: true,
            title: "Inspect custom omp conf".into(),
            created_at: String::new(),
            modified_at: String::new(),
            size_bytes: 0,
            message_count: 0,
            branch_count: 0,
            in_use: false,
            probe_ok: true,
            occupant: None,
            fork: None,
            format_supported: true,
            version: Some(3),
            bad_lines: 0,
            first_user_message: None,
        };
        let e = recent_entry(&s);
        assert_eq!(e.session_id, "s1");
        assert_eq!(e.path, "/tmp/s1.jsonl");
        assert_eq!(e.text, "Inspect custom omp conf · omp-resume");
    }
}
