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
    /// 会话路径校验的额外根（如 Superagent 会话目录；扫描不看这里）。
    pub extra_roots: Vec<PathBuf>,
}

/// 解析配置：`--sessions-dir <p>` 参数 > `OMP_RESUME_SESSIONS_DIR` >
/// `$HOME/.omp/agent/sessions`；`ownersDir` 为 `OMP_RESUME_OWNERS_DIR` >
/// `$HOME/.omp/run/session-owners`；`extra_roots` 为 Superagent 会话目录
/// `<state>/sessions`，其中 `state` 与 supervisor 同规则（见
/// `superagent::paths::state_dir_for_with_override`）：`env` 闭包提供的
/// `OMP_RESUME_SUPERAGENT_STATE_DIR` 覆盖（绝对路径）优先，否则 debug 构建
/// 用 `<data_dir>/superagent-dev`、release 用 `<data_dir>/superagent`
/// （`data_dir` 与 `meta::data_dir` 同口径）。
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
    let data_dir = env("OMP_RESUME_DATA_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("Library/Application Support/omp-resume"));
    // 状态目录覆盖经可注入的 `env` 闭包读取（不碰真实进程环境）：与
    // supervisor 同源，单测无需串行化即可覆盖各分支。
    let override_dir = env(crate::superagent::paths::STATE_DIR_ENV).map(PathBuf::from);
    Config {
        sessions_dir,
        owners_dir,
        extra_roots: vec![crate::superagent::paths::state_dir_for_with_override(
            &data_dir,
            cfg!(debug_assertions),
            override_dir.as_deref(),
        )
        .join("sessions")],
    }
}

/// 生产入口：从真实进程环境解析。
pub fn resolve(sessions_dir_arg: Option<String>) -> Config {
    let home = crate::util::home_dir();
    resolve_with(sessions_dir_arg, |k| std::env::var(k).ok(), &home)
}

