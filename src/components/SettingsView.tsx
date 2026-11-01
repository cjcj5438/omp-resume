/** 外观与行为页：外观卡 + 菜单栏卡 + 更新卡 + 路径卡 + 关于卡。 */
import { Check, RefreshCw } from "lucide-react";
import {
  ACCENT_LABEL,
  ACCENT_SWATCH,
  ACCENTS,
  THEME_MODE_LABEL,
  type AccentName,
  type Appearance,
  type ThemeMode,
} from "../appearance";
import type { AppPrefs } from "../appPrefs";
import type { Route } from "../routes";
import type { BuildInfo } from "../types";
import { getAppPaths, getBuildInfo } from "../api";
import { copyText } from "../clipboard";
import { openOmpChangelog } from "../format";
import type { ToastFn } from "./useOmpOp";
import { useTraySettings } from "../traySettings";
import { ErrorBanner, PageHeader, Switch } from "./page";
import { Badge, Ico } from "./ui";
import { useAsyncData } from "./useAsyncData";
import "./SettingsView.css";

interface SettingsViewProps {
  appearance: Appearance;
  onSetMode: (m: ThemeMode) => void;
  onSetAccent: (a: AccentName) => void;
  prefs: AppPrefs;
  onPrefs: (p: AppPrefs) => void;
  appVersion: string | null;
  appChecking: boolean;
  ompVersion: string | null;
  ompChecking: boolean;
  onCheckApp: () => void;
  onCheckOmp: () => void;
  onNavigate: (r: Route) => void;
  onToast: ToastFn;
}

/** 主题卡本地渲染顺序（设计稿 [深色, 浅色, 跟随系统]；不动 appearance.ts 的 THEME_MODES）。 */
const THEME_ORDER: ThemeMode[] = ["dark", "light", "system"];

