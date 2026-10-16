//! 完成通知：转换判定（纯函数）+ 发送后端（CONTRACT §17.6）。
//!
//! 规则：
//! - 仅「工作中 → 等待输入」转换发通知，且此前工作中持续 ≥ 30 秒；
//! - 同会话 30 秒防抖；同一轮询周期 > 3 个转换 → 合并成一条汇总；
//! - 「疑似卡住」首次出现通知一次（离开卡住态后重新计数，即按 episode 一次）；
//! - 正文只含会话标题与状态，**不含对话内容**；可经设置关闭。
//!
//! 发送：优先 `tauri-plugin-notification`（`tray` 侧用 AppHandle 发送，点击
//! 回调聚焦对应 iTerm 标签）；插件不可用/发送失败时退回
//! `osascript display notification`（只展示，不可点击）。

use std::collections::{HashMap, HashSet};

use super::classify::SessionStatus;

/// 转换前工作中持续门槛（秒）。
pub const WORK_GATE_SECS: i64 = 30;
/// 同会话通知防抖窗口（秒）。
pub const DEBOUNCE_SECS: i64 = 30;
/// 单周期转换数超过此值则合并为汇总。
pub const SUMMARY_THRESHOLD: usize = 3;
/// 通知标题截断（字符）。
pub const NOTIFY_TITLE_CHARS: usize = 60;

/// 一次状态转换（由轮询组装；`busy_secs` 仅在进入等待输入时有意义，
/// 表示此前连续工作中（Working|Stuck）的持续秒数）。
#[derive(Debug, Clone)]
pub struct Transition {
    pub session_id: String,
    pub title: String,
    pub prev: SessionStatus,
    pub next: SessionStatus,
    pub busy_secs: i64,
}

/// 通知动作（纯判定结果，发送由调用方执行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifyAction {
    /// 单个会话进入等待输入。
    Waiting { session_id: String, title: String },
    /// 单个会话疑似卡住。
    Stuck { session_id: String, title: String },
    /// 单周期大量转换的汇总。
    Summary { count: usize },
}

/// 防抖/去重跟踪器（轮询持有，随进程常驻）。
#[derive(Debug, Default)]
pub struct Tracker {
    last_waiting: HashMap<String, i64>,
    stuck: HashSet<String>,
}

impl Tracker {
    /// 会话消失时清理其条目（避免无界增长）。
    pub fn forget(&mut self, session_id: &str) {
        self.last_waiting.remove(session_id);
        self.stuck.remove(session_id);
    }
}

fn is_busy(s: SessionStatus) -> bool {
    matches!(s, SessionStatus::Working | SessionStatus::Stuck)
}

/// 判定本周期要发的通知（纯函数，调用方负责发送）。
pub fn decide(
    transitions: &[Transition],
    now: i64,
    enabled: bool,
    tracker: &mut Tracker,
) -> Vec<NotifyAction> {
    if !enabled {
        return Vec::new();
    }
    let mut actions = Vec::new();
    // 卡住优先（更紧急），再处理等待输入。
    for t in transitions {
        if t.next == SessionStatus::Stuck && t.prev != SessionStatus::Stuck {
            if tracker.stuck.insert(t.session_id.clone()) {
                actions.push(NotifyAction::Stuck {
                    session_id: t.session_id.clone(),
                    title: truncate_title(&t.title),
                });
            }
        } else if t.prev == SessionStatus::Stuck && t.next != SessionStatus::Stuck {
            tracker.stuck.remove(&t.session_id);
        }
    }
    let mut waiting: Vec<&Transition> = transitions
        .iter()
        .filter(|t| {
            t.next == SessionStatus::WaitingInput
                && is_busy(t.prev)
                && t.busy_secs >= WORK_GATE_SECS
                && tracker
                    .last_waiting
                    .get(&t.session_id)
                    .is_none_or(|at| now.saturating_sub(*at) > DEBOUNCE_SECS)
        })
        .collect();
    waiting.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    if waiting.len() > SUMMARY_THRESHOLD {
        for t in &waiting {
            tracker.last_waiting.insert(t.session_id.clone(), now);
        }
        actions.push(NotifyAction::Summary {
            count: waiting.len(),
        });
    } else {
        for t in waiting {
            tracker.last_waiting.insert(t.session_id.clone(), now);
            actions.push(NotifyAction::Waiting {
                session_id: t.session_id.clone(),
                title: truncate_title(&t.title),
            });
        }
    }
    actions
}

fn truncate_title(title: &str) -> String {
    crate::sessions::truncate_chars(title, NOTIFY_TITLE_CHARS)
}

/// 通知展示文案（标题，正文）：只含会话标题与状态。
pub fn action_text(action: &NotifyAction) -> (String, String) {
    match action {
        NotifyAction::Waiting { title, .. } => (title.clone(), "进入等待输入".to_string()),
        NotifyAction::Stuck { title, .. } => (title.clone(), "疑似卡住".to_string()),
        NotifyAction::Summary { count } => {
            ("omp-resume".to_string(), format!("{count} 个会话在等你"))
        }
    }
}

