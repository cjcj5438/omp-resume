//! 托盘图标 / 下拉菜单装配与事件路由（需 tauri `tray-icon` 特性）。
//!
//! - 图标：单色模板图（`icons/tray-icon.png`，黑 + alpha），`icon_as_template(true)`；
//! - 菜单内容来自 [`crate::menubar::menu::MenuModel`]，只在模型变化时重建；
//! - 事件：会话行 = 聚焦 iTerm 标签；勾选 = 设置落盘；退出 = 真退出。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    Mutex,
};

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder},
    App, AppHandle, Manager, Runtime,
};

use super::menu::{menu_text, refresh_decision, MenuModel, Refresh};
use super::notify::{self, NotifyAction};
use super::poller::{Poller, SystemOccupants, POLL_INTERVAL_SECS};
use super::settings::{self, Settings};

pub const TRAY_ID: &str = "menubar";
pub const ITEM_OPEN_WINDOW: &str = "open-window";
pub const ITEM_TOGGLE_NOTIFY: &str = "toggle-notify";
pub const ITEM_TOGGLE_DOCK: &str = "toggle-dock";
pub const ITEM_QUIT: &str = "quit";
pub const ITEM_MORE: &str = "more";
pub const SESSION_PREFIX: &str = "session:";
/// 「模式」子菜单项 id 前缀。
pub const MODE_PREFIX: &str = "mode:";
pub const ITEM_MODES: &str = "modes";

/// 托盘共享状态（Tauri 全局 `manage`，跨线程）。
pub struct Shared {
    /// 会话 id → tty（聚焦用，轮询每轮发布）。
    pub focus: Mutex<HashMap<String, String>>,
    /// 运行中会话快照（每轮整体覆盖；`list_running_sessions` 读它）。
    pub running: Mutex<Vec<crate::model::RunningSession>>,
    pub last_menu: Mutex<Option<MenuModel>>,
    pub settings: Mutex<Settings>,
    /// 通知 id → 会话 id（点击回调聚焦用；汇总/ plain 通知记空串 → 打开主窗口）。
    pub notify_targets: Mutex<HashMap<i32, String>>,
    pub notify_seq: AtomicI32,
    /// 真退出进行中（菜单“退出”置位；置位后窗口 CloseRequested 不再拦截）。
    pub quitting: AtomicBool,
    pub data_dir: PathBuf,
    /// 行文本更新器（会话 id → `set_text` 闭包）：仅时长变化时就地更新，
    /// 结构性重建时整体替换。
    pub row_updaters: Mutex<RowUpdaters>,
    /// 模型模式列表（`None` = 尚未读到 / 读取失败）。
    pub modes: Mutex<Option<Vec<super::menu::ModeEntry>>>,
}

impl Shared {
    pub fn new(data_dir: PathBuf, settings: Settings) -> Self {
        Self {
            focus: Mutex::new(HashMap::new()),
            running: Mutex::new(Vec::new()),
            last_menu: Mutex::new(None),
            settings: Mutex::new(settings),
            notify_targets: Mutex::new(HashMap::new()),
            notify_seq: AtomicI32::new(1),
            quitting: AtomicBool::new(false),
            data_dir,
            row_updaters: Mutex::new(Vec::new()),
            modes: Mutex::new(None),
        }
    }
}

/// 行文本更新器：(会话 id, `set_text` 闭包)。结构性重建时整体替换。
pub type RowUpdaters = Vec<(String, Box<dyn Fn(&str) + Send + Sync>)>;

/// 装配结果：菜单 + 行项句柄（会话 id → 菜单项，供时长就地更新）。
pub type BuiltMenu<R> = (Menu<R>, Vec<(String, MenuItem<R>)>);

