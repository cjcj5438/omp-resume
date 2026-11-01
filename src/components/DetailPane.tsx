/** 会话工作台右栏：头部动作 + 概览/对话/树三个标签页。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getConversation, getSessionRecap } from "../api";
import type { SessionMeta, SessionSummary } from "../types";
import { displayCwd, formatRelativeTime, formatSize, formatTreeTime } from "../format";
import { copyText } from "../clipboard";
import { useAsyncData } from "./useAsyncData";
import { ConversationView } from "./ConversationView";
import { TreeView } from "./TreeView";
import { EmptyState, Badge, Ico, SessionBadges } from "./ui";
import { Panel, Seg } from "./page";
import { SessionInfoSidebar } from "./SessionInfoSidebar";
import { filterConversation, recentTurns, type ConversationFilter } from "../conversationFilter";
import { ArrowLeft, ArrowRight, Book, FileX, History, MessageSquareText, PanelLeft, Pin, SquareTerminal, Trash } from "lucide-react";
import "./DetailPane.css";
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
  /** 列表页行内「备注」请求：消费后打开备注对话框。 */
  metaRequest: { path: string; seq: number } | null;
  /** 打开备注对话框（三 tab 通用，App 级渲染）。 */
  onOpenMetaDialog: () => void;
  /** 分叉请求（App 级弹 ForkDialog）。 */
  onForkRequest: (nodeId: string) => void;
  onDelete: () => void;
  onToast: (text: string, kind: "info" | "error") => void;
  pinned: boolean;
  onTogglePin: () => void;
  metaEntry: SessionMeta | null;
  /** 工作台 tab（App 持有，T7 面包屑用；按会话切换重置为概览）。 */
  detailTab: Tab;
  onDetailTabChange: (t: Tab) => void;
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
  onOpenMetaDialog,
  onForkRequest,
  onDelete,
  onToast,
  pinned,
  onTogglePin,
  metaEntry,
  detailTab: tab,
  onDetailTabChange: setTab,
}: DetailPaneProps) {
  const [convFilter, setConvFilter] = useState<ConversationFilter>("all");
  // R4 联动：树「在对话中定位」的目标节点 id；手动切 tab 或换会话时清空。
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const path = session?.path ?? null;
  const formatSupported = session?.formatSupported ?? true;
  const conv = useAsyncData(() => getConversation({ path: path! }), [path, formatSupported, refreshKey], { enabled: path !== null && formatSupported });
  // 切换会话：重置消息筛选与定位（tab 由 App 重置）。
  useEffect(() => {
    setConvFilter("all");
    setFocusNodeId(null);
  }, [path]);

  // 列表页行内「备注」请求：消费后打开备注对话框（必须在重置 effect 之后）。
  const consumedMetaSeq = useRef(-1);
  useEffect(() => {
    if (metaRequest === null || metaRequest.path !== path) return;
    if (metaRequest.seq <= consumedMetaSeq.current) return;
    consumedMetaSeq.current = metaRequest.seq;
    onOpenMetaDialog();
  }, [metaRequest, path, onOpenMetaDialog]);

  const filteredConv = useMemo(
    () => (conv.data ? { ...conv.data, items: filterConversation(conv.data.items, convFilter) } : null),
    [conv.data, convFilter],
  );
  const turns = useMemo(() => recentTurns(conv.data?.items ?? [], 4), [conv.data]);

  // H10/G8：在用可点（打开确认框解释/聚焦），仅目录缺失禁用。
  const itermDisabled = !session?.cwdExists;
  const itermTip = !session?.cwdExists ? "项目目录不存在" : undefined;

  async function copySessionId(id: string) {
    if (await copyText(id)) onToast("已复制会话 ID", "info");
    else onToast("复制失败，请手动选择复制", "error");
  }

  const projectName = session ? (session.cwd.split("/").filter(Boolean).pop() ?? session.cwd) : null;
  const tagCount = metaEntry?.tags.length ?? 0;
  const alias = metaEntry?.alias ?? null;

  return (
    <main className="detail">
      {session ? (
        <header className="ws-head">
          <div className="ws-head-main">
            <button type="button" className="back-link ws-back" onClick={onBack}>
              <Ico icon={ArrowLeft} size={13} />
              返回会话列表
            </button>
            <div className="page-kicker">
              {projectName} · {formatSupported ? "可恢复会话" : "只读审阅"}
            </div>
            <h1 className="page-title ws-title">{session.title}</h1>
            <div className="ws-meta">
              <span className="mono">{displayCwd(session.cwd)}</span>
              <span className="sep">·</span>
              <span>{session.messageCount} 条消息</span>
              <span className="sep">·</span>
              <span>{formatSize(session.sizeBytes)}</span>
              <span className="sep">·</span>
              <span>{session.model ?? "—"}</span>
              <span className="sep">·</span>
              <span>{formatRelativeTime(session.modifiedAt)}</span>
              <SessionBadges s={session} />
              <button
                type="button"
                className="id-copy mono"
                title="点击复制会话 ID"
                aria-label="复制会话 ID"
                onClick={() => void copySessionId(session.id)}
              >
                {session.id.slice(0, 8)}
              </button>
              {session.occupant != null ? (
                <span>
                  占用：
                  {session.occupant.app != null
                    ? `${session.occupant.app}${session.occupant.appVersion != null ? ` ${session.occupant.appVersion}` : ""} · PID ${session.occupant.pid}`
                    : `PID ${session.occupant.pid}`}
                </span>
              ) : null}
            </div>
          </div>
          <div className="page-actions ws-actions">
            <button type="button" className="btn btn-small" onClick={() => onOpenStage(session.path)}>
              舞台
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              aria-pressed={pinned}
              onClick={onTogglePin}
            >
              <Ico icon={Pin} size={12} />
              {pinned ? "已置顶" : "置顶"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={onOpenMetaDialog}
            >
              <Ico icon={Book} size={12} />
              备注
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small btn-danger-ghost"
              onClick={onDelete}
            >
              <Ico icon={Trash} size={12} />
              删除
            </button>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={itermDisabled}
              title={itermTip}
              onClick={() => onOpenIterm(session)}
            >
              <Ico icon={SquareTerminal} size={12} />
              在 iTerm2 恢复
            </button>
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
          <div className="ws-tabbar">
            <Seg
              label="详情视图"
              value={tab}
              onChange={setTab}
              options={[
                { value: "overview", label: "概览" },
                { value: "conv", label: "对话" },
                { value: "tree", label: "树" },
              ]}
            />
            <span className="spacer" />
            <span className="ws-alias">
              {alias ? (
                <>
                  别名 <code>{alias}</code>
                </>
              ) : (
                "未设置别名"
              )}
            </span>
            <span className="ws-tag-count">{tagCount} 个标签</span>
          </div>
          {tab === "overview" ? (
            <div role="tabpanel" id="panel-overview" aria-label="概览">
              <div className="split">
                <div className="section-stack">
                  <SessionSummaryPanel
                    session={session}
                    metaEntry={metaEntry}
                    onEdit={onOpenMetaDialog}
                  />
                  <Panel
                    title="最近节点"
                    icon={History}
                    meta={turns.length > 0 && conv.data ? `${turns.length} / ${conv.data.items.length}` : undefined}
                    foot={
                      <>
                        <span>append-only · 内容不会被改写</span>
                        <button type="button" className="back-link" onClick={() => setTab("conv")}>
                          查看完整对话
                          <Ico icon={ArrowRight} size={12} />
                        </button>
                      </>
                    }
                    body="flush"
                  >
                    {turns.length > 0 ? (
                      <div className="ov-feed">
                        {turns.map((t) => (
                          <div className="ov-msg" key={t.id}>
                            <span className={t.role === "user" ? "ov-role user" : "ov-role assistant"}>
                              {t.role === "user" ? "用户" : "助手"}
                            </span>
                            <div className="ov-msg-body">
                              <p>{t.text}</p>
                              <span className="ov-time">
                                {t.id} · {t.time ? formatTreeTime(t.time) : "—"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="panel-body">
                        <p className="meta">暂无对话内容</p>
                      </div>
                    )}
                  </Panel>
                </div>
                <SessionInfoSidebar
                  variant="overview"
                  session={session}
                  conversation={conv.data}
                  metaEntry={metaEntry}
                  refreshKey={refreshKey}
                  onResume={() => onOpenIterm(session)}
                  onForkLatest={() => {
                    if (conv.data?.leafId) onForkRequest(conv.data.leafId);
                  }}
                  forkDisabled={session.inUse || !session.formatSupported || conv.data?.leafId == null}
                  forkTip={
                    session.inUse
                      ? "会话正在使用中"
                      : !session.formatSupported
                        ? "该会话格式不支持分叉"
                        : conv.data?.leafId == null
                          ? "对话尚未加载"
                          : undefined
                  }
                  onCopyId={() => void copySessionId(session.id)}
                  onEditMeta={onOpenMetaDialog}
                />
              </div>
            </div>
          ) : tab === "conv" ? (
            <div role="tabpanel" id="panel-conv" aria-label="对话">
              {!formatSupported ? (
                <div className="panel">
                  <div className="pane-note">该会话格式暂不支持预览</div>
                </div>
              ) : (
                <div className="split">
                  <Panel
                    title="对话记录"
                    icon={MessageSquareText}
                    actions={
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
                    }
                    foot={
                      <>
                        <span>append-only · 会话内容不会被改写</span>
                        <span className="mono">{filteredConv?.items.length ?? 0} 个节点已加载</span>
                      </>
                    }
                    body="flush"
                  >
                    <ConversationView
                      conversation={filteredConv}
                      loading={conv.loading}
                      error={conv.error}
                      onRetry={conv.reload}
                      scrollToBottom
                      emptyNote={convFilter === "all" ? undefined : "没有此类节点"}
                      activeNodeId={focusNodeId}
                    />
                  </Panel>
                  <SessionInfoSidebar
                    variant="conversation"
                    session={session}
                    conversation={conv.data}
                    metaEntry={metaEntry}
                    refreshKey={refreshKey}
                    onResume={() => onOpenIterm(session)}
                    onForkLatest={() => {
                      if (conv.data?.leafId) onForkRequest(conv.data.leafId);
                    }}
                    forkDisabled={session.inUse || !session.formatSupported || conv.data?.leafId == null}
                    forkTip={
                      session.inUse
                        ? "会话正在使用中"
                        : !session.formatSupported
                          ? "该会话格式不支持分叉"
                          : conv.data?.leafId == null
                            ? "对话尚未加载"
                            : undefined
                    }
                    onCopyId={() => void copySessionId(session.id)}
                    onEditMeta={onOpenMetaDialog}
                  />
                </div>
              )}
            </div>
          ) : (
            <div role="tabpanel" id="panel-tree" aria-label="树">
              <TreeView
                session={session}
                refreshKey={refreshKey}
                onLocate={(nodeId) => {
                  setFocusNodeId(nodeId);
                  setTab("conv");
                }}
                onForkRequest={onForkRequest}
              />
            </div>
          )}
        </>
      ) : null}
    </main>
  );
}

/** 会话摘要 panel（V2 设计稿：recap 摘要行 + 别名/标签/备注 + 编辑入口）。 */
function SessionSummaryPanel({
  session,
  metaEntry,
  onEdit,
}: {
  session: SessionSummary;
  metaEntry: SessionMeta | null;
  onEdit: () => void;
}) {
  const [recap, setRecap] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setRecap(null);
    setOpen(false);
    getSessionRecap(session.id)
      .then((text) => {
        if (!cancelled) setRecap(text);
      })
      .catch(() => {
        if (!cancelled) setRecap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);
  const tags = metaEntry?.tags ?? [];
  return (
    <Panel title="会话摘要" icon={MessageSquareText} meta="来自 JSONL 尾部">
      {recap ? (
        <>
          <p className={open ? "ov-summary" : "ov-summary ov-summary-clamp"}>{recap}</p>
          <button
            type="button"
            className="btn btn-small"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "收起概要" : "展开概要"}
          </button>
        </>
      ) : null}
      <dl className="detail-list" style={recap ? { marginTop: 14 } : undefined}>
        <div className="detail-row">
          <dt>别名</dt>
          <dd className="mono">{metaEntry?.alias ?? "—"}</dd>
        </div>
        <div className="detail-row">
          <dt>标签</dt>
          <dd>
            {tags.length > 0 ? (
              tags.map((t) => (
                <Badge key={t} tone="quiet">
                  {t}
                </Badge>
              ))
            ) : (
              <span className="meta">未添加标签</span>
            )}
          </dd>
        </div>
        <div className="detail-row">
          <dt>备注</dt>
          <dd className="ov-note">{metaEntry?.note ?? "还没有备注。"}</dd>
        </div>
      </dl>
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-ghost btn-small" onClick={onEdit}>
          <Ico icon={Book} size={12} />
          编辑别名、标签与备注
        </button>
      </div>
    </Panel>
  );
}
