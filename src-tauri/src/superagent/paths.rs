//! Superagent 路径：状态目录、socket、日志、资源目录。

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::Manager;
/// socket 用状态目录内路径的上限（含 `daemon.sock` 文件名在内，按字节计）。
/// macOS `sun_path` 上限 104 字节（含结尾 NUL，即路径最多 103 字节），
/// 超过 100 就落到 /tmp 下的短路径，留 3 字节余量。
const SOCKET_INLINE_LIMIT: usize = 100;

/// 资源包内的守护进程入口（开发与打包后相对位置一致）。
const DAEMON_ENTRY: &str = "dist/daemon.js";

/// 覆盖资源目录的环境变量（测试/开发用）。
pub const ASSETS_DIR_ENV: &str = "OMP_RESUME_SUPERAGENT_DIR";

/// 覆盖状态目录的环境变量：绝对路径，非空；任何构建下都优先于通道默认。
pub const STATE_DIR_ENV: &str = "OMP_RESUME_SUPERAGENT_STATE_DIR";

/// 状态目录 `S`：`$OMP_RESUME_SUPERAGENT_STATE_DIR`（绝对路径）优先；
/// 否则 debug 构建用 `<data_dir>/superagent-dev`，release 用 `<data_dir>/superagent`。
/// debug 与 release 永不共用同一个状态库：dev 构建迁移出的新 schema 会让
/// 低版本 release 守护进程秒退（`Unsupported orchestrator database version`），
/// 而 debug 专用目录从根上杜绝了这种互相污染。
pub fn state_dir(data_dir: &Path) -> PathBuf {
    state_dir_for(data_dir, cfg!(debug_assertions))
}

/// 带通道参数的状态目录解析（debug/release 在编译期确定，测试经此覆盖参数）。
pub fn state_dir_for(data_dir: &Path, dev: bool) -> PathBuf {
    let override_dir = std::env::var_os(STATE_DIR_ENV).map(PathBuf::from);
    state_dir_for_with_override(data_dir, dev, override_dir.as_deref())
}

/// 带覆盖目录注入的状态目录解析内核：`override_dir` 为非空绝对路径时优先，
/// 否则按通道默认（`dev` → `superagent-dev`，否则 `superagent`）。
/// `config::resolve_with` 经此与 supervisor 共用同一规则，以其可注入的
/// `env` 闭包提供覆盖值（`state_dir_for` 则读真实进程环境）。
pub fn state_dir_for_with_override(
    data_dir: &Path,
    dev: bool,
    override_dir: Option<&Path>,
) -> PathBuf {
    if let Some(dir) = override_dir.filter(|dir| !dir.as_os_str().is_empty() && dir.is_absolute()) {
        return dir.to_path_buf();
    }
    data_dir.join(if dev { "superagent-dev" } else { "superagent" })
}

/// debug 首次运行的状态迁移：`<data_dir>/superagent-dev/superagent.sqlite` 不存在
/// 且生产库 `<data_dir>/superagent/superagent.sqlite` 存在时，把库文件与其
/// `-wal`/`-shm` 旁车拷进 `superagent-dev/`（按需建目录），让既有项目/工单/设置
/// 一次性带过来。只拷、不删、不改生产库；任何一步失败都静默跳过（返回 false），
/// 绝不阻断启动。release 构建调此函数是无操作（返回 false）。
pub fn seed_dev_state_dir(data_dir: &Path) -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    seed_dev_state_dir_inner(data_dir)
}

