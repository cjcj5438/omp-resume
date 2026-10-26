//! 会话状态判定：纯函数 + 阈值常量（CONTRACT §17.2）。
//!
//! 输入来自检测流水线（T2 jsonl 尾部 + T3 iTerm 标题），输出四态之一。
//! 非 `inUse` 的会话不进入本模块（调用方过滤，“不展示”）。

/// “等待输入”保持多久后转为“空闲”（推断值，待校准）。
pub const ATTENTION_IDLE_SECS: i64 = 30 * 60;
/// “工作中”超过多久无进展 + 仍有未配对工具则判“疑似卡住”（推断值，待校准）。
pub const STUCK_SECS: i64 = 10 * 60;
/// 工具结果 / 用户消息多新算“模型正在生成”（推断值，待校准）。
pub const RECENT_SECS: i64 = 60;

/// 会话运行状态（菜单展示用词）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionStatus {
    /// 正在工作（标题旋转符 / 子代理运行 / 工具有进展）。
    Working,
    /// 在提示符等待用户输入（含疑似审批）。
    WaitingInput,
    /// 占用但无事发生。
    Idle,
    /// 工作中但长时间无进展且工具有堆积。
    Stuck,
}

impl SessionStatus {
    pub fn label(self) -> &'static str {
        match self {
            SessionStatus::Working => "工作中",
            SessionStatus::WaitingInput => "等待输入",
            SessionStatus::Idle => "空闲",
            SessionStatus::Stuck => "疑似卡住",
        }
    }

    /// 稳定键（前端/舞台用；与 [`Self::label`] 的中文文案一一对应）。
    pub fn key(self) -> &'static str {
        match self {
            SessionStatus::Working => "working",
            SessionStatus::WaitingInput => "waiting",
            SessionStatus::Idle => "idle",
            SessionStatus::Stuck => "stuck",
        }
    }

    /// 菜单排序键：疑似卡住 → 等待输入 → 工作中 → 空闲。
    pub fn sort_rank(self) -> u8 {
        match self {
            SessionStatus::Stuck => 0,
            SessionStatus::WaitingInput => 1,
            SessionStatus::Working => 2,
            SessionStatus::Idle => 3,
        }
    }

    /// 菜单行首状态符（单字窄符号）。
    pub fn glyph(self) -> &'static str {
        match self {
            SessionStatus::Working => "▶",
            SessionStatus::WaitingInput => "⏸",
            SessionStatus::Idle => "○",
            SessionStatus::Stuck => "⚠",
        }
    }
}

/// iTerm 标题携带的状态信号（`π <状态符> … (omp)`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleState {
    /// 盲文旋转符（U+2800–U+28FF 任一帧）：正在工作。
    Working,
    /// `>`：在提示符等待输入。
    Prompt,
    /// 能读到标题但状态符无法识别（非 π 格式等）：不携带信号。
    Other,
    /// 无标题（非 iTerm 占用者、iTerm 未运行等）：只用 jsonl 规则。
    Unknown,
}

/// 最后一条“有意义记录”的种类。
///
/// 有意义 = `message`（user/assistant/toolResult/bashExecution）与 `custom` 的
/// `tool_execution_start/end`；`model_usage`（cache-warm 心跳）、`title_change`、
/// `todo_hud_state` 等一律不算（见 `tail` 模块）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastKind {
    User,
    Assistant {
        /// `stopReason == "stop"`（缺失视为 true，见 `tail`）。
        stopped: bool,
    },
    ToolResult,
    BashExecution,
    ToolEvent,
}

/// 最后一条有意义记录及其时间（epoch 秒）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LastMeaningful {
    pub kind: LastKind,
    pub at: i64,
}

/// 判定输入（调用方保证会话当前 `inUse`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassifyInput {
    pub title: TitleState,
    pub last: Option<LastMeaningful>,
    pub unpaired_tool_calls: u32,
    pub running_subagents: u32,
    /// 当前时间（epoch 秒，可注入以便测试边界）。
    pub now: i64,
}

/// 判定结果：状态 + 中文依据（供探针/日志，不进菜单）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub status: SessionStatus,
    pub reason: String,
}