/// 由 [`MenuModel`] 装配原生菜单（纯装配，文案已由模型定好）。
/// 返回菜单与行项句柄（供时长就地更新；句柄同时以闭包形式存入
/// [`Shared::row_updaters`]）。
pub fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    model: &MenuModel,
) -> tauri::Result<BuiltMenu<R>> {
    let menu = Menu::new(app)?;
    let header = MenuItem::new(app, menu_text(&model.header), false, None::<&str>)?;
    menu.append(&header)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let mut handles: Vec<(String, MenuItem<R>)> = Vec::new();
    for row in &model.rows {
        let item = MenuItem::with_id(
            app,
            format!("{SESSION_PREFIX}{}", row.session_id),
            menu_text(&row.text()),
            row.enabled,
            None::<&str>,
        )?;
        menu.append(&item)?;
        handles.push((row.session_id.clone(), item));
    }
    if !model.overflow.is_empty() {
        let mut built: Vec<MenuItem<R>> = Vec::new();
        for row in &model.overflow {
            let item = MenuItem::with_id(
                app,
                format!("{SESSION_PREFIX}{}", row.session_id),
                menu_text(&row.text()),
                row.enabled,
                None::<&str>,
            )?;
            built.push(item.clone());
            handles.push((row.session_id.clone(), item));
        }
        let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = built
            .iter()
            .map(|b| b as &dyn tauri::menu::IsMenuItem<R>)
            .collect();
        let more = Submenu::with_id_and_items(app, ITEM_MORE, "更多…", true, &refs)?;
        menu.append(&more)?;
    }
    if let Some(modes) = &model.modes {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        let active = modes.iter().find(|m| m.active).map(|m| m.name.as_str());
        let title = format!("模式：{}", active.unwrap_or("自定义"));
        if modes.is_empty() {
            let empty = MenuItem::new(
                app,
                "还没有模式（在主窗口侧栏底部保存）",
                false,
                None::<&str>,
            )?;
            let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&empty];
            let sub = Submenu::with_id_and_items(app, ITEM_MODES, title, true, &refs)?;
            menu.append(&sub)?;
        } else {
            let mut built: Vec<CheckMenuItem<R>> = Vec::new();
            for mode in modes {
                built.push(CheckMenuItem::with_id(
                    app,
                    format!("{MODE_PREFIX}{}", mode.name),
                    menu_text(&mode.name),
                    mode.enabled,
                    mode.active,
                    None::<&str>,
                )?);
            }
            let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = built
                .iter()
                .map(|b| b as &dyn tauri::menu::IsMenuItem<R>)
                .collect();
            let sub = Submenu::with_id_and_items(app, ITEM_MODES, title, true, &refs)?;
            menu.append(&sub)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        ITEM_OPEN_WINDOW,
        "打开主窗口",
        true,
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        ITEM_TOGGLE_NOTIFY,
        "完成时通知",
        true,
        model.notify_on,
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        ITEM_TOGGLE_DOCK,
        "在 Dock 显示图标",
        true,
        model.dock_on,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        ITEM_QUIT,
        "退出 omp-resume",
        true,
        None::<&str>,
    )?)?;
    Ok((menu, handles))
}

/// 创建托盘图标（初始菜单由调用方给，首轮轮询后刷新）。
pub fn create_tray<R: Runtime>(app: &App<R>, model: &MenuModel) -> tauri::Result<TrayIcon<R>> {
    let icon = Image::from_bytes(include_bytes!("../../icons/tray-icon.png"))?;
    let handle = app.handle();
    let (menu, _handles) = build_menu(handle, model)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip(&model.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(true);
    if let Some(title) = &model.tray_title {
        builder = builder.title(title);
    }
    builder.build(app)
}

/// 菜单点击事件路由（注册到 `Builder::on_menu_event`）。
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref().to_string();
    if let Some(name) = id.strip_prefix(MODE_PREFIX) {
        switch_mode_from_tray(app, name.to_string());
        return;
    }
    if let Some(session_id) = id.strip_prefix(SESSION_PREFIX) {
        focus_session(app, session_id.to_string());
        return;
    }
    match id.as_str() {
        ITEM_OPEN_WINDOW => show_main(app),
        ITEM_TOGGLE_NOTIFY => toggle_setting(app, true),
        ITEM_TOGGLE_DOCK => toggle_setting(app, false),
        ITEM_QUIT => {
            if let Some(shared) = app.try_state::<Shared>() {
                shared.quitting.store(true, Ordering::SeqCst);
            }
            app.exit(0);
        }
        _ => {}
    }
}