/** `$HOME` → `~` 折叠（展示用；复制用完整路径）。 */
function abbreviateHome(path: string): string {
  // 浏览器/mock 环境：按 `/Users/<name>/` 前缀折叠。
  const m = path.match(/^\/Users\/[^/]+\//);
  if (m !== null) return `~/${path.slice(m[0].length)}`;
  return path;
}

/** `BuildInfo` → 展示文案（`macOS arm64 · Tauri 2`）。 */
function buildText(info: BuildInfo | null): string {
  if (info === null) return "…";
  const os = info.os === "macos" ? "macOS" : info.os;
  const arch = info.arch === "aarch64" ? "arm64" : info.arch === "x86_64" ? "x64" : info.arch;
  return `${os} ${arch} · Tauri 2`;
}

export function SettingsView({
  appearance,
  onSetMode,
  onSetAccent,
  prefs,
  onPrefs,
  appVersion,
  appChecking,
  ompVersion,
  ompChecking,
  onCheckApp,
  onCheckOmp,
  onNavigate,
  onToast,
}: SettingsViewProps) {
  const tray = useTraySettings(onToast);
  const paths = useAsyncData(getAppPaths, []);
  const build = useAsyncData(getBuildInfo, []);

  const copyVersion = (): void => {
    void copyText(`omp-resume ${appVersion ?? "未知版本"}`).then((ok) =>
      onToast(ok ? "已复制版本" : "复制失败", ok ? "info" : "error"),
    );
  };

  return (
    <div className="view">
      <PageHeader
        kicker="设置"
        title="外观与行为"
        sub="主题、菜单栏与路径。所有偏好只存在本机；WebView 的 localStorage 与 .app 之间不共享。"
        actions={
          <button type="button" className="btn btn-ghost" disabled={appChecking} onClick={onCheckApp}>
            <Ico icon={RefreshCw} size={14} />
            检查更新
          </button>
        }
      />
      <div className="settings-grid">
        <section className="panel" aria-label="外观">
          <div className="panel-head">
            <div className="panel-title">外观</div>
            <span className="panel-meta">系统 / 深色 / 浅色</span>
          </div>
          <div className="panel-body">
            <div className="theme-choice" role="radiogroup" aria-label="主题模式">
              {THEME_ORDER.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={appearance.mode === m}
                  className={appearance.mode === m ? "theme-card is-on" : "theme-card"}
                  onClick={() => onSetMode(m)}
                >
                  <span
                    className={
                      m === "dark" ? "theme-preview tp-dark" : "theme-preview tp-light"
                    }
                    aria-hidden="true"
                  >
                    <i className={m === "dark" ? "tp-side tp-dark" : "tp-side tp-light"} />
                    <i className={m === "dark" ? "tp-body tp-dark" : "tp-body tp-light"}>
                      <i className="tp-line w" />
                      <i className="tp-line" />
                      <i className="tp-line w" />
                    </i>
                  </span>
                  <span className="theme-name">
                    {THEME_MODE_LABEL[m]}
                    {appearance.mode === m ? <Ico icon={Check} size={14} /> : null}
                  </span>
                </button>
              ))}
            </div>
            <div className="setting-row settings-accent-row">
              <div>
                <div className="setting-label" id="settings-accent-label">
                  强调色
                </div>
                <div className="setting-desc">仅作用于本机 WebView，不影响原生菜单。</div>
              </div>
              <div className="accent-row" role="group" aria-labelledby="settings-accent-label">
                {ACCENTS.map((a) => {
                  const selected = appearance.accent === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      className="accent-swatch"
                      style={{ background: ACCENT_SWATCH[a] }}
                      aria-pressed={selected}
                      aria-label={`强调色：${ACCENT_LABEL[a]}`}
                      title={ACCENT_LABEL[a]}
                      onClick={() => onSetAccent(a)}
                    >
                      {selected ? <span aria-hidden="true">✓</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">侧边栏材质</div>
                <div className="setting-desc">深色主题下侧栏透明，浅色主题下保持实色。</div>
              </div>
              <Badge tone="quiet">跟随主题</Badge>
            </div>
          </div>
        </section>
        <section className="panel" aria-label="菜单栏">
          <div className="panel-head">
            <div className="panel-title">菜单栏</div>
            <span className="panel-meta">托盘图标</span>
          </div>
          <div className="panel-body flush">
            <div className="setting-row">
              <div>
                <div className="setting-label">图标、面板与快捷动作</div>
                <div className="setting-desc">徽标样式、面板宽度、状态预览与通知行为。</div>
              </div>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => onNavigate("tray")}>
                打开菜单栏设计
              </button>
            </div>
            {tray.error !== null && tray.settings === null ? (
              <ErrorBanner error={tray.error} onRetry={tray.reload} />
            ) : tray.settings !== null ? (
              <>
                <Switch
                  label="等待输入时通知"
                  description="会话进入 waiting for input 状态时发送系统通知"
                  checked={tray.settings.notifyOnWaiting}
                  disabled={tray.saving}
                  onChange={(v) => void tray.update({ notifyOnWaiting: v })}
                />
                <Switch
                  label="显示今日花费"
                  description="从 usage 记录汇总，不额外请求网络"
                  checked={tray.settings.showCost}
                  disabled={tray.saving}
                  onChange={(v) => void tray.update({ showCost: v })}
                />
                <Switch
                  label="在 Dock 显示图标"
                  checked={tray.settings.showDockIcon}
                  disabled={tray.saving}
                  onChange={(v) => void tray.update({ showDockIcon: v })}
                />
              </>
            ) : (
              <p className="muted">正在加载菜单栏设置…</p>
            )}
          </div>
          <div className="panel-foot">
            <span>托盘不会终止进程，也不会向已有标签页输入按键。</span>
          </div>
        </section>
      </div>
      <div className="settings-grid">
        <section className="panel" aria-label="更新">
          <div className="panel-head">
            <div className="panel-title">更新</div>
            <span className="panel-meta">Tauri updater</span>
          </div>
          <div className="panel-body flush">
            <Switch
              label="启动时自动检查应用更新"
              checked={prefs.checkUpdateOnLaunch}
              onChange={(v) => onPrefs({ ...prefs, checkUpdateOnLaunch: v })}
            />
            <div className="setting-row">
              <div>
                <div className="setting-label">
                  omp-resume {appVersion ?? "未知版本"}
                </div>
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={appChecking}
                  onClick={onCheckApp}
                >
                  {appChecking ? <span className="spinner" aria-hidden="true" /> : null}
                  检查应用更新
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">omp {ompVersion ?? "未知版本"}</div>
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn btn-small"
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
          </div>
        </section>
        <section className="panel" aria-label="路径">
          <div className="panel-head">
            <div className="panel-title">路径</div>
            <span className="panel-meta">全部可在启动参数覆盖</span>
          </div>
          {paths.error !== null ? (
            <div className="panel-body">
              <ErrorBanner error={paths.error} onRetry={paths.reload} />
            </div>
          ) : paths.data === null ? (
            <div className="panel-body">
              <p className="muted">正在加载路径…</p>
            </div>
          ) : (
            <div className="panel-body">
              <table className="path-table">
                <tbody>
                  <PathRow
                    label="会话目录"
                    value={paths.data.sessionsDir}
                    onToast={onToast}
                  />
                  <PathRow label="所有权锁" value={paths.data.ownersDir} onToast={onToast} />
                  <PathRow
                    label="提示词历史"
                    value={paths.data.historyDb}
                    onToast={onToast}
                  />
                  <PathRow label="记忆库" value={paths.data.memoryDir} onToast={onToast} />
                  <PathRow label="应用数据" value={paths.data.dataDir} onToast={onToast} />
                  <PathRow
                    label="omp 二进制"
                    value={paths.data.ompBin}
                    onToast={onToast}
                  />
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-foot">
            <span>可用 OMP_RESUME_* 环境变量覆盖，见 README「Configuration」</span>
          </div>
        </section>
      </div>
      <section className="panel" aria-label="关于">
        <div className="panel-head">
          <div className="panel-title">关于</div>
          <span className="panel-meta">v{appVersion ?? "…"}</span>
        </div>
        <div className="panel-body">
          <dl className="detail-list">
            <div className="detail-row">
              <dt>版本</dt>
              <dd className="mono">{appVersion ?? "…"}</dd>
            </div>
            <div className="detail-row">
              <dt>构建</dt>
              <dd className="mono">{buildText(build.data ?? null)}</dd>
            </div>
            <div className="detail-row">
              <dt>omp</dt>
              <dd className="mono">{ompVersion ?? "…"}</dd>
            </div>
            <div className="detail-row">
              <dt>遥测</dt>
              <dd>关闭 · 无分析</dd>
            </div>
          </dl>
          {build.error !== null ? <ErrorBanner error={build.error} onRetry={build.reload} /> : null}
          <div className="settings-about-actions">
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={appChecking}
              onClick={onCheckApp}
            >
              检查更新
            </button>
            <button type="button" className="btn btn-quiet btn-small" onClick={copyVersion}>
              复制版本
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PathRow({
  label,
  value,
  onToast,
}: {
  label: string;
  value: string | null;
  onToast: ToastFn;
}): React.JSX.Element {
  if (value === null) {
    return (
      <tr>
        <td>{label}</td>
        <td>
          <span className="muted">未找到</span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{label}</td>
      <td>
        <code title={value}>{abbreviateHome(value)}</code>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          aria-label={`复制${label}`}
          onClick={() =>
            void copyText(value).then((ok) => onToast(ok ? "已复制" : "复制失败", ok ? "info" : "error"))
          }
        >
          复制
        </button>
      </td>
    </tr>
  );
}

/** 测试用导出。 */
export { abbreviateHome, buildText };
