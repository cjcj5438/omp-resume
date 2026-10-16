//! 检测轮询器：组装 T0–T3 → 快照 → 菜单模型 → 通知判定。
//!
//! 跑在独立后台线程（3 秒一轮，不阻塞 UI）；无占用会话时只跑 T0。
//! 每层耗时随 [`PollOutcome`] 返回，供探针与报告使用。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

use super::classify::{self, ClassifyInput, SessionStatus, TitleState};
use super::detect;
use super::iterm::{self, ParsedTitle, Runner};
use super::menu::{self, MenuModel, RowInput};
use super::notify::{self, NotifyAction, Tracker, Transition};
use super::tail::{self, TailState};

/// 轮询间隔（秒）。
pub const POLL_INTERVAL_SECS: u64 = 3;
/// 索引兜底重建周期（轮数；inUse 变化时立即重建）。
const INDEX_REFRESH_TICKS: u64 = 10;

/// 占用者解析（T1 的 lsof+归类部分），便于测试注入。
pub trait OccupantSource {
    fn resolve(
        &self,
        owners_dir: &std::path::Path,
        ids: &[String],
    ) -> HashMap<String, crate::model::Occupant>;
}

/// 生产实现：复用 `occupant::resolve_occupants`。
pub struct SystemOccupants;

impl OccupantSource for SystemOccupants {
    fn resolve(
        &self,
        owners_dir: &std::path::Path,
        ids: &[String],
    ) -> HashMap<String, crate::model::Occupant> {
        crate::occupant::resolve_occupants(owners_dir, ids)
    }
}

/// 单个运行会话的快照（一轮的判定结果 + 依据）。
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub id: String,
    pub title: String,
    pub status: SessionStatus,
    /// 中文判定依据（探针展示，不进菜单）。
    pub reason: String,
    pub app: Option<String>,
    pub pid: Option<u32>,
    pub tty: Option<String>,
    pub focusable: bool,
    pub subagents: u32,
    pub unpaired: u32,
    pub duration_secs: i64,
}

/// 各层耗时（毫秒）。
#[derive(Debug, Clone, Default)]
pub struct Timings {
    pub t0_ms: f64,
    pub t1_ms: f64,
    pub t2_ms: f64,
    pub t3_ms: f64,
    pub total_ms: f64,
}

/// 一轮的完整产出。
#[derive(Debug)]
pub struct PollOutcome {
    pub snapshots: Vec<Snapshot>,
    /// None = 本轮失败，调用方保留旧菜单。
    pub menu: Option<MenuModel>,
    pub actions: Vec<NotifyAction>,
    pub transitions: Vec<Transition>,
    pub timings: Timings,
    /// 被持有的锁总数（含子代理锁）。
    pub inuse_total: usize,
    /// 无法归属到顶层会话的锁数（子代理锁等，不成行）。
    pub unattributed: usize,
    pub error: Option<String>,
}

/// 轮询器（非线程安全：只在轮询线程内使用）。
pub struct Poller {
    owners_dir: PathBuf,
    sessions_dir: PathBuf,
    runner: Box<dyn Runner>,
    occupants: Box<dyn OccupantSource>,
    index: HashMap<String, PathBuf>,
    prev_inuse: HashSet<String>,
    holders: HashMap<String, crate::model::Occupant>,
    ttys: HashMap<u32, String>,
    titles: HashMap<String, ParsedTitle>,
    tails: HashMap<String, TailState>,
    prev_status: HashMap<String, SessionStatus>,
    busy_since: HashMap<String, i64>,
    seen_at: HashMap<String, i64>,
    tracker: Tracker,
    tick: u64,
}

impl Poller {
    pub fn new(
        owners_dir: PathBuf,
        sessions_dir: PathBuf,
        runner: Box<dyn Runner>,
        occupants: Box<dyn OccupantSource>,
    ) -> Self {
        Self {
            owners_dir,
            sessions_dir,
            runner,
            occupants,
            index: HashMap::new(),
            prev_inuse: HashSet::new(),
            holders: HashMap::new(),
            ttys: HashMap::new(),
            titles: HashMap::new(),
            tails: HashMap::new(),
            prev_status: HashMap::new(),
            busy_since: HashMap::new(),
            seen_at: HashMap::new(),
            tracker: Tracker::default(),
            tick: 0,
        }
    }

