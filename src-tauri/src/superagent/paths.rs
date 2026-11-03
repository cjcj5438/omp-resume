//! Superagent 路径：状态目录、socket、日志、资源目录。

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use tauri::Manager;
/// socket 用状态目录内路径的上限（含 `daemon.sock` 文件名在内，按字节计）。
/// macOS `sun_path` 上限 104 字节（含结尾 NUL，即路径最多 103 字节），
/// 超过 100 就落到 /tmp 下的短路径，留 3 字节余量。
const SOCKET_INLINE_LIMIT: usize = 100;

/// 资源包内的守护进程入口（开发与打包后相对位置一致）。
const DAEMON_ENTRY: &str = "dist/daemon.js";

/// 覆盖资源目录的环境变量（测试/开发用）。
pub const ASSETS_DIR_ENV: &str = "OMP_RESUME_SUPERAGENT_DIR";

/// 状态目录 `S = <data_dir>/superagent`。
pub fn state_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("superagent")
}

/// unix socket 路径：`S/daemon.sock` 的字节长度 ≤ 100 时用它，
/// 否则用 `/tmp/omp-superagent-<uid>/daemon.sock`（目录 0700）。
pub fn socket_path(state: &Path) -> PathBuf {
    let inline = state.join("daemon.sock");
    if inline.as_os_str().as_encoded_bytes().len() <= SOCKET_INLINE_LIMIT {
        return inline;
    }
    fallback_socket_path()
}

/// 过长状态目录的短 socket 路径（目录按需创建为 0700）。
///
/// 若目录已存在但属主不是当前 uid、或组/其他用户可写，则拒绝使用并
/// 回退到 `std::env::temp_dir()` 下的同名目录（同样校验），避免经由
/// 他人可写的目录劫持 socket。
pub fn fallback_socket_path() -> PathBuf {
    // SAFETY：getuid 无副作用、无失败路径。
    let uid = unsafe { libc::getuid() };
    let primary = PathBuf::from(format!("/tmp/omp-superagent-{uid}"));
    if let Some(dir) = secure_socket_dir(&primary, uid) {
        return dir.join("daemon.sock");
    }
    let alt = std::env::temp_dir().join(format!("omp-superagent-{uid}"));
    if alt != primary {
        if let Some(dir) = secure_socket_dir(&alt, uid) {
            return dir.join("daemon.sock");
        }
    }
    // 两个目录都不可用时仍返回主路径：`bind`/`connect` 会报出明确的
    // 系统错误，而不是静默用了一个不安全的目录。
    primary.join("daemon.sock")
}

/// 确保 socket 目录存在、属主为 `uid`、组/其他用户不可写；成功返回目录。
fn secure_socket_dir(dir: &Path, uid: u32) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    if let Err(e) = std::fs::DirBuilder::new().mode(0o700).create(dir) {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return None;
        }
    }
    let md = std::fs::symlink_metadata(dir).ok()?;
    // 拒绝符号链接：指向他人目录的链接会绕过下面的属主检查。
    if md.file_type().is_symlink() {
        return None;
    }
    if !md.is_dir() || md.uid() != uid {
        return None;
    }
    // 组/其他用户可写即不可信（即使属主正确，也可能被他人植入 socket）。
    if md.permissions().mode() & 0o022 != 0 {
        return None;
    }
    Some(dir.to_path_buf())
}

/// 守护进程 pid 文件 `S/daemon.pid`（十进制 pid + 换行，0600）。
pub fn pid_path(state: &Path) -> PathBuf {
    state.join("daemon.pid")
}

/// 守护进程日志路径 `S/logs/daemon.log`。
pub fn log_path(state: &Path) -> PathBuf {
    state.join("logs").join("daemon.log")
}

/// Superagent 资源目录：`$OMP_RESUME_SUPERAGENT_DIR` → debug 构建下的
/// `<manifest>/../superagent` → 打包后的 `resource_dir/superagent`，
/// 只返回其中存在 `dist/daemon.js` 的那个。
pub fn assets_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(dir) = env_assets_dir() {
        return Some(dir);
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../superagent");
        if has_daemon_entry(&dev) {
            return Some(dev);
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join("superagent");
        if has_daemon_entry(&bundled) {
            return Some(bundled);
        }
    }
    None
}

/// 环境变量覆盖的资源目录（测试/开发用）：存在 `dist/daemon.js` 才返回。
/// `Supervisor` 的测试构造器经此路径注入假资源，无需 AppHandle。
pub fn env_assets_dir() -> Option<PathBuf> {
    let dir = std::env::var_os(ASSETS_DIR_ENV)
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty())?;
    has_daemon_entry(&dir).then_some(dir)
}

fn has_daemon_entry(dir: &Path) -> bool {
    dir.join(DAEMON_ENTRY).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_state_dir_uses_inline_socket() {
        let t = tempfile::tempdir().unwrap();
        let state = state_dir(t.path());
        assert_eq!(socket_path(&state), state.join("daemon.sock"));
    }

    #[test]
    fn long_state_dir_falls_back_to_tmp() {
        // 构造超过 100 字节的状态目录路径。
        let long = format!("/tmp/{}", "s".repeat(120));
        let state = Path::new(&long).join("superagent");
        let got = socket_path(&state);
        let uid = unsafe { libc::getuid() };
        assert_eq!(
            got,
            PathBuf::from(format!("/tmp/omp-superagent-{uid}/daemon.sock"))
        );
    }

    #[test]
    fn boundary_100_bytes_stays_inline() {
        // 恰 100 字节仍用目录内路径；101 字节落到 /tmp。
        // state = "/tmp/" + "s"*N + "/superagent"，inline = state + "/daemon.sock"。
        // "/tmp/".len()=5, "/superagent".len()=11, "/daemon.sock".len()=12。
        // inline 总长 = 28 + N；N=72 → 100（inline），N=73 → 101（fallback）。
        for (n, inline) in [(72usize, true), (73usize, false)] {
            let state = Path::new(&format!("/tmp/{}", "s".repeat(n))).join("superagent");
            let candidate = state.join("daemon.sock");
            assert_eq!(
                candidate.as_os_str().as_encoded_bytes().len(),
                28 + n,
                "test arithmetic drifted"
            );
            let got = socket_path(&state);
            if inline {
                assert_eq!(got, candidate);
            } else {
                assert_ne!(got, candidate);
                // fallback 目录可能因环境退到 temp_dir；只断言文件名与父目录名形状。
                assert_eq!(got.file_name().unwrap(), "daemon.sock");
                let parent = got.parent().unwrap().file_name().unwrap().to_string_lossy();
                assert!(parent.starts_with("omp-superagent-"), "{got:?}");
            }
        }
    }

    #[test]
    fn fallback_creates_0700_dir() {
        use std::os::unix::fs::PermissionsExt;
        let sock = fallback_socket_path();
        let dir = sock.parent().unwrap();
        let mode = std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
        // 目录可能早已存在（0700 或更严）；至少不能组/其他可写。
        assert_eq!(mode & 0o022, 0, "{dir:?} mode {mode:o}");
    }

    #[test]
    fn world_writable_dir_is_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let uid = unsafe { libc::getuid() };
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("sockdir");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(secure_socket_dir(&dir, uid), None);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(secure_socket_dir(&dir, uid), Some(dir.clone()));
        // 符号链接拒绝。
        let link = t.path().join("linkdir");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert_eq!(secure_socket_dir(&link, uid), None);
    }
}
