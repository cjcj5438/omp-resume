/**
 * 主导航：品牌区 + NAV_GROUPS + 底部版本/更新行。根节点沿用 .sidebar 类，
 * 半透明材质规则继续生效。折叠时只留图标，悬停靠全局 ChartTip 显示 data-tip。
 */
import { RotateCw } from "lucide-react";
import { NAV_GROUPS, type Route } from "../../routes";
import { openOmpChangelog } from "../../format";
import { Ico } from "../ui";
import { ModePicker } from "../ModePicker";
import type { ToastFn } from "../useOmpOp";

interface NavSidebarProps {
  route: Route;
  collapsed: boolean;
  totalCount: number;
  appVersion: string | null;
  appChecking: boolean;
  ompVersion: string | null;
  ompChecking: boolean;
  onNavigate: (r: Route) => void;
  onCheckApp: () => void;
  onCheckOmp: () => void;
  onToast: ToastFn;
}

/** session 路由高亮「会话列表」；其余路由按自身高亮。 */
function activeRoute(route: Route): Route {
  return route === "session" ? "sessions" : route;
}

export function NavSidebar({
  route,
  collapsed,
  totalCount,
  appVersion,
  appChecking,
  ompVersion,
  ompChecking,
  onNavigate,
  onCheckApp,
  onCheckOmp,
  onToast,
}: NavSidebarProps) {
  const active = activeRoute(route);
  return (
    <aside className={collapsed ? "sidebar sidebar-collapsed" : "sidebar"} aria-label="主导航">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          π
        </span>
        {!collapsed ? (
          <span className="brand-text">
            <strong>omp-resume</strong>
            {appVersion !== null ? <span>v{appVersion}</span> : null}
          </span>
        ) : null}
      </div>
      <nav className="nav" aria-label="功能导航">
        {NAV_GROUPS.map((g) => (
          <div className="nav-group" key={g.label}>
            {!collapsed ? <div className="nav-label">{g.label}</div> : null}
            {g.items.map((item) => {
              const isActive = active === item.route;
              const count = item.route === "sessions" ? totalCount : null;
              const tip =
                count !== null ? item.label + "\n" + String(count) + " 个会话" : item.label;
              return (
                <button
                  key={item.route}
                  type="button"
                  className={isActive ? "nav-item is-active" : "nav-item"}
                  aria-current={isActive ? "page" : undefined}
                  data-tip={collapsed ? tip : undefined}
                  onClick={() => onNavigate(item.route)}
                >
                  <span className="nav-ico">
                    <Ico icon={item.icon} size={15} />
                  </span>
                  {!collapsed ? <span className="nav-text">{item.label}</span> : null}
                  {!collapsed && count !== null ? <span className="nav-count">{count}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <footer className="sidebar-foot">
        {collapsed ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="检查应用更新"
            data-tip={appVersion !== null ? "omp-resume " + appVersion + "\n检查应用更新" : "检查应用更新"}
            onClick={onCheckApp}
          >
            <Ico icon={RotateCw} size={15} />
          </button>
        ) : (
          <>
            <ModePicker onToast={onToast} />
            {appVersion !== null ? (
              <div className="footer-row">
                <span className="mono muted">omp-resume {appVersion}</span>
                <div className="footer-actions">
                  <button
                    type="button"
                    className="btn btn-small footer-update"
                    disabled={appChecking}
                    onClick={onCheckApp}
                  >
                    {appChecking ? <span className="spinner" aria-hidden="true" /> : null}
                    检查应用更新
                  </button>
                </div>
              </div>
            ) : null}
            {ompVersion !== null ? (
              <div className="footer-row">
                <span className="mono muted">omp {ompVersion}</span>
                <div className="footer-actions">
                  <button
                    type="button"
                    className="btn btn-small footer-update"
                    disabled={ompChecking}
                    onClick={onCheckOmp}
                  >
                    {ompChecking ? <span className="spinner" aria-hidden="true" /> : null}
                    检查 omp 更新
                  </button>
                  <button
                    type="button"
                    className="changelog-link"
                    title="在浏览器打开 omp 官方更新日志"
                    onClick={() => void openOmpChangelog()}
                  >
                    更新日志
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </footer>
    </aside>
  );
}
