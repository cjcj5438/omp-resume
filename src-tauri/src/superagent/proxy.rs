//! Superagent 守护进程代理：经 unix socket 转发 HTTP 请求。
//!
//! 只做最小 HTTP/1.1 客户端：手拼请求行与头部，读到 EOF 后在 `\r\n\r\n`
//! 处切开头部与正文。socket 文件权限 0600 即访问边界，不做同源检查。

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use crate::model::{AppError, ErrorCode};

/// 响应体上限 32 MiB。
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// API 路径长度上限。
const MAX_PATH_LEN: usize = 2048;

/// API 前缀（不含首尾斜杠，由调用方传入的 `path` 拼接）。
const API_PREFIX: &str = "/orchestrator/api/";

/// GET 请求超时。
pub const GET_TIMEOUT: Duration = Duration::from_secs(30);
/// 非 GET 请求超时。
pub const MUTATE_TIMEOUT: Duration = Duration::from_secs(120);
/// 就绪探测单次超时。
pub const READY_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

fn invalid_input(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn unavailable(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::SuperagentUnavailable, message)
}

/// 经 `socket` 向守护进程发请求，返回 `(状态码, 正文)`。
///
/// - `method` 必须为 GET/POST/PUT；`path` 为 `orchestrator/api/` 后的相对路径。
/// - socket 不存在或拒绝连接、读写超时 → `SUPERAGENT_UNAVAILABLE`。
/// - 响应超过 32 MiB → `IO`。
pub fn request(
    socket: &Path,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
    timeout: Duration,
) -> Result<(u16, String), AppError> {
    if !matches!(method, "GET" | "POST" | "PUT") {
        return Err(invalid_input(format!("不支持的请求方法：{method}")));
    }
    validate_path(path)?;

    let mut stream = UnixStream::connect(socket)
        .map_err(|_| unavailable(format!("Superagent 守护进程未运行（{}）", socket.display())))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法设置 socket 读超时：{e}")))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法设置 socket 写超时：{e}")))?;

    let body_bytes = match body {
        Some(v) => {
            serde_json::to_vec(v).map_err(|e| invalid_input(format!("请求体无法序列化：{e}")))?
        }
        None => Vec::new(),
    };
    let mut head = format!(
        "{method} {API_PREFIX}{path} HTTP/1.1\r\nHost: superagent\r\nConnection: close\r\nAccept: application/json\r\n"
    );
    if body.is_some() {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body_bytes.len()
        ));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .map_err(|e| map_io_error(&e, "发送 Superagent 请求失败"))?;
    if !body_bytes.is_empty() {
        stream
            .write_all(&body_bytes)
            .map_err(|e| map_io_error(&e, "发送 Superagent 请求体失败"))?;
    }

    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > MAX_RESPONSE_BYTES {
                    return Err(AppError::new(
                        ErrorCode::Io,
                        "Superagent 响应超过 32 MiB 上限",
                    ));
                }
            }
            Err(e) => return Err(map_io_error(&e, "读取 Superagent 响应失败")),
        }
    }
    parse_response(&raw)
}

/// 读写错误映射：超时 → `SUPERAGENT_UNAVAILABLE`（无响应），其余 → `IO`。
fn map_io_error(e: &std::io::Error, context: &str) -> AppError {
    if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock {
        return unavailable("Superagent 守护进程无响应");
    }
    AppError::new(ErrorCode::Io, format!("{context}：{e}"))
}

/// 校验 API 相对路径：非空、不以 `/` 开头、首个 `?` 之前的路由段经 `%`
/// 解码后不含 `..`、长度 ≤ 2048、字符只能在 RFC 3986 的 pchar 与 `/`、
/// `?` 范围内；控制字符与空格一律拒绝。
///
/// 说明：
/// - 查询串（首个 `?` 之后）不做 `..` 段检查：`?` 后的内容永不进入路由
///   匹配（守护进程按 `/` 切分 pathname），但字符集与长度限制仍然适用；
/// - 路径段先按 `%` 解码（非法转义直接拒绝），再比较 `..`，防止
///   `%2e%2e`、大小写混写（`%2E%2e`）绕过；双重编码（`%252e`）守护进程
///   只解一次码，落到字面量、无害，但同样拒绝；
/// - 反斜杠与 NUL 不在允许字符集内。
fn validate_path(path: &str) -> Result<(), AppError> {
    if path.starts_with('/') || path.is_empty() {
        return Err(invalid_input(format!("非法的 Superagent 路径：{path}")));
    }
    if path.len() > MAX_PATH_LEN {
        return Err(invalid_input("Superagent 路径过长"));
    }
    const ALLOWED: &str =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~%/:@!$&'()*+,;=?-";
    if !path.bytes().all(|b| ALLOWED.bytes().any(|a| a == b)) {
        return Err(invalid_input(format!("非法的 Superagent 路径：{path}")));
    }
    // 首个 `?` 之前才是路由路径；`?` 之后为查询串，不参与 `..` 检查。
    let route = path.split('?').next().unwrap_or("");
    for seg in route.split('/') {
        // 字面量 `..` 与解码后为 `..` 的段都拒绝；但含 `%` 的段即使解码后
        // 不是 `..` 也要检查转义本身合法（非法转义直接拒绝）。
        if seg == ".." || percent_decode_eq_dotdot(seg).unwrap_or(true) {
            return Err(invalid_input(format!("非法的 Superagent 路径：{path}")));
        }
    }
    Ok(())
}

