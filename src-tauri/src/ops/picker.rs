//! 原生目录选择器：经 `osascript` 调用 AppleScript `choose folder`。
//!
//! - 不引入新依赖、不改 capabilities（与 iTerm 原语一样直接 spawn `osascript`，
//!   脚本走 `-e` argv，不经 shell）。
//! - 用户取消（osascript 错误 -128）不是错误：返回 `None`。
//! - 纯函数 `parse_choose_output` 负责解释结果，便于单测。

use std::process::{Command, Stdio};

use crate::model::{AppError, ErrorCode};

const CHOOSE_SCRIPT: &str = r#"POSIX path of (choose folder with prompt "选择项目目录")"#;

/// 运行选择器。`Ok(None)` = 用户取消；`Ok(Some(p))` = 所选目录（无末尾斜杠）。
pub fn choose_directory() -> Result<Option<String>, AppError> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(CHOOSE_SCRIPT)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法启动目录选择器：{e}")))?;
    parse_choose_output(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

/// 解释 osascript 结果（纯函数）。
///
/// - 成功：去掉 `POSIX path` 输出的换行与末尾斜杠（根目录保留 `/`）。
/// - 失败且 stderr 含 `(-128)`：用户取消 ⇒ `Ok(None)`。
/// - 其他失败 ⇒ `IO`，附 osascript 原始信息。
pub fn parse_choose_output(
    success: bool,
    stdout: &str,
    stderr: &str,
) -> Result<Option<String>, AppError> {
    if !success {
        if stderr.contains("(-128)") {
            return Ok(None);
        }
        return Err(AppError::new(
            ErrorCode::Io,
            format!("选择项目目录失败：{}", stderr.trim()),
        ));
    }
    let line = stdout.strip_suffix('\n').unwrap_or(stdout);
    let trimmed = line.trim_end_matches('/');
    if trimmed.is_empty() {
        // 空串（非根）说明输出异常；`/` 本身即根目录。
        return if line.starts_with('/') {
            Ok(Some("/".to_owned()))
        } else {
            Err(AppError::new(ErrorCode::Io, "选择项目目录失败：未返回路径"))
        };
    }
    Ok(Some(trimmed.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_strips_newline_and_trailing_slash() {
        assert_eq!(
            parse_choose_output(true, "/Users/x/项目/\n", "").unwrap(),
            Some("/Users/x/项目".to_owned())
        );
        assert_eq!(
            parse_choose_output(true, "/Users/x/my proj\n", "").unwrap(),
            Some("/Users/x/my proj".to_owned())
        );
    }

    #[test]
    fn root_keeps_slash() {
        assert_eq!(
            parse_choose_output(true, "/\n", "").unwrap(),
            Some("/".to_owned())
        );
    }

    #[test]
    fn user_cancel_is_none_not_error() {
        let stderr = "execution error: User canceled. (-128)";
        assert_eq!(parse_choose_output(false, "", stderr).unwrap(), None);
    }

    #[test]
    fn other_failure_is_io_error() {
        let e = parse_choose_output(false, "", "execution error: boom (-1)").unwrap_err();
        assert_eq!(e.code, ErrorCode::Io);
        assert!(e.message.contains("boom"), "{e:?}");
    }
}