/// 显示主窗口：切回 Regular（显示 Dock 图标）并聚焦。
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 隐藏主窗口（由关闭拦截调用）；Dock 图标按设置处理。
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let show_dock = app
        .try_state::<Shared>()
        .and_then(|s| s.settings.lock().ok().map(|g| g.show_dock_icon))
        .unwrap_or(false);
    if !show_dock {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

fn toggle_setting<R: Runtime>(app: &AppHandle<R>, notify: bool) {
    let Some(shared) = app.try_state::<Shared>() else {
        return;
    };
    let (notify_on, dock_on) = {
        let mut guard = match shared.settings.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if notify {
            guard.notify_on_waiting = !guard.notify_on_waiting;
        } else {
            guard.show_dock_icon = !guard.show_dock_icon;
        }
        let next = guard.clone();
        drop(guard);
        if settings::save(&shared.data_dir, &next).is_err() {
            return;
        }
        (next.notify_on_waiting, next.show_dock_icon)
    };
    // Dock 策略立即生效（窗口可见时保持 Regular）。
    let window_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(true);
    if !window_visible {
        let _ = app.set_activation_policy(if dock_on {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        });
    }
    // 用缓存模型立即刷新勾选态（不等下轮）。
    let cached = shared.last_menu.lock().ok().and_then(|g| g.clone());
    if let Some(mut model) = cached {
        model.notify_on = notify_on;
        model.dock_on = dock_on;
        refresh_tray(app, &shared, &model);
    }
}

/// 从托盘切换模型模式（后台线程；结果用系统通知反馈，勾选态回同步）。
fn switch_mode_from_tray<R: Runtime>(app: &AppHandle<R>, name: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        use crate::omp_cli::OmpBusy;
        let Some(bin) = crate::omp_cli::resolve_omp() else {
            send_plain(&app, "切换模式失败", "未找到 omp");
            return;
        };
        let busy = app.state::<OmpBusy>();
        match crate::model_presets::switch_preset_impl(&bin, &busy, &name, None) {
            Ok(state) => {
                publish_modes(&app, &state);
                send_plain(&app, "已切换模式", &format!("当前模式：{name}"));
            }
            Err(e) => {
                send_plain(&app, "切换模式失败", &e.message);
                // 尽力把勾选态恢复成真实值。
                if let Ok(state) = crate::model_presets::read_presets_state(&bin) {
                    publish_modes(&app, &state);
                }
            }
        }
    });
}

/// 发布模式列表到托盘（与缓存相同则直接返回；否则按缓存模型重建菜单）。
pub fn publish_modes<R: Runtime>(app: &AppHandle<R>, state: &crate::model::ModelPresetsState) {
    let entries = super::menu::mode_entries(state);
    let Some(shared) = app.try_state::<Shared>() else {
        return;
    };
    {
        let Ok(mut guard) = shared.modes.lock() else {
            return;
        };
        if guard.as_ref() == Some(&entries) {
            return;
        }
        *guard = Some(entries.clone());
    }
    let cached = shared.last_menu.lock().ok().and_then(|g| g.clone());
    if let Some(mut model) = cached {
        model.modes = Some(entries);
        refresh_tray(app, &shared, &model);
    }
}