/// 路径段经 `%` 解码后是否等于 `..`。非法转义（`%` 后不足两位十六进制）
/// 返回 None（调用方按拒绝处理），避免半截转义进入守护进程。
fn percent_decode_eq_dotdot(seg: &str) -> Option<bool> {
    // 快速路径：不含 `%` 的段不可能解码出 `..`（字面量 `..` 由调用方另行判断）。
    if !seg.as_bytes().contains(&b'%') {
        return Some(false);
    }
    let bytes = seg.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    decoded.push(h << 4 | l);
                    i += 3;
                }
                _ => return None,
            }
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    Some(decoded.as_slice() == b"..")
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 解析 HTTP/1.x 响应：在首个 `\r\n\r\n` 处切分头部与正文，从状态行取
/// 三位状态码；`Transfer-Encoding: chunked` 时解码分块正文（上限仍受
/// 32 MiB 约束），正文按 UTF-8 宽松解码。
///
/// 守护进程按约定总是带 `content-length`，这里兼容 chunked 只是为了在
/// node:http 行为变化时不把分块帧当成业务 JSON。
fn parse_response(raw: &[u8]) -> Result<(u16, String), AppError> {
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| AppError::new(ErrorCode::Io, "Superagent 响应缺少头部结束标记"))?;
    let head = &raw[..sep];
    let body = &raw[sep + 4..];
    let status_line_end = head.iter().position(|&b| b == b'\n').unwrap_or(head.len());
    let status_line = String::from_utf8_lossy(&head[..status_line_end]);
    let mut parts = status_line.split_whitespace();
    let version = parts
        .next()
        .ok_or_else(|| AppError::new(ErrorCode::Io, "Superagent 响应状态行无法解析"))?;
    if !version.starts_with("HTTP/") {
        return Err(AppError::new(
            ErrorCode::Io,
            "Superagent 响应状态行无法解析",
        ));
    }
    let code: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::new(ErrorCode::Io, "Superagent 响应状态行无法解析"))?;
    if is_chunked(head) {
        let decoded = decode_chunked(body)?;
        return Ok((code, String::from_utf8_lossy(&decoded).into_owned()));
    }
    Ok((code, String::from_utf8_lossy(body).into_owned()))
}

/// 头部是否声明 `Transfer-Encoding: chunked`（大小写不敏感，编码列表含
/// chunked 即判为分块；node:http 只会发出单一 `chunked` 值，这里取宽松判断）。
fn is_chunked(head: &[u8]) -> bool {
    for line in head.split(|&b| b == b'\n').skip(1) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Some(colon) = line.iter().position(|&b| b == b':') else {
            continue;
        };
        if line[..colon].eq_ignore_ascii_case(b"transfer-encoding")
            && line[colon + 1..]
                .split(|&b| b == b',')
                .any(|v| v.trim_ascii().eq_ignore_ascii_case(b"chunked"))
        {
            return true;
        }
    }
    false
}

