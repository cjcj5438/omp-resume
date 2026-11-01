/** 会话工作台右栏：头部动作 + 概览/对话/树三个标签页。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getConversation } from "../api";
import type { AppError, MetaSnapshot, SessionMeta, SessionSummary } from "../types";
import { displayCwd, formatFullTime, formatSize } from "../format";
import type { ContinueOutcome } from "../flows";
import { copyText } from "../clipboard";
import { useAsyncData } from "./useAsyncData";
import { ConversationView } from "./ConversationView";
import { TreeView } from "./TreeView";
import { EmptyState, Ico, SessionBadges } from "./ui";
import { Seg } from "./page";
import { filterConversation, recentTurns, type ConversationFilter } from "../conversationFilter";
import { UsageSummary } from "./UsageSummary";
import { RecapBlock } from "./RecapBlock";
import { SessionMetaEditor } from "./SessionMetaEditor";
import { ArrowLeft, FileX, PanelLeft } from "lucide-react";

interface DetailPaneProps {
  session: SessionSummary | null;
  /** 选中的会话在刷新后消失（或被删除）时展示提示。 */
  gone: boolean;
  /** 从节点继续后递增，触发树与对话重新加载。 */
  refreshKey: number;
  onOpenIterm: (s: SessionSummary) => void;
  /** 进舞台回看该会话（App 转 route=stage 并递增 stageTarget.seq）。 */
  onOpenStage: (path: string) => void;
  /** 返回会话列表。 */
  onBack: () => void;
  /** 列表页行内「备注」请求：消费后展开备注编辑器。 */
  metaRequest: { path: string; seq: number } | null;
  onDelete: () => void;
  onContinue: (nodeId: string) => Promise<ContinueOutcome>;
  onToast: (text: string, kind: "info" | "error") => void;
  pinned: boolean;
  onTogglePin: () => void;
  metaEntry: SessionMeta | null;
  metaRevision: number;
  metaError: AppError | null;
  onMetaSnapshot: (snap: MetaSnapshot) => void;
}

type Tab = "overview" | "conv" | "tree";

