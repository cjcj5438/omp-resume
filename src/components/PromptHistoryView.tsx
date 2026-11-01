/** 提示词历史视图（只读 omp history.db）：搜索、复制、跳到来源会话、在该目录新开会话。 */
import { useEffect, useMemo, useState } from "react";
import { normalizeError, searchPromptHistory } from "../api";
import type { PromptHistoryEntry } from "../types";
import { copyText } from "../clipboard";
import { errorText, formatRelativeTime } from "../format";
import { EmptyState } from "./ui";
import { PageHeader, SearchInput } from "./page";
import { filterHistoryByProject, historyProjects } from "../historyFilter";
import { History } from "lucide-react";

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
  const [project, setProject] = useState<string | "all">("all");
  const projects = useMemo(() => historyProjects(entries), [entries]);
  // 搜索结果变化后选中值已不在选项中：重置为 all。
  useEffect(() => {
    if (project !== "all" && !projects.some((p) => p.value === project)) setProject("all");
  }, [projects, project]);
  const visible = useMemo(() => filterHistoryByProject(entries, project), [entries, project]);

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
    <div className="view ph-view">
      <PageHeader
        kicker="分析 · 来自 history.db"
        title="提示词历史"
        sub="只读检索 omp 的 history.db；「跳到来源会话」需要该会话已在列表中。"
      />
      <div className="ph-head">
        <SearchInput
          label="搜索提示词历史"
          placeholder="搜索提示词历史"
          value={query}
          onChange={setQuery}
        />
        <select aria-label="按项目过滤" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="all">全部项目</option>
          {projects.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="muted">{loading ? "搜索中…" : `${visible.length} 条`}</span>
      </div>
      <div className="ph-body">
        {visible.length === 0 && !loading ? (
          <EmptyState icon={History} title={query.trim() ? "没有匹配的提示词" : "暂无提示词历史"}>
            {query.trim() ? "换个关键词再试。" : "在 omp 里提问后，提示词会出现在这里。"}
          </EmptyState>
        ) : null}
        <ul className="ph-list">
          {visible.map((e) => {
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
      </div>
    </div>
  );
}
