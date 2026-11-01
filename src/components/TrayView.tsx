/** 菜单栏页：左侧画布（macOS 菜单栏条 + 真实面板组件 + 说明）与状态判定，右侧三张设置卡。 */
import { useEffect, useState } from "react";
import {
  Activity,
  Clock,
  Cpu,
  ExternalLink,
  Info,
  List,
  PanelTop,
} from "lucide-react";
import type { SessionSummary } from "../types";
import type { ToastFn } from "./useOmpOp";
import type { TrayBadgeStyle, TrayClickAction, TrayTitleWidth } from "../types";
import { getOmpVersion, openMainWindow } from "../api";
import { getVersion } from "@tauri-apps/api/app";
import { ErrorBanner, PageHeader, Panel, Seg, Switch } from "./page";
import { Ico } from "./ui";
import { useTrayPreview, useTraySettings } from "../traySettings";
import { TRAY_STATUS_NAME, TrayMark, TrayPanel, type TrayPanelActions } from "./TrayPanel";
import { ModePicker } from "./ModePicker";
import "./TrayView.css";

/** 徽标档位：live 用真实 title，其余用后端 badge_samples。 */
type TrayStateTab = "live" | "working" | "waiting" | "idle" | "stuck";

const STATE_TABS: { key: TrayStateTab; label: string }[] = [
  { key: "live", label: "实时" },
  { key: "working", label: "工作中" },
  { key: "waiting", label: "等待输入" },
  { key: "idle", label: "空闲" },
  { key: "stuck", label: "异常" },
];

/** 档位 → 样例状态 key（live 无样例，走真实 title）。 */
const TAB_SAMPLE_STATE: Partial<Record<TrayStateTab, string>> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  stuck: "stuck",
};

