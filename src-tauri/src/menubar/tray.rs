//! 托盘图标 / 下拉菜单装配与事件路由（需 tauri `tray-icon` 特性）。
//!
//! - 图标：单色模板图（`icons/tray.png`，黑 + alpha），`icon_as_template(true)`；
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

use super::menu::{menu_text, MenuModel};
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

/// 托盘共享状态（Tauri 全局 `manage`，跨线程）。
pub struct Shared {
    /// 会话 id → tty（聚焦用，轮询每轮发布）。
    pub focus: Mutex<HashMap<String, String>>,
    pub last_menu: Mutex<Option<MenuModel>>,
    pub settings: Mutex<Settings>,
    /// 通知 id → 会话 id（点击回调聚焦用；汇总/ plain 通知记空串 → 打开主窗口）。
    pub notify_targets: Mutex<HashMap<i32, String>>,
    pub notify_seq: AtomicI32,
    /// 真退出进行中（菜单“退出”置位；置位后窗口 CloseRequested 不再拦截）。
    pub quitting: AtomicBool,
    pub data_dir: PathBuf,
}

impl Shared {
    pub fn new(data_dir: PathBuf, settings: Settings) -> Self {
        Self {
            focus: Mutex::new(HashMap::new()),
            last_menu: Mutex::new(None),
            settings: Mutex::new(settings),
            notify_targets: Mutex::new(HashMap::new()),
            notify_seq: AtomicI32::new(1),
            quitting: AtomicBool::new(false),
            data_dir,
        }
    }
}

/// 由 [`MenuModel`] 装配原生菜单（纯装配，文案已由模型定好）。
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, model: &MenuModel) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    let header = MenuItem::new(app, menu_text(&model.header), false, None::<&str>)?;
    menu.append(&header)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for row in &model.rows {
        let item = MenuItem::with_id(
            app,
            format!("{SESSION_PREFIX}{}", row.session_id),
            menu_text(&row.text),
            row.enabled,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }
    if !model.overflow.is_empty() {
        let built: Vec<MenuItem<R>> = model
            .overflow
            .iter()
            .map(|row| {
                MenuItem::with_id(
                    app,
                    format!("{SESSION_PREFIX}{}", row.session_id),
                    menu_text(&row.text),
                    row.enabled,
                    None::<&str>,
                )
            })
            .collect::<Result<_, _>>()?;
        let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = built
            .iter()
            .map(|b| b as &dyn tauri::menu::IsMenuItem<R>)
            .collect();
        let more = Submenu::with_id_and_items(app, ITEM_MORE, "更多…", true, &refs)?;
        menu.append(&more)?;
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
    Ok(menu)
}

/// 创建托盘图标（初始菜单由调用方给，首轮轮询后刷新）。
pub fn create_tray<R: Runtime>(app: &App<R>, model: &MenuModel) -> tauri::Result<TrayIcon<R>> {
    let icon = Image::from_bytes(include_bytes!("../../icons/tray-icon.png"))?;
    let handle = app.handle();
    let menu = build_menu(handle, model)?;
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

/// 用模型刷新托盘（菜单 + 标题 + tooltip），并更新缓存。
fn refresh_tray<R: Runtime>(app: &AppHandle<R>, shared: &Shared, model: &MenuModel) {
    if let Ok(mut guard) = shared.last_menu.lock() {
        *guard = Some(model.clone());
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app, model) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_title(model.tray_title.as_deref());
        let _ = tray.set_tooltip(Some(&model.tooltip));
    }
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
    std::thread::Builder::new()
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
                        let changed = shared
                            .last_menu
                            .lock()
                            .map(|g| g.as_ref() != Some(&model))
                            .unwrap_or(true);
                        // 发布聚焦表。
                        if let Ok(mut focus) = shared.focus.lock() {
                            focus.clear();
                            for s in &outcome.snapshots {
                                if let Some(tty) = &s.tty {
                                    focus.insert(s.id.clone(), tty.clone());
                                }
                            }
                        }
                        if changed {
                            refresh_tray(&app, &shared, &model);
                        } else if let Ok(mut guard) = shared.last_menu.lock() {
                            *guard = Some(model);
                        }
                        for action in &outcome.actions {
                            send_action(&app, &shared, action);
                        }
                    }
                }
                let elapsed = tick_start.elapsed();
                let interval = std::time::Duration::from_secs(POLL_INTERVAL_SECS);
                if elapsed < interval {
                    std::thread::sleep(interval - elapsed);
                }
            }
        })
        .expect("spawn menubar poll thread");
}
