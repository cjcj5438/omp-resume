//! Superagent：守护进程托管、IPC 命令与代理（见计划 §8）。
//!
//! 模块布局：
//! - `settings`：`<data_dir>/superagent.json` 启用开关
//! - `paths`：状态目录 / socket / 日志 / 资源目录
//! - `proxy`：经 unix socket 的最小 HTTP/1.1 客户端
//! - `supervisor`：守护进程监管器（Tauri 全局单例）
//!
//! 5 个命令（CONTRACT §4.74–§4.78）：`superagent_status`、
//! `superagent_set_enabled`、`superagent_restart`、`superagent_request`、
//! `superagent_log_tail`。

pub mod paths;
pub mod proxy;
pub mod settings;
pub mod supervisor;

use crate::model::{
    AppError, AppResult, ErrorCode, SuperagentResponse, SuperagentState, SuperagentStatus,
};

/// 当前托管状态快照。
#[tauri::command]
pub async fn superagent_status(
    supervisor: tauri::State<'_, supervisor::Supervisor>,
) -> AppResult<SuperagentStatus> {
    let supervisor = supervisor.inner().clone();
    crate::blocking(move || Ok(supervisor.status())).await
}

/// 启用/停用守护进程，返回新状态。
#[tauri::command]
pub async fn superagent_set_enabled(
    supervisor: tauri::State<'_, supervisor::Supervisor>,
    enabled: bool,
) -> AppResult<SuperagentStatus> {
    let supervisor = supervisor.inner().clone();
    crate::blocking(move || supervisor.set_enabled(enabled)).await
}

/// 重启守护进程（未启用时拒绝），返回新状态。
#[tauri::command]
pub async fn superagent_restart(
    supervisor: tauri::State<'_, supervisor::Supervisor>,
) -> AppResult<SuperagentStatus> {
    let supervisor = supervisor.inner().clone();
    crate::blocking(move || supervisor.restart()).await
}

/// 经守护进程 socket 转发 API 请求。守护进程非 `Running` 时直接
/// 返回 `SUPERAGENT_UNAVAILABLE`，不尝试连接。
#[tauri::command]
pub async fn superagent_request(
    supervisor: tauri::State<'_, supervisor::Supervisor>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> AppResult<SuperagentResponse> {
    let supervisor = supervisor.inner().clone();
    crate::blocking(move || {
        let status = supervisor.status();
        if !matches!(status.state, SuperagentState::Running) {
            return Err(AppError::new(
                ErrorCode::SuperagentUnavailable,
                "Superagent 守护进程未运行",
            ));
        }
        let timeout = if method == "GET" {
            proxy::GET_TIMEOUT
        } else {
            proxy::MUTATE_TIMEOUT
        };
        let socket = std::path::PathBuf::from(&status.socket_path);
        let (code, text) = proxy::request(&socket, &method, &path, body.as_ref(), timeout)?;
        Ok(SuperagentResponse {
            status: code,
            body: text,
        })
    })
    .await
}

/// 读取守护进程日志最后 `lines` 行（1..=2000）；文件不存在时返回空列表。
#[tauri::command]
pub async fn superagent_log_tail(
    supervisor: tauri::State<'_, supervisor::Supervisor>,
    lines: u32,
) -> AppResult<Vec<String>> {
    if !(1..=2000).contains(&lines) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "日志行数必须在 1 到 2000 之间",
        ));
    }
    let supervisor = supervisor.inner().clone();
    crate::blocking(move || {
        let status = supervisor.status();
        let lines = usize::try_from(lines).unwrap_or(usize::MAX);
        read_last_lines(std::path::Path::new(&status.log_path), lines)
    })
    .await
}

/// 从后往前读文件的最后 `n` 行：按 64 KiB 块倒序扫描换行符，只在尾部
/// 数据不足时继续向前，最多读到文件头。非 UTF-8 字节宽松解码（`lossy`），
/// 文件不存在返回空列表。
fn read_last_lines(path: &std::path::Path, n: usize) -> AppResult<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("无法读取 Superagent 日志：{e}"),
            ))
        }
    };
    let size = file
        .metadata()
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法读取 Superagent 日志：{e}")))?
        .len();
    // 块倒序扫描：每块 64 KiB，从文件尾向前收集，直到换行符数量足够
    // 覆盖 `n` 行（末尾换行不产生空行），或已到文件头。
    const CHUNK: u64 = 64 * 1024;
    let mut buf = Vec::new();
    let mut pos = size;
    let mut newlines = 0usize;
    // 需要 `n` 个换行才能确定切出 `n` 行（末尾无换行时行数 = 换行数 + 1）。
    let want = n.saturating_add(1);
    while pos > 0 && newlines < want {
        let take = CHUNK.min(pos);
        pos -= take;
        file.seek(SeekFrom::Start(pos))
            .map_err(|e| AppError::new(ErrorCode::Io, format!("无法读取 Superagent 日志：{e}")))?;
        let mut chunk = vec![0u8; usize::try_from(take).unwrap_or(usize::MAX)];
        file.read_exact(&mut chunk)
            .map_err(|e| AppError::new(ErrorCode::Io, format!("无法读取 Superagent 日志：{e}")))?;
        newlines += chunk.iter().filter(|&&b| b == b'\n').count();
        // 前置拼接：新读到的块在更前的位置。
        let mut head = std::mem::take(&mut buf);
        buf = chunk;
        buf.append(&mut head);
    }
    // 末尾换行不计为空行：与 `str::lines` 口径一致。
    if buf.last() == Some(&b'\n') {
        buf.pop();
        // `\r\n` 结尾时顺手去掉 `\r`（`lines()` 同样会去）。
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let all: Vec<&str> = text.split('\n').collect();
    // `split` 保留 `\r` 后缀（`lines` 会去）；逐行去尾 `\r` 以对齐口径。
    let take = n.min(all.len());
    Ok(all[all.len() - take..]
        .iter()
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::read_last_lines;

    #[test]
    fn tail_reads_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        std::fs::write(&path, "a\nb\nc\nd\ne\n").unwrap();
        assert_eq!(read_last_lines(&path, 2).unwrap(), vec!["d", "e"]);
        assert_eq!(
            read_last_lines(&path, 99).unwrap(),
            vec!["a", "b", "c", "d", "e"]
        );
    }

    #[test]
    fn tail_without_trailing_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        std::fs::write(&path, "a\nb\nc").unwrap();
        assert_eq!(read_last_lines(&path, 2).unwrap(), vec!["b", "c"]);
    }

    #[test]
    fn tail_handles_crlf_and_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        std::fs::write(&path, b"a\r\nb\xffc\r\nd\n").unwrap();
        assert_eq!(
            read_last_lines(&path, 2).unwrap(),
            vec!["b�c".to_string(), "d".to_string()]
        );
    }

    #[test]
    fn tail_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let got = read_last_lines(&dir.path().join("nope.log"), 10).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn tail_scans_across_chunks() {
        // 文件 > 64 KiB：倒序多块扫描仍只返回最后 N 行。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let mut content = String::new();
        for i in 0..6000 {
            content.push_str(&format!("line-{i:05}-0123456789abcdef\n"));
        }
        std::fs::write(&path, &content).unwrap();
        assert!(content.len() > 64 * 1024);
        let got = read_last_lines(&path, 3).unwrap();
        assert_eq!(
            got,
            vec![
                "line-05997-0123456789abcdef",
                "line-05998-0123456789abcdef",
                "line-05999-0123456789abcdef",
            ]
        );
    }
}
