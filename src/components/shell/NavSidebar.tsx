/**
 * 主导航：品牌区 + NAV_GROUPS + 底部版本/更新行。根节点沿用 .sidebar 类，
 * 半透明材质规则继续生效。折叠时只留图标，悬停显示锚定式 flyout（含计数）。
 */
import { useEffect, useRef, useState } from "react";
import { NAV_GROUPS, type Route } from "../../routes";
import { openOmpChangelog } from "../../format";
import { Ico } from "../ui";

/** 应用更新检查结论（App 侧最近一次手动检查；null = 未检查）。 */
export interface AppCheckResult {
  status: "ok" | "fail";
  version: string | null;
}

/** omp 更新检查结论（null = 未检查；不可识别输出记 fail）。 */
export interface OmpCheckResult {
  status: "ok" | "new" | "fail";
  version: string | null;
}

interface NavSidebarProps {
  route: Route;
  collapsed: boolean;
  totalCount: number;
  appVersion: string | null;
  buildInfo?: { os: string; arch: string } | null;
  appChecking: boolean;
  appCheckResult: AppCheckResult | null;
  /** 待安装的应用新版本（update 对话框未关闭时非 null）。 */
  appUpdateVersion: string | null;
  ompVersion: string | null;
  ompChecking: boolean;
  ompCheckResult: OmpCheckResult | null;
  onNavigate: (r: Route) => void;
  onCheckApp: () => void;
  onCheckOmp: () => void;
}

/** session 路由高亮「会话列表」；其余路由按自身高亮。 */
function activeRoute(route: Route): Route {
  return route === "session" ? "sessions" : route;
}

/** os/arch → 展示名（macos/aarch64 → macOS arm64；未知值原样）。 */
function platformLabel(os: string, arch: string): string {
  const osName = os === "macos" ? "macOS" : os === "windows" ? "Windows" : os === "linux" ? "Linux" : os;
  const archName = arch === "aarch64" ? "arm64" : arch === "x86_64" ? "x64" : arch;
  return `${osName} ${archName}`;
}

interface Flyout {
  label: string;
  count: string;
  left: number;
  top: number;
}

/** 折叠导航锚定式 flyout：按钮右侧卡片 + 左箭头 + 计数（设计稿 nav-flyout，N6）。 */
function useNavFlyout(collapsed: boolean): { flyout: Flyout | null; showFor: (btn: HTMLElement) => void; hide: () => void } {
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const hide = (): void => setFlyout(null);
  useEffect(() => {
    if (!collapsed) setFlyout(null);
  }, [collapsed]);
  const showFor = (btn: HTMLElement): void => {
    if (!collapsed) return;
    const label = btn.getAttribute("aria-label") ?? btn.getAttribute("title") ?? "";
    if (label === "") return;
    const count = btn.querySelector(".nav-count")?.textContent?.trim() ?? "";
    const r = btn.getBoundingClientRect();
    // 先按估计宽定位，渲染后用 ref 修正（宽 ≤260，见 CSS max-width）。
    const estW = Math.min(260, 20 + label.length * 12 + (count === "" ? 0 : 40));
    let left = r.right + 10;
    if (left + estW > window.innerWidth - 8) left = r.left - estW - 10;
    const estH = 32;
    const top = Math.max(8, Math.min(r.top + r.height / 2 - estH / 2, window.innerHeight - estH - 8));
    setFlyout({ label, count, left: Math.round(left), top: Math.round(top) });
  };
  return { flyout, showFor, hide };
}
/** update-row 五态：检查中 > 有新版 > 检查失败 > 已是最新 > 未检查。 */
type UpdateStatus =
  | { kind: "checking" }
  | { kind: "new"; version: string }
  | { kind: "fail" }
  | { kind: "ok" }
  | { kind: "idle" };

function updateStatusOf(args: {
  appChecking: boolean;
  ompChecking: boolean;
  appUpdateVersion: string | null;
  appCheckResult: AppCheckResult | null;
  ompCheckResult: OmpCheckResult | null;
}): UpdateStatus {
  const { appChecking, ompChecking, appUpdateVersion, appCheckResult, ompCheckResult } = args;
  if (appChecking || ompChecking) return { kind: "checking" };
  // 任一端有新版即提示（应用待安装版优先：对话框开着时版本已知）。
  if (appUpdateVersion !== null) return { kind: "new", version: appUpdateVersion };
  if (ompCheckResult?.status === "new" && ompCheckResult.version !== null) {
    return { kind: "new", version: ompCheckResult.version };
  }
  if (appCheckResult?.status === "fail" || ompCheckResult?.status === "fail") return { kind: "fail" };
  // 两端都确认最新（或一端确认最新、另一端未检查）才报最新；任一端未检查则整体未检查。
  if (appCheckResult?.status === "ok" && (ompCheckResult === null || ompCheckResult.status === "ok")) {
    return { kind: "ok" };
  }
  if (ompCheckResult?.status === "ok" && appCheckResult === null) return { kind: "ok" };
  return { kind: "idle" };
}


