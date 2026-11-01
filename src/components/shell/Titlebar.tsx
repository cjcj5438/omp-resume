/**
 * 顶部标题栏：折叠按钮 + 面包屑 + 全局搜索 + 主题切换。
 * 在文档流内（高 --titlebar-h），左内边距 84px 给原生红绿灯留位。
 * 只有标题栏本身和面包屑文字带 data-tauri-drag-region（Tauri 只认命中元素自身）。
 */
import { Moon, Search, Sun } from "lucide-react";
import { ROUTE_TITLE, type Route } from "../../routes";
import { Ico } from "../ui";
import type { ResolvedTheme, ThemeMode } from "../../appearance";

interface TitlebarProps {
  route: Route;
  sessionName: string | null;
  /** 会话工作台 tab（fe-sessions 上提后传入）：决定 session 路由面包屑显示「会话概览/对话审阅/会话树」。 */
  sessionTab?: "overview" | "conv" | "tree";
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenPalette: () => void;
  resolved: ResolvedTheme;
  onSetMode: (m: ThemeMode) => void;
}

const SESSION_TAB_TITLE = { overview: "会话概览", conv: "对话审阅", tree: "会话树" } as const;

/** 浏览器预览（?mock）时画装饰红绿灯；Tauri 下原生红绿灯占位，不画（T1）。 */
function showMockLights(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("mock")
  );
}

export function Titlebar({
  route,
  sessionName,
  sessionTab,
  collapsed,
  onToggleCollapse,
  onOpenPalette,
  resolved,
  onSetMode,
}: TitlebarProps) {
  const collapseLabel = collapsed ? "展开侧栏" : "折叠侧栏";
  const themeLabel = resolved === "dark" ? "切换到浅色主题" : "切换到深色主题";
  // T7：session 路由显示当前 tab 名（设计稿 app.js:219-220）；未上提时回退「会话」。
  const pageName = route === "session" && sessionTab !== undefined ? SESSION_TAB_TITLE[sessionTab] : ROUTE_TITLE[route];
  return (
    <header className={showMockLights() ? "titlebar has-lights" : "titlebar"} data-tauri-drag-region>
      <div className="tb-left">
        {showMockLights() ? (
          <div className="lights" aria-hidden="true">
            <span className="light red" />
            <span className="light yellow" />
            <span className="light green" />
          </div>
        ) : null}
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={collapseLabel}
          aria-expanded={!collapsed}
          title={collapseLabel + "（⌘B）"}
          onClick={onToggleCollapse}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" width="16" height="16">
            <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
            <path d="M9.5 4.5v15" />
            <path className="st-arrow" d="M15.6 10.2 13.8 12l1.8 1.8" />
          </svg>
        </button>
        <nav className="tb-title" aria-label="面包屑">
          <span data-tauri-drag-region>
            <span className="tb-app" data-tauri-drag-region>
              omp-resume
            </span>
            <span className="tb-sep" aria-hidden="true">
              {" / "}
            </span>
            <span className="tb-page">{pageName}</span>
            {route === "session" && sessionTab === undefined && sessionName !== null ? (
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