pub fn classify(input: &ClassifyInput) -> Verdict {
    let age = input.last.map(|l| input.now.saturating_sub(l.at));
    let status = provisional(input, age);
    // 卡住覆盖：工作中 + 长时间无进展 + 仍有未配对工具调用 + **没有运行中的子代理**。
    //
    // 子代理运行中的父会话，其「有意义记录」天然长时间不更新（进展都写在子代理
    // 自己的文件里），实测（2026-10-16）曾因此把正在工作的父会话误判为「疑似
    // 卡住」；任务工具的未配对调用要等子代理返回，期间属正常等待。
    // 子代理活动即该类会话的活性信号，因此卡住覆盖只对无子代理的会话生效。
    if status == SessionStatus::Working
        && input.running_subagents == 0
        && input.unpaired_tool_calls > 0
        && age.is_some_and(|a| a > STUCK_SECS)
    {
        return Verdict {
            status: SessionStatus::Stuck,
            reason: format!(
                "疑似卡住：{}无进展且有{}个未配对工具调用",
                format_age(age.unwrap_or(0)),
                input.unpaired_tool_calls
            ),
        };
    }
    let reason = explain(input, status, age);
    Verdict { status, reason }
}

fn provisional(input: &ClassifyInput, age: Option<i64>) -> SessionStatus {
    // 1. 标题旋转符或子代理运行中 → 工作中。
    if input.title == TitleState::Working || input.running_subagents > 0 {
        return SessionStatus::Working;
    }
    // 2. 在提示符 + 有未配对工具调用 → 等待输入（疑似审批）。
    if input.title == TitleState::Prompt && input.unpaired_tool_calls > 0 {
        return SessionStatus::WaitingInput;
    }
    // 3. 有未配对工具调用 → 工作中（工具执行）。
    if input.unpaired_tool_calls > 0 {
        return SessionStatus::Working;
    }
    // 4. 按最后一条有意义记录判定。
    match input.last {
        Some(LastMeaningful {
            kind: LastKind::ToolResult | LastKind::BashExecution | LastKind::User,
            ..
        }) if age.is_some_and(|a| a < RECENT_SECS) => SessionStatus::Working,
        Some(LastMeaningful {
            kind: LastKind::ToolEvent,
            ..
        }) if age.is_some_and(|a| a < RECENT_SECS) => SessionStatus::Working,
        Some(LastMeaningful {
            kind: LastKind::Assistant { stopped: false },
            ..
        }) => SessionStatus::Working,
        Some(LastMeaningful {
            kind: LastKind::Assistant { stopped: true },
            ..
        }) => {
            if age.is_some_and(|a| a < ATTENTION_IDLE_SECS) {
                SessionStatus::WaitingInput
            } else {
                SessionStatus::Idle
            }
        }
        _ => SessionStatus::Idle,
    }
}

/// 规则 4 中 `User` 与 `ToolEvent` 的处理是相对 CONTRACT 初稿的两处细化，
/// 均有单测锁定（见 `user_recent_is_working`、`tool_event_recent_is_working`）：
/// - `User` 视同 `ToolResult`：用户刚发消息必然是模型在生成；
/// - `ToolEvent`（tool_execution_start/end）新鲜时说明工具有进展；
/// - `Assistant` 且 `stopReason != "stop"`（如 `toolUse`）说明回合未结束。
fn explain(input: &ClassifyInput, status: SessionStatus, age: Option<i64>) -> String {
    let age_text = age.map(format_age).unwrap_or_else(|| "无记录".to_string());
    match status {
        SessionStatus::Working => {
            if input.title == TitleState::Working {
                "标题旋转符，正在工作".to_string()
            } else if input.running_subagents > 0 {
                format!("{}个子代理运行中", input.running_subagents)
            } else if input.unpaired_tool_calls > 0 {
                format!("{}个未配对工具调用执行中", input.unpaired_tool_calls)
            } else {
                format!("{age_text}前有进展，模型生成中")
            }
        }
        SessionStatus::WaitingInput => {
            if input.title == TitleState::Prompt && input.unpaired_tool_calls > 0 {
                format!(
                    "在提示符且有{}个未配对工具调用（疑似审批）",
                    input.unpaired_tool_calls
                )
            } else {
                format!("assistant stop，{age_text}前结束")
            }
        }
        SessionStatus::Idle => format!("空闲（{age_text}无进展）"),
        SessionStatus::Stuck => "疑似卡住".to_string(),
    }
}

