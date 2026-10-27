//! Agent 舞台（CONTRACT §23）：把一个会话里的主会话 / 子代理 / worker 拼成
//! 可视化所需的状态（只读，不写任何会话文件）。
//!
//! 数据来源全部是既有 jsonl：
//! - 顶层 `<dir>/<file>.jsonl` → 主会话角色；
//! - 同级去扩展目录里的子代理 jsonl（`task` 子代理、`vibe_spawn` worker、
//!   `__advisor.jsonl`）；
//! - 父会话里的 `custom/tool_execution_start`、assistant `toolCall`
//!   （`task.tasks[]` / `vibe_spawn`）与 `vibe-session-lifecycle` 行。
//!
//! 增量：每个文件一个 [`cursor::JsonlCursor`] + [`actor_tail::ActorTail`]，
//! 最多缓存 4 个会话；不在本轮目录列表里的文件项当轮丢弃。

mod actor_tail;
mod cursor;
mod derive;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, SecondsFormat, Utc};

use crate::config::{validate_session_path, Config};
use crate::lock::{self, Probe};
use crate::model::{
    AgentStage, AppError, AppResult, ErrorCode, RunningSession, StageActivity, StageActivityKind,
    StageActor, StageActorKind, StageActorState,
};
use crate::usage::cache::nested_files;

use actor_tail::{iso_ms, ActorTail, Life, SpawnInfo};
use cursor::{JsonlCursor, LineSink};
use derive::{derive_state, DeriveInput};

/// 单个会话最多展开的附件 jsonl 数（超出按 mtime 降序保留）。
pub const MAX_FILES: usize = 200;
/// 进程内缓存的会话数（超出淘汰最久未用）。
const MAX_SESSIONS: usize = 4;

/// 一个会话的增量状态。
struct SessionTails {
    top: PathBuf,
    files: HashMap<PathBuf, (JsonlCursor, ActorTail)>,
    used: Instant,
}

/// 跨请求缓存（`Default` 空）。
#[derive(Default)]
pub struct StageCache(Mutex<Vec<SessionTails>>);

fn cache_poisoned() -> AppError {
    AppError::new(ErrorCode::Io, "舞台缓存不可用")
}

/// 游标回调：把行喂给 `ActorTail`，重置时清空它。
struct TailSink<'a> {
    tail: &'a mut ActorTail,
    now_ms: i64,
}

impl LineSink for TailSink<'_> {
    fn reset(&mut self) {
        self.tail.reset();
    }

    fn line(&mut self, line: &[u8]) {
        self.tail.feed_line(line, self.now_ms);
    }
}

/// 推进单个文件的游标，返回该文件 tail 的一份克隆（避免长借用）。
fn advance_file(slot: &mut SessionTails, path: &Path, now_ms: i64) -> std::io::Result<ActorTail> {
    let (cursor, tail) = slot
        .files
        .entry(path.to_path_buf())
        .or_insert_with(|| (JsonlCursor::default(), ActorTail::default()));
    let result = {
        let mut sink = TailSink { tail, now_ms };
        cursor.advance(path, &mut sink)
    };
    match result {
        Ok(()) => Ok(slot
            .files
            .get(path)
            .map(|(_, t)| t.clone())
            .unwrap_or_default()),
        Err(e) => Err(e),
    }
}

fn io_error(path: &Path, e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::new(
            ErrorCode::NotFound,
            format!("会话文件不存在：{}", path.display()),
        )
    } else {
        AppError::new(ErrorCode::Io, format!("无法读取 {}：{e}", path.display()))
    }
}

/// 附件目录里要纳入舞台的文件。
struct Discovered {
    /// 相对附件目录的 id（去掉 `.jsonl`，`/` 分隔）。
    id: String,
    path: PathBuf,
    /// 相对附件目录的嵌套层数（0 = 直接子文件）。
    depth: usize,
}