/// osascript 回退发送的脚本（纯函数，便于单测锁定转义）。
pub fn osascript_notify_script(title: &str, body: &str) -> String {
    let title = crate::ops::iterm::applescript_escape(title);
    let body = crate::ops::iterm::applescript_escape(body);
    format!("display notification \"{body}\" with title \"{title}\" subtitle \"omp 会话\"\n")
}

/// 经 osascript 发送（回退路径；展示用，无点击回调）。
pub fn send_via_osascript(
    title: &str,
    body: &str,
    run: &dyn super::iterm::Runner,
) -> Result<(), String> {
    let script = osascript_notify_script(title, body);
    run.run("/usr/bin/osascript", &["-e", &script]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(id: &str, prev: SessionStatus, next: SessionStatus, busy: i64) -> Transition {
        Transition {
            session_id: id.to_string(),
            title: format!("标题{id}"),
            prev,
            next,
            busy_secs: busy,
        }
    }

    #[test]
    fn work_gate_and_debounce() {
        let mut tracker = Tracker::default();
        // 工作不足 30 秒 → 不通知。
        let a = decide(
            &[tr(
                "s",
                SessionStatus::Working,
                SessionStatus::WaitingInput,
                29,
            )],
            1000,
            true,
            &mut tracker,
        );
        assert!(a.is_empty());
        // 满 30 秒 → 通知。
        let a = decide(
            &[tr(
                "s",
                SessionStatus::Working,
                SessionStatus::WaitingInput,
                30,
            )],
            1000,
            true,
            &mut tracker,
        );
        assert_eq!(a.len(), 1);
        assert!(matches!(a[0], NotifyAction::Waiting { .. }));
        // 30 秒内再次转换 → 防抖。
        let a = decide(
            &[tr(
                "s",
                SessionStatus::Working,
                SessionStatus::WaitingInput,
                99,
            )],
            1030,
            true,
            &mut tracker,
        );
        assert!(a.is_empty(), "{a:?}");
        // 超过 30 秒 → 再通知。
        let a = decide(
            &[tr(
                "s",
                SessionStatus::Working,
                SessionStatus::WaitingInput,
                99,
            )],
            1031,
            true,
            &mut tracker,
        );
        assert_eq!(a.len(), 1);
    }

    #[test]
    fn summary_over_threshold() {
        let mut tracker = Tracker::default();
        let ts: Vec<Transition> = (0..4)
            .map(|i| {
                tr(
                    &format!("s{i}"),
                    SessionStatus::Working,
                    SessionStatus::WaitingInput,
                    60,
                )
            })
            .collect();
        let a = decide(&ts, 1000, true, &mut tracker);
        assert_eq!(a, vec![NotifyAction::Summary { count: 4 }]);
        // 汇总后同样防抖。
        let a = decide(&ts, 1010, true, &mut tracker);
        assert!(a.is_empty());
        // 恰 3 个不汇总。
        let mut tracker = Tracker::default();
        let a = decide(&ts[..3], 1000, true, &mut tracker);
        assert_eq!(a.len(), 3);
    }

    #[test]
    fn stuck_once_per_episode() {
        let mut tracker = Tracker::default();
        let t = tr("s", SessionStatus::Working, SessionStatus::Stuck, 0);
        let a = decide(std::slice::from_ref(&t), 1000, true, &mut tracker);
        assert_eq!(a.len(), 1);
        // 同一 episode 内重复转换不再通知。
        let a = decide(&[t], 1100, true, &mut tracker);
        assert!(a.is_empty());
        // 离开卡住态后清除；再次进入重新通知。
        let out = tr("s", SessionStatus::Stuck, SessionStatus::Working, 0);
        assert!(decide(&[out], 1200, true, &mut tracker).is_empty());
        let again = tr("s", SessionStatus::Working, SessionStatus::Stuck, 0);
        assert_eq!(decide(&[again], 1300, true, &mut tracker).len(), 1);
    }

    #[test]
    fn non_working_source_ignored_and_disabled() {
        let mut tracker = Tracker::default();
        // 空闲 → 等待输入：不是“完成”，不通知。
        let a = decide(
            &[tr(
                "s",
                SessionStatus::Idle,
                SessionStatus::WaitingInput,
                999,
            )],
            1000,
            true,
            &mut tracker,
        );
        assert!(a.is_empty());
        // 开关关闭：什么都不发。
        let a = decide(
            &[tr(
                "s",
                SessionStatus::Working,
                SessionStatus::WaitingInput,
                99,
            )],
            1000,
            false,
            &mut tracker,
        );
        assert!(a.is_empty());
    }

    #[test]
    fn notify_script_escapes() {
        let s = osascript_notify_script("含\"引号\\标题", "正文\n换行");
        assert!(s.starts_with("display notification "), "{s}");
        assert!(s.contains("\\\""), "{s}");
        assert!(
            !s.contains('\n') || s.ends_with('\n') && s.trim_end().lines().count() == 1,
            "{s}"
        );
        // 不含对话内容：文案只由 action_text 产生。
        let (title, body) = action_text(&NotifyAction::Waiting {
            session_id: "x".into(),
            title: "T".into(),
        });
        assert_eq!((title.as_str(), body.as_str()), ("T", "进入等待输入"));
    }
}
