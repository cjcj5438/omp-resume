/** 外观与行为页：外观卡 + 菜单栏卡 + 更新卡 + 路径卡。 */
import {
  ACCENT_LABEL,
  ACCENT_SWATCH,
  ACCENTS,
  THEME_MODE_LABEL,
  THEME_MODES,
  type AccentName,
  type Appearance,
  type ThemeMode,
} from "../appearance";
import type { AppPrefs } from "../appPrefs";
import type { Route } from "../routes";
import type { AppPaths } from "../types";
import { getAppPaths } from "../api";
import { copyText } from "../clipboard";
import { openOmpChangelog } from "../format";
import type { ToastFn } from "./useOmpOp";
import { useTraySettings } from "../traySettings";
import { ErrorBanner, PageHeader, Switch } from "./page";
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

  return (
    <div className="view">
      <PageHeader
        kicker="设置"
        title="外观与行为"
        sub="外观偏好存于本机 WebView（开发版与 .app 不共享）；菜单栏设置写入 settings.json。"
      />
      <div className="settings-grid">
        <section className="panel" aria-label="外观">
          <div className="panel-head">
            <div className="panel-title">外观</div>
          </div>
          <div className="panel-body">
            <div className="theme-choice" role="radiogroup" aria-label="主题模式">
              {THEME_MODES.map((m) => (
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
                  <span className="theme-name">{THEME_MODE_LABEL[m]}</span>
                </button>
              ))}
            </div>
            <div className="setting-row settings-accent-row">
              <div>
                <div className="setting-label" id="settings-accent-label">
                  强调色
                </div>
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
          </div>
        </section>
        <section className="panel" aria-label="菜单栏">
          <div className="panel-head">
            <div className="panel-title">菜单栏</div>
            <span className="panel-meta">托盘图标</span>
          </div>
          {tray.error !== null && tray.settings === null ? (
            <div className="panel-body">
              <ErrorBanner error={tray.error} onRetry={tray.reload} />
            </div>
          ) : tray.settings !== null ? (
            <div className="panel-body flush">
              <Switch
                label="等待输入时通知"
                checked={tray.settings.notifyOnWaiting}
                disabled={tray.saving}
                onChange={(v) => void tray.update({ notifyOnWaiting: v })}
              />
              <Switch
                label="显示今日花费"
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
            </div>
          ) : (
            <div className="panel-body">
              <p className="muted">正在加载菜单栏设置…</p>
            </div>
          )}
          <div className="panel-foot">
            <span>徽标样式、面板宽度、状态预览与通知行为。</span>
            <button type="button" className="btn btn-small" onClick={() => onNavigate("tray")}>
              全部菜单栏设置
            </button>
          </div>
        </section>
      </div>
      <div className="settings-grid">
        <section className="panel" aria-label="更新">
          <div className="panel-head">
            <div className="panel-title">更新</div>
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
                  <PathRow label="占用锁目录" value={paths.data.ownersDir} onToast={onToast} />
                  <PathRow
                    label="提示词历史"
                    value={paths.data.historyDb}
                    onToast={onToast}
                  />
                  <PathRow label="记忆库" value={paths.data.memoryDir} onToast={onToast} />
                  <PathRow label="应用数据" value={paths.data.dataDir} onToast={onToast} />
                  <PathRow
                    label="omp 可执行文件"
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
    </div>
  );
}

function PathRow({
  label,
  value,
  onToast,
}: {
  label: string;
  value: AppPaths[keyof AppPaths];
  onToast: ToastFn;
}) {
  const copy = async () => {
    if (value === null) return;
    if (await copyText(value)) onToast("已复制路径", "info");
    else onToast("复制失败：剪贴板不可用", "error");
  };
  return (
    <tr>
      <td>{label}</td>
      <td>
        {value === null ? (
          <span className="muted">未找到</span>
        ) : (
          <code>{value}</code>
        )}
      </td>
      <td>
        {value === null ? null : (
          <button
            type="button"
            className="btn btn-small"
            aria-label={`复制${label}`}
            onClick={() => void copy()}
          >
            复制
          </button>
        )}
      </td>
    </tr>
  );
}