/// 收集附件目录中合格的文件：直接子文件全部、嵌套文件中的非 advisor。
///
/// 每个文件都 canonicalize 并校验前缀（照 `usage/cache.rs`）：逃出会话根目录或
/// 附件目录 → `OUTSIDE_ROOT`；符号链接已在 `nested_files` 内被跳过。
fn discover(cfg: &Config, attach: &Path) -> AppResult<(Vec<Discovered>, u32)> {
    let mut nested = Vec::new();
    nested_files(attach, &mut nested)?;
    nested.sort();
    let root = cfg
        .sessions_dir
        .canonicalize()
        .map_err(|e| io_error(&cfg.sessions_dir, e))?;
    let attach_canon = attach.canonicalize().map_err(|e| io_error(attach, e))?;
    let mut out = Vec::new();
    for path in nested {
        let canonical = path.canonicalize().map_err(|e| io_error(&path, e))?;
        if !canonical.starts_with(&root) || !canonical.starts_with(&attach_canon) {
            return Err(AppError::new(
                ErrorCode::OutsideRoot,
                "子代理路径逃出会话目录",
            ));
        }
        let Ok(rel) = canonical.strip_prefix(&attach_canon) else {
            continue;
        };
        let depth = rel.components().count().saturating_sub(1);
        let stem = rel.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        // 嵌套 advisor（子目录里的 `__advisor.jsonl`）一律忽略。
        if depth >= 1 && stem == "__advisor" {
            continue;
        }
        let id = rel
            .with_extension("")
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        out.push(Discovered {
            id,
            path: canonical,
            depth,
        });
    }
    let omitted = out.len().saturating_sub(MAX_FILES) as u32;
    if omitted > 0 {
        // 按 mtime 降序保留最近变更的 MAX_FILES 个，再按路径复原稳定顺序。
        out.sort_by_key(|d| {
            std::cmp::Reverse(std::fs::metadata(&d.path).and_then(|m| m.modified()).ok())
        });
        out.truncate(MAX_FILES);
        out.sort_by(|a, b| a.path.cmp(&b.path));
    }
    Ok((out, omitted))
}

