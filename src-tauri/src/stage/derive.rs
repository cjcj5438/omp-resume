//! 角色状态判定（纯函数，表驱动单测）。
//!
//! 规则按序短路，输入是已提取的少量事实（见 [`DeriveInput`]）。
//! 不做 IO：所有「文件是否存在 / 父会话是否在用」由调用方提供。

use crate::model::{StageActorKind, StageActorState};

/// 无 `session_exit` 的子代理：最后一条 assistant 已 `stop` 且无未配对工具，
/// 静默超过这么多秒即视为「已结束」（推断值，真实样本缺失时的兜底）。
pub const ORPHAN_DONE_SECS: i64 = 120;

/// 判定输入。
#[derive(Debug, Clone)]
pub struct DeriveInput {
    pub kind: StageActorKind,
    /// 该角色的 jsonl 是否已出现（lifecycle 先到的 worker 为 false）。
    pub file_exists: bool,
    /// 父会话是否在用（`in_use || (!probe_ok && 轮询器见过)`）。
    pub parent_in_use: bool,
    /// `session_exit` 的 kind（`"normal"` / `"signal"` / …）。
    pub exit_kind: Option<String>,
    /// `session_exit` 的 reason（`"dispose"` / `"sighup"` / …）。
    pub exit_reason: Option<String>,
    /// `vibe-session-lifecycle` 的最后动作（仅 Worker）。
    pub lifecycle_action: Option<String>,
    pub pending_tools: usize,
    /// 最后一条 assistant 的 `stopReason`（缺失已归一为 `"stop"`）。
    pub last_assistant_stop: Option<String>,
    /// 最后活动时间（epoch 秒）。
    pub last_at_secs: Option<i64>,
    pub now_secs: i64,
    /// 主会话的中文状态（仅 Main；`"working"`/`"waiting"`/`"idle"`/`"stuck"`）。
    pub main_status: Option<String>,
}

/// `Kind` 的便捷构造：main 角色的默认输入。
/// 判定状态 + 人话说明。
pub fn derive_state(i: &DeriveInput) -> (StageActorState, Option<String>) {
    // 1) 主会话：状态直接来自轮询器（菜单栏同一口径）。
    if i.kind == StageActorKind::Main {
        if !i.parent_in_use {
            return (StageActorState::Done, Some("已结束".to_string()));
        }
        return match i.main_status.as_deref() {
            Some("waiting") => (StageActorState::Idle, Some("等待输入".to_string())),
            Some("idle") => (StageActorState::Idle, Some("空闲".to_string())),
            Some("stuck") => (StageActorState::Failed, Some("疑似卡住".to_string())),
            // working 或轮询器尚未见到：按运行中处理（stage 数据比菜单栏新）。
            _ => (StageActorState::Running, None),
        };
    }

    // 2) 工作者：以父会话的 lifecycle 为准（文件有没有、跑到哪一步）。
    let abnormal_exit = i.exit_kind.as_deref().is_some_and(|k| k != "normal");
    if let Some(action) = i.lifecycle_action.as_deref() {
        if abnormal_exit {
            return (
                StageActorState::Failed,
                Some(
                    i.exit_reason
                        .clone()
                        .unwrap_or_else(|| "异常退出".to_string()),
                ),
            );
        }
        // 文件里已经写过正常退出：worker 会话进程已终结，就是完成
        // （lifecycle 的 turn-settled 可能还没落盘）。
        if i.exit_kind.as_deref() == Some("normal") {
            return (StageActorState::Done, Some("已结束".to_string()));
        }
        return match action {
            "spawn" => (StageActorState::Queued, None),
            "turn-started" => {
                if i.parent_in_use {
                    (StageActorState::Running, None)
                } else {
                    (StageActorState::Lost, Some("会话已退出".to_string()))
                }
            }
            "turn-settled" => (StageActorState::Idle, Some("待命".to_string())),
            _ => (StageActorState::Running, None),
        };
    }

    // 3) 子代理 / advisor：文件 + 退出记录 + 父会话是否还在。
    if !i.file_exists {
        return (StageActorState::Queued, None);
    }
    if let Some(kind) = i.exit_kind.as_deref() {
        if kind == "normal" {
            return (StageActorState::Done, Some("已结束".to_string()));
        }
        return (
            StageActorState::Failed,
            Some(i.exit_reason.clone().unwrap_or_else(|| kind.to_string())),
        );
    }
    // 父会话不在用，且子代理自己已经干净收尾（无未配对工具、最后一条 assistant 已
    // stop，或干脆没有任何 assistant 记录）：视为正常结束。真实样本里 advisor 常缺
    // `session_exit`，若判成「失联」会把已完成的历史会话显示成全员异常。
    let stop = i.last_assistant_stop.as_deref();
    // 最后一轮报错/被中止是终态：不论父会话是否还在用，都显示失败（原因原文照搬）。
    // 例外：advisor 被重置（`aborted`）是正常机制，按完成处理。
    if i.pending_tools == 0 && matches!(stop, Some("error") | Some("aborted")) {
        if i.kind == StageActorKind::Advisor && stop == Some("aborted") {
            return (StageActorState::Done, Some("已结束".to_string()));
        }
        return (StageActorState::Failed, i.last_assistant_stop.clone());
    }
    if !i.parent_in_use {
        let clean =
            i.pending_tools == 0 && matches!(i.last_assistant_stop.as_deref(), None | Some("stop"));
        if clean {
            return (StageActorState::Done, Some("已结束".to_string()));
        }
        return (StageActorState::Lost, Some("会话已退出".to_string()));
    }
    // 无 exit 但最后一条 assistant 已收尾且无未配对工具：静默足够久即视为完成。
    if i.pending_tools == 0
        && i.last_assistant_stop.as_deref() == Some("stop")
        && i.last_at_secs
            .is_some_and(|last| i.now_secs.saturating_sub(last) > ORPHAN_DONE_SECS)
    {
        return (StageActorState::Done, Some("已结束".to_string()));
    }
    (StageActorState::Running, None)
}

impl Default for DeriveInput {
    fn default() -> Self {
        Self {
            // 默认按子代理（最通用的分支）；调用方总是显式给 `kind`。
            kind: StageActorKind::Subagent,
            file_exists: false,
            parent_in_use: false,
            exit_kind: None,
            exit_reason: None,
            lifecycle_action: None,
            pending_tools: 0,
            last_assistant_stop: None,
            last_at_secs: None,
            now_secs: 0,
            main_status: None,
        }
    }
}
