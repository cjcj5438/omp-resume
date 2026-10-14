//! Tauri 应用入口。
//!
//! 后端命令由后续 worker 按模块添加：
//! - `sessions`：扫描 / 解析 / 列表 / 会话内容 / 树
//! - `ops`：占用探测 / 删除 / 分支标记 / iTerm 打开
//! - `config`：配置解析
//!
//! 每个新命令必须同时注册到下面 `generate_handler!` 列表中，
//! 并在 `docs/CONTRACT.md`、`model.rs`、`src/types.ts`、`src/api.ts`
//! 四处保持一致（见 CONTRACT.md「一致性规则」）。

/// 全局共享的数据模型：命令参数、返回值与错误类型。
pub mod model;

/// OPS 纯原语：删除 / iTerm / 分支标记（暂无 Tauri 命令装配）。
pub mod ops;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
