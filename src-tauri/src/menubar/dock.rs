//! Dock 右键菜单（macOS）：运行时向 tao 的 NSApp delegate 注入 `applicationDockMenu:`。
//!
//! - tauri/tao 均未提供 Dock 菜单 API（上游 issue #9916/#14699 未合入），
//!   且 tao 的 delegate 类未定义该方法，故在 setup（主线程）用
//!   `class_addMethod` 动态加上；
//! - 方法实现每次右键时按缓存 [`crate::menubar::menu::MenuModel`] 现场组装
//!   一个全新的 `muda::Menu`（与托盘菜单同文案/同 id），经 `ns_menu()` 把
//!   NSMenu 指针还给 AppKit；muda 的点击经 tauri 已注册的全局
//!   `MenuEvent` 处理器转发到既有 `handle_menu_event`（`session:<id>` /
//!   `open-window`），无需新路由；
//! - 风险：若未来 tao 自己定义了该方法（`class_addMethod` 返回 false）或
//!   替换了 delegate 类，Dock 菜单会静默消失（仅打一条 stderr 日志），
//!   应用其余行为不受影响。

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::OnceLock;

use muda::{ContextMenu, IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::MainThreadMarker;
use objc2_app_kit::NSApplication;
use tauri::{AppHandle, Manager, Wry};

use super::classify::SessionStatus;
use super::menu::{menu_text, MenuModel};
use super::tray::{Shared, ITEM_MORE, ITEM_OPEN_WINDOW, SESSION_PREFIX};

// 主线程独占：上一次 Dock 菜单（`ns_menu()` 指针随它活到下一次右键）。
thread_local! {
    static LAST_DOCK_MENU: RefCell<Option<Menu>> = const { RefCell::new(None) };
}

/// AppHandle（setup 时写入，供 `applicationDockMenu:` 取缓存模型）。
static APP_HANDLE: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// 在 setup（主线程）调用：给当前 `NSApp.delegate` 的类加上 `applicationDockMenu:`。
///
/// 任何前置条件缺失（非主线程 / 无 delegate / 方法已存在）都只打日志并跳过，
/// 调用方无需处理。
pub fn install(app: &AppHandle<Wry>) {
    let _ = APP_HANDLE.set(app.clone());

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("dock: 不在主线程，跳过 Dock 菜单注入");
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns_app.delegate() else {
        eprintln!("dock: 取 NSApp.delegate 失败，跳过 Dock 菜单注入");
        return;
    };
    // 用 live delegate 的动态类（object_getClass），绝不硬编码 tao 的类名。
    let delegate_ptr: *const AnyObject = std::ptr::from_ref(&*delegate).cast();
    // SAFETY: delegate 是合法 Objective-C 对象；ProtocolObject 以 AnyObject 开头（repr C）。
    let cls_const = unsafe { objc2::ffi::object_getClass(delegate_ptr) };
    if cls_const.is_null() {
        eprintln!("dock: object_getClass 返回空，跳过 Dock 菜单注入");
        return;
    }
    let cls = cls_const as *mut AnyClass;
    let sel = objc2::sel!(applicationDockMenu:);
    // SAFETY: 签名与 `-applicationDockMenu:` 一致（self, _cmd, sender）-> NSMenu*，
    // 类型编码 `@@:@`；实现内全是 fallible 路径，永不 panic。
    let imp: objc2::runtime::Imp = unsafe {
        std::mem::transmute(
            application_dock_menu as extern "C" fn(&AnyObject, Sel, *mut AnyObject) -> *mut c_void,
        )
    };
    let types = c"@@:@";
    // SAFETY: cls 是 live delegate 的类，sel/imp/types 如上。
    let ok = unsafe { objc2::ffi::class_addMethod(cls, sel, imp, types.as_ptr()) };
    if !ok.as_bool() {
        eprintln!("dock: class_addMethod(applicationDockMenu:) 返回 false（tao 已定义？），跳过");
    }
}

/// `applicationDockMenu:` 实现：现场组装并返回 NSMenu 指针，失败返回空。
extern "C" fn application_dock_menu(
    _this: &AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> *mut c_void {
    build_dock_menu_ptr()
}

fn build_dock_menu_ptr() -> *mut c_void {
    // muda 只能在主线程建菜单；AppKit 本就该在主线程回调，非主线程直接给空。
    if MainThreadMarker::new().is_none() {
        return std::ptr::null_mut();
    }
    let Some(app) = APP_HANDLE.get() else {
        return std::ptr::null_mut();
    };
    let model: Option<MenuModel> = app
        .try_state::<Shared>()
        .and_then(|s| s.last_menu.lock().ok().and_then(|g| g.clone()));
    let Some(model) = model else {
        return std::ptr::null_mut();
    };

    // 与 `tray::build_menu` 同文案/同 id（无 toggles/quit：Dock 自带 选项/退出）。
    let menu = Menu::new();
    let header = MenuItem::new(menu_text(&model.header), false, None);
    if menu.append(&header).is_err() {
        return std::ptr::null_mut();
    }
    if menu.append(&PredefinedMenuItem::separator()).is_err() {
        return std::ptr::null_mut();
    }
    for row in &model.rows {
        let item = IconMenuItem::with_id_and_native_icon(
            format!("{SESSION_PREFIX}{}", row.session_id),
            menu_text(&row.text()),
            row.enabled,
            Some(dock_status_icon(row.status)),
            None,
        );
        if menu.append(&item).is_err() {
            return std::ptr::null_mut();
        }
    }
    if !model.overflow.is_empty() {
        let mut built = Vec::with_capacity(model.overflow.len());
        for row in &model.overflow {
            built.push(IconMenuItem::with_id_and_native_icon(
                format!("{SESSION_PREFIX}{}", row.session_id),
                menu_text(&row.text()),
                row.enabled,
                Some(dock_status_icon(row.status)),
                None,
            ));
        }
        let refs: Vec<&dyn IsMenuItem> = built.iter().map(|b| b as &dyn IsMenuItem).collect();
        match Submenu::with_id_and_items(ITEM_MORE, "更多…", true, &refs) {
            Ok(more) => {
                if menu.append(&more).is_err() {
                    return std::ptr::null_mut();
                }
            }
            Err(_) => return std::ptr::null_mut(),
        }
    }
    if menu.append(&PredefinedMenuItem::separator()).is_err() {
        return std::ptr::null_mut();
    }
    let open = MenuItem::with_id(ITEM_OPEN_WINDOW, "打开主窗口", true, None);
    if menu.append(&open).is_err() {
        return std::ptr::null_mut();
    }

    let ptr = menu.ns_menu();
    LAST_DOCK_MENU.with(|cell| {
        *cell.borrow_mut() = Some(menu);
    });
    ptr
}

/// 会话状态 → 原生状态图标（与托盘菜单同映射）。
fn dock_status_icon(s: SessionStatus) -> muda::NativeIcon {
    match s {
        SessionStatus::Working => muda::NativeIcon::StatusAvailable,
        SessionStatus::WaitingInput => muda::NativeIcon::StatusPartiallyAvailable,
        SessionStatus::Stuck => muda::NativeIcon::StatusUnavailable,
        SessionStatus::Idle => muda::NativeIcon::StatusNone,
    }
}
