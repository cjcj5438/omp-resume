//! 会话删除原语：镜像 omp 的 `deleteSessionWithArtifacts`。
//!
//! omp 上游实现（`packages/coding-agent/src/session/session-storage.ts`，
//! 已从 `~/.local/bin/omp` 二进制字符串中核对逻辑）―
//! ```js
//! async deleteSessionWithArtifacts(r) {
//!   await this.unlink(r);                       // 1. 先删 .jsonl，失败直接抛
//!   const i = r.slice(0, -6);                   // 2. 同 stem sibling（去 ".jsonl"）
//!   try { await Je.rm(i, { recursive: true, force: true }); }
//!   catch (u) { throw new Error(
//!     `Session file deleted but failed to remove artifacts directory ${i}: ...`); }
//!   const s = Se.basename(r);                   // 3. 同目录下 `<base>.` 开头的 *.bak
//!   for (const u of this.listFilesSync(Se.dirname(r), "*.bak")) {
//!     if (!Se.basename(u).startsWith(`${s}.`)) continue;
//!     try { await Je.unlink(u); }               //    单个失败只告警，不回滚
//!     catch (f) { o("Failed to remove stale session backup during delete", ...); }
//!   }
//! }
//! ```
//!
//! 与上游的两处有意差异（更保守，见 CONTRACT §4.6 的"只删三样"精神）：
//! - sibling 若是**符号链接**：只删除链接本身，绝不跟随递归（上游 `rm -r`
//!   语义在 macOS 上跟随链接会误删链接目标；见单测 `symlinked_sibling_dir`）。
//! - sibling 若是普通文件（非目录非链接）：保持不动（上游 `rm -rf` 会删掉它）。
//!   只有"真实目录"才会被 `remove_dir_all`。

use std::io::ErrorKind;
use std::path::Path;

use crate::model::{AppError, ErrorCode};

/// 删除结果：只有 best-effort 的 `.bak` 清理会产生"软失败"记录。
#[derive(Debug, Clone, Default)]
pub struct DeleteReport {
    /// 删除失败的 `.bak` 文件绝对路径（已尽力，不影响整体成功）。
    pub bak_failed: Vec<String>,
}

/// 删除一个会话文件及其附属物（见模块文档）。
///
/// 调用方已做路径校验与占用探测；此处只做廉价自卫：
/// 路径必须以小写 `.jsonl` 结尾且为已存在的常规文件，否则拒绝。
pub fn delete_session_files(session_path: &Path) -> Result<DeleteReport, AppError> {
    let is_jsonl = session_path
        .extension()
        .is_some_and(|ext| ext == "jsonl");
    if !is_jsonl {
        return Err(AppError::new(
            ErrorCode::Io,
            format!("拒绝删除：不是 .jsonl 会话文件：{}", session_path.display()),
        ));
    }
    match std::fs::metadata(session_path) {
        Ok(md) if md.is_file() => {}
        Ok(_) => {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("拒绝删除：不是常规文件：{}", session_path.display()),
            ));
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(AppError::new(
                ErrorCode::NotFound,
                format!("会话文件不存在：{}", session_path.display()),
            ));
        }
        Err(e) => {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("无法访问会话文件 {}：{e}", session_path.display()),
            ));
        }
    }

    // 1. 先删 .jsonl：失败则什么都不再碰。
    if let Err(e) = std::fs::remove_file(session_path) {
        if e.kind() == ErrorKind::NotFound {
            return Err(AppError::new(
                ErrorCode::NotFound,
                format!("会话文件不存在：{}", session_path.display()),
            ));
        }
        return Err(AppError::new(
            ErrorCode::Io,
            format!("删除会话文件 {} 失败：{e}", session_path.display()),
        ));
    }

    // 2. 同 stem sibling 目录（`<x>.jsonl` → 旁边的 `<x>`）。
    let parent = session_path.parent().ok_or_else(|| {
        AppError::new(
            ErrorCode::Io,
            format!("会话路径没有父目录：{}", session_path.display()),
        )
    })?;
    let stem = session_path.file_stem().ok_or_else(|| {
        AppError::new(
            ErrorCode::Io,
            format!("会话路径没有文件名：{}", session_path.display()),
        )
    })?;
    let sibling = parent.join(stem);
    match std::fs::symlink_metadata(&sibling) {
        Err(e) if e.kind() == ErrorKind::NotFound => {} // 不存在视为成功
        Err(e) => return Err(sibling_failed(&sibling, &e.to_string())),
        Ok(md) if md.file_type().is_symlink() => {
            // 只删链接本身，绝不跟随。
            if let Err(e) = std::fs::remove_file(&sibling) {
                if e.kind() != ErrorKind::NotFound {
                    return Err(sibling_failed(&sibling, &e.to_string()));
                }
            }
        }
        Ok(md) if md.is_dir() => {
            if let Err(e) = std::fs::remove_dir_all(&sibling) {
                return Err(sibling_failed(&sibling, &e.to_string()));
            }
        }
        Ok(_) => {
            // sibling 是普通文件或其他：不动（比上游 rm -rf 更保守）。
        }
    }

    // 3. `<x>.jsonl.<anything>.bak`（与上游一致：`*.bak` + 前缀匹配），
    //    best-effort：单个失败只记录。
    let mut report = DeleteReport::default();
    if let (Some(file_name), Ok(entries)) = (
        session_path.file_name().map(|s| s.to_string_lossy()),
        std::fs::read_dir(parent),
    ) {
        let prefix = format!("{file_name}.");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(prefix.as_str()) && name.ends_with(".bak") {
                let bak_path = entry.path();
                if std::fs::remove_file(&bak_path).is_err() {
                    report.bak_failed.push(bak_path.display().to_string());
                }
            }
        }
    }
    Ok(report)
}