/** TRAY_STATE_COPY：档位说明（设计稿 views-tools.js:232-238，stuck 已是「可能卡住」口径）。 */
const STATE_COPY: Record<TrayStateTab, string> = {
  live: "运行中与等待输入同时显示，例如 2·1。",
  working: "只显示运行中数量，适合快速扫一眼。",
  waiting: "只强调等待输入，不让运行中数字干扰。",
  idle: "全部空闲时收起数字，让菜单栏保持安静。",
  stuck: "探测到可能卡住时显示红色感叹号。",
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 真实时钟（每周一分钟 tick）：`周X HH:MM`。 */
function useMenuClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[now.getDay()]} ${hh}:${mm}`;
}

interface TrayViewProps {
  sessions: SessionSummary[];
  onOpenSession: (path: string) => void;
  onToast: ToastFn;
}

export function TrayView({ sessions, onOpenSession, onToast }: TrayViewProps) {
  const { settings, error, saving, reload, update } = useTraySettings(onToast);
  // 设置对象变化（本地写回或事件同步）→ 预览立即重拉。
  const { preview, error: previewError } = useTrayPreview(settings);
  const [tab, setTab] = useState<TrayStateTab>("live");
  const clock = useMenuClock();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [ompVersion, setOmpVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    getOmpVersion()
      .then((v) => setOmpVersion(v.version))
      .catch(() => {});
  }, []);
  const ready = settings !== null && error === null;
  const disabled = !ready || saving;

  // 预览模式动作：行点击跳工作台；其余动作为空（预览内不做真操作）。
  const previewActions: TrayPanelActions = {
    onFocusSession: (sessionId) => {
      const target = byId.get(sessionId);
      if (target !== undefined) onOpenSession(target.path);
    },
    onResumeRecent: () => {},
    onNewSession: () => {},
    onOpenMain: () => {},
    onOpenSettings: () => {},
    onSwitchMode: () => {},
    onQuit: () => {},
  };

  const sampleTitle =
    tab === "live"
      ? (preview?.trayTitle ?? null)
      : (preview?.badgeSamples.find((s) => s.state === TAB_SAMPLE_STATE[tab])?.title ?? null);
  const slotClass = `mb-slot is-open${tab === "idle" ? " is-idle" : ""}${tab === "stuck" ? " is-stuck" : ""}`;
  const badgeText =
    tab === "live"
      ? sampleTitle
      : (preview?.badgeSamples.find((s) => s.state === TAB_SAMPLE_STATE[tab])?.title ?? null);

  return (
    <div className="view">
      <PageHeader
        kicker="Menu Bar"
        title="菜单栏"
        sub="不用离开当前工作，就能看到哪些会话在跑、哪些在等人。图标状态、面板内容与通知行为都在这里调整。"
        actions={
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void openMainWindow().catch(() => {})}
          >
            <Ico icon={ExternalLink} size={14} />
            打开主窗口
          </button>
        }
      />
      <div className="tray-workbench">
        <div className="tray-left">
          <section className="tray-canvas" aria-label="菜单栏预览">
            <div className="menubar-mock">
              <div className="mb-left">
                <span className="mb-app">omp-resume</span>
                <span>文件</span>
                <span>编辑</span>
                <span>会话</span>
                <span>窗口</span>
                <span>帮助</span>
              </div>
              <div className="mb-right">
                <span className="mb-sys" aria-hidden="true">
                  <svg className="mb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                    <path d="M3.5 8.8a13 13 0 0 1 17 0" />
                    <path d="M6.5 12.4a8.5 8.5 0 0 1 11 0" />
                    <path d="M9.6 16a4 4 0 0 1 4.8 0" />
                    <circle cx="12" cy="19" r=".9" fill="currentColor" stroke="none" />
                  </svg>
                </span>
                <span className="mb-sys" aria-hidden="true">
                  <svg className="mb-ico" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="2" y="8.5" width="19" height="9" rx="2.5" />
                    <rect x="4" y="10.5" width="13" height="5" rx="1.2" fill="currentColor" stroke="none" />
                    <path d="M23.5 11.5v3" />
                  </svg>
                </span>
                <span className="mb-clock">{clock}</span>
                <span className={slotClass} aria-label="omp-resume 菜单栏">
                  <span className="mb-mark">
                    <TrayMark />
                  </span>
                  {settings?.badgeStyle !== "icon" && badgeText !== null && badgeText !== "" ? (
                    <span className="mb-count">{badgeText}</span>
                  ) : null}
                  {settings?.badgeStyle === "dot" ? (
                    <span
                      className={`mb-dot${tab === "stuck" ? " bad" : tab === "waiting" ? " warn" : tab === "idle" ? " idle" : ""}`}
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
              </div>
            </div>

            <div className="tray-pop-slot">
              {previewError !== null ? (
                <ErrorBanner error={previewError} />
              ) : preview !== null && settings !== null ? (
                <TrayPanel
                  preview={preview}
                  settings={settings}
                  mode="preview"
                  actions={previewActions}
                  appVersion={appVersion}
                  ompVersion={ompVersion}
                  switchingMode={null}
                />
              ) : (
                <p className="muted">正在加载预览…</p>
              )}
              {preview !== null && !preview.ready ? (
                <p className="tray-notice">菜单栏尚未完成首轮检测</p>
              ) : null}
            </div>

            <div className="tray-desk-note">
              <Ico icon={Info} size={14} />
              <span>
                徽标 <b>{preview?.trayTitle ?? "–"}</b> 表示运行中与等待输入的会话数。状态来自独占锁与
                JSONL 尾部，不依赖文件修改时间。
              </span>
            </div>
          </section>

          <Panel title="状态判定" icon={Activity} meta="flock + tail" foot={<span>不会终止进程，也不会向已有标签页输入按键。</span>}>
            <div className="tray-legend">
              <LegendRow dot="ok" name="工作中" desc="标题在转圈、有子代理在跑或工具执行中" />
              <LegendRow dot="warn" name="等待输入" desc="回合结束 30 分钟内，或疑似在等审批" />
              <LegendRow dot="" name="空闲" desc="超过 30 分钟无动作" />
              <LegendRow dot="bad" name="可能卡住" desc="工具调用超过 10 分钟没有进展" />
            </div>
          </Panel>
        </div>

        <aside className="tray-config">
          {error !== null && settings === null ? (
            <ErrorBanner error={error} onRetry={reload} />
          ) : settings !== null ? (
            <>
              <Panel title="图标" icon={PanelTop} meta="菜单栏右侧">
                <div className="tray-settings">
                  <div className="tray-setting-block">
                    <div className="tray-set-label">徽标样式</div>
                    <Seg<TrayBadgeStyle>
                      label="徽标样式"
                      value={settings.badgeStyle}
                      disabled={disabled}
                      onChange={(v) => void update({ badgeStyle: v })}
                      options={[
                        { value: "count", label: "计数" },
                        { value: "dot", label: "圆点" },
                        { value: "icon", label: "仅图标" },
                      ]}
                    />
                  </div>
                  <div className="tray-setting-block">
                    <div className="tray-set-label">状态预览</div>
                    <div className="tray-states" role="group" aria-label="状态预览">
                      {STATE_TABS.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          className={tab === t.key ? "tray-state is-on" : "tray-state"}
                          aria-pressed={tab === t.key}
                          onClick={() => setTab(t.key)}
                        >
                          <span className={`tray-state-dot ${t.key}`} aria-hidden="true" />
                          <span>{t.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="tray-icon-preview">
                    <span className="tray-preview-slot" aria-hidden="true">
                      <span className="mb-mark">
                        <TrayMark />
                      </span>
                      {settings.badgeStyle !== "icon" && badgeText !== null && badgeText !== "" ? (
                        <span className="mb-count">{badgeText}</span>
                      ) : null}
                      {settings.badgeStyle === "dot" ? (
                        <span
                          className={`mb-dot${tab === "stuck" ? " bad" : tab === "waiting" ? " warn" : tab === "idle" ? " idle" : ""}`}
                        />
                      ) : null}
                    </span>
                    <span className="tray-preview-copy">{STATE_COPY[tab]}</span>
                  </div>
                </div>
              </Panel>

              <Panel title="面板内容" icon={List} meta="实时预览">
                <div className="tray-setting-block">
                  <div className="tray-set-label">面板宽度</div>
                  <Seg<TrayTitleWidth>
                    label="面板宽度"
                    value={settings.titleWidth}
                    disabled={disabled}
                    onChange={(v) => void update({ titleWidth: v })}
                    options={[
                      { value: "compact", label: "紧凑" },
                      { value: "standard", label: "标准" },
                      { value: "wide", label: "宽" },
                    ]}
                  />
                  <p className="tray-width-note">
                    原生菜单按标题截断 20 / 32 / 48 字；面板按逻辑宽 316 / 356 / 396px。
                  </p>
                </div>
                <div>
                  <Switch
                    label="显示搜索框"
                    description="在面板顶部按会话标题或项目过滤"
                    checked={settings.showSearch}
                    disabled={disabled}
                    onChange={(v) => void update({ showSearch: v })}
                  />
                  <Switch
                    label="显示今日花费"
                    description="从 usage 记录汇总，不额外请求网络"
                    checked={settings.showCost}
                    disabled={disabled}
                    onChange={(v) => void update({ showCost: v })}
                  />
                  <Switch
                    label="显示项目名"
                    description="在状态后面补充会话所属项目"
                    checked={settings.showProject}
                    disabled={disabled}
                    onChange={(v) => void update({ showProject: v })}
                  />
                  <Switch
                    label="显示空闲会话"
                    description="关闭后只保留正在运行与等待输入的会话"
                    checked={settings.showIdle}
                    disabled={disabled}
                    onChange={(v) => void update({ showIdle: v })}
                  />
                  <Switch
                    label="精简行"
                    description="只保留标题与时长"
                    checked={settings.compactRows}
                    disabled={disabled}
                    onChange={(v) => void update({ compactRows: v })}
                  />
                </div>
              </Panel>

              <Panel title="行为与通知" icon={Clock} meta="仅本机">
                <div className="tray-setting-block">
                  <div className="tray-set-label">点击菜单栏图标</div>
                  <Seg<TrayClickAction>
                    label="点击菜单栏图标"
                    value={settings.clickAction}
                    disabled={disabled}
                    onChange={(v) => void update({ clickAction: v })}
                    options={[
                      { value: "panel", label: "打开面板" },
                      { value: "window", label: "打开主窗口" },
                    ]}
                  />
                </div>
                <div>
                  <Switch
                    label="等待输入时通知"
                    checked={settings.notifyOnWaiting}
                    disabled={disabled}
                    onChange={(v) => void update({ notifyOnWaiting: v })}
                  />
                  <Switch
                    label="可能卡住时通知"
                    checked={settings.notifyOnStuck}
                    disabled={disabled}
                    onChange={(v) => void update({ notifyOnStuck: v })}
                  />
                  <Switch
                    label="会话结束时通知"
                    description="连续约 6 秒不再占用才判定结束"
                    checked={settings.notifyOnFinish}
                    disabled={disabled}
                    onChange={(v) => void update({ notifyOnFinish: v })}
                  />
                  <Switch
                    label="在 Dock 显示图标"
                    checked={settings.showDockIcon}
                    disabled={disabled}
                    onChange={(v) => void update({ showDockIcon: v })}
                  />
                </div>
              </Panel>

              <Panel title="模型模式" icon={Cpu} meta="omp modelPresets">
                <div className="tray-setting-block tray-mode-block">
                  <div className="tray-set-label">模式</div>
                  <ModePicker onToast={onToast} />
                  <p className="tray-width-note">
                    切换整套模型配置（omp modelPresets）。与托盘面板「模式」同一份列表。
                  </p>
                </div>
              </Panel>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function LegendRow({ dot, name, desc }: { dot: string; name: string; desc: string }): React.JSX.Element {
  return (
    <div className="tray-legend-row">
      <span className={dot === "" ? "dot" : `dot ${dot}`} aria-hidden="true" />
      <span>{name}</span>
      <span>{desc}</span>
    </div>
  );
}

/** 状态名映射重导出（测试用，与 TrayPanel 同源）。 */
export { TRAY_STATUS_NAME };
