/** 提示词历史视图（只读 omp history.db）：搜索、复制、跳到来源会话、在该目录新开会话。 */
import { useEffect, useState } from "react";
import { normalizeError, searchPromptHistory } from "../api";
import type { PromptHistoryEntry } from "../types";
import { copyText } from "../clipboard";
import { errorText, formatRelativeTime } from "../format";

interface PromptHistoryViewProps {
  /** 当前列表已加载的会话 id；来源会话不在其中时「跳到来源会话」禁用。 */
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  /** 只传目录，绝不携带 prompt。 */
  onNewSessionIn: (cwd: string) => void;
  onToast: (text: string, kind: "info" | "error") => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export function PromptHistoryView({
  loadedSessionIds,
  onOpenSession,
  onNewSessionIn,
  onToast,
}: PromptHistoryViewProps) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<PromptHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // 输入防抖后查询；过期的响应被丢弃，避免慢请求覆盖新结果。
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      searchPromptHistory(query)
        .then((rows) => {
          if (!cancelled) setEntries(rows);
        })
        .catch((e: unknown) => {
          if (!cancelled) onToast(errorText(normalizeError(e)), "error");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, onToast]);

  return (
    <main className="detail ph-view">
      <div className="ph-head">
        <input
          type="search"
          className="filter-input"
          placeholder="搜索提示词历史"
          aria-label="搜索提示词历史"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted">{loading ? "搜索中…" : `${entries.length} 条`}</span>
      </div>
      {entries.length === 0 && !loading ? (
        <div className="pane-note">{query.trim() ? "没有匹配的提示词" : "暂无提示词历史"}</div>
      ) : null}
      <ul className="ph-list">
        {entries.map((e) => {
          const sourceLoaded = e.sessionId !== null && loadedSessionIds.has(e.sessionId);
          const cwdName = e.cwd ? (e.cwd.split("/").filter(Boolean).pop() ?? e.cwd) : "无项目目录";
          return (
            <li key={e.id} className="ph-item">
              <div className="ph-prompt" title={e.prompt}>
                {e.prompt}
              </div>
              <div className="ph-meta">
                <span className="mono" title={e.cwd ?? undefined}>
                  {cwdName}
                </span>
                <span>{formatRelativeTime(e.createdAt)}</span>
                <span>使用 {e.useCount} 次</span>
              </div>
              <div className="ph-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={async () => {
                    const ok = await copyText(e.prompt);
                    onToast(ok ? "已复制提示词" : "复制失败：剪贴板不可用", ok ? "info" : "error");
                  }}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!sourceLoaded}
                  title={sourceLoaded ? undefined : "来源会话不在当前列表中"}
                  onClick={() => {
                    if (e.sessionId !== null) onOpenSession(e.sessionId);
                  }}
                >
                  跳到来源会话
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={e.cwd === null}
                  title={e.cwd === null ? "该提示词没有记录项目目录" : undefined}
                  onClick={() => {
                    if (e.cwd !== null) onNewSessionIn(e.cwd);
                  }}
                >
                  在该目录新会话
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
