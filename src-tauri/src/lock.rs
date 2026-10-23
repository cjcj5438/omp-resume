//! 占用探测（CONTRACT §3）：对 `<ownersDir>/<session-id>.lock` 做
//! 非阻塞 `flock(LOCK_EX|LOCK_NB)`。成功即释放；`EWOULDBLOCK` 视为占用。

use std::os::unix::io::AsRawFd;
use std::path::Path;

/// flock 探测结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub in_use: bool,
    pub probe_ok: bool,
}

/// 探测结果常量（单测共用）。
const FREE: Probe = Probe {
    in_use: false,
    probe_ok: true,
};
const UNKNOWN: Probe = Probe {
    in_use: false,
    probe_ok: false,
};

/// 会话 id 字符集：omp 生成的 uuid 与 8-hex id 均落在此集合；
/// 其他形状（如 `h-<wyhash>` 派生名亦符合）超出则拒绝猜测。
pub(crate) fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 探测会话是否被 omp 进程占用。
///
/// - 锁文件缺失 → 空闲（`in_use:false, probe_ok:true`）；
/// - 加锁成功（立即释放）→ 空闲；
/// - `EWOULDBLOCK` → 占用；
/// - id 非法或其他错误 → `probe_ok:false, in_use:false`。
pub fn probe(owners_dir: &Path, session_id: &str) -> Probe {
    if !valid_session_id(session_id) {
        return UNKNOWN;
    }
    let lock_path = owners_dir.join(format!("{session_id}.lock"));
    let file = match std::fs::OpenOptions::new().read(true).open(&lock_path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FREE,
        Err(_) => return UNKNOWN,
    };
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        unsafe {
            libc::flock(file.as_raw_fd(), libc::LOCK_UN);
        }
        FREE
    } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK) {
        Probe {
            in_use: true,
            probe_ok: true,
        }
    } else {
        UNKNOWN
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn missing_lock_file_is_free() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(
            probe(t.path(), "01a13834-80db-70cb-83b5-2f528fc1d96c"),
            FREE
        );
    }

    #[test]
    fn unlocked_file_is_free() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("abc123.lock"), "").unwrap();
        assert_eq!(probe(t.path(), "abc123"), FREE);
    }

    #[test]
    fn garbage_id_is_unknown() {
        let t = tempfile::tempdir().unwrap();
        let long = "y".repeat(129);
        let bad: Vec<&str> = vec!["", "../x", "a/b", "a.lock", "x!", &long];
        for id in bad {
            assert_eq!(probe(t.path(), id), UNKNOWN, "id: {id:?}");
        }
    }

    /// 子线程持有 flock，主线程探测必须看到占用。
    #[test]
    fn held_lock_reports_in_use() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("held-01.lock");
        std::fs::write(&path, "").unwrap();
        let (tx, rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let f = std::fs::OpenOptions::new().read(true).open(&path).unwrap();
            let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
            assert_eq!(rc, 0);
            tx.send(()).unwrap();
            // 持锁直到探测完成
            std::thread::sleep(std::time::Duration::from_secs(10));
            unsafe {
                libc::flock(f.as_raw_fd(), libc::LOCK_UN);
            }
        });
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        let got = probe(t.path(), "held-01");
        assert_eq!(
            got,
            Probe {
                in_use: true,
                probe_ok: true,
            }
        );
        // holder 线程持有 sleep(10)；直接 detach，不管它（临时目录随 test 清理）。
        std::mem::forget(holder);
    }
}
