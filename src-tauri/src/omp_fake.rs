//! 共享的假 omp 测试替身（`#[cfg(test)]`）：`omp_models` 与 `model_presets`
//! 的测试都通过它来模拟 `omp config get/set`、`omp models --json`、`omp agents`。
//!
//! 设计：全部状态落在临时目录的 `state/` 子目录里，一个「键」对应一个文件，
//! 内容形如 `{"key":..,"value":..,"type":..}`；`config set` 把 `<key> <value>`
//! 追加到 `sets.log`，用来断言写入顺序与内容。
use std::path::{Path, PathBuf};

use serde_json::Value;

pub(crate) fn write_fake(dir: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("omp");
    std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

/// 有状态假 omp：`config get/set` 以临时目录内文件模拟 config，
/// 并把每次 set 的参数记入日志；`models --json` 读 `state/models.json`
/// （不存在则返回空列表）；`agents unpack` 写两个 agent md；
/// `--version` 固定；任何未识别子命令都失败。
///
/// 失败注入：创建 `state/fail-set-<key>` 文件后，对应该 key 的 `config set`
/// 直接失败（用于验证写入回滚）。
pub(crate) fn fake_stateful() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    let log = dir.path().join("sets.log");
    let body = format!(
        r#"STATE="{state}"
LOG="{log}"
if [ "$1" = "--version" ]; then echo "omp/99.0.0-test"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  if [ -f "$STATE/$3" ]; then cat "$STATE/$3"; else printf '{{"key":"%s","value":{{}},"type":"record"}}' "$3"; fi
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "set" ]; then
  if [ -f "$STATE/fail-set-$3" ]; then
    left=$(cat "$STATE/fail-set-$3" 2>/dev/null || echo 0)
    case "$left" in ''|*[!0-9]*) left=1 ;; esac
    if [ "$left" -gt 0 ]; then
      left=$((left - 1))
      printf '%s' "$left" > "$STATE/fail-set-$3"
      echo "injected failure" >&2
      exit 1
    fi
  fi
  if [ "$3" = "defaultThinkingLevel" ]; then
    printf '{{"key":"%s","value":"%s","type":"string"}}' "$3" "$4" > "$STATE/$3"
  else
    printf '{{"key":"%s","value":%s,"type":"x"}}' "$3" "$4" > "$STATE/$3"
  fi
  printf '%s %s\n' "$3" "$4" >> "$LOG"
  exit 0
fi
if [ "$1" = "models" ]; then
  if [ -f "$STATE/models.json" ]; then cat "$STATE/models.json"; else echo '{{"models":[]}}'; fi
  exit 0
fi
if [ "$1" = "agents" ]; then
  mkdir -p "$4"
  printf '%s\n' '---' 'name: task' 'description: 总控' 'model:' '  - "@task"' 'thinkingLevel: auto' '---' 'body' > "$4/task.md"
  printf '%s\n' '---' 'name: scout' 'description: 调研' 'model: "@smol"' 'thinkingLevel: medium' '---' 'body' > "$4/scout.md"
  printf '{{"targetDir":"%s","total":2,"written":[],"skipped":[]}}\n' "$4"
  exit 0
fi
echo "unexpected: $*" >&2
exit 1"#,
        state = state.display(),
        log = log.display(),
    );
    let bin = write_fake(dir.path(), &body);
    (dir, bin)
}

/// 被调用即在 `invoked` 文件留痕，用于断言「绝不触碰 omp」。
pub(crate) fn fake_with_marker() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("invoked");
    let body = format!("echo invoked >> \"{}\"", marker.display());
    let bin = write_fake(dir.path(), &body);
    (dir, bin, marker)
}

pub(crate) fn seed(tmp: &Path, key: &str, value: &Value) {
    std::fs::write(
        tmp.join("state").join(key),
        serde_json::json!({"key": key, "value": value, "type": "record"}).to_string(),
    )
    .unwrap();
}

pub(crate) fn set_log(tmp: &Path) -> String {
    std::fs::read_to_string(tmp.join("sets.log")).unwrap_or_default()
}