fn format_age(secs: i64) -> String {
    if secs < 60 {
        format!("{secs}秒")
    } else if secs < 3600 {
        format!("{}分", secs / 60)
    } else if secs < 86400 {
        format!("{}小时", secs / 3600)
    } else {
        format!("{}天", secs / 86400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ClassifyInput {
        ClassifyInput {
            title: TitleState::Unknown,
            last: None,
            unpaired_tool_calls: 0,
            running_subagents: 0,
            now: 1_000_000,
        }
    }

    fn last(kind: LastKind, ago: i64) -> Option<LastMeaningful> {
        Some(LastMeaningful {
            kind,
            at: 1_000_000 - ago,
        })
    }

    #[test]
    fn spinner_title_is_working() {
        let mut i = input();
        i.title = TitleState::Working;
        i.last = last(LastKind::Assistant { stopped: true }, 3600);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn running_subagent_is_working_even_at_prompt() {
        let mut i = input();
        i.title = TitleState::Prompt;
        i.running_subagents = 2;
        i.last = last(LastKind::Assistant { stopped: true }, 600);
        let v = classify(&i);
        assert_eq!(v.status, SessionStatus::Working);
        assert!(v.reason.contains('2'), "reason: {}", v.reason);
    }

    #[test]
    fn prompt_with_unpaired_is_waiting_approval() {
        let mut i = input();
        i.title = TitleState::Prompt;
        i.unpaired_tool_calls = 1;
        i.last = last(LastKind::Assistant { stopped: false }, 30);
        let v = classify(&i);
        assert_eq!(v.status, SessionStatus::WaitingInput);
        assert!(v.reason.contains("疑似审批"), "reason: {}", v.reason);
    }

    #[test]
    fn unpaired_without_title_is_working() {
        // 非 iTerm 占用者：无标题信号，靠未配对工具调用判定工作中。
        let mut i = input();
        i.unpaired_tool_calls = 3;
        i.last = last(LastKind::ToolResult, 500);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn fresh_tool_result_is_working() {
        let mut i = input();
        i.last = last(LastKind::ToolResult, RECENT_SECS - 1);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn stale_tool_result_is_idle() {
        let mut i = input();
        i.last = last(LastKind::ToolResult, RECENT_SECS);
        assert_eq!(classify(&i).status, SessionStatus::Idle);
    }

    #[test]
    fn user_recent_is_working() {
        let mut i = input();
        i.last = last(LastKind::User, 10);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn tool_event_recent_is_working() {
        let mut i = input();
        i.last = last(LastKind::ToolEvent, 10);
        assert_eq!(classify(&i).status, SessionStatus::Working);
        i.last = last(LastKind::ToolEvent, RECENT_SECS + 1);
        assert_eq!(classify(&i).status, SessionStatus::Idle);
    }

    #[test]
    fn assistant_open_turn_is_working() {
        let mut i = input();
        i.last = last(LastKind::Assistant { stopped: false }, 5000);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn assistant_stop_attention_window() {
        let mut i = input();
        i.last = last(
            LastKind::Assistant { stopped: true },
            ATTENTION_IDLE_SECS - 1,
        );
        assert_eq!(classify(&i).status, SessionStatus::WaitingInput);
        i.last = last(LastKind::Assistant { stopped: true }, ATTENTION_IDLE_SECS);
        assert_eq!(classify(&i).status, SessionStatus::Idle);
    }

    #[test]
    fn no_records_is_idle() {
        let i = input();
        assert_eq!(classify(&i).status, SessionStatus::Idle);
    }

    #[test]
    fn prompt_alone_without_signals_is_idle() {
        // 在提示符但无未配对工具、无近期记录：无事需要用户处理 → 空闲。
        let mut i = input();
        i.title = TitleState::Prompt;
        i.last = last(LastKind::ToolResult, 3600);
        assert_eq!(classify(&i).status, SessionStatus::Idle);
    }

    #[test]
    fn stuck_override() {
        let mut i = input();
        i.unpaired_tool_calls = 2;
        i.last = last(LastKind::ToolResult, STUCK_SECS + 1);
        let v = classify(&i);
        assert_eq!(v.status, SessionStatus::Stuck);
        assert!(v.reason.contains('2'), "reason: {}", v.reason);
    }

    #[test]
    fn stuck_boundary_not_stuck() {
        let mut i = input();
        i.unpaired_tool_calls = 2;
        i.last = last(LastKind::ToolResult, STUCK_SECS);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn stuck_requires_unpaired() {
        // 工作中但无堆积工具：不判卡住（纯标题信号 + 陈旧记录）。
        let mut i = input();
        i.title = TitleState::Working;
        i.last = last(LastKind::ToolResult, STUCK_SECS + 9999);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn stuck_requires_last_record() {
        let mut i = input();
        i.unpaired_tool_calls = 1;
        i.last = None;
        // 有未配对但无 last：规则 3 → 工作中，卡住覆盖要求有 last 时间。
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }

    #[test]
    fn stuck_skipped_while_subagents_running() {
        // 父会话等子代理：进展写在子代理文件里，父文件「有意义记录」长期不更新
        // 是正常的 → 不判卡住（2026-10-16 真实数据误判修正，见 CONTRACT §17）。
        let mut i = input();
        i.running_subagents = 2;
        i.unpaired_tool_calls = 1;
        i.last = last(LastKind::ToolResult, STUCK_SECS + 600);
        assert_eq!(classify(&i).status, SessionStatus::Working);
    }
}