/// 建一个会话的舞台。
///
/// `running` 是菜单栏轮询器的本会话快照（有则提供主会话状态）；
/// `probe` 注入占用探测（测试可控）；`now` 为当前时间。
pub fn build_stage(
    cfg: &Config,
    cache: &StageCache,
    top: &Path,
    running: Option<&RunningSession>,
    probe: &dyn Fn(&str) -> Probe,
    now: DateTime<Utc>,
) -> AppResult<AgentStage> {
    let now_ms = now.timestamp_millis();
    let now_secs = now.timestamp();
    let mut sessions = cache.0.lock().map_err(|_| cache_poisoned())?;
    let slot_index = match sessions.iter().position(|s| s.top == top) {
        Some(i) => i,
        None => {
            if sessions.len() >= MAX_SESSIONS {
                let oldest = sessions
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, s)| s.used)
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                sessions.remove(oldest);
            }
            sessions.push(SessionTails {
                top: top.to_path_buf(),
                files: HashMap::new(),
                used: Instant::now(),
            });
            sessions.len() - 1
        }
    };
    let slot = &mut sessions[slot_index];
    slot.used = Instant::now();

    // ---- 主会话 ----
    let main_tail = advance_file(slot, top, now_ms).map_err(|e| io_error(top, e))?;
    if main_tail.header_version != Some(3) {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            "仅支持 version 3 会话",
        ));
    }
    let probed = main_tail.header_id.as_deref().map(probe);
    let (in_use, probe_ok) = match probed {
        Some(p) => (p.in_use, p.probe_ok),
        // header 无 id：只能靠轮询器快照。
        None => (running.is_some(), true),
    };
    let parent_in_use = in_use || (!probe_ok && running.is_some());

    // ---- 附件目录 ----
    let attach = top.with_extension("");
    let (discovered, omitted) = if attach.is_dir() {
        discover(cfg, &attach)?
    } else {
        (Vec::new(), 0)
    };
    // 本轮目录列表之外的文件项丢弃（顶层游标保留，避免每轮全量重读主会话）。
    let live: Vec<PathBuf> = discovered
        .iter()
        .map(|d| d.path.clone())
        .chain(std::iter::once(top.to_path_buf()))
        .collect();
    slot.files.retain(|p, _| live.contains(p));

    // 子代理角色（借用 slot 期间就建好）。
    let main_spawn: HashMap<String, SpawnInfo> = main_tail.spawn_info.clone();
    let main_lifecycle: HashMap<String, Life> = main_tail.lifecycle.clone();
    // 第一遍：推进游标，拿到每个文件的 tail（读失败的本轮跳过，下轮可读时自然出现）。
    let mut tails: Vec<(&Discovered, ActorTail)> = Vec::with_capacity(discovered.len());
    for d in &discovered {
        if let Ok(tail) = advance_file(slot, &d.path, now_ms) {
            tails.push((d, tail));
        }
    }
    // 派发说明按「派发它的那一层」取：孙代理的 task 调用写在父子代理里，不在主会话里。
    let child_spawn: HashMap<&str, &HashMap<String, SpawnInfo>> = tails
        .iter()
        .map(|(d, tail)| (d.id.as_str(), &tail.spawn_info))
        .collect();
    let mut actors: Vec<StageActor> = Vec::with_capacity(tails.len());
    for (d, tail) in &tails {
        let (kind, life) = classify_actor(&d.id, &main_lifecycle);
        let spawn = match d.id.rsplit_once('/') {
            Some((parent, _)) => child_spawn.get(parent).copied(),
            None => Some(&main_spawn),
        };
        actors.push(build_actor(
            d,
            tail,
            kind,
            life,
            parent_in_use,
            spawn,
            now_secs,
        ));
    }

    // ---- 主会话角色 ----
    let main_status = running.map(|r| r.status.clone());
    let (main_state, main_text) = derive_state(&DeriveInput {
        kind: StageActorKind::Main,
        file_exists: true,
        parent_in_use,
        main_status,
        ..DeriveInput::default()
    });
    let mut main_actor = StageActor {
        id: "main".to_string(),
        kind: StageActorKind::Main,
        parent_id: None,
        name: "管理员".to_string(),
        agent: None,
        brief: None,
        state: main_state,
        status_text: main_text,
        started_at: main_tail.header_ts_ms.or(main_tail.last_at_ms).map(iso_ms),
        ended_at: main_tail.exit.as_ref().map(|e| iso_ms(e.at_ms)),
        last_activity_at: main_tail.last_at_ms.map(iso_ms),
        model: main_tail.model.clone(),
        context_tokens: main_tail.context_tokens,
        cost: main_tail.cost,
        tool_calls: main_tail.tool_calls,
        current: current_of(&main_tail, main_state, main_state != StageActorState::Done),
        recent: recent_of(&main_tail),
    };
    if parent_in_use {
        main_actor.ended_at = None;
    }

    // lifecycle 里有、文件尚未出现的 worker：补一个「排队中」角色。
    for (name, life) in &main_lifecycle {
        // 已退役或尚未拿到子会话文件名：都不补角色。
        if life.tombstoned {
            continue;
        }
        let Some(child) = &life.child_file else {
            continue;
        };
        let file = child.trim_end_matches(".jsonl").to_string();
        if discovered.iter().any(|d| d.id == file || d.id == *name) {
            continue;
        }
        let (state, text) = derive_state(&DeriveInput {
            kind: StageActorKind::Worker,
            file_exists: false,
            parent_in_use,
            lifecycle_action: Some(life.action.clone()),
            last_at_secs: Some(life.last_at_ms / 1000),
            now_secs,
            ..DeriveInput::default()
        });
        actors.push(StageActor {
            id: file,
            kind: StageActorKind::Worker,
            parent_id: None,
            name: name.clone(),
            agent: life.agent.clone(),
            brief: main_spawn.get(name).and_then(|s| s.brief.clone()),
            state,
            status_text: text,
            started_at: Some(iso_ms(life.last_at_ms)),
            ended_at: None,
            last_activity_at: Some(iso_ms(life.last_at_ms)),
            model: None,
            context_tokens: 0,
            cost: 0.0,
            tool_calls: 0,
            current: None,
            recent: Vec::new(),
        });
    }

    drop(sessions);

    // main 置首，其余按 startedAt 升序（None 排后）、再按 id。
    actors.sort_by(|a, b| match (&a.started_at, &b.started_at) {
        (Some(x), Some(y)) => x.cmp(y).then_with(|| a.id.cmp(&b.id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    });
    let mut ordered = Vec::with_capacity(actors.len() + 1);
    ordered.push(main_actor);
    ordered.extend(actors);

    let title = running
        .map(|r| r.title.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| main_tail.title().trim().to_string());

    Ok(AgentStage {
        path: top.to_string_lossy().to_string(),
        session_id: main_tail.header_id.clone(),
        title: if title.is_empty() {
            "(无标题)".to_string()
        } else {
            title
        },
        cwd: main_tail.header_cwd.clone(),
        in_use,
        probe_ok,
        updated_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        omitted,
        actors: ordered,
    })
}

/// 附件文件的种类与它对应的 lifecycle 条目。
///
/// `__advisor` → Advisor；lifecycle 的 `childSessionFile` 命中 → Worker（并带上该条目，
/// 让 worker 文件走 lifecycle 判定而不是子代理规则）；其余 → Subagent。
fn classify_actor<'a>(
    id: &str,
    lifecycle: &'a HashMap<String, Life>,
) -> (StageActorKind, Option<&'a Life>) {
    if id.rsplit('/').next() == Some("__advisor") {
        return (StageActorKind::Advisor, None);
    }
    let hit = lifecycle.values().find(|l| {
        l.child_file
            .as_deref()
            .map(|f| f.trim_end_matches(".jsonl") == id)
            .unwrap_or(false)
    });
    match hit {
        Some(life) => (StageActorKind::Worker, Some(life)),
        None => (StageActorKind::Subagent, None),
    }
}