/// `seed_dev_state_dir` 的可测试内核（去掉 `cfg!(debug_assertions)` 门）。
fn seed_dev_state_dir_inner(data_dir: &Path) -> bool {
    const DB: &str = "superagent.sqlite";
    let dev_db = data_dir.join("superagent-dev").join(DB);
    if dev_db.exists() {
        return false;
    }
    let prod_db = data_dir.join("superagent").join(DB);
    if !prod_db.is_file() {
        return false;
    }
    let dev_dir = data_dir.join("superagent-dev");
    if std::fs::create_dir_all(&dev_dir).is_err() {
        return false;
    }
    let mut copied = std::fs::copy(&prod_db, &dev_db).is_ok();
    for sidecar in ["-wal", "-shm"] {
        let mut src = prod_db.as_os_str().to_os_string();
        src.push(sidecar);
        let mut dst = dev_db.as_os_str().to_os_string();
        dst.push(sidecar);
        if Path::new(&src).is_file() {
            copied |= std::fs::copy(&src, &dst).is_ok();
        }
    }
    copied
}

/// unix socket 路径：`S/daemon.sock` 的字节长度 ≤ 100 时用它，
/// 否则用 `/tmp/omp-superagent-<uid>-<disc>/daemon.sock`（目录 0700，
/// `<disc>` 见 `fallback_socket_path`）。
pub fn socket_path(state: &Path) -> PathBuf {
    let inline = state.join("daemon.sock");
    if inline.as_os_str().as_encoded_bytes().len() <= SOCKET_INLINE_LIMIT {
        return inline;
    }
    fallback_socket_path(state)
}

/// 过长状态目录的短 socket 路径（目录按需创建为 0700）。
///
/// 按状态目录区分：目录名为 `omp-superagent-<uid>-<disc>`，其中 `<disc>`
/// 为 `sha256(state_dir)` 的前 8 位小写 hex。不同状态目录各用各的 socket：
/// debug（`superagent-dev`）与 release（`superagent`）不再抢同一个路径，
/// 否则后起的守护进程会以 exit 3 退出并报出误导性的锁冲突信息。
///
/// 若目录已存在但属主不是当前 uid、或组/其他用户可写，则拒绝使用并
/// 回退到 `std::env::temp_dir()` 下的同名目录（同样校验），避免经由
/// 他人可写的目录劫持 socket。
pub fn fallback_socket_path(state: &Path) -> PathBuf {
    // SAFETY：getuid 无副作用、无失败路径。
    let uid = unsafe { libc::getuid() };
    let name = format!("omp-superagent-{uid}-{}", fallback_disc(state));
    let primary = PathBuf::from(format!("/tmp/{name}"));
    if let Some(dir) = secure_socket_dir(&primary, uid) {
        return dir.join("daemon.sock");
    }
    let alt = std::env::temp_dir().join(&name);
    if alt != primary {
        if let Some(dir) = secure_socket_dir(&alt, uid) {
            return dir.join("daemon.sock");
        }
    }
    // 两个目录都不可用时仍返回主路径：`bind`/`connect` 会报出明确的
    // 系统错误，而不是静默用了一个不安全的目录。
    primary.join("daemon.sock")
}