/// 模式列表后台刷新（30 秒一轮；首轮立即执行，失败保留旧值）。
pub fn spawn_modes_refresher<R: Runtime + 'static>(app: AppHandle<R>) {
    let spawned = std::thread::Builder::new()
        .name("menubar-modes".to_string())
        .spawn(move || loop {
            if let Some(bin) = crate::omp_cli::resolve_omp() {
                if let Ok(state) = crate::model_presets::read_presets_state(&bin) {
                    publish_modes(&app, &state);
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
    if let Err(e) = spawned {
        eprintln!("menubar: 模式刷新线程启动失败：{e}");
    }
}

/// 按会话 id 聚焦其 iTerm 标签（后台线程执行，失败发通知明示）。
fn focus_session<R: Runtime>(app: &AppHandle<R>, session_id: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let tty = app.try_state::<Shared>().and_then(|s| {
            s.focus
                .lock()
                .ok()
                .and_then(|m| m.get(&session_id).cloned())
        });
        eprintln!("menubar: 聚焦请求 {session_id} tty={tty:?}");
        let Some(tty) = tty else {
            eprintln!("menubar: 聚焦失败——找不到该会话的终端映射");
            send_plain(&app, "聚焦失败", "找不到该会话的终端");
            return;
        };
        let runner = super::iterm::SystemRunner;
        match super::iterm::focus_tty(&tty, &runner) {
            Ok(()) => eprintln!("menubar: 聚焦成功 {tty}"),
            Err(e) => {
                eprintln!("menubar: 聚焦失败：{}", e.message());
                send_plain(&app, "聚焦失败", &e.message());
            }
        }
    });
}

/// Dock 角标 = 需要用户处理的会话数（等待输入 + 疑似卡住）；0 清除。
/// macOS 上经主窗口 `set_badge_count` 应用（应用级 NSDockTile badge）。
pub fn apply_badge<R: Runtime>(app: &AppHandle<R>, model: &MenuModel) {
    if let Some(window) = app.get_webview_window("main") {
        let count = if model.badge_count == 0 {
            None
        } else {
            Some(model.badge_count as i64)
        };
        let _ = window.set_badge_count(count);
    }
}

/// 用模型整体重建托盘（菜单 + 标题 + tooltip + Dock 角标），更新缓存与行文本更新器。
fn refresh_tray<R: Runtime>(app: &AppHandle<R>, shared: &Shared, model: &MenuModel) {
    if let Ok(mut guard) = shared.last_menu.lock() {
        *guard = Some(model.clone());
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok((menu, handles)) = build_menu(app, model) {
            let _ = tray.set_menu(Some(menu));
            if let Ok(mut updaters) = shared.row_updaters.lock() {
                *updaters = handles
                    .into_iter()
                    .map(|(sid, item)| {
                        let f: Box<dyn Fn(&str) + Send + Sync> = Box::new(move |text: &str| {
                            let _ = item.set_text(menu_text(text));
                        });
                        (sid, f)
                    })
                    .collect();
            }
        }
        let _ = tray.set_title(model.tray_title.as_deref());
        let _ = tray.set_tooltip(Some(&model.tooltip));
    }
    apply_badge(app, model);
}

/// 发送判定产出的通知：插件优先，失败退回 osascript。
pub fn send_action<R: Runtime>(app: &AppHandle<R>, shared: &Shared, action: &NotifyAction) {
    let (title, body) = notify::action_text(action);
    let target = match action {
        NotifyAction::Waiting { session_id, .. } | NotifyAction::Stuck { session_id, .. } => {
            session_id.clone()
        }
        NotifyAction::Summary { .. } => String::new(),
    };
    eprintln!("menubar: 通知发送尝试「{title} / {body}」");
    if send_via_plugin(app, shared, &title, &body, target).is_err() {
        eprintln!("menubar: 插件发送失败/不可用，退回 osascript");
        let runner = super::iterm::SystemRunner;
        match notify::send_via_osascript(&title, &body, &runner) {
            Ok(()) => eprintln!("menubar: osascript 发送调用成功（是否展示由系统决定）"),
            Err(e) => eprintln!("menubar: osascript 发送失败：{e}"),
        }
    } else {
        eprintln!("menubar: 插件发送调用成功（是否展示由系统决定）");
    }
}

/// 简单通知（聚焦失败等；点击打开主窗口）。
fn send_plain<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    let target = String::new();
    let via_plugin = app
        .try_state::<Shared>()
        .map(|s| send_via_plugin(app, s.inner(), title, body, target).is_ok())
        .unwrap_or(false);
    if !via_plugin {
        let runner = super::iterm::SystemRunner;
        let _ = notify::send_via_osascript(title, body, &runner);
    }
}

fn send_via_plugin<R: Runtime>(
    app: &AppHandle<R>,
    shared: &Shared,
    title: &str,
    body: &str,
    target: String,
) -> Result<(), ()> {
    use tauri_plugin_notification::NotificationExt;
    let id = shared.notify_seq.fetch_add(1, Ordering::SeqCst);
    app.notification()
        .builder()
        .id(id)
        .title(title)
        .body(body)
        .show()
        .map_err(|_| ())?;
    if let Ok(mut guard) = shared.notify_targets.lock() {
        guard.insert(id, target);
        // 有界：只保留最近 64 条映射。
        if guard.len() > 64 {
            let drop: Vec<i32> = guard.keys().take(guard.len() - 64).cloned().collect();
            for k in drop {
                guard.remove(&k);
            }
        }
    }
    Ok(())
}

/// 注册通知点击回调：点会话通知聚焦对应标签，点汇总/plain 打开主窗口。
pub fn register_click_handler<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri_plugin_notification::NotificationExt;
    let notifier = app.clone();
    let handle = app.clone();
    notifier
        .notification()
        .on_action(move |action| {
            if action.action_id() != "tap" {
                return;
            }
            let target = action.notification().and_then(|n| {
                handle.try_state::<Shared>().and_then(|s| {
                    s.notify_targets
                        .lock()
                        .ok()
                        .and_then(|m| m.get(&n.id()).cloned())
                })
            });
            match target.as_deref() {
                Some("") | None => show_main(&handle),
                Some(session_id) => focus_session(&handle, session_id.to_string()),
            }
        })
        .map_err(|e| tauri::Error::PluginInitialization("notification".into(), e.to_string()))?;
    Ok(())
}