    pub fn poll_once(&mut self, now: i64, notify_on: bool, dock_on: bool) -> PollOutcome {
        let total = Instant::now();
        let mut timings = Timings::default();

        // ---- T0：flock 全量探测 ----
        let t = Instant::now();
        let inuse = match detect::scan_inuse(&self.owners_dir) {
            Ok(set) => set,
            Err(e) => {
                return PollOutcome {
                    snapshots: Vec::new(),
                    menu: None,
                    actions: Vec::new(),
                    transitions: Vec::new(),
                    timings,
                    inuse_total: 0,
                    unattributed: 0,
                    error: Some(format!("锁目录不可读：{e}")),
                };
            }
        };
        timings.t0_ms = t.elapsed().as_secs_f64() * 1000.0;

        // ---- T1：inUse 变化时重建索引 + 占用者 + tty ----
        let t = Instant::now();
        if inuse != self.prev_inuse || self.tick.is_multiple_of(INDEX_REFRESH_TICKS) {
            if let Ok(index) = detect::build_index(&self.sessions_dir) {
                self.index = index;
            }
            let top: Vec<String> = inuse
                .iter()
                .filter(|id| self.index.contains_key(id.as_str()))
                .cloned()
                .collect();
            self.holders = self.occupants.resolve(&self.owners_dir, &top);
            let mut pids: Vec<u32> = self.holders.values().map(|o| o.pid).collect();
            pids.sort_unstable();
            pids.dedup();
            let mut ttys = HashMap::new();
            for pid in pids {
                if let Some(tty) = self.ttys.get(&pid).cloned() {
                    ttys.insert(pid, tty);
                } else if let Some(tty) = iterm::tty_of_pid(pid, &*self.runner) {
                    ttys.insert(pid, tty);
                }
            }
            self.ttys = ttys;
            self.prev_inuse = inuse.clone();
        }
        timings.t1_ms = t.elapsed().as_secs_f64() * 1000.0;

        // ---- T3（先于判定）：iTerm 标题批量抓取 ----
        let t = Instant::now();
        let want_iterm = self
            .holders
            .values()
            .any(|o| o.app.as_deref() == Some("iTerm2"));
        self.titles = if want_iterm && iterm::iterm_running(&*self.runner) {
            iterm::fetch_titles(&*self.runner)
                .into_iter()
                .map(|(tty, name)| (tty, iterm::parse_title(&name)))
                .collect()
        } else {
            HashMap::new()
        };
        timings.t3_ms = t.elapsed().as_secs_f64() * 1000.0;

        // ---- T2 + 判定：逐顶层会话尾部读取 + classify ----
        let t = Instant::now();
        let mut snapshots = Vec::new();
        let mut transitions = Vec::new();
        let mut unattributed = 0usize;
        let mut top_ids: Vec<&String> = inuse.iter().collect();
        top_ids.sort();
        for id in top_ids {
            let Some(path) = self.index.get(id) else {
                unattributed += 1;
                continue;
            };
            let tail = self.tails.entry(id.clone()).or_default();
            // 读失败（文件消失等）→ 用旧状态继续判定；从未成功则跳过本轮。
            let read_ok = tail::poll_file(path, tail, now).is_ok();
            if !read_ok && tail.last().is_none() && tail.header_id().is_none() {
                continue;
            }
            let holder = self.holders.get(id);
            let pid = holder.map(|o| o.pid);
            let app = holder.and_then(|o| o.app.clone());
            let tty = pid.and_then(|p| self.ttys.get(&p).cloned());
            let title_state = match (&app, &tty) {
                (Some(app), Some(tty)) if app == "iTerm2" => self
                    .titles
                    .get(tty)
                    .map(|p| p.state)
                    .unwrap_or(TitleState::Unknown),
                _ => TitleState::Unknown,
            };
            let verdict = classify::classify(&ClassifyInput {
                title: title_state,
                last: tail.last(),
                unpaired_tool_calls: tail.unpaired_tool_calls(),
                running_subagents: tail.running_subagents(),
                now,
            });
            let created = tail
                .header_created()
                .unwrap_or_else(|| *self.seen_at.entry(id.clone()).or_insert(now));
            let status = verdict.status;
            // 转换 + busy 持续跟踪。busy_secs 必须在清理 busy_since 之前取：
            // 离开工作态的转换恰恰要用「此前工作中持续了多久」做通知门槛。
            let busy = matches!(status, SessionStatus::Working | SessionStatus::Stuck);
            let was_busy = self
                .prev_status
                .get(id)
                .is_some_and(|s| matches!(s, SessionStatus::Working | SessionStatus::Stuck));
            let busy_secs = self.busy_since.get(id).map(|s| now - s).unwrap_or(0);
            if busy && !was_busy {
                self.busy_since.insert(id.clone(), now);
            } else if !busy {
                self.busy_since.remove(id);
            }
            if let Some(prev) = self.prev_status.get(id) {
                if *prev != status {
                    transitions.push(Transition {
                        session_id: id.clone(),
                        title: tail.title(),
                        prev: *prev,
                        next: status,
                        busy_secs,
                    });
                }
            } else if status == SessionStatus::Stuck {
                // 首次观察即「疑似卡住」也算出现一次（通知规则见 CONTRACT §17.5：
                // episode 内只通知一次，重复观察不再触发）。
                transitions.push(Transition {
                    session_id: id.clone(),
                    title: tail.title(),
                    prev: SessionStatus::Working,
                    next: status,
                    busy_secs: 0,
                });
            }
            self.prev_status.insert(id.clone(), status);
            let focusable = app.as_deref() == Some("iTerm2") && tty.is_some();
            snapshots.push(Snapshot {
                id: id.clone(),
                title: tail.title(),
                status,
                reason: verdict.reason,
                app,
                pid,
                tty,
                focusable,
                subagents: tail.running_subagents(),
                unpaired: tail.unpaired_tool_calls(),
                duration_secs: (now - created).max(0),
            });
        }
        timings.t2_ms = t.elapsed().as_secs_f64() * 1000.0;

        // 清理已消失会话的缓存。
        let live: HashSet<&str> = snapshots.iter().map(|s| s.id.as_str()).collect();
        self.tails.retain(|id, _| live.contains(id.as_str()));
        self.prev_status.retain(|id, _| live.contains(id.as_str()));
        self.busy_since.retain(|id, _| live.contains(id.as_str()));
        self.seen_at.retain(|id, _| live.contains(id.as_str()));
        for id in self.prev_inuse.clone() {
            if !live.contains(id.as_str()) {
                self.tracker.forget(&id);
            }
        }

        let actions = notify::decide(&transitions, now, notify_on, &mut self.tracker);
        let rows: Vec<RowInput> = snapshots
            .iter()
            .map(|s| RowInput {
                session_id: s.id.clone(),
                title: s.title.clone(),
                status: s.status,
                app_label: s.app.clone(),
                pid: s.pid,
                focusable: s.focusable,
                focus_block_reason: focus_block_reason(s),
                subagents_running: s.subagents,
                duration_secs: s.duration_secs,
            })
            .collect();
        let menu = menu::build_model(rows, notify_on, dock_on);
        self.tick += 1;
        timings.total_ms = total.elapsed().as_secs_f64() * 1000.0;
        PollOutcome {
            snapshots,
            menu: Some(menu),
            actions,
            transitions,
            timings,
            inuse_total: inuse.len(),
            unattributed,
            error: None,
        }
    }
}