export function DetailPane({
  session,
  gone,
  refreshKey,
  onOpenIterm,
  onOpenStage,
  onBack,
  metaRequest,
  onDelete,
  onContinue,
  onToast,
  pinned,
  onTogglePin,
  metaEntry,
  metaRevision,
  metaError,
  onMetaSnapshot,
}: DetailPaneProps) {
  const [tab, setTab] = useState<Tab>("overview");
  // 备注编辑器默认收起：详情头部只留一行动作，编辑态按需展开。
  const [metaOpen, setMetaOpen] = useState(false);
  const [convFilter, setConvFilter] = useState<ConversationFilter>("all");
  const path = session?.path ?? null;
  const formatSupported = session?.formatSupported ?? true;
  const conv = useAsyncData(() => getConversation({ path: path! }), [path, formatSupported, refreshKey], { enabled: path !== null && formatSupported });

  // 切换会话：回到概览标签，收起备注编辑器（避免误编辑另一个会话），重置消息筛选。
  useEffect(() => {
    setTab("overview");
    setMetaOpen(false);
    setConvFilter("all");
  }, [path]);

  // 列表页行内「备注」请求：必须声明在重置 effect 之后，保证同一切换中后执行。
  const consumedMetaSeq = useRef(-1);
  useEffect(() => {
    if (metaRequest === null || metaRequest.path !== path) return;
    if (metaRequest.seq <= consumedMetaSeq.current) return;
    consumedMetaSeq.current = metaRequest.seq;
    setTab("overview");
    setMetaOpen(true);
  }, [metaRequest, path]);

  const filteredConv = useMemo(
    () => (conv.data ? { ...conv.data, items: filterConversation(conv.data.items, convFilter) } : null),
    [conv.data, convFilter],
  );
  const turns = useMemo(() => recentTurns(conv.data?.items ?? [], 4), [conv.data]);

  const itermDisabled = session?.inUse || !session?.cwdExists;
  const itermTip = session?.inUse
    ? "会话正在被另一个 omp 使用"
    : !session?.cwdExists
      ? "项目目录不存在"
      : undefined;

  async function copySessionId(id: string) {
    if (await copyText(id)) onToast("已复制会话 ID", "info");
    else onToast("复制失败，请手动选择复制", "error");
  }

  const projectName = session ? (session.cwd.split("/").filter(Boolean).pop() ?? session.cwd) : null;

  return (
    <main className="detail">
      {session ? (
        <header className="detail-head">
          <button type="button" className="btn ws-back" onClick={onBack}>
            <Ico icon={ArrowLeft} size={13} />
            返回会话列表
          </button>
          <div className="page-kicker">{projectName}</div>
          <div className="detail-title-row">
            <h1 className="detail-title">{session.title}</h1>
            <SessionBadges s={session} />
            <span className="detail-actions">
              <button type="button" className="btn" onClick={() => onOpenStage(session.path)}>
                舞台
              </button>
              <button
                type="button"
                className={pinned ? "btn btn-toggle-on" : "btn"}
                aria-pressed={pinned}
                onClick={onTogglePin}
              >
                {pinned ? "已置顶" : "置顶"}
              </button>
              <button
                type="button"
                className={metaOpen ? "btn btn-toggle-on" : "btn"}
                aria-expanded={metaOpen}
                aria-controls="session-meta-editor"
                onClick={() => setMetaOpen((v) => !v)}
              >
                备注
              </button>
              <button type="button" className="btn btn-danger" onClick={onDelete}>
                删除
              </button>
              <button
                type="button"
                className="btn btn-accent"
                disabled={itermDisabled}
                title={itermTip}
                onClick={() => onOpenIterm(session)}
              >
                在 iTerm 继续
              </button>
            </span>
          </div>
        </header>
      ) : (
        gone ? (
          <EmptyState
            icon={FileX}
            title="该会话已不存在"
            action={
              <button type="button" className="btn" onClick={onBack}>
                返回会话列表
              </button>
            }
          >
            它可能已被删除或移动。
          </EmptyState>
        ) : (
          <EmptyState icon={PanelLeft} title="选择一个会话">
            从左侧列表选中会话，查看对话、分支树和用量。右键会话可快速继续、重命名、打标签。
          </EmptyState>
        )
      )}
      {session ? (
        <>
          <div className="tabs" role="tablist" aria-label="详情视图">
            <button
              type="button"
              role="tab"
              id="tab-overview"
              aria-selected={tab === "overview"}
              aria-controls="panel-overview"
              className={tab === "overview" ? "tab tab-active" : "tab"}
              onClick={() => setTab("overview")}
            >
              概览
            </button>
            <button
              type="button"
              role="tab"
              id="tab-conv"
              aria-selected={tab === "conv"}
              aria-controls="panel-conv"
              className={tab === "conv" ? "tab tab-active" : "tab"}
              onClick={() => setTab("conv")}
            >
              对话
            </button>
            <button
              type="button"
              role="tab"
              id="tab-tree"
              aria-selected={tab === "tree"}
              aria-controls="panel-tree"
              disabled={!formatSupported}
              title={formatSupported ? undefined : "该会话格式不支持树视图"}
              className={tab === "tree" ? "tab tab-active" : "tab"}
              onClick={() => setTab("tree")}
            >
              树
            </button>
          </div>
          {tab === "overview" ? (
            <div
              role="tabpanel"
              id="panel-overview"
              aria-labelledby="tab-overview"
              className="panel"
            >
              <div className="detail-meta">
                <span className="mono">{displayCwd(session.cwd)}</span>
                <button
                  type="button"
                  className="id-copy mono"
                  title="点击复制会话 ID"
                  aria-label="复制会话 ID"
                  onClick={() => void copySessionId(session.id)}
                >
                  {session.id.slice(0, 8)}
                </button>
                <span>修改 {formatFullTime(session.modifiedAt)}</span>
                <span>创建 {formatFullTime(session.createdAt)}</span>
                <span className="detail-meta-group">
                  {formatSize(session.sizeBytes)} · {session.messageCount} 条消息
                </span>
                {session.occupant != null ? (
                  <span>
                    占用：
                    {session.occupant.app != null
                      ? `${session.occupant.app}${session.occupant.appVersion != null ? ` ${session.occupant.appVersion}` : ""} · PID ${session.occupant.pid}`
                      : `PID ${session.occupant.pid}`}
                  </span>
                ) : null}
              </div>
              <UsageSummary path={session.path} supported={session.formatSupported} revision={`${session.modifiedAt}:${session.sizeBytes}:${refreshKey}`} />
              <RecapBlock sessionId={session.id} />
              {!session.formatSupported ? (
                <div className="banner banner-warn">
                  该会话格式（版本 {session.version ?? "?"}）暂不支持预览，仍可继续或删除
                </div>
              ) : null}
              {metaOpen ? (
                <div id="session-meta-editor">
                  <SessionMetaEditor sessionId={session.id} entry={metaEntry} revision={metaRevision} loadError={metaError} onSnapshot={onMetaSnapshot} onToast={onToast} />
                </div>
              ) : null}
              {session.formatSupported ? (
                <section className="recent-turns" aria-label="最近节点">
                  <h2>最近节点</h2>
                  {turns.length === 0 ? (
                    <p className="pane-note">暂无对话内容</p>
                  ) : (
                    <ul>
                      {turns.map((t, i) => (
                        <li key={i}>
                          <span className="recent-role">{t.role === "user" ? "用户" : "助手"}</span>
                          <span className="recent-text">{t.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className="btn" onClick={() => setTab("conv")}>
                    查看完整对话
                  </button>
                </section>
              ) : null}
            </div>
          ) : tab === "conv" ? (
            <div
              role="tabpanel"
              id="panel-conv"
              aria-labelledby="tab-conv"
              className="panel"
            >
              {!formatSupported ? (
                <div className="pane-note">该会话格式暂不支持预览</div>
              ) : (
                <>
                  <Seg
                    label="消息筛选"
                    value={convFilter}
                    onChange={setConvFilter}
                    options={[
                      { value: "all", label: "全部" },
                      { value: "chat", label: "仅对话" },
                      { value: "tools", label: "仅工具" },
                      { value: "thinking", label: "仅思考" },
                    ]}
                  />
                  <ConversationView
                    conversation={filteredConv}
                    loading={conv.loading}
                    error={conv.error}
                    onRetry={conv.reload}
                    scrollToBottom
                    emptyNote={convFilter === "all" ? undefined : "没有此类节点"}
                  />
                </>
              )}
            </div>
          ) : (
            <div
              role="tabpanel"
              id="panel-tree"
              aria-labelledby="tab-tree"
              className="panel"
            >
              <TreeView
                session={session}
                onContinue={onContinue}
                refreshKey={refreshKey}
                onToast={onToast}
              />
            </div>
          )}
        </>
      ) : null}
    </main>
  );
}