/// 组装一个子代理角色。
fn build_actor(
    d: &Discovered,
    tail: &ActorTail,
    kind: StageActorKind,
    // worker 在父会话 lifecycle 里的当前动作（子代理/advisor 恒 None）。
    life: Option<&Life>,
    parent_in_use: bool,
    // 派发它的那一层的 `spawn_info`：直接子文件来自主会话，嵌套文件来自父代理。
    spawn: Option<&HashMap<String, SpawnInfo>>,
    now_secs: i64,
) -> StageActor {
    let leaf = d.id.rsplit('/').next().unwrap_or(&d.id);
    let name = display_name(&d.id);
    let info = spawn.and_then(|m| m.get(name).or_else(|| m.get(leaf)));
    let parent_id = (d.depth >= 1)
        .then(|| d.id.rsplit_once('/').map(|(p, _)| p.to_string()))
        .flatten();
    let (state, text) = derive_state(&DeriveInput {
        kind,
        file_exists: true,
        parent_in_use,
        exit_kind: tail.exit.as_ref().map(|e| e.kind.clone()),
        exit_reason: tail.exit.as_ref().map(|e| e.reason.clone()),
        lifecycle_action: life.map(|l| l.action.clone()),
        pending_tools: tail.pending.len(),
        last_assistant_stop: tail.last_assistant.as_ref().map(|a| a.stop_reason.clone()),
        last_at_secs: tail.last_at_ms.map(|ms| ms / 1000),
        now_secs,
        main_status: None,
    });
    let ended_at = tail.exit.as_ref().map(|e| iso_ms(e.at_ms)).or_else(|| {
        matches!(
            state,
            StageActorState::Done | StageActorState::Failed | StageActorState::Lost
        )
        .then(|| tail.last_assistant.as_ref().map(|a| iso_ms(a.at_ms)))
        .flatten()
    });
    StageActor {
        id: d.id.clone(),
        kind,
        parent_id,
        name: name.to_string(),
        // 派发调用里有 agent 用它；vibe worker 的 agent 只在 lifecycle 里（如 "sonic"）。
        agent: info
            .and_then(|i| i.agent.clone())
            .or_else(|| life.and_then(|l| l.agent.clone())),
        brief: info.and_then(|i| i.brief.clone()),
        state,
        status_text: text,
        started_at: tail.header_ts_ms.or(tail.last_at_ms).map(iso_ms),
        ended_at,
        last_activity_at: tail.last_at_ms.map(iso_ms),
        model: tail.model.clone(),
        context_tokens: tail.context_tokens,
        cost: tail.cost,
        tool_calls: tail.tool_calls,
        current: current_of(
            tail,
            state,
            matches!(state, StageActorState::Running | StageActorState::Idle),
        ),
        recent: recent_of(tail),
    }
}