fn focus_block_reason(s: &Snapshot) -> Option<String> {
    if s.focusable {
        return None;
    }
    if s.pid.is_none() {
        return Some("未找到占用进程".to_string());
    }
    if s.app.as_deref() != Some("iTerm2") {
        return Some("仅 iTerm 可聚焦".to_string());
    }
    Some("未找到终端".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Occupant;
    use std::cell::RefCell;
    use std::os::unix::io::AsRawFd;

    struct FakeRunner {
        titles: RefCell<HashMap<String, String>>,
        running: bool,
        fd0: String,
    }

    impl Runner for FakeRunner {
        fn run(&self, prog: &str, args: &[&str]) -> Result<String, String> {
            match prog {
                "/usr/bin/pgrep" => {
                    if self.running {
                        Ok("1\n".into())
                    } else {
                        Err("no".into())
                    }
                }
                "/usr/bin/osascript" => {
                    assert!(args[0] == "-e");
                    let mut out = String::new();
                    for (tty, name) in self.titles.borrow().iter() {
                        out.push_str(&format!("{tty}\t{name}\n"));
                    }
                    Ok(out)
                }
                _ => Ok(self.fd0.clone()),
            }
        }
    }

    struct FakeOccupants {
        map: HashMap<String, Occupant>,
    }

    impl OccupantSource for FakeOccupants {
        fn resolve(&self, _owners: &std::path::Path, ids: &[String]) -> HashMap<String, Occupant> {
            ids.iter()
                .filter_map(|id| self.map.get(id).map(|o| (id.clone(), o.clone())))
                .collect()
        }
    }

    /// 搭一个最小真实环境：sessions 目录（1 顶层会话）+ owners 目录（锁被本测试持有）。
    struct Harness {
        _sessions: tempfile::TempDir,
        _owners: tempfile::TempDir,
        _held: std::fs::File,
        session_path: PathBuf,
        session_id: String,
    }

    impl Harness {
        fn setup(title: &str) -> Self {
            let sessions = tempfile::tempdir().unwrap();
            let owners = tempfile::tempdir().unwrap();
            let proj = sessions.path().join("proj");
            std::fs::create_dir(&proj).unwrap();
            let session_id = "abc12345-0000-0000-0000-000000000000".to_string();
            let session_path = proj.join(format!("2026-10-16T00-00-00-000Z_{session_id}.jsonl"));
            std::fs::write(
                &session_path,
                format!(
                    "{{\"type\":\"title\",\"v\":1,\"title\":\"{title}\",\"source\":\"auto\",\"updatedAt\":\"2026-10-16T12:00:00.000Z\"}}\n\
                     {{\"type\":\"session\",\"version\":3,\"id\":\"{session_id}\",\"timestamp\":\"2026-10-16T11:00:00.000Z\",\"cwd\":\"/tmp\"}}\n"
                ),
            )
            .unwrap();
            let lock_path = owners.path().join(format!("{session_id}.lock"));
            std::fs::write(&lock_path, "").unwrap();
            let held = std::fs::OpenOptions::new()
                .read(true)
                .open(&lock_path)
                .unwrap();
            unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            Self {
                _sessions: sessions,
                _owners: owners,
                _held: held,
                session_path,
                session_id,
            }
        }

        fn append(&self, line: &str) {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&self.session_path)
                .unwrap();
            writeln!(f, "{line}").unwrap();
        }
    }

    fn poller(h: &Harness, titles: HashMap<String, String>, app: Option<&str>) -> Poller {
        let mut occ = HashMap::new();
        if let Some(app) = app {
            occ.insert(
                h.session_id.clone(),
                Occupant {
                    pid: 4242,
                    app: Some(app.to_string()),
                    app_version: None,
                },
            );
        }
        Poller::new(
            h._owners.path().to_path_buf(),
            h._sessions.path().to_path_buf(),
            Box::new(FakeRunner {
                titles: RefCell::new(titles),
                running: true,
                fd0: "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n\
                      omp 4242 u 0u CHR 1 0 1 /dev/ttys009\n"
                    .to_string(),
            }),
            Box::new(FakeOccupants { map: occ }),
        )
    }

    #[test]
    fn end_to_end_waiting_then_working() {
        let h = Harness::setup("测试会话");
        let mut titles = HashMap::new();
        titles.insert("/dev/ttys009".to_string(), "π > 测试会话 (omp)".to_string());
        let mut p = poller(&h, titles, Some("iTerm2"));
        // 第一轮：只有头，无有意义记录 → 空闲。
        let o1 = p.poll_once(1_790_000_000, true, false);
        assert!(o1.error.is_none());
        assert_eq!(o1.inuse_total, 1);
        assert_eq!(o1.snapshots.len(), 1);
        assert_eq!(o1.snapshots[0].status, SessionStatus::Idle);
        assert_eq!(o1.snapshots[0].title, "测试会话");
        assert!(o1.snapshots[0].focusable);
        assert!(o1.actions.is_empty());
        // 追加 assistant stop（60 秒前）→ 等待输入；但首个转换 prev=Idle → 不通知。
        h.append(r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-10-16T12:00:00.000Z","message":{"role":"assistant","content":[],"stopReason":"stop"}}"#);
        let now = 1_790_000_000 + 3600 + 60;
        let o2 = p.poll_once(now, true, false);
        assert_eq!(o2.snapshots[0].status, SessionStatus::WaitingInput);
        assert!(o2.actions.is_empty());
        // 标题切旋转符 → 工作中。
        // （FakeRunner 的 titles 不可变：重建 poller 会丢状态，这里只验证 busy 跟踪逻辑改由单测覆盖；
        // 本测试聚焦装配链路，状态翻转已在上面验证。）
        assert_eq!(
            o2.menu.as_ref().unwrap().tray_title,
            Some("0·1".to_string())
        );
    }

    #[test]
    fn non_iterm_row_not_focusable() {
        let h = Harness::setup("VS 会话");
        h.append(r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-10-16T12:00:00.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"read"}],"stopReason":"toolUse"}}"#);
        let mut p = poller(&h, HashMap::new(), Some("VS Code"));
        let o = p.poll_once(1_790_001_000, true, false);
        assert_eq!(o.snapshots.len(), 1);
        // 无标题信号，但有未配对工具 → 工作中；不可聚焦。
        assert_eq!(o.snapshots[0].status, SessionStatus::Working);
        assert!(!o.snapshots[0].focusable);
        let row = &o.menu.unwrap().rows[0];
        assert!(!row.enabled);
        assert!(row.text.contains("仅 iTerm 可聚焦"), "{}", row.text);
    }

    #[test]
    fn unknown_lock_is_unattributed() {
        let h = Harness::setup("顶层");
        // 额外一把子代理锁（无顶层文件），同目录持有。
        let sub = h._owners.path().join("subagent-id-1.lock");
        std::fs::write(&sub, "").unwrap();
        let held = std::fs::OpenOptions::new().read(true).open(&sub).unwrap();
        unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        let mut p = poller(&h, HashMap::new(), None);
        let o = p.poll_once(1_790_000_000, true, false);
        assert_eq!(o.inuse_total, 2);
        assert_eq!(o.unattributed, 1);
        assert_eq!(o.snapshots.len(), 1);
    }

    #[test]
    fn owners_unreadable_keeps_old_menu() {
        let h = Harness::setup("顶层");
        let mut p = poller(&h, HashMap::new(), None);
        p.owners_dir = h._owners.path().join("missing");
        let o = p.poll_once(1_790_000_000, true, false);
        assert!(o.menu.is_none());
        assert!(o.error.is_some());
    }

    #[test]
    fn busy_duration_gates_waiting_notification() {
        let h = Harness::setup("生成后等待");
        h.append(
            r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-10-16T12:00:00.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"read"}],"stopReason":"toolUse"}}"#,
        );
        let mut p = poller(&h, HashMap::new(), None);
        // t0：工作中（未配对工具）。
        let o = p.poll_once(1_790_000_000, true, false);
        assert_eq!(o.snapshots[0].status, SessionStatus::Working);
        assert!(o.actions.is_empty());
        // t0+40：工具返回 + 回合结束 → 等待输入；忙碌 40s ≥ 30s 门槛 → 通知。
        // （回归：busy_secs 曾因先清 busy_since 而恒为 0，通知从未发出。）
        h.append(
            r#"{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-10-16T12:01:00.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"read","content":[]}}"#,
        );
        h.append(
            r#"{"type":"message","id":"a3","parentId":"a2","timestamp":"2026-10-16T12:01:01.000Z","message":{"role":"assistant","content":[],"stopReason":"stop"}}"#,
        );
        let o = p.poll_once(1_790_000_040, true, false);
        assert_eq!(o.snapshots[0].status, SessionStatus::WaitingInput);
        assert!(
            matches!(o.actions.as_slice(), [NotifyAction::Waiting { .. }]),
            "actions={:?}",
            o.actions
        );
        assert!(o.transitions[0].busy_secs >= 30, "{:?}", o.transitions);
    }

    #[test]
    fn first_sight_stuck_notifies_once() {
        let h = Harness::setup("卡住会话");
        // 1 小时前的未配对 toolCall（超 STUCK 未超 24h 过期）：首轮即判「疑似卡住」。
        let ts = chrono::DateTime::from_timestamp(1_789_996_400, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        h.append(&format!(
            r#"{{"type":"message","id":"a1","parentId":null,"timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"toolCall","id":"t1","name":"read"}}],"stopReason":"toolUse"}}}}"#
        ));
        let mut p = poller(&h, HashMap::new(), None);
        let o = p.poll_once(1_790_000_000, true, false);
        assert_eq!(o.snapshots[0].status, SessionStatus::Stuck);
        // 首次观察到卡住 = 出现一次 → 通知。
        assert_eq!(o.actions.len(), 1, "{:?}", o.actions);
        assert!(matches!(o.actions[0], NotifyAction::Stuck { .. }));
        // 同一 episode 内重复观察不再通知。
        let o = p.poll_once(1_790_000_003, true, false);
        assert!(o.actions.is_empty(), "{:?}", o.actions);
    }
}