export function NavSidebar({
  route,
  collapsed,
  totalCount,
  appVersion,
  buildInfo,
  appChecking,
  appCheckResult,
  appUpdateVersion,
  ompVersion,
  ompChecking,
  ompCheckResult,
  onNavigate,
  onCheckApp,
  onCheckOmp,
}: NavSidebarProps) {
  const active = activeRoute(route);
  const { flyout, showFor, hide } = useNavFlyout(collapsed);
  const flyoutRef = useRef<HTMLDivElement>(null);
  // 渲染后用真实尺寸修正位置（估计宽可能偏大导致溢出）。
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = flyoutRef.current;
    if (el === null || flyout === null) {
      if (flyout === null) setFlyoutPos(null);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setFlyoutPos({
      left: Math.min(flyout.left, window.innerWidth - w - 8),
      top: Math.max(8, Math.min(flyout.top, window.innerHeight - h - 8)),
    });
  }, [flyout]);
  return (
    <aside className={collapsed ? "sidebar sidebar-collapsed" : "sidebar"} aria-label="主导航">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="18" height="16" rx="4" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 9.5h5M7 13h10M7 16.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        {!collapsed ? (
          <span className="brand-text">
            <strong>omp-resume</strong>
            {appVersion !== null ? (
              <span>{buildInfo ? `${appVersion} · ${platformLabel(buildInfo.os, buildInfo.arch)}` : `v${appVersion}`}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <nav className="nav" aria-label="功能导航" onMouseLeave={hide}>
        {NAV_GROUPS.map((g) => (
          <div className="nav-group" key={g.label}>
            {!collapsed ? <div className="nav-label">{g.label}</div> : null}
            {g.items.map((item) => {
              const isActive = active === item.route;
              const count = item.route === "sessions" ? totalCount : null;
              return (
                <button
                  key={item.route}
                  type="button"
                  className={isActive ? "nav-item is-active" : "nav-item"}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => onNavigate(item.route)}
                  onMouseEnter={(e) => showFor(e.currentTarget)}
                  onFocus={(e) => showFor(e.currentTarget)}
                  onMouseLeave={hide}
                  onBlur={hide}
                >
                  <span className="nav-ico">
                    <Ico icon={item.icon} size={15} />
                  </span>
                  {!collapsed ? <span className="nav-text">{item.label}</span> : null}
                  {/* 计数常驻 DOM（折叠时 CSS 隐藏）：flyout 读它显示计数。 */}
                  {count !== null ? <span className="nav-count" aria-hidden={collapsed}>{count}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <footer className="sidebar-foot">
        {(() => {
          const status = updateStatusOf({ appChecking, ompChecking, appUpdateVersion, appCheckResult, ompCheckResult });
          const checking = status.kind === "checking";
          const label =
            status.kind === "checking"
              ? "正在检查…"
              : status.kind === "new"
                ? `发现新版 ${status.version}`
                : status.kind === "fail"
                  ? "检查失败"
                  : status.kind === "ok"
                    ? "已是最新版本"
                    : "检查更新";
          const dotClass =
            status.kind === "new" ? "dot warn" : status.kind === "fail" ? "dot bad" : status.kind === "ok" ? "dot ok" : "dot";
          const title = ompVersion !== null ? `${label} · omp ${ompVersion}` : label;
          if (collapsed) {
            return (
              <button
                type="button"
                className="update-dot"
                aria-label={label}
                title={title}
                disabled={checking}
                onClick={() => {
                  onCheckApp();
                  onCheckOmp();
                }}
              >
                {checking ? <span className="spinner" aria-hidden="true" /> : <span className={dotClass} aria-hidden="true" />}
              </button>
            );
          }
          return (
            <>
              <button
                type="button"
                className="update-row"
                title={title}
                aria-label={label}
                disabled={checking}
                onClick={() => {
                  onCheckApp();
                  onCheckOmp();
                }}
              >
                {checking ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <span className={dotClass} aria-hidden="true" />
                )}
                <span className={status.kind === "new" ? "ver-new" : status.kind === "fail" ? "ver-fail" : status.kind === "ok" ? "ver-ok" : undefined}>{label}</span>
                {ompVersion !== null ? (
                  <>
                    <span className="meta-dot" aria-hidden="true">·</span>
                    <span className="muted">omp {ompVersion}</span>
                  </>
                ) : null}
              </button>
              <div className="foot-note">
                {appVersion !== null ? <span>omp-resume {appVersion}</span> : <span>本地会话 · 只读浏览</span>}
                <button
                  type="button"
                  className="changelog-link"
                  title="在浏览器打开 omp 官方更新日志"
                  onClick={() => void openOmpChangelog()}
                >
                  更新日志
                </button>
              </div>
            </>
          );
        })()}
      </footer>
      {flyout !== null ? (
        <div
          className="nav-flyout is-on"
          ref={flyoutRef}
          role="tooltip"
          style={{ left: flyoutPos?.left ?? flyout.left, top: flyoutPos?.top ?? flyout.top }}
        >
          <span>{flyout.label}</span>
          {flyout.count === "" ? null : <span className="nav-flyout-count">{flyout.count}</span>}
        </div>
      ) : null}
    </aside>
  );
}
