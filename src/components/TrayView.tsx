/** 菜单栏页：左侧预览（完全由 TrayPreview 渲染）+ 右侧三张设置卡。 */
import type { AppError, SessionSummary } from "../types";
import type { ToastFn } from "./useOmpOp";
import type {
  TrayBadgeStyle,
  TrayClickAction,
  TrayPreview as TrayPreviewData,
  TrayPreviewRow,
  TrayTitleWidth,
} from "../types";
import { PageHeader, ErrorBanner, Seg, Switch } from "./page";
import { useTrayPreview, useTraySettings } from "../traySettings";
import "./TrayView.css";

/** 状态键 → 中文名（只做键映射，所有文案仍由 TrayPreview 提供）。 */
const STATUS_NAME: Record<TrayPreviewRow["status"], string> = {
  working: "工作中",
  waiting: "等待输入",
  idle: "空闲",
  stuck: "疑似卡住",
};

interface TrayViewProps {
  sessions: SessionSummary[];
  onOpenSession: (path: string) => void;
  onToast: ToastFn;
}

export function TrayView({ sessions, onOpenSession, onToast }: TrayViewProps) {
  const { settings, error, saving, reload, update } = useTraySettings(onToast);
  // 设置对象变化（本地写回或事件同步）→ 预览立即重拉。
  const { preview, error: previewError } = useTrayPreview(settings);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const ready = settings !== null && error === null;
  const disabled = !ready || saving;

  return (
    <div className="view">
      <PageHeader
        kicker="设置 · 菜单栏"
        title="菜单栏"
        sub="托盘图标常驻菜单栏：查看运行中的会话、聚焦 iTerm 标签、新建与恢复会话。设置立即生效。"
      />
      <div className="tray-cols">
        <div className="tray-left">
          <PreviewPanel preview={preview} error={previewError} byId={byId} onOpenSession={onOpenSession} />
          <section className="panel" aria-label="状态判定">
            <div className="panel-head">
              <div className="panel-title">状态判定</div>
            </div>
            <div className="panel-body">
              <dl className="tray-legend">
                <div className="tray-legend-row">
                  <dt>
                    <span className="tray-dot tray-dot-working" aria-hidden="true" />
                    工作中
                  </dt>
                  <dd>标题在转圈、有子代理在跑或工具执行中</dd>
                </div>
                <div className="tray-legend-row">
                  <dt>
                    <span className="tray-dot tray-dot-waiting" aria-hidden="true" />
                    等待输入
                  </dt>
                  <dd>回合结束 30 分钟内，或疑似在等审批</dd>
                </div>
                <div className="tray-legend-row">
                  <dt>
                    <span className="tray-dot tray-dot-idle" aria-hidden="true" />
                    空闲
                  </dt>
                  <dd>持有会话锁但超过 30 分钟无动作</dd>
                </div>
                <div className="tray-legend-row">
                  <dt>
                    <span className="tray-dot tray-dot-stuck" aria-hidden="true" />
                    疑似卡住
                  </dt>
                  <dd>工具调用超过 10 分钟没有进展</dd>
                </div>
              </dl>
            </div>
            <div className="panel-foot">
              <span>占用来自 flock 探测，状态来自会话文件尾部；从不依据文件修改时间。</span>
            </div>
          </section>
        </div>
        <div className="tray-right">
          {error !== null && settings === null ? (
            <ErrorBanner error={error} onRetry={reload} />
          ) : settings !== null ? (
            <>
              <section className="panel" aria-label="图标">
                <div className="panel-head">
                  <div className="panel-title">图标</div>
                </div>
                <div className="panel-body">
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">徽标样式</div>
                    </div>
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
                  <div className="tray-samples" aria-label="状态预览">
                    {preview?.badgeSamples.map((s) => (
                      <div className="tray-sample-row" key={s.state}>
                        <span>{STATUS_NAME[s.state as TrayPreviewRow["status"]] ?? s.state}</span>
                        <span className="mono">{s.title ?? "（仅图标）"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
              <section className="panel" aria-label="菜单内容">
                <div className="panel-head">
                  <div className="panel-title">菜单内容</div>
                </div>
                <div className="panel-body flush">
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">面板宽度</div>
                      <div className="setting-desc">按会话标题截断长度：20 / 32 / 48 字</div>
                    </div>
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
                  </div>
                  <Switch
                    label="显示今日花费"
                    checked={settings.showCost}
                    disabled={disabled}
                    onChange={(v) => void update({ showCost: v })}
                  />
                  <Switch
                    label="显示项目名"
                    checked={settings.showProject}
                    disabled={disabled}
                    onChange={(v) => void update({ showProject: v })}
                  />
                  <Switch
                    label="显示空闲会话"
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
              </section>
              <section className="panel" aria-label="行为与通知">
                <div className="panel-head">
                  <div className="panel-title">行为与通知</div>
                </div>
                <div className="panel-body flush">
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">点击图标</div>
                      <div className="setting-desc">选择「打开主窗口」时，右键图标仍可打开菜单</div>
                    </div>
                    <Seg<TrayClickAction>
                      label="点击图标"
                      value={settings.clickAction}
                      disabled={disabled}
                      onChange={(v) => void update({ clickAction: v })}
                      options={[
                        { value: "menu", label: "打开菜单" },
                        { value: "window", label: "打开主窗口" },
                      ]}
                    />
                  </div>
                  <Switch
                    label="等待输入时通知"
                    checked={settings.notifyOnWaiting}
                    disabled={disabled}
                    onChange={(v) => void update({ notifyOnWaiting: v })}
                  />
                  <Switch
                    label="疑似卡住时通知"
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
                <div className="panel-foot">
                  <span>macOS 原生菜单不支持内嵌搜索框；菜单展开时直接键入首字母即可跳转。</span>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface PreviewPanelProps {
  preview: TrayPreviewData | null;
  error: AppError | null;
  byId: Map<string, SessionSummary>;
  onOpenSession: (path: string) => void;
}

function PreviewPanel({ preview, error, byId, onOpenSession }: PreviewPanelProps) {
  const activeMode = preview?.modes?.find((m) => m.active) ?? null;
  return (
    <section className="panel" aria-label="预览">
      <div className="panel-head">
        <div className="panel-title">预览</div>
      </div>
      <div className="panel-body">
        {preview !== null && !preview.ready ? (
          <p className="tray-notice">菜单栏尚未完成首轮检测</p>
        ) : null}
        {error !== null ? (
          <ErrorBanner error={error} />
        ) : preview === null ? (
          <p className="muted">正在加载预览…</p>
        ) : (
          <div className="tray-mock">
            <div className="tray-menubar" aria-hidden="true">
              <span className="tray-brand-mark">π</span>
              {preview.trayTitle !== null ? (
                <span className="tray-mock-title">{preview.trayTitle}</span>
              ) : null}
            </div>
            <div className="tray-menu">
              <div className="tray-menu-header">{preview.header}</div>
              {preview.costText !== null ? (
                <div className="tray-menu-cost">{preview.costText}</div>
              ) : null}
              <div className="tray-sep" aria-hidden="true" />
              {preview.rows.map((r) => {
                const target = byId.get(r.sessionId);
                const clickable = r.enabled && target !== undefined;
                return (
                  <button
                    key={r.sessionId}
                    type="button"
                    className={r.enabled ? "tray-menu-row" : "tray-menu-row is-disabled"}
                    disabled={!clickable}
                    onClick={target ? () => onOpenSession(target.path) : undefined}
                  >
                    <span
                      className={`tray-dot tray-dot-${r.status}`}
                      aria-hidden="true"
                    />
                    <span className="tray-menu-text">{r.text}</span>
                  </button>
                );
              })}
              {preview.overflow.length > 0 ? (
                <div className="tray-menu-more">更多…（{preview.overflow.length}）</div>
              ) : null}
              <div className="tray-sep" aria-hidden="true" />
              <details className="tray-sub">
                <summary>新建会话 ▸</summary>
                <div className="tray-sub-body">
                  {preview.projects.map((p) => (
                    <div className="tray-menu-item" key={p.key}>
                      {p.text}
                    </div>
                  ))}
                  <div className="tray-menu-item">选择目录…</div>
                </div>
              </details>
              <details className="tray-sub">
                <summary>最近会话 ▸</summary>
                <div className="tray-sub-body">
                  {preview.recent.length === 0 ? (
                    <div className="tray-menu-item is-disabled">没有最近会话</div>
                  ) : (
                    preview.recent.map((e) => (
                      <div className="tray-menu-item" key={e.key}>
                        {e.text}
                      </div>
                    ))
                  )}
                </div>
              </details>
              {preview.modes !== null ? (
                <details className="tray-sub">
                  <summary>模式：{activeMode?.name ?? "自定义"} ▸</summary>
                  <div className="tray-sub-body">
                    {preview.modes.map((m) => (
                      <div
                        className={m.enabled ? "tray-menu-item" : "tray-menu-item is-disabled"}
                        key={m.name}
                      >
                        {m.active ? "✓ " : null}
                        {m.name}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
              <div className="tray-sep" aria-hidden="true" />
              <div className="tray-menu-item">打开主窗口</div>
              <div className="tray-menu-item">设置 ▸</div>
              <div className="tray-sep" aria-hidden="true" />
              <div className="tray-menu-item">退出 omp-resume</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
