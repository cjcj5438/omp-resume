//! OPS 纯原语：删除 / iTerm / 分支标记。
//!
//! 本模块只提供可独立测试的底层函数，不做 Tauri 命令装配，
//! 不读全局配置，所有输入均为显式参数（路径等由调用方先做
//! sessions-root 校验与占用探测，本模块只做廉价自卫）。
pub mod commands;
pub mod delete;
pub mod iterm;
pub mod marker;
