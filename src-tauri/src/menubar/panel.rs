//! 菜单栏面板窗口：图标正下方的小弹出窗口（CONTRACT §17.11）。
//!
//! - 左键点击托盘图标 → [`toggle_panel`]：按 `titleWidth` 逻辑宽定位图标正下方；
//! - 定位是纯函数 [`panel_position`]（全 physical 运算，不碰 `scale_factor`），单测锁定；
//! - 失焦隐藏由 `lib.rs on_window_event` 执行，本模块只提供 250ms toggle/blur
//!   竞态守卫的时间戳读写（[`note_blur_hide`] / [`recently_blur_hidden`]）。

use tauri::{Manager, Runtime};

use super::settings::TitleWidth;

/// 面板窗口 label（`tauri.conf.json` 同名）。
pub const PANEL_LABEL: &str = "tray-panel";

/// 标题宽度 → 面板逻辑宽（px；与设计稿 `styles.css` 对齐）。
pub fn panel_width(title_width: TitleWidth) -> u32 {
    match title_width {
        TitleWidth::Compact => 316,
        TitleWidth::Standard => 356,
        TitleWidth::Wide => 396,
    }
}

/// toggle/blur 竞态守卫窗口（ms）：blur 隐藏后 250ms 内的 show 请求视为
/// 同一次点击的回弹，直接忽略（Esc/主动 toggle 的隐藏不记时间戳，不触发守卫）。
pub const BLUR_GUARD_MS: u128 = 250;

/// 面板定位的几何输入（全 physical 像素）：托盘图标框 / 面板尺寸 / 屏幕框。
#[derive(Debug, Clone, Copy)]
pub struct PanelGeom {
    /// 托盘图标框左上 (x, y)。
    pub icon_xy: (f64, f64),
    /// 托盘图标框尺寸 (w, h)。
    pub icon_wh: (f64, f64),
    /// 面板尺寸 (w, h)。
    pub panel_wh: (f64, f64),
    /// 屏幕框左上 (x, y)。
    pub screen_xy: (f64, f64),
    /// 屏幕框尺寸 (w, h)。
    pub screen_wh: (f64, f64),
}

/// 面板定位（纯函数，全 physical 像素）：以托盘图标框为基准居中，
/// 垂直紧贴图标下方，超出屏幕则向内钳制。
pub fn panel_position(g: PanelGeom) -> (f64, f64) {
    let (icon_x, icon_y) = g.icon_xy;
    let (icon_w, icon_h) = g.icon_wh;
    let (panel_w, panel_h) = g.panel_wh;
    let (screen_x, screen_y) = g.screen_xy;
    let (screen_w, screen_h) = g.screen_wh;
    let mut x = icon_x + (icon_w - panel_w) / 2.0;
    let mut y = icon_y + icon_h;
    x = x.clamp(screen_x, (screen_x + screen_w - panel_w).max(screen_x));
    y = y.clamp(screen_y, (screen_y + screen_h - panel_h).max(screen_y));
    (x.round(), y.round())
}

/// 左键 toggle 面板：可见则隐藏；隐藏（且不在 blur 守卫内）则定位后显示。
pub fn toggle_panel<R: Runtime>(app: &tauri::AppHandle<R>, rect: tauri::Rect) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    if recently_blur_hidden(app) {
        return;
    }
    let width = app
        .try_state::<super::tray::Shared>()
        .and_then(|s| s.settings.lock().ok().map(|g| panel_width(g.title_width)))
        .unwrap_or_else(|| panel_width(TitleWidth::Standard));
    let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
    let panel_w_phys = width as f64 * scale;
    // 高度取当前面板高（physical）：内容区内部滚动，窗口高固定。
    let panel_h_phys = window
        .outer_size()
        .map(|s| s.height as f64)
        .unwrap_or(620.0 * scale);
    let (mx, my, mw, mh) = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            (
                pos.x as f64,
                pos.y as f64,
                size.width as f64,
                size.height as f64,
            )
        })
        .unwrap_or((0.0, 0.0, 1920.0, 1080.0));
    // 事件 `rect` 是 Physical 变体（macOS `get_tray_rect` 转 physical 后装配，
    // 见 tray-icon `platform_impl/macos`）；用 `to_physical` 归一，防未来变体变化。
    let icon_pos: tauri::PhysicalPosition<f64> = rect.position.to_physical(scale);
    let icon_size: tauri::PhysicalSize<f64> = rect.size.to_physical(scale);
    let (x, y) = panel_position(PanelGeom {
        icon_xy: (icon_pos.x, icon_pos.y),
        icon_wh: (icon_size.width, icon_size.height),
        panel_wh: (panel_w_phys, panel_h_phys),
        screen_xy: (mx, my),
        screen_wh: (mw, mh),
    });
    let _ = window.set_size(tauri::PhysicalSize::new(
        panel_w_phys as u32,
        panel_h_phys as u32,
    ));
    let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    let _ = window.show();
    let _ = window.set_focus();
}

/// 记录一次 blur 触发的隐藏（`lib.rs on_window_event` 调用）。
pub fn note_blur_hide<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(shared) = app.try_state::<super::tray::Shared>() {
        if let Ok(mut guard) = shared.last_blur_hide.lock() {
            *guard = Some(std::time::Instant::now());
        }
    }
}

/// 距上次 blur 隐藏是否在守卫窗口内。
fn recently_blur_hidden<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.try_state::<super::tray::Shared>()
        .and_then(|s| s.last_blur_hide.lock().ok().and_then(|g| *g))
        .is_some_and(|t| t.elapsed().as_millis() < BLUR_GUARD_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_below_icon() {
        // 图标 (1000,0,24,22)，面板 356×620，屏幕 0,0,1920,1080。
        let (x, y) = panel_position(PanelGeom {
            icon_xy: (1000.0, 0.0),
            icon_wh: (24.0, 22.0),
            panel_wh: (356.0, 620.0),
            screen_xy: (0.0, 0.0),
            screen_wh: (1920.0, 1080.0),
        });
        assert_eq!((x, y), (834.0, 22.0));
    }

    #[test]
    fn clamps_to_screen_edges() {
        // 右缘：居中会越界 → 钳制到右缘。
        let (x, _) = panel_position(PanelGeom {
            icon_xy: (1900.0, 0.0),
            icon_wh: (24.0, 22.0),
            panel_wh: (356.0, 620.0),
            screen_xy: (0.0, 0.0),
            screen_wh: (1920.0, 1080.0),
        });
        assert_eq!(x, 1564.0);
        // 左缘：居中会越界 → 钳制到左缘。
        let (x, _) = panel_position(PanelGeom {
            icon_xy: (10.0, 0.0),
            icon_wh: (24.0, 22.0),
            panel_wh: (356.0, 620.0),
            screen_xy: (0.0, 0.0),
            screen_wh: (1920.0, 1080.0),
        });
        assert_eq!(x, 0.0);
        // 副屏偏移原点：居中 (1834,22) 越左缘 → 钳制到屏幕原点 (1920,22)。
        let (x, y) = panel_position(PanelGeom {
            icon_xy: (2000.0, 0.0),
            icon_wh: (24.0, 22.0),
            panel_wh: (356.0, 620.0),
            screen_xy: (1920.0, 0.0),
            screen_wh: (1920.0, 1080.0),
        });
        assert_eq!((x, y), (1920.0, 22.0));
    }

    #[test]
    fn width_mapping_matches_design() {
        assert_eq!(panel_width(TitleWidth::Compact), 316);
        assert_eq!(panel_width(TitleWidth::Standard), 356);
        assert_eq!(panel_width(TitleWidth::Wide), 396);
    }
}