fn sibling_failed(sibling: &Path, detail: &str) -> AppError {
    AppError::new(
        ErrorCode::Io,
        format!(
            "会话文件已删除但附属目录清理失败 {}：{detail}",
            sibling.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_dir(name: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "omp-resume-ops-delete-{}-{}-{}",
            std::process::id(),
            n,
            name
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    /// 建一个完整会话树：jsonl + 含嵌套子 agent jsonl 的 sibling 目录
    /// + .bak + 点锁文件 + 前缀碰撞邻居。
    fn full_tree(root: &Path) -> std::path::PathBuf {
        let session = root.join("2026-10-14T02-18-47-387Z_abc123.jsonl");
        write_file(&session, "{\"type\":\"session\",\"version\":3}\n");
        write_file(&root.join("abc-sibling-placeholder"), "x");
        let sib = root.join("2026-10-14T02-18-47-387Z_abc123");
        write_file(&sib.join("artifact.txt"), "blob");
        write_file(&sib.join("sub").join("nested.jsonl"), "{}\n");
        write_file(
            &root.join("2026-10-14T02-18-47-387Z_abc123.jsonl.12345.bak"),
            "bak",
        );
        write_file(
            &root.join(".2026-10-14T02-18-47-387Z_abc123.jsonl.lock.os"),
            "lock",
        );
        // 前缀碰撞：stem 仅以同前缀开头，但不是同一会话。
        write_file(
            &root.join("2026-10-14T02-18-47-387Z_abc1234.jsonl"),
            "{}\n",
        );
        write_file(&root.join("2026-10-14T02-18-47-387Z_abc1234").join("keep.txt"), "k");
        write_file(&root.join("other.jsonl.9.bak"), "unrelated");
        session
    }

    #[test]
    fn full_tree_deleted_and_neighbors_survive() {
        let root = test_dir("full");
        let session = full_tree(&root);
        let report = delete_session_files(&session).unwrap();
        assert!(report.bak_failed.is_empty(), "{report:?}");

        assert!(!session.exists(), "jsonl 应被删除");
        assert!(
            !root.join("2026-10-14T02-18-47-387Z_abc123").exists(),
            "sibling 目录应被递归删除"
        );
        assert!(
            !root
                .join("2026-10-14T02-18-47-387Z_abc123.jsonl.12345.bak")
                .exists(),
            ".bak 应被清理"
        );
        // 不该碰的东西：
        assert!(
            root.join(".2026-10-14T02-18-47-387Z_abc123.jsonl.lock.os")
                .exists(),
            "点锁文件必须保留"
        );
        assert!(
            root.join("2026-10-14T02-18-47-387Z_abc1234.jsonl").exists(),
            "前缀碰撞的会话文件必须保留"
        );
        assert!(
            root.join("2026-10-14T02-18-47-387Z_abc1234")
                .join("keep.txt")
                .exists(),
            "前缀碰撞的 sibling 目录必须保留"
        );
        assert!(root.join("other.jsonl.9.bak").exists(), "无关 .bak 必须保留");
        assert!(root.join("abc-sibling-placeholder").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_sibling_dir_is_fine() {
        let root = test_dir("nosib");
        let session = root.join("a.jsonl");
        write_file(&session, "{}\n");
        let report = delete_session_files(&session).unwrap();
        assert!(report.bak_failed.is_empty());
        assert!(!session.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn symlinked_sibling_dir_removes_link_only() {
        let root = test_dir("symlink");
        let session = root.join("victim.jsonl");
        write_file(&session, "{}\n");
        let victim = root.join("real-victim-dir");
        write_file(&victim.join("precious.txt"), "do not delete");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, root.join("victim")).unwrap();

        let report = delete_session_files(&session).unwrap();
        assert!(report.bak_failed.is_empty());
        assert!(!session.exists());
        assert!(
            !root.join("victim").exists() && std::fs::symlink_metadata(root.join("victim")).is_err(),
            "符号链接本身应被删除"
        );
        assert!(
            victim.join("precious.txt").exists(),
            "链接目标目录必须完好"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sibling_file_not_dir_is_left_alone() {
        let root = test_dir("sibfile");
        let session = root.join("a.jsonl");
        write_file(&session, "{}\n");
        write_file(&root.join("a"), "i am a file, not a dir");
        delete_session_files(&session).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a")).unwrap(), "i am a file, not a dir");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn non_jsonl_path_refused() {
        let root = test_dir("nonjsonl");
        let p = root.join("a.txt");
        write_file(&p, "hello");
        let err = delete_session_files(&p).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert!(p.exists(), "拒绝删除时文件必须保留");
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn directory_path_refused() {
        let root = test_dir("dirpath");
        // 真实目录但以 .jsonl 结尾 → IO 拒绝，且目录保留。
        let d = root.join("d.jsonl");
        std::fs::create_dir_all(&d).unwrap();
        let err = delete_session_files(&d).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert!(d.is_dir(), "目录必须保留");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bak_best_effort_records_failures() {
        let root = test_dir("bakfail");
        let session = root.join("a.jsonl");
        write_file(&session, "{}\n");
        // 把 .bak 做成一个非空目录：remove_file 对目录必失败 → 只记录，不抛错。
        let bak_dir = root.join("a.jsonl.1.bak");
        write_file(&bak_dir.join("inner.txt"), "x");
        let report = delete_session_files(&session).unwrap();
        assert!(!session.exists());
        assert_eq!(report.bak_failed.len(), 1, "{report:?}");
        assert!(report.bak_failed[0].ends_with("a.jsonl.1.bak"));
        assert!(bak_dir.join("inner.txt").exists(), "删不掉的 .bak 必须原样保留");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn nonexistent_file_is_not_found() {
        let root = test_dir("missing");
        let err = delete_session_files(&root.join("nope.jsonl")).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(unix)] // 依赖 unix 权限位
    fn sibling_cleanup_failure_reports_chinese_message() {
        use std::os::unix::fs::PermissionsExt;
        let root = test_dir("sibfail");
        let session = root.join("a.jsonl");
        write_file(&session, "{}\n");
        let sib = root.join("a");
        write_file(&sib.join("child.txt"), "c");
        // 拿掉 sibling 目录写权限 → remove_dir_all 失败。
        std::fs::set_permissions(&sib, std::fs::Permissions::from_mode(0o555)).unwrap();
        let err = delete_session_files(&session).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert!(
            err.message.contains("会话文件已删除但附属目录清理失败"),
            "unexpected message: {}",
            err.message
        );
        assert!(!session.exists(), "jsonl 此时已被删除（与 omp 一致）");
        // 恢复权限以便清理。
        std::fs::set_permissions(&sib, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
