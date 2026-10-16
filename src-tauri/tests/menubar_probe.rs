//! 菜单栏检测流水线真实环境只读探针（`#[ignore]`，手动跑）：
//!
//! ```sh
//! cd src-tauri
//! cargo test --test menubar_probe -- --ignored --nocapture
//! ```
//!
//! 只读：flock 探测、lsof、jsonl 尾部读取、iTerm 标题查询（带 pgrep 门禁）。
//! 不聚焦、不发通知（只打印会发的动作）、不写任何文件。
//! 跑完后人工对照各会话在 iTerm 里的实际标题，确认判定合理。

use omp_resume_lib::config;
use omp_resume_lib::menubar::iterm::SystemRunner;
use omp_resume_lib::menubar::poller::{Poller, SystemOccupants};

fn epoch_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[test]
#[ignore]
fn live_pipeline_once() {
    let cfg = config::resolve(None);
    println!("sessions: {}", cfg.sessions_dir.display());
    println!("owners:   {}", cfg.owners_dir.display());
    let mut poller = Poller::new(
        cfg.owners_dir.clone(),
        cfg.sessions_dir.clone(),
        Box::new(SystemRunner),
        Box::new(SystemOccupants),
    );
    // 跑两轮：第二轮验证增量路径（偏移推进、无重复计数）。
    for round in 1..=2 {
        let outcome = poller.poll_once(epoch_now(), true, false);
        println!("--- round {round} ---");
        println!(
            "locks held={} unattributed={} rows={} error={:?}",
            outcome.inuse_total,
            outcome.unattributed,
            outcome.snapshots.len(),
            outcome.error,
        );
        println!(
            "timings: T0={:.1}ms T1={:.1}ms T2={:.1}ms T3={:.1}ms total={:.1}ms",
            outcome.timings.t0_ms,
            outcome.timings.t1_ms,
            outcome.timings.t2_ms,
            outcome.timings.t3_ms,
            outcome.timings.total_ms,
        );
        for s in &outcome.snapshots {
            println!(
                "  [{}] {} app={:?} pid={:?} tty={:?} focusable={} sub={} unpaired={} dur={}s",
                s.status.label(),
                s.title,
                s.app,
                s.pid,
                s.tty,
                s.focusable,
                s.subagents,
                s.unpaired,
                s.duration_secs,
            );
            println!("    id={} reason={}", s.id, s.reason);
        }
        if let Some(menu) = &outcome.menu {
            println!("  header: {}", menu.header);
            println!("  tray_title: {:?}", menu.tray_title);
            for row in menu.rows.iter().chain(menu.overflow.iter()) {
                println!(
                    "  row{}: {}",
                    if row.enabled { "" } else { " (disabled)" },
                    row.text
                );
            }
        }
        for t in &outcome.transitions {
            println!(
                "  transition: {} {:?} -> {:?} (busy {}s)",
                &t.session_id[..8.min(t.session_id.len())],
                t.prev,
                t.next,
                t.busy_secs
            );
        }
        for a in &outcome.actions {
            println!("  would-notify: {a:?}");
        }
        if round == 1 {
            std::thread::sleep(std::time::Duration::from_secs(4));
        }
    }
}
