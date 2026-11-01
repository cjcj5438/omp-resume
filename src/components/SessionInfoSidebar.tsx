/** 会话信息右侧栏（V1/D1 设计稿：会话信息 panel + side-actions + 本次用量 + inline-note）。
 * variant="overview"：概览 tab；variant="conversation"：对话 tab（多别名/标签/备注块，文案区分）。
 */
import { BookOpen, ChartColumn, CircleDot, Copy } from "lucide-react";
import type { Conversation, SessionMeta, SessionSummary } from "../types";
import { displayCwd, formatFullTime } from "../format";
import { Badge, Ico } from "./ui";
import { Panel } from "./page";
import { UsageSummary } from "./UsageSummary";

interface SessionInfoSidebarProps {
  variant: "overview" | "conversation";
  session: SessionSummary;
  /** 对话数据（开始/时长/分支点用；null = 未加载，按「—」展示）。 */
  conversation: Conversation | null;
  metaEntry: SessionMeta | null;
  refreshKey: number;
  onResume: () => void;
  onForkLatest: () => void;
  forkDisabled: boolean;
  forkTip?: string;
  onCopyId: () => void;
  onEditMeta: () => void;
}

/** 文件名：path 取最后一段。 */
function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** 开始/时长：由对话首尾时间戳算；缺失则 null。时长中文口径（设计稿「1 小时 26 分」）。 */
function startAndDuration(conv: Conversation | null): { start: string | null; duration: string | null } {
  const times = (conv?.items ?? [])
    .map((i) => i.timestamp)
    .filter((t): t is string => t !== null)
    .map((t) => Date.parse(t))
    .filter((ms) => !Number.isNaN(ms));
  if (times.length === 0) return { start: null, duration: null };
  const first = Math.min(...times);
  const last = Math.max(...times);
  return {
    start: formatFullTime(new Date(first).toISOString()),
    duration: formatSessionDuration(Math.max(0, last - first)),
  };
}

/** 会话时长中文：59 秒 / 7 分钟 / 1 小时 26 分钟（零头省略，不补零）。 */
function formatSessionDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} 分钟` : `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分钟`;
}

export function SessionInfoSidebar({
  variant,
  session,
  conversation,
  metaEntry,
  refreshKey,
  onResume,
  onForkLatest,
  forkDisabled,
  forkTip,
  onCopyId,
  onEditMeta,
}: SessionInfoSidebarProps) {
  const { start, duration } = startAndDuration(conversation);
  const v3 = session.formatSupported;
  const tags = metaEntry?.tags ?? [];
  void onEditMeta;
  return (
    <aside className="section-stack">
      <Panel
        title="会话信息"
        icon={CircleDot}
        meta={
          v3 ? <Badge tone="ok">v3 · 可恢复</Badge> : <Badge tone="warn">v2 · 只读</Badge>
        }
      >
        <dl className="detail-list">
          <div className="detail-row">
            <dt>开始</dt>
            <dd>{start ?? "—"}</dd>
          </div>
          <div className="detail-row">
            <dt>时长</dt>
            <dd>{duration ?? "—"}</dd>
          </div>
          <div className="detail-row">
            <dt>模型</dt>
            <dd className="mono">{session.model ?? "—"}</dd>
          </div>
          <div className="detail-row">
            <dt>分支点</dt>
            <dd className="mono">{conversation?.branchPointId ?? "—"}</dd>
          </div>
          <div className="detail-row">
            <dt>文件</dt>
            <dd className="mono" title={session.path}>{fileName(session.path)}</dd>
          </div>
          <div className="detail-row">
            <dt>格式</dt>
            <dd>v{session.version ?? "?"} · {v3 ? "可恢复" : "不支持恢复"}</dd>
          </div>
          {variant === "conversation" ? (
            <>
              <div className="detail-row">
                <dt>别名</dt>
                <dd className="mono">{metaEntry?.alias ?? "—"}</dd>
              </div>
              <div className="detail-row">
                <dt>标签</dt>
                <dd>{tags.length > 0 ? tags.join("、") : "未添加标签"}</dd>
              </div>
              <div className="detail-row">
                <dt>备注</dt>
                <dd>{metaEntry?.note ?? "还没有备注。"}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <div className="side-actions">
          <button type="button" className="btn btn-primary btn-block" onClick={onResume}>
            {variant === "overview" ? "恢复会话" : "恢复"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled={forkDisabled}
            title={forkTip}
            onClick={onForkLatest}
          >
            从最新节点分叉
          </button>
          <button type="button" className="btn btn-quiet btn-block" onClick={onCopyId}>
            <Ico icon={Copy} size={12} />
            复制会话 ID
          </button>
        </div>
      </Panel>

      <Panel title="本次用量" icon={ChartColumn}>
        <UsageSummary
          path={session.path}
          supported={session.formatSupported}
          revision={`${session.modifiedAt}:${session.sizeBytes}:${refreshKey}`}
        />
      </Panel>

      <div className="inline-note">
        <Ico icon={BookOpen} size={12} />
        <span>
          {variant === "overview" ? (
            <>
              备注、标签和别名只写入应用自己的 <code>meta.json</code>，不会修改会话文件。
            </>
          ) : (
            <>
              对话为只读审阅：{displayCwd(session.cwd)} 的会话文件不会被改写。
            </>
          )}
        </span>
      </div>
    </aside>
  );
}
