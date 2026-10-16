//! macOS 菜单栏：查看并管理当前运行中的 omp 会话（CONTRACT §17）。
//!
//! - `classify`：状态判定纯函数（工作中 / 等待输入 / 空闲 / 疑似卡住）；
//! - `tail`：会话 jsonl 尾部增量读取（T2，只读）；
//! - `iterm`：iTerm 标题批量查询（T3，只读）与聚焦（仅 activate+select）；
//! - `detect`：T0 flock 全量探测 + id→路径索引；
//! - `poller`：后台轮询组装（T0–T3 → 快照 → 菜单模型 → 通知判定）；
//! - `menu`：下拉菜单纯数据模型；
//! - `settings`：`settings.json` 读写；
//! - `notify`：通知转换判定 + osascript 回退发送；
//! - `tray`：托盘图标/菜单装配与事件路由（需 `tray-icon` 特性）。

pub mod classify;
pub mod detect;
pub mod iterm;
pub mod menu;
pub mod notify;
pub mod poller;
pub mod settings;
pub mod tail;
pub mod tray;