/// 校验会话路径（CONTRACT §6）：
/// 绝对路径 → canonicalize（含符号链接）→ 必须位于 sessionsDir 或任一
/// extra_root 下、且相对部分恰为 `<dir>/<file>.jsonl`、文件名非点文件。
/// extra root canonicalize 失败就跳过；都不满足时：sessionsDir 自身不可
/// 用报原来的 `IO` 错误，否则报 `OUTSIDE_ROOT`。
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
    let mut roots: Vec<PathBuf> = Vec::with_capacity(cfg.extra_roots.len() + 1);
    roots.push(root);
    for extra in &cfg.extra_roots {
        if let Ok(canon_extra) = std::fs::canonicalize(extra) {
            roots.push(canon_extra);
        }
    }
    let Some(rel) = roots.iter().find_map(|root| canon.strip_prefix(root).ok()) else {
        return Err(AppError::new(
            ErrorCode::OutsideRoot,
            format!("会话路径不在根目录内：{path}"),
        ));
    };
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
            extra_roots: vec![],
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

    #[test]
    fn resolve_sets_superagent_extra_root() {
        // `cargo test` 开 debug_assertions：默认进 `superagent-dev` 通道。
        let home = Path::new("/home/u");
        let c = resolve_with(None, env_of(HashMap::new()), home);
        let channel = if cfg!(debug_assertions) {
            "superagent-dev"
        } else {
            "superagent"
        };
        assert_eq!(
            c.extra_roots,
            vec![home
                .join("Library/Application Support/omp-resume")
                .join(channel)
                .join("sessions")]
        );
        let mut m = HashMap::new();
        m.insert("OMP_RESUME_DATA_DIR".into(), "/d".into());
        let c = resolve_with(None, env_of(m), home);
        assert_eq!(
            c.extra_roots,
            vec![PathBuf::from(format!("/d/{channel}/sessions"))]
        );
    }

    #[test]
    fn extra_root_follows_state_dir_channels() {
        // 与 supervisor 共用的通道规则：dev → `superagent-dev`，release →
        // `superagent`（release 路径与改动前字节一致）；经可注入内核断言，
        // 不依赖当前构建的 `cfg!(debug_assertions)`。
        use crate::superagent::paths::state_dir_for_with_override;
        let data = Path::new("/d");
        assert_eq!(
            state_dir_for_with_override(data, false, None).join("sessions"),
            PathBuf::from("/d/superagent/sessions")
        );
        assert_eq!(
            state_dir_for_with_override(data, true, None).join("sessions"),
            PathBuf::from("/d/superagent-dev/sessions")
        );
    }

    #[test]
    fn extra_root_override_wins_over_channel() {
        // `OMP_RESUME_SUPERAGENT_STATE_DIR` 覆盖经可注入 `env` 闭包生效，
        // 任意通道下都优先（绝对路径）；相对/空值忽略、回通道默认。
        let home = Path::new("/home/u");
        for (value, expected) in [
            ("/custom/state", "/custom/state/sessions"),
            ("relative/path", "CHANNEL"),
            ("", "CHANNEL"),
        ] {
            let mut m = HashMap::new();
            m.insert("OMP_RESUME_DATA_DIR".into(), "/d".into());
            m.insert(crate::superagent::paths::STATE_DIR_ENV.into(), value.into());
            let c = resolve_with(None, env_of(m), home);
            let expected = if expected == "CHANNEL" {
                let channel = if cfg!(debug_assertions) {
                    "superagent-dev"
                } else {
                    "superagent"
                };
                PathBuf::from(format!("/d/{channel}/sessions"))
            } else {
                PathBuf::from(expected)
            };
            assert_eq!(c.extra_roots, vec![expected], "override={value:?}");
        }
    }

    // 仅 debug 构建断言 dev 通道（release 下 `resolve_with` 进 release 通道）。
    #[cfg(debug_assertions)]
    #[test]
    fn validate_accepts_debug_channel_extra_root() {
        // 端到端：debug 通道 extra root 下的 `.jsonl` 通过校验
        // （此前硬编码 release 目录时此类路径报 OUTSIDE_ROOT）。
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        let sessions = t.path().join("sessions");
        std::fs::create_dir_all(sessions.join("proj")).unwrap();
        let dev_sessions = data.join("superagent-dev/sessions");
        std::fs::create_dir_all(dev_sessions.join("main")).unwrap();
        let f = dev_sessions.join("main").join("x.jsonl");
        std::fs::write(&f, "{}\n").unwrap();
        let mut m = HashMap::new();
        m.insert("OMP_RESUME_DATA_DIR".into(), data.to_str().unwrap().into());
        m.insert(
            "OMP_RESUME_SESSIONS_DIR".into(),
            sessions.to_str().unwrap().into(),
        );
        let c = resolve_with(None, env_of(m), t.path());
        assert_eq!(c.extra_roots, vec![dev_sessions.clone()]);
        let got = validate_session_path(&c, f.to_str().unwrap()).unwrap();
        assert_eq!(got, std::fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn validate_accepts_extra_root_two_levels() {
        let t = tempfile::tempdir().unwrap();
        let sessions = t.path().join("sessions");
        let extra = t.path().join("extra");
        std::fs::create_dir_all(sessions.join("proj")).unwrap();
        std::fs::create_dir_all(extra.join("main")).unwrap();
        let f = extra.join("main").join("x.jsonl");
        std::fs::write(&f, "{}\n").unwrap();
        let c = Config {
            sessions_dir: sessions,
            owners_dir: t.path().join("owners"),
            extra_roots: vec![extra],
        };
        let got = validate_session_path(&c, f.to_str().unwrap()).unwrap();
        assert_eq!(got, std::fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn validate_rejects_extra_root_three_levels() {
        let t = tempfile::tempdir().unwrap();
        let sessions = t.path().join("sessions");
        let extra = t.path().join("extra");
        std::fs::create_dir_all(sessions.join("proj")).unwrap();
        std::fs::create_dir_all(extra.join("main").join("sub")).unwrap();
        let f = extra.join("main").join("sub").join("x.jsonl");
        std::fs::write(&f, "{}\n").unwrap();
        let c = Config {
            sessions_dir: sessions,
            owners_dir: t.path().join("owners"),
            extra_roots: vec![extra],
        };
        let err = validate_session_path(&c, f.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, ErrorCode::OutsideRoot);
    }
}
