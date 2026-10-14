/** 详情面板：会话头、工具栏（在 iTerm 继续 / 删除）、对话/树两个标签页。 */
import { useCallback, useEffect, useState } from "react";
import { getConversation } from "../api";
import type { AppError, Conversation, SessionSummary } from "../types";
import { displayCwd, formatFullTime, formatSize } from "../format";
import type { ContinueOutcome } from "../flows";
import { ConversationView } from "./ConversationView";
import { TreeView } from "./TreeView";
import { SessionBadges } from "./ui";

interface DetailPaneProps {
  session: SessionSummary | null;
  /** 选中的会话在刷新后消失（或被删除）时展示提示。 */
  gone: boolean;
  checkedCount: number;
  /** 从节点继续后递增，触发树与对话重新加载。 */
  refreshKey: number;
  onOpenIterm: (s: SessionSummary) => void;
  onDelete: () => void;
  onContinue: (nodeId: string) => Promise<ContinueOutcome>;
  onToast: (text: string, kind: "info" | "error") => void;
}

type Tab = "conv" | "tree";

export function DetailPane({
  session,
  gone,
  checkedCount,
  refreshKey,
  onOpenIterm,
  onDelete,
  onContinue,
  onToast,
}: DetailPaneProps) {
  const [tab, setTab] = useState<Tab>("conv");
  const [conv, setConv] = useState<{
    data: Conversation | null;
    loading: boolean;
    error: AppError | null;
  }>({ data: null, loading: false, error: null });

  const loadConv = useCallback(async (path: string) => {
    setConv((s) => ({ ...s, loading: true }));
    try {
      const data = await getConversation({ path });
      setConv({ data, loading: false, error: null });
    } catch (e) {
      setConv({ data: null, loading: false, error: e as AppError });
    }
  }, []);

  const path = session?.path ?? null;
  const formatSupported = session?.formatSupported ?? true;

  // 切换会话：回到对话标签并清空旧内容。
  useEffect(() => {
    setTab("conv");
    setConv({ data: null, loading: false, error: null });
  }, [path]);

  // 加载对话；refreshKey 变化（从节点继续后）同步刷新。
  useEffect(() => {
    if (!path || !formatSupported) return;
    void loadConv(path);
  }, [path, formatSupported, refreshKey, loadConv]);

  // 无会话也允许批量删除（勾选行存在时保留工具栏）。
  const showToolbar = session != null || checkedCount > 0;
  const itermDisabled = session?.inUse || !session?.cwdExists;
  const itermTip = session?.inUse
    ? "会话正在被另一个 omp 使用"
    : !session?.cwdExists
      ? "项目目录不存在"
      : undefined;

  return (
    <main className="detail">
      {session ? (
        <header className="detail-head">
          <div className="detail-title-row">
            <h1 className="detail-title">{session.title}</h1>
            <SessionBadges s={session} />
          </div>
          <div className="detail-meta mono">{displayCwd(session.cwd)}</div>
          <div className="detail-meta">
            <span className="mono muted">{session.id}</span>
            <span>创建 {formatFullTime(session.createdAt)}</span>
            <span>修改 {formatFullTime(session.modifiedAt)}</span>
            <span>{formatSize(session.sizeBytes)}</span>
            <span>{session.messageCount} 条消息</span>
          </div>
          {!session.formatSupported ? (
            <div className="banner banner-warn">
              该会话格式（版本 {session.version ?? "?"}）暂不支持预览，仍可继续或删除
            </div>
          ) : null}
        </header>
      ) : (
        <div className="pane-note">
          {gone ? "该会话已不存在" : "从左侧选择一个会话查看详情"}
        </div>
      )}
      {showToolbar ? (
        <div className="toolbar">
          {session ? (
            <button
              type="button"
              className="btn btn-accent"
              disabled={itermDisabled}
              title={itermTip}
              onClick={() => onOpenIterm(session)}
            >
              在 iTerm 继续
            </button>
          ) : null}
          <button type="button" className="btn btn-danger" onClick={onDelete}>
            {checkedCount > 0 ? `删除所选 (${checkedCount})` : "删除"}
          </button>
        </div>
      ) : null}
      {session ? (
        <>
          <div className="tabs" role="tablist" aria-label="详情视图">
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
          {tab === "conv" ? (
            <div
              role="tabpanel"
              id="panel-conv"
              aria-labelledby="tab-conv"
              className="panel"
            >
              {!formatSupported ? (
                <div className="pane-note">该会话格式暂不支持预览</div>
              ) : (
                <ConversationView
                  conversation={conv.data}
                  loading={conv.loading}
                  error={conv.error}
                  onRetry={() => void loadConv(session.path)}
                  scrollToBottom
                />
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
