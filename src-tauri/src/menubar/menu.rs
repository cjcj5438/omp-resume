//! 菜单栏下拉菜单的纯数据模型（CONTRACT §17.4）。
//!
//! 输入快照 → 输出全部展示字符串。[`MenuModel`] 派生 `PartialEq`：
//! 轮询只在模型变化时重建原生菜单。展示细节（排序、截断、计数文案）
//! 全部由本模块单测锁定，`tray` 只做机械装配。

use super::classify::SessionStatus;

/// 首屏最多会话行数，超出进「更多…」子菜单。
pub const MAX_ROWS: usize = 8;
/// 行内标题最大字符数（超出截断加 `…`）。
pub const TITLE_MAX_CHARS: usize = 32;

/// 单个会话行的输入快照（由轮询组装）。
#[derive(Debug, Clone)]
pub struct RowInput {
    pub session_id: String,
    pub title: String,
    pub status: SessionStatus,
    /// 占用应用展示名（未知时 None）。
    pub app_label: Option<String>,
    /// 占用者 PID（应用未知时展示用）。
    pub pid: Option<u32>,
    /// 是否可聚焦（iTerm 占用 + tty 已知）。
    pub focusable: bool,
    /// 不可聚焦的原因（`focusable == false` 时展示，如“仅 iTerm 可聚焦”）。
    pub focus_block_reason: Option<String>,
    pub subagents_running: u32,
    /// 会话持续秒数（自 header 创建时间起）。
    pub duration_secs: i64,
}

/// 单个会话行的展示数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowModel {
    pub session_id: String,
    /// 行文本（已截断，未做 `&` 转义——装配时经 [`menu_text`] 处理）。
    pub text: String,
    pub enabled: bool,
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
    pub notify_on: bool,
    pub dock_on: bool,
}

/// 构建菜单模型（纯函数）。
pub fn build_model(inputs: Vec<RowInput>, notify_on: bool, dock_on: bool) -> MenuModel {
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
    // 托盘标题：`{在工作}·{在等我}`，在工作含疑似卡住；有卡住追加 `!`。
    let tray_title = if total == 0 {
        None
    } else {
        let mut t = format!("{}·{}", working + stuck, waiting);
        if stuck > 0 {
            t.push('!');
        }
        Some(t)
    };

    let mut rows = Vec::new();
    let mut overflow = Vec::new();
    for (i, input) in inputs.iter().enumerate() {
        let row = RowModel {
            session_id: input.session_id.clone(),
            text: row_text(input),
            enabled: input.focusable,
        };
        if i < MAX_ROWS {
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
        notify_on,
        dock_on,
    }
}

fn row_text(input: &RowInput) -> String {
    let title = crate::sessions::truncate_chars(&input.title, TITLE_MAX_CHARS);
    let app = match (&input.app_label, input.pid) {
        (Some(app), _) => app.clone(),
        (None, Some(pid)) => format!("PID {pid}"),
        (None, None) => "占用中".to_string(),
    };
    let mut text = format!(
        "{} {} · {} · {}",
        input.status.glyph(),
        title,
        app,
        format_duration(input.duration_secs)
    );
    if input.subagents_running > 0 {
        text.push_str(&format!(" · 子代理 {}", input.subagents_running));
    }
    if !input.focusable {
        if let Some(reason) = &input.focus_block_reason {
            text.push_str(&format!("（{reason}）"));
        }
    }
    text
}

/// 持续时长展示：`刚刚` / `X分` / `X小时Y分` / `X天`。
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

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, status: SessionStatus) -> RowInput {
        RowInput {
            session_id: id.to_string(),
            title: format!("会话{id}"),
            status,
            app_label: Some("iTerm2".to_string()),
            pid: Some(100),
            focusable: true,
            focus_block_reason: None,
            subagents_running: 0,
            duration_secs: 150,
        }
    }

    #[test]
    fn empty_model() {
        let m = build_model(vec![], true, false);
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
            true,
            false,
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
            true,
            false,
        );
        assert_eq!(m.header, "omp 会话 · 占用 2 · 工作中 1 · 等待输入 0");
        assert_eq!(m.tray_title, Some("1·0".to_string()));
    }

    #[test]
    fn overflow_goes_to_more() {
        let inputs: Vec<RowInput> = (0..10)
            .map(|i| row(&format!("s{i:02}"), SessionStatus::Working))
            .collect();
        let m = build_model(inputs, true, false);
        assert_eq!(m.rows.len(), MAX_ROWS);
        assert_eq!(m.overflow.len(), 2);
        assert_eq!(m.overflow[0].session_id, "s08");
    }

    #[test]
    fn row_text_shape() {
        let mut r = row("x", SessionStatus::Working);
        r.title = "加长标题测试会话".to_string();
        r.subagents_running = 2;
        r.duration_secs = 3700;
        let m = build_model(vec![r], true, false);
        assert_eq!(
            m.rows[0].text,
            "▶ 加长标题测试会话 · iTerm2 · 1小时1分 · 子代理 2"
        );
        assert!(m.rows[0].enabled);
    }

    #[test]
    fn non_focusable_row_disabled_with_reason() {
        let mut r = row("v", SessionStatus::WaitingInput);
        r.app_label = Some("VS Code".to_string());
        r.focusable = false;
        r.focus_block_reason = Some("仅 iTerm 可聚焦".to_string());
        let m = build_model(vec![r], true, false);
        assert!(!m.rows[0].enabled);
        assert!(m.rows[0].text.contains("VS Code"), "{}", m.rows[0].text);
        assert!(
            m.rows[0].text.contains("（仅 iTerm 可聚焦）"),
            "{}",
            m.rows[0].text
        );
    }

    #[test]
    fn unknown_app_falls_back_to_pid_then_marker() {
        let mut r = row("u", SessionStatus::Idle);
        r.app_label = None;
        r.pid = Some(4242);
        r.focusable = false;
        r.focus_block_reason = Some("未找到占用进程".to_string());
        let m = build_model(vec![r], true, false);
        assert!(m.rows[0].text.contains("PID 4242"), "{}", m.rows[0].text);

        let mut r = row("u2", SessionStatus::Idle);
        r.app_label = None;
        r.pid = None;
        r.focusable = false;
        r.focus_block_reason = Some("未找到占用进程".to_string());
        let m = build_model(vec![r], true, false);
        assert!(
            m.rows[0].text.contains(" · 占用中 · "),
            "{}",
            m.rows[0].text
        );
    }

    #[test]
    fn title_truncation() {
        let mut r = row("t", SessionStatus::Idle);
        r.title =
            "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四".to_string();
        assert!(r.title.chars().count() > TITLE_MAX_CHARS);
        let m = build_model(vec![r], true, false);
        let title_part = m.rows[0].text.split(" · ").next().unwrap().to_string();
        assert_eq!(title_part.chars().count(), 2 + TITLE_MAX_CHARS); // glyph + 空格 + 32
        assert!(title_part.ends_with('…'), "{title_part}");
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
}
