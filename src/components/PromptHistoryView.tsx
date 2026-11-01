/** 提示词历史视图（只读 omp history.db）：搜索、项目筛选、整行跳转、hover 快捷动作。 */
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Copy, History, Plus } from "lucide-react";
import { normalizeError, searchPromptHistory } from "../api";
import type { PromptHistoryEntry } from "../types";
import { copyText } from "../clipboard";
import { errorText } from "../format";
import { Badge, EmptyState } from "./ui";
import { PageHeader, Panel, SearchInput, Seg } from "./page";
import { HISTORY_NO_PROJECT, filterHistoryByProject, formatHistoryTime, historyProjects } from "../historyFilter";
import "./PromptHistory.css";

interface PromptHistoryViewProps {
  /** 当前列表已加载的会话 id；来源会话不在其中时整行不可点。 */
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  /** 只传目录，绝不携带 prompt。 */
  onNewSessionIn: (cwd: string) => void;
  onToast: (text: string, kind: "info" | "error") => void;
}

const SEARCH_DEBOUNCE_MS = 200;

function cwdName(cwd: string | null): string {
  if (cwd === null) return "未记录目录";
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

function sessionShort(sessionId: string | null): string {
  return sessionId === null ? "未知会话" : sessionId.slice(0, 8);
}

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

  const filtered = query.trim() !== "" || project !== "all";

  async function copyPrompt(prompt: string) {
    const ok = await copyText(prompt);
    onToast(ok ? "已复制提示词" : "复制失败：剪贴板不可用", ok ? "info" : "error");
  }

  return (
    <div className="view ph-view">
      <PageHeader
        kicker="分析 · 来自 history.db"
        title="提示词历史"
        sub="omp 记录的每一条输入都保留在这里，可回跳到原会话继续。"
        actions={<Badge tone="tag">{entries.length} 条记录</Badge>}
      />
      <div className="ph-toolbar">
        <SearchInput
          label="搜索提示词历史"
          placeholder="搜索提示词或会话"
          value={query}
          onChange={setQuery}
          icon
        />
        <div className="ph-seg-scroll">
          <Seg
            label="按项目过滤"
            value={project}
            onChange={setProject}
            options={[
              { value: "all", label: "全部项目", count: entries.length },
              ...projects.map((p) => ({
                value: p.value,
                label: p.value === HISTORY_NO_PROJECT ? "未记录目录" : (p.value.split("/").filter(Boolean).pop() ?? p.value),
                count: p.count,
              })),
            ]}
          />
        </div>
        <span className="ph-match">{loading ? "搜索中…" : `${visible.length} 条匹配`}</span>
      </div>
      <Panel
        title=""
        body="flush"
        foot={
          <>
            <span>提示词来自 omp 自己的 history.db，只读展示。</span>
            <span>共 {visible.length} 条</span>
          </>
        }
      >
        <div className="ph-body">
          {visible.length === 0 && !loading ? (
            <EmptyState
              icon={History}
              title={query.trim() ? "没有匹配的提示词" : "暂无提示词历史"}
              action={filtered ? (
                <button type="button" className="btn btn-ghost" onClick={() => { setQuery(""); setProject("all"); }}>
                  清除筛选
                </button>
              ) : undefined}
            >
              {query.trim() ? "换个关键词，或把项目筛选切回全部。" : "在 omp 里提问后，提示词会出现在这里。"}
            </EmptyState>
          ) : null}
          <ul className="ph-list">
            {visible.map((e) => {
              const sourceLoaded = e.sessionId !== null && loadedSessionIds.has(e.sessionId);
              const name = cwdName(e.cwd);
              const title = e.sessionTitle ?? sessionShort(e.sessionId);
              const when = formatHistoryTime(e.createdAt);
              const jump = () => {
                if (e.sessionId !== null) onOpenSession(e.sessionId);
              };
              return (
                <li
                  key={e.id}
                  className={sourceLoaded ? "hist-row is-click" : "hist-row"}
                  onClick={sourceLoaded ? jump : undefined}
                  onKeyDown={sourceLoaded ? (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); jump(); } } : undefined}
                  tabIndex={sourceLoaded ? 0 : undefined}
                  role={sourceLoaded ? "button" : undefined}
                  title={sourceLoaded ? undefined : "来源会话不在当前列表中"}
                >
                  <div className="hist-main">
                    <div className="hist-prompt" title={e.prompt}>
                      {e.prompt}
                    </div>
                    <div className="hist-meta">
                      <span title={e.cwd ?? undefined}>{name}</span>
                      <span>→ {title}</span>
                    </div>
                  </div>
                  <span className="hist-when mono" title={when === "" ? "时间未知" : e.createdAt}>
                    {when === "" ? "—" : when}
                  </span>
                  <span className="hist-proj">
                    <Badge tone="tag">{name}</Badge>
                  </span>
                  <span className="hist-fwd">
                    {sourceLoaded ? <ArrowRight size={14} aria-hidden="true" /> : null}
                  </span>
                  <span
                    className="hist-hover"
                    onClick={(ev) => ev.stopPropagation()}
                    onKeyDown={(ev) => ev.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="btn btn-small btn-quiet hist-icon"
                      aria-label="复制提示词"
                      title="复制提示词"
                      onClick={() => void copyPrompt(e.prompt)}
                    >
                      <Copy size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-quiet hist-icon"
                      aria-label="在该目录新会话"
                      title={e.cwd === null ? "该提示词没有记录项目目录" : "在该目录新会话"}
                      disabled={e.cwd === null}
                      onClick={() => {
                        if (e.cwd !== null) onNewSessionIn(e.cwd);
                      }}
                    >
                      <Plus size={13} aria-hidden="true" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