/// fallback socket 目录名中的状态目录判别段：`sha256(state)` 前 8 位小写 hex。
fn fallback_disc(state: &Path) -> String {
    // hex 输出全为 ASCII，`[..8]` 按字节截断恒安全。
    format!("{:x}", Sha256::digest(state.as_os_str().as_encoded_bytes()))[..8].to_owned()
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

    /// RAII 环境变量覆盖：drop 时恢复旧值（无旧值则删除）。
    struct EnvOverride {
        key: &'static str,
        old: Option<std::ffi::OsString>,
    }
    impl EnvOverride {
        fn set(key: &'static str, value: &str) -> Self {
            let old = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, old }
        }
    }
    impl Drop for EnvOverride {
        fn drop(&mut self) {
            match &self.old {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn channel_and_override_pick_state_dir() {
        let _guard = crate::omp_cli::subprocess_test_guard();
        let _unset = EnvOverride::set(STATE_DIR_ENV, "");
        std::env::remove_var(STATE_DIR_ENV);
        let t = tempfile::tempdir().unwrap();
        assert_eq!(state_dir_for(t.path(), false), t.path().join("superagent"));
        assert_eq!(
            state_dir_for(t.path(), true),
            t.path().join("superagent-dev")
        );
        // 覆盖：绝对路径优先于通道默认；相对/空值忽略。
        let abs = t.path().join("custom-state");
        let _abs = EnvOverride::set(STATE_DIR_ENV, abs.to_str().unwrap());
        assert_eq!(state_dir_for(t.path(), false), abs);
        assert_eq!(state_dir_for(t.path(), true), abs);
        drop(_abs);
        let _rel = EnvOverride::set(STATE_DIR_ENV, "relative/path");
        assert_eq!(state_dir_for(t.path(), false), t.path().join("superagent"));
    }

    #[test]
    fn seed_copies_db_and_sidecars_once() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path();
        // 首次：生产库 + 双旁车 → 全拷进 superagent-dev/。
        std::fs::create_dir_all(data.join("superagent")).unwrap();
        std::fs::write(data.join("superagent/superagent.sqlite"), b"db").unwrap();
        std::fs::write(data.join("superagent/superagent.sqlite-wal"), b"wal").unwrap();
        std::fs::write(data.join("superagent/superagent.sqlite-shm"), b"shm").unwrap();
        assert!(seed_dev_state_dir_inner(data));
        assert_eq!(
            std::fs::read(data.join("superagent-dev/superagent.sqlite")).unwrap(),
            b"db"
        );
        assert_eq!(
            std::fs::read(data.join("superagent-dev/superagent.sqlite-wal")).unwrap(),
            b"wal"
        );
        assert_eq!(
            std::fs::read(data.join("superagent-dev/superagent.sqlite-shm")).unwrap(),
            b"shm"
        );
        // 生产库原样保留。
        assert_eq!(
            std::fs::read(data.join("superagent/superagent.sqlite")).unwrap(),
            b"db"
        );
        // 第二次：dev 库已存在，不再覆盖。
        std::fs::write(data.join("superagent/superagent.sqlite"), b"db2").unwrap();
        assert!(!seed_dev_state_dir_inner(data));
        assert_eq!(
            std::fs::read(data.join("superagent-dev/superagent.sqlite")).unwrap(),
            b"db"
        );
    }

    #[test]
    fn seed_skips_without_prod_db_or_sidecars() {
        // 无生产库：不建目录，不做任何事。
        let t = tempfile::tempdir().unwrap();
        assert!(!seed_dev_state_dir_inner(t.path()));
        assert!(!t.path().join("superagent-dev").exists());
        // 只有库、没有旁车：只拷库，不报错。
        std::fs::create_dir_all(t.path().join("superagent")).unwrap();
        std::fs::write(t.path().join("superagent/superagent.sqlite"), b"db").unwrap();
        assert!(seed_dev_state_dir_inner(t.path()));
        assert_eq!(
            std::fs::read(t.path().join("superagent-dev/superagent.sqlite")).unwrap(),
            b"db"
        );
        assert!(!t
            .path()
            .join("superagent-dev/superagent.sqlite-wal")
            .exists());
    }

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
            PathBuf::from(format!(
                "/tmp/omp-superagent-{uid}-{}/daemon.sock",
                fallback_disc(&state)
            ))
        );
    }

    #[test]
    fn different_state_dirs_get_different_fallbacks() {
        // debug（`superagent-dev`）与 release（`superagent`）状态目录的
        // fallback socket 互不相同：不再抢同一个路径。
        let data = Path::new("/Users/x/Library/Application Support/omp-resume");
        let dev = fallback_socket_path(&data.join("superagent-dev"));
        let rel = fallback_socket_path(&data.join("superagent"));
        assert_eq!(dev.file_name().unwrap(), "daemon.sock");
        assert_eq!(rel.file_name().unwrap(), "daemon.sock");
        assert_ne!(dev.parent(), rel.parent());
        // 同一状态目录判别段稳定：重复调用落在同一目录。
        assert_eq!(fallback_socket_path(&data.join("superagent")), rel);
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
        let t = tempfile::tempdir().unwrap();
        let sock = fallback_socket_path(&state_dir(t.path()));
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