/// 当前 epoch 秒（轮询时间源）。
fn epoch_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 启动后台轮询线程（3 秒一轮；单轮失败只跳过，永不 panic 退出）。
pub fn spawn_poller<R: Runtime + 'static>(
    app: AppHandle<R>,
    owners_dir: PathBuf,
    sessions_dir: PathBuf,
) {
    let poller = std::thread::Builder::new()
        .name("menubar-poll".to_string())
        .spawn(move || {
            let mut poller = Poller::new(
                owners_dir,
                sessions_dir,
                Box::new(super::iterm::SystemRunner),
                Box::new(SystemOccupants),
            );
            loop {
                let tick_start = std::time::Instant::now();
                let (notify_on, dock_on) = app
                    .try_state::<Shared>()
                    .and_then(|s| {
                        s.settings
                            .lock()
                            .ok()
                            .map(|g| (g.notify_on_waiting, g.show_dock_icon))
                    })
                    .unwrap_or((true, false));
                let outcome = poller.poll_once(epoch_now(), notify_on, dock_on);
                if let Some(model) = outcome.menu {
                    if let Some(shared) = app.try_state::<Shared>() {
                        // 发布聚焦表。
                        if let Ok(mut focus) = shared.focus.lock() {
                            focus.clear();
                            for s in &outcome.snapshots {
                                if let Some(tty) = &s.tty {
                                    focus.insert(s.id.clone(), tty.clone());
                                }
                            }
                        }
                        // 发布运行中快照（舞台左栏 + 主会话状态）。
                        if let Ok(mut running) = shared.running.lock() {
                            running.clear();
                            for s in &outcome.snapshots {
                                running.push(crate::model::RunningSession {
                                    id: s.id.clone(),
                                    path: s.path.to_string_lossy().to_string(),
                                    title: s.title.clone(),
                                    status: s.status.key().to_string(),
                                    status_text: s.status.label().to_string(),
                                    subagents: s.subagents,
                                    duration_secs: s.duration_secs,
                                    app: s.app.clone(),
                                });
                            }
                        }
                        // 仅时长文字变化 → 就地 set_text（不关掉用户展开着的菜单）；
                        // 结构性变化（会话增减/状态/排序/标题/勾选）→ 整体重建。
                        let mut model = model;
                        if let Ok(guard) = shared.modes.lock() {
                            model.modes = guard.clone();
                        }
                        let decision = shared
                            .last_menu
                            .lock()
                            .map(|guard| refresh_decision(guard.as_ref(), &model))
                            .unwrap_or(Refresh::Rebuild);
                        match decision {
                            Refresh::None => {}
                            Refresh::Texts(texts) => {
                                let mut applied = 0;
                                if let Ok(updaters) = shared.row_updaters.lock() {
                                    for (sid, text) in &texts {
                                        for (uid, set_text) in updaters.iter() {
                                            if uid == sid {
                                                set_text(text);
                                                applied += 1;
                                            }
                                        }
                                    }
                                }
                                if applied == texts.len() {
                                    if let Ok(mut guard) = shared.last_menu.lock() {
                                        *guard = Some(model);
                                    }
                                } else {
                                    // 更新器与行对不上（不该发生）：保险整体重建。
                                    refresh_tray(&app, &shared, &model);
                                }
                            }
                            Refresh::Rebuild => {
                                refresh_tray(&app, &shared, &model);
                            }
                        }
                        for action in &outcome.actions {
                            send_action(&app, &shared, action);
                        }
                        // 有通知动作即 Dock 跳一次（每轮至多一次；开关/门槛/防抖由判定继承）。
                        // macOS 在应用已激活时忽略，属系统行为。
                        if !outcome.actions.is_empty() {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.request_user_attention(Some(
                                    tauri::UserAttentionType::Informational,
                                ));
                            }
                        }
                    }
                }
                let elapsed = tick_start.elapsed();
                let interval = std::time::Duration::from_secs(POLL_INTERVAL_SECS);
                if elapsed < interval {
                    std::thread::sleep(interval - elapsed);
                }
            }
        });
    if let Err(e) = poller {
        eprintln!("menubar: 轮询线程启动失败：{e}");
    }
}
