//! IPC 契约一致性：`generate_handler!` 与 `src/api.ts` wrapper 集合相等（只用标准库）。

use std::collections::BTreeSet;
use std::path::Path;

fn read_manifest_dir_file(rel: &str) -> String {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    std::fs::read_to_string(Path::new(&dir).join(rel)).unwrap()
}

/// 从 `src/lib.rs` 的 `generate_handler![...]` 提取命令名（按 `::` 取最后一段）。
fn handler_commands(lib_rs: &str) -> BTreeSet<String> {
    let start = lib_rs
        .find("generate_handler![")
        .expect("lib.rs 缺少 generate_handler!");
    let rest = &lib_rs[start + "generate_handler![".len()..];
    let end = rest.find(']').expect("generate_handler! 缺少 ]");
    rest[..end]
        .split(',')
        .filter_map(|item| {
            let name = item.trim().rsplit("::").next()?.trim();
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                return None;
            }
            Some(name.to_owned())
        })
        .collect()
}

/// 从 `src/api.ts` 提取 `call("…"` / `streamedCall("…"` / `invoke("…"` 的字面量命令名。
fn api_commands(api_ts: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for prefix in ["call(\"", "streamedCall(\"", "invoke(\""] {
        let mut rest = api_ts;
        while let Some(i) = rest.find(prefix) {
            rest = &rest[i + prefix.len()..];
            let Some(end) = rest.find('"') else {
                break;
            };
            let name = &rest[..end];
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                out.insert(name.to_owned());
            }
            rest = &rest[end + 1..];
        }
    }
    out
}

#[test]
fn tauri_commands_match_api_wrappers() {
    let lib_rs = read_manifest_dir_file("src/lib.rs");
    let api_ts = read_manifest_dir_file("../src/api.ts");
    let handler = handler_commands(&lib_rs);
    let api = api_commands(&api_ts);
    assert!(!handler.is_empty(), "handler 命令集为空，提取逻辑失效？");
    assert!(!api.is_empty(), "api 命令集为空，提取逻辑失效？");
    let handler_only: Vec<_> = handler.difference(&api).collect();
    let api_only: Vec<_> = api.difference(&handler).collect();
    assert!(
        handler_only.is_empty() && api_only.is_empty(),
        "IPC 契约不一致：\nhandler-only（需在 src/api.ts 加 wrapper）：{handler_only:?}\napi-only（需注册到 generate_handler!）：{api_only:?}",
    );
}

/// 回归：`setup` 必须显式创建托盘图标（`create_tray`），且只创建一次。
///
/// 缺陷现场：大改提交里 `let _tray = create_tray(..)?;` 被整行删掉，应用退到
/// Accessory 后既无 Dock 图标也无菜单栏状态项——没有任何入口能再打开主窗口。
/// 这里只锁装配关系（源码扫描，与本文其余用例同口径），托盘运行行为由人工/
/// 运行时验证覆盖，不做 GUI 假测试。
#[test]
fn setup_creates_tray_icon_once() {
    let lib_rs = read_manifest_dir_file("src/lib.rs");
    let setup_start = lib_rs
        .find(".setup(move |app| {")
        .expect("lib.rs 缺少 setup");
    let rest = &lib_rs[setup_start..];
    let setup_end = rest.find(".on_menu_event(").expect("setup 缺少结束边界");
    let setup = &rest[..setup_end];
    let calls = setup.matches("menubar::tray::create_tray(").count();
    assert_eq!(
        calls, 1,
        "setup 必须恰好创建一次托盘图标（create_tray），实际 {calls} 次——缺了就没有菜单栏入口，多了会重复状态项",
    );
}