/// 角色显示名：孙代理的 id 是 `<父>/<父>.<子>`，去掉重复的父名前缀。
fn display_name(id: &str) -> &str {
    let leaf = id.rsplit('/').next().unwrap_or(id);
    let Some((parent, _)) = id.rsplit_once('/') else {
        return leaf;
    };
    let parent_leaf = parent.rsplit('/').next().unwrap_or(parent);
    leaf.strip_prefix(parent_leaf)
        .and_then(|rest| rest.strip_prefix('.'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(leaf)
}

/// 当前活动：已收尾的角色不再显示过期活动；否则优先最新未配对工具，
/// 其次运行中且最后一条 assistant 未收尾 → 思考。
fn current_of(tail: &ActorTail, state: StageActorState, live: bool) -> Option<StageActivity> {
    if !live {
        return None;
    }
    if let Some(p) = tail.current_pending() {
        return Some(StageActivity {
            at: iso_ms(p.at_ms),
            kind: StageActivityKind::Tool,
            tool: Some(p.tool.clone()),
            text: p.text.clone(),
        });
    }
    if state != StageActorState::Running {
        return None;
    }
    let last = tail.last_assistant.as_ref()?;
    if last.stop_reason == "stop" {
        return None;
    }
    Some(StageActivity {
        at: iso_ms(last.at_ms),
        kind: StageActivityKind::Thinking,
        tool: None,
        text: String::new(),
    })
}

fn recent_of(tail: &ActorTail) -> Vec<StageActivity> {
    tail.recent.iter().map(|r| r.activity.clone()).collect()
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// CONTRACT §4.57：单个会话的舞台（只读）。
#[tauri::command]
pub async fn get_agent_stage(
    cfg: tauri::State<'_, Config>,
    cache: tauri::State<'_, Arc<StageCache>>,
    shared: tauri::State<'_, crate::menubar::tray::Shared>,
    path: String,
) -> AppResult<AgentStage> {
    let cfg = cfg.inner().clone();
    let cache = Arc::clone(cache.inner());
    let running = shared
        .running
        .lock()
        .ok()
        .and_then(|list| list.iter().find(|r| r.path == path).cloned());
    crate::blocking(move || {
        let valid = validate_session_path(&cfg, &path)?;
        let probe = |id: &str| lock::probe(&cfg.owners_dir, id);
        build_stage(&cfg, &cache, &valid, running.as_ref(), &probe, Utc::now())
    })
    .await
}

/// CONTRACT §4.58：运行中会话快照（菜单栏轮询器每 3 秒发布）。
#[tauri::command]
pub async fn list_running_sessions(
    shared: tauri::State<'_, crate::menubar::tray::Shared>,
) -> AppResult<Vec<RunningSession>> {
    Ok(shared
        .running
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default())
}