/// 解码 HTTP/1.1 分块正文。块扩展（`;` 后）忽略；末尾 trailer 忽略；
/// 任何截断/非法十六进制/块后缺少 CRLF 都报 `IO`。
fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, AppError> {
    fn bad() -> AppError {
        AppError::new(ErrorCode::Io, "Superagent 分块响应无法解析")
    }
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n").ok_or_else(bad)?;
        let size_line = &rest[..line_end];
        let size_part = match size_line.iter().position(|&b| b == b';') {
            Some(i) => &size_line[..i],
            None => size_line,
        };
        let size_str = std::str::from_utf8(size_part.trim_ascii()).map_err(|_| bad())?;
        // 空块大小行非法；十六进制解析失败也非法。
        if size_str.is_empty() {
            return Err(bad());
        }
        let size = usize::from_str_radix(size_str, 16).map_err(|_| bad())?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            // 0 块后是可选 trailer + 空行；EOF 即正文结束，不强制要求空行存在。
            return Ok(out);
        }
        if rest.len() < size + 2 || &rest[size..size + 2] != b"\r\n" {
            return Err(bad());
        }
        out.extend_from_slice(&rest[..size]);
        if out.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::new(
                ErrorCode::Io,
                "Superagent 响应超过 32 MiB 上限",
            ));
        }
        rest = &rest[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;

    /// 在临时目录起一个回固定响应的 UnixListener 线程，返回 socket 路径。
    fn serve_once(response: &'static [u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        std::thread::spawn(move || {
            let Ok((mut conn, _)) = listener.accept() else {
                return;
            };
            // 读走请求（内容不重要），再回固定响应。
            let mut buf = [0u8; 4096];
            let _ = conn.read(&mut buf);
            let _ = conn.write_all(response);
        });
        (dir, socket)
    }

    #[test]
    fn get_returns_status_and_body() {
        let (_dir, socket) = serve_once(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: 7\r\nconnection: close\r\n\r\n{\"a\":1}",
        );
        let (status, body) =
            request(&socket, "GET", "state", None, Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, r#"{"a":1}"#);
    }

    #[test]
    fn not_found_status_passes_through() {
        let (_dir, socket) = serve_once(
            b"HTTP/1.1 404 Not Found\r\ncontent-length: 21\r\nconnection: close\r\n\r\n{\"error\":\"no such op\"}",
        );
        let (status, body) = request(&socket, "GET", "nope", None, Duration::from_secs(5)).unwrap();
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"error":"no such op"}"#);
    }

    #[test]
    fn connection_refused_maps_to_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("missing.sock");
        let err = request(&socket, "GET", "state", None, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.code, ErrorCode::SuperagentUnavailable);
    }

    #[test]
    fn illegal_paths_map_to_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("daemon.sock");
        for path in [
            "/absolute",
            "a/../b",
            "..",
            "has space",
            "中文",
            "a\\b",
            "a/%2e%2e/b",
            "a/%2E%2E/b",
            "a/%2e%2E/b",
            "%2e%2e",
            "a/%2e%2e/b",
            "a/%/b",
            "a/%zz/b",
            "a/b%",
            "a\0b",
            "",
            &"x".repeat(3000),
        ] {
            let err = request(&socket, "GET", path, None, Duration::from_secs(5)).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "path: {path:?}");
        }
        let err = request(&socket, "DELETE", "state", None, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn query_dotdot_is_not_a_route_escape() {
        // `?` 后的 `..` 永不进入路由匹配，应放行到连接阶段
        // （socket 不存在 → UNAVAILABLE 而非 INVALID_INPUT）。
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("missing.sock");
        let err = request(&socket, "GET", "search?q=..", None, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.code, ErrorCode::SuperagentUnavailable);
    }

    #[test]
    fn panel_routes_pass_validation() {
        // 面板实际发出的路径形状必须全部通过校验（放行到连接阶段）。
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("missing.sock");
        for path in [
            "state",
            "sessions",
            "tickets/abc123",
            "triggers/1?filter=recent&limit=20",
            "threads/a%20b?limit=50&before=2024-01-01T00%3A00%3A00.000Z",
            "settings/source:github",
            "settings/policy",
            "search?q=%E4%B8%AD%E6%96%87",
            "tickets/a-b_c.d~e",
            // 合法转义（解码后非 `..`）必须放行。
            "a%2eb",
            "a/%252e%252e/b",
        ] {
            let err = request(&socket, "GET", path, None, Duration::from_secs(5)).unwrap_err();
            assert_eq!(err.code, ErrorCode::SuperagentUnavailable, "path: {path:?}");
        }
    }

    #[test]
    fn chunked_response_is_decoded() {
        let (_dir, socket) = serve_once(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n",
        );
        let (status, body) =
            request(&socket, "GET", "state", None, Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, r#"{"a":1}"#);
    }

    #[test]
    fn chunked_response_with_extensions_and_trailers() {
        let (_dir, socket) = serve_once(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Trailer: 1\r\n\r\n",
        );
        let (status, body) =
            request(&socket, "GET", "state", None, Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "Wikipedia");
    }

    #[test]
    fn truncated_chunked_response_is_io_error() {
        let (_dir, socket) =
            serve_once(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n7\r\n{\"a\":1");
        let err = request(&socket, "GET", "state", None, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
    }

    #[test]
    fn bad_status_line_is_io_error() {
        for response in [
            &b"NOTHTTP 200 OK\r\ncontent-length: 0\r\n\r\n"[..],
            &b"HTTP/1.1 OK\r\ncontent-length: 0\r\n\r\n"[..],
            &b"HTTP/1.1 99999 OK\r\ncontent-length: 0\r\n\r\n"[..],
            &b"no-headers-at-all"[..],
        ] {
            let err = parse_response(response).unwrap_err();
            assert_eq!(err.code, ErrorCode::Io);
        }
        // 合法三位数上限仍通过。
        let (status, _) = parse_response(b"HTTP/1.1 599 x\r\n\r\n").unwrap();
        assert_eq!(status, 599);
    }
}
