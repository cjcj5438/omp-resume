/**
 * 顶部标题栏：折叠按钮 + 面包屑 + 全局搜索 + 主题切换。
 * 在文档流内（高 --titlebar-h），左内边距 84px 给原生红绿灯留位。
 * 只有标题栏本身和面包屑文字带 data-tauri-drag-region（Tauri 只认命中元素自身）。
 */
import { Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from "lucide-react";
import { ROUTE_TITLE, type Route } from "../../routes";
import { Ico } from "../ui";
import type { ResolvedTheme, ThemeMode } from "../../appearance";

interface TitlebarProps {
  route: Route;
  sessionName: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenPalette: () => void;
  resolved: ResolvedTheme;
  onSetMode: (m: ThemeMode) => void;
}

export function Titlebar({
  route,
  sessionName,
  collapsed,
  onToggleCollapse,
  onOpenPalette,
  resolved,
  onSetMode,
}: TitlebarProps) {
  const collapseLabel = collapsed ? "展开侧栏" : "折叠侧栏";
  const themeLabel = resolved === "dark" ? "切换到浅色主题" : "切换到深色主题";
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-left">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={collapseLabel}
          aria-expanded={!collapsed}
          title={collapseLabel + "（⌘B）"}
          onClick={onToggleCollapse}
        >
          <Ico icon={collapsed ? PanelLeftOpen : PanelLeftClose} size={16} />
        </button>
        <nav className="tb-title" aria-label="面包屑">
          <span data-tauri-drag-region>
            <span className="tb-app" data-tauri-drag-region>
              omp-resume
            </span>
            <span className="tb-sep" aria-hidden="true">
              {" / "}
            </span>
            <span className="tb-page">{ROUTE_TITLE[route]}</span>
            {route === "session" && sessionName !== null ? (
              <>
                <span className="tb-sep" aria-hidden="true">
                  {" / "}
                </span>
                <span className="tb-page">{sessionName}</span>
              </>
            ) : null}
          </span>
        </nav>
      </div>
      <div className="tb-right">
        <button type="button" className="tb-search" aria-label="全局搜索" onClick={onOpenPalette}>
          <Ico icon={Search} size={14} />
          <span>搜索会话与页面</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={themeLabel}
          onClick={() => onSetMode(resolved === "dark" ? "light" : "dark")}
        >
          <Ico icon={resolved === "dark" ? Sun : Moon} size={16} />
        </button>
      </div>
    </header>
  );
}
