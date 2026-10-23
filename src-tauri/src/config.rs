//! 配置解析（CONTRACT §1）与会话路径校验（CONTRACT §6）。
//!
//! 不依赖 Tauri：`resolve_with` 接受显式环境读取函数，便于单测。

use std::path::{Path, PathBuf};

use crate::model::{AppError, ErrorCode};

/// 解析后的实际目录。
#[derive(Debug, Clone)]
pub struct Config {
    pub sessions_dir: PathBuf,
    pub owners_dir: PathBuf,
}

/// 解析配置：`--sessions-dir <p>` 参数 > `OMP_RESUME_SESSIONS_DIR` >
/// `$HOME/.omp/agent/sessions`；`ownersDir` 为 `OMP_RESUME_OWNERS_DIR` >
/// `$HOME/.omp/run/session-owners`。
pub fn resolve_with(
    sessions_dir_arg: Option<String>,
    env: impl Fn(&str) -> Option<String>,
    home: &Path,
) -> Config {
    let sessions_dir = sessions_dir_arg
        .map(PathBuf::from)
        .or_else(|| env("OMP_RESUME_SESSIONS_DIR").map(PathBuf::from))
        .unwrap_or_else(|| home.join(".omp/agent/sessions"));
    let owners_dir = env("OMP_RESUME_OWNERS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".omp/run/session-owners"));
    Config {
        sessions_dir,
        owners_dir,
    }
}

/// 生产入口：从真实进程环境解析。
pub fn resolve(sessions_dir_arg: Option<String>) -> Config {
    let home = crate::util::home_dir();
    resolve_with(sessions_dir_arg, |k| std::env::var(k).ok(), &home)
}

/// 校验会话路径（CONTRACT §6）：
/// 绝对路径 → canonicalize（含符号链接）→ 必须位于 sessionsDir 下、
/// 且相对部分恰为 `<dir>/<file>.jsonl`、文件名非点文件。
/// 不存在 → `NOT_FOUND`；形状非法/逃出 → `OUTSIDE_ROOT`。
pub fn validate_session_path(cfg: &Config, path: &str) -> Result<PathBuf, AppError> {
    let input = Path::new(path);
    if !input.is_absolute() {
        return Err(AppError::new(
            ErrorCode::OutsideRoot,
            format!("会话路径必须为绝对路径：{path}"),
        ));
    }
    let canon = std::fs::canonicalize(input).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new(ErrorCode::NotFound, format!("会话文件不存在：{path}"))
        } else {
            AppError::new(ErrorCode::Io, format!("无法解析会话路径 {path}：{e}"))
        }
    })?;
    let root = std::fs::canonicalize(&cfg.sessions_dir).map_err(|e| {
        AppError::new(
            ErrorCode::Io,
            format!("会话根目录不可用：{}：{e}", cfg.sessions_dir.display()),
        )
    })?;
    let rel = canon.strip_prefix(&root).map_err(|_| {
        AppError::new(
            ErrorCode::OutsideRoot,
            format!("会话路径不在根目录内：{path}"),
        )
    })?;
    let rel_parts: Vec<_> = rel.components().collect();
    let [dir, file] = rel_parts.as_slice() else {
        return Err(AppError::new(
            ErrorCode::OutsideRoot,
            format!("会话路径必须为 <项目>/<文件>.jsonl：{path}"),
        ));
    };
    // 项目目录本身也不得是点目录（`--sessions-dir` 下的编码 cwd 恒以 `-` 开头，
    // 点目录只可能是锁文件残留或手工构造；保守拒绝）。
    let dir_name = dir.as_os_str().to_string_lossy();
    if dir_name.starts_with('.') || dir_name.is_empty() {
        return Err(AppError::new(
            ErrorCode::OutsideRoot,
            format!("非法会话路径（项目目录）：{path}"),
        ));
    }
    let file_name = file.as_os_str().to_string_lossy();
    if !file_name.ends_with(".jsonl")
        || file_name.starts_with('.')
        || file_name.len() <= ".jsonl".len()
    {
        return Err(AppError::new(
            ErrorCode::OutsideRoot,
            format!("非法会话文件名：{path}"),
        ));
    }
    // `x.jsonl` 命名的目录（或 FIFO/socket/设备）不得通过校验：
    // 调用方只应读写常规文件；目录在此直接拒绝，避免下游以 PROBE_FAILED
    // 等间接错误码兜底（见 safety 集成测试）。
    match std::fs::metadata(&canon) {
        Ok(md) if md.is_file() => {}
        Ok(_) => {
            return Err(AppError::new(
                ErrorCode::OutsideRoot,
                format!("非法会话路径（不是常规文件）：{path}"),
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // canonicalize 已成功却取不到 metadata：竞态删除，视为不存在。
            return Err(AppError::new(
                ErrorCode::NotFound,
                format!("会话文件不存在：{path}"),
            ));
        }
        Err(e) => {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("无法访问会话路径 {path}：{e}"),
            ));
        }
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(dir: &Path) -> Config {
        Config {
            sessions_dir: dir.to_path_buf(),
            owners_dir: dir.join("owners"),
        }
    }

    fn env_of(map: HashMap<String, String>) -> impl Fn(&str) -> Option<String> {
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn resolve_priority_arg_over_env_over_default() {
        let home = Path::new("/home/u");
        let empty = HashMap::new();
        let c = resolve_with(None, env_of(empty), home);
        assert_eq!(c.sessions_dir, Path::new("/home/u/.omp/agent/sessions"));
        assert_eq!(c.owners_dir, Path::new("/home/u/.omp/run/session-owners"));

        let mut m = HashMap::new();
        m.insert("OMP_RESUME_SESSIONS_DIR".into(), "/e/s".into());
        m.insert("OMP_RESUME_OWNERS_DIR".into(), "/e/o".into());
        let c = resolve_with(None, env_of(m.clone()), home);
        assert_eq!(c.sessions_dir, Path::new("/e/s"));
        assert_eq!(c.owners_dir, Path::new("/e/o"));

        let c = resolve_with(Some("/a/s".into()), env_of(m), home);
        assert_eq!(c.sessions_dir, Path::new("/a/s"));
    }

    #[test]
    fn validate_accepts_top_level_jsonl() {
        let t = tempfile::tempdir().unwrap();
        let proj = t.path().join("proj");
        std::fs::create_dir(&proj).unwrap();
        let f = proj.join("a.jsonl");
        std::fs::write(&f, "{}\n").unwrap();
        let got = validate_session_path(&cfg(t.path()), f.to_str().unwrap()).unwrap();
        assert_eq!(got, std::fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn validate_rejects_shapes() {
        let t = tempfile::tempdir().unwrap();
        let c = cfg(t.path());
        // 相对路径
        assert!(matches!(
            validate_session_path(&c, "proj/a.jsonl").unwrap_err().code,
            ErrorCode::OutsideRoot
        ));
        // 不存在
        assert!(matches!(
            validate_session_path(&c, t.path().join("p/a.jsonl").to_str().unwrap())
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        ));
    }

    #[test]
    fn validate_rejects_dotfile_nested_and_escape() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir(t.path().join("p")).unwrap();
        std::fs::create_dir_all(t.path().join("p/nested")).unwrap();
        std::fs::write(t.path().join("p/.a.jsonl.lock.os"), "x").unwrap();
        std::fs::write(t.path().join("p/nested/a.jsonl"), "x").unwrap();
        std::fs::write(t.path().join("p/a.bak"), "x").unwrap();
        std::fs::write(t.path().join("outside.jsonl"), "x").unwrap();
        let c = cfg(t.path());
        for p in [
            t.path().join("p/.a.jsonl.lock.os"),
            t.path().join("p/nested/a.jsonl"),
            t.path().join("p/a.bak"),
            t.path().join("outside.jsonl"),
        ] {
            let err = validate_session_path(&c, p.to_str().unwrap()).unwrap_err();
            assert_eq!(err.code, ErrorCode::OutsideRoot, "path: {p:?}");
        }
        // `..` 逃逸
        let evil = t.path().join("p/../outside.jsonl");
        let err = validate_session_path(&c, evil.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, ErrorCode::OutsideRoot);
    }

    #[cfg(unix)]
    #[test]
    fn validate_rejects_symlink_escape() {
        let t = tempfile::tempdir().unwrap();
        let out = t.path().join("out");
        std::fs::create_dir(&out).unwrap();
        std::fs::write(out.join("real.jsonl"), "x").unwrap();
        std::os::unix::fs::symlink(out.join("real.jsonl"), t.path().join("p-link.jsonl")).unwrap();
        // 顶层 symlink 本身指向根外文件 → canonicalize 后前缀不符
        let root = t.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let c = cfg(&root);
        let err =
            validate_session_path(&c, t.path().join("p-link.jsonl").to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, ErrorCode::OutsideRoot);
    }
}
