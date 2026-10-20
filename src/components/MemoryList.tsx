/**
 * 记忆列表：单库内的搜索 / 过滤 / 排序 / 分页 / 详情展开 / 多选删除。
 * `renderItemActions`（行级）与 `renderDetailActions`（详情级）为写操作插槽，不传则不渲染任何占位。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryDetail, memoryList, normalizeError } from "../api";
import type { MemoryDetail, MemoryItem, MemoryKindFilter, MemorySort } from "../types";
import { copyText } from "../clipboard";
import { errorText, formatFullTime, formatRelativeTime } from "../format";
import type { ToastFn } from "./useOmpOp";
import { MemoryDeleteDialog } from "./MemoryDeleteDialog";
import { MemorySelectionBar, useMemorySelection } from "./MemorySelection";
import { MEMORY_DELETE_IDS_MAX } from "./useMemoryMaintenance";
import "./MemoryPanel.css";

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 50;

const KIND_LABEL: Record<MemoryItem["kind"], string> = {
  working: "工作记忆",
  episodic: "情节摘要",
};

const KIND_HELP = "工作记忆：长期保存的零散知识点与偏好；情节摘要：从某次对话提炼的事件摘要。";

interface SourceJump {
  enabled: boolean;
  title: string | undefined;
}

function sourceJumpOf(item: MemoryItem, loadedSessionIds: ReadonlySet<string>): SourceJump {
  if (item.sourceSessionId === null) return { enabled: false, title: "该记忆未记录来源会话" };
  if (loadedSessionIds.has(item.sourceSessionId)) return { enabled: true, title: undefined };
  if (item.sourceSessionExists === false) return { enabled: false, title: "来源会话已不在（可能已被删除）" };
  return { enabled: false, title: "来源会话未加载到当前列表" };
}

/** 查询子串高亮（大小写不敏感；无命中时原样返回）。 */
function highlightSnippet(snippet: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (q === "") return snippet;
  const idx = snippet.toLowerCase().indexOf(q);
  if (idx < 0) return snippet;
  return (
    <>
      {snippet.slice(0, idx)}
      <mark>{snippet.slice(idx, idx + q.length)}</mark>
      {snippet.slice(idx + q.length)}
    </>
  );
}

export function MemoryList(props: {
  bank: string;
  displayName: string;
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  onToast: ToastFn;
  /** 外部刷新令牌：变化时重查列表并丢弃详情缓存。 */
  refreshToken?: number;
  renderItemActions?: (item: MemoryItem, refresh: () => void) => ReactNode;
  renderDetailActions?: (detail: MemoryDetail, refresh: () => void) => ReactNode;
  /** 写操作成功后的统一失效入口（总览 + 列表 + 详情缓存）。 */
  onRefresh: () => void;
}): ReactNode {
  const { bank, displayName, loadedSessionIds, onOpenSession, onToast, refreshToken = 0, onRefresh, renderItemActions, renderDetailActions } = props;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [kind, setKind] = useState<MemoryKindFilter>("all");
  const [onlyNeverRecalled, setOnlyNeverRecalled] = useState(false);
  const [onlyUnconsolidated, setOnlyUnconsolidated] = useState(false);
  const [onlyMissingSource, setOnlyMissingSource] = useState(false);
  const [sort, setSort] = useState<MemorySort>("newest");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [contentOpen, setContentOpen] = useState(false);
  // 列表与详情各用一个序号：翻页 / 过滤不会误丢弃详情请求，反之亦然。
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const detailCache = useRef(new Map<string, MemoryDetail>());
  const selection = useMemorySelection(
    bank,
    {
      query: debouncedQuery.trim() === "" ? null : debouncedQuery.trim(),
      kind,
      onlyNeverRecalled,
      onlyUnconsolidated,
      onlyMissingSource,
      sort,
    },
    onToast,
  );
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // 切库时退出选择模式并清空（选择不跨库）。
  useEffect(() => {
    selection.setSelecting(false);
    selection.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank]);

  useEffect(() => {
    detailCache.current.clear();
  }, [refreshToken]);

  // 过滤条件变化 → 从第 0 条重查；seq 守卫丢弃过期响应。
  // 选择只在同一库同一筛选中跨页保持，条件或刷新变化即清空。
  useEffect(() => {
    const id = ++listSeq.current;
    ++detailSeq.current;
    selection.reset();
    setLoading(true);
    setListError(null);
    setExpandedId(null);
    setDetail(null);
    setDetailLoading(false);
    memoryList({
      bank,
      query: debouncedQuery.trim() === "" ? null : debouncedQuery.trim(),
      kind,
      onlyNeverRecalled,
      onlyUnconsolidated,
      onlyMissingSource,
      sort,
      limit: PAGE_SIZE,
      offset: 0,
    })
      .then((page) => {
        if (listSeq.current !== id) return;
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((e: unknown) => {
        if (listSeq.current !== id) return;
        const text = errorText(normalizeError(e));
        setListError(text);
        onToast(`加载记忆列表失败：${text}`, "error");
      })
      .finally(() => {
        if (listSeq.current === id) setLoading(false);
      });
  }, [bank, debouncedQuery, kind, onlyNeverRecalled, onlyUnconsolidated, onlyMissingSource, sort, refreshToken, onToast]);

  function loadMore(): void {
    if (loadingMore || items.length >= total) return;
    const id = ++listSeq.current;
    setLoadingMore(true);
    memoryList({
      bank,
      query: debouncedQuery.trim() === "" ? null : debouncedQuery.trim(),
      kind,
      onlyNeverRecalled,
      onlyUnconsolidated,
      onlyMissingSource,
      sort,
      limit: PAGE_SIZE,
      offset: items.length,
    })
      .then((page) => {
        if (listSeq.current !== id) return;
        setItems((prev) => [...prev, ...page.items]);
        setTotal(page.total);
      })
      .catch((e: unknown) => {
        if (listSeq.current !== id) return;
        const text = errorText(normalizeError(e));
        setListError(text);
        onToast(`加载更多失败：${text}`, "error");
      })
      .finally(() => {
        if (listSeq.current === id) setLoadingMore(false);
      });
  }

  function toggleDetail(item: MemoryItem): void {
    if (expandedId === item.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(item.id);
    setContentOpen(false);
    setDetailError(null);
    const cached = detailCache.current.get(item.id);
    if (cached) {
      ++detailSeq.current;
      setDetailLoading(false);
      setDetail(cached);
      return;
    }
    const id = ++detailSeq.current;
    setDetail(null);
    setDetailLoading(true);
    memoryDetail({ bank, id: item.id })
      .then((d) => {
        if (detailSeq.current !== id) return;
        detailCache.current.set(item.id, d);
        setDetail(d);
      })
      .catch((e: unknown) => {
        if (detailSeq.current !== id) return;
        const text = errorText(normalizeError(e));
        setDetailError(text);
        onToast(`加载记忆详情失败：${text}`, "error");
      })
      .finally(() => {
        if (detailSeq.current === id) setDetailLoading(false);
      });
  }

  async function copySnippet(item: MemoryItem): Promise<void> {
    const ok = await copyText(item.snippet);
    onToast(ok ? "已复制记忆片段" : "复制失败：剪贴板不可用", ok ? "info" : "error");
  }

  async function copyContent(d: MemoryDetail): Promise<void> {
    const ok = await copyText(d.content);
    onToast(ok ? "已复制记忆全文" : "复制失败：剪贴板不可用", ok ? "info" : "error");
  }

  const filtering =
    debouncedQuery.trim() !== "" ||
    kind !== "all" ||
    onlyNeverRecalled ||
    onlyUnconsolidated ||
    onlyMissingSource;

  return (
    <section className="mem-list" aria-label={`${displayName}的记忆列表`}>
      <div className="mem-list-head">
        <h3 className="mem-list-title">{displayName} 的记忆</h3>
        <button
          type="button"
          className="btn btn-small"
          aria-pressed={selection.selecting}
          onClick={() => selection.setSelecting(!selection.selecting)}
        >
          选择
        </button>
      </div>
      <div className="mem-list-toolbar">
        <input
          type="search"
          className="filter-input"
          placeholder={`在 ${displayName} 中搜索记忆`}
          aria-label="搜索记忆"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="mem-kind" title={KIND_HELP}>
          类型
          <select aria-label="记忆类型" value={kind} onChange={(e) => setKind(e.target.value as MemoryKindFilter)}>
            <option value="all">全部</option>
            <option value="working">工作记忆</option>
            <option value="episodic">情节摘要</option>
          </select>
        </label>
        <div className="mem-chips" role="group" aria-label="记忆过滤">
          <button
            type="button"
            className="btn btn-small"
            aria-pressed={onlyNeverRecalled}
            onClick={() => setOnlyNeverRecalled((v) => !v)}
          >
            从未召回
          </button>
          <button
            type="button"
            className="btn btn-small"
            aria-pressed={onlyUnconsolidated}
            onClick={() => setOnlyUnconsolidated((v) => !v)}
          >
            未合并
          </button>
          <button
            type="button"
            className="btn btn-small"
            aria-pressed={onlyMissingSource}
            onClick={() => setOnlyMissingSource((v) => !v)}
          >
            来源已不在
          </button>
        </div>
        <span className="mem-preset" title="快捷筛选建议：只帮你打开筛选，不会自动选中任何记忆">
          <span className="muted">建议：</span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setOnlyNeverRecalled(true);
              setOnlyMissingSource(true);
            }}
          >
            从未召回且来源已不在
          </button>
        </span>
        <label className="mem-kind">
          排序
          <select aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value as MemorySort)}>
            <option value="newest">最新在前</option>
            <option value="oldest">最早在前</option>
            <option value="mostRecalled">召回最多</option>
          </select>
        </label>
        <span className="muted" aria-live="polite">
          {loading ? "加载中…" : `共 ${total} 条`}
        </span>
      </div>
      {selection.selecting ? (
        <MemorySelectionBar
          selection={selection}
          loadedIds={items.map((m) => m.id)}
          onDelete={() => setDeleteIds([...selection.checked])}
        />
      ) : null}
      {listError !== null ? <div className="pane-note">加载失败：{listError}</div> : null}
      {items.length === 0 && !loading && listError === null ? (
        <div className="pane-note">{filtering ? "没有匹配的记忆" : "该项目库暂无记忆"}</div>
      ) : null}
      <ul className="mem-items">
        {items.map((item) => {
          const jump = sourceJumpOf(item, loadedSessionIds);
          const open = expandedId === item.id;
          // 收集筛选项期间禁用行复选框：此时 setChecked 会整体覆盖，手动勾选会被丢弃。
          const collecting = selection.collecting !== null;
          const atCap = !selection.checked.has(item.id) && selection.checked.size >= MEMORY_DELETE_IDS_MAX;
          return (
            <li key={item.id} className="mem-item">
              <div className="mem-row">
                {selection.selecting ? (
                  <input
                    type="checkbox"
                    className="mem-check"
                    aria-label={`选择：${item.snippet}`}
                    checked={selection.checked.has(item.id)}
                    disabled={collecting || atCap}
                    title={collecting ? "正在收集筛选项，请稍候" : atCap ? "一次最多删除 500 条" : undefined}
                    onChange={(e) => selection.toggleCheck(item.id, e.target.checked)}
                  />
                ) : null}
                <button
                  type="button"
                  className="mem-open"
                  aria-expanded={open}
                  onClick={() => toggleDetail(item)}
                >
                  <span className={`mem-pill mem-pill-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                  <span className="mem-snippet" title={item.snippet}>
                    {highlightSnippet(item.snippet, debouncedQuery)}
                  </span>
                  <span className="mem-row-meta">
                    <span title={item.createdAt === null ? undefined : formatFullTime(item.createdAt)}>
                      {item.createdAt === null ? "时间未知" : formatRelativeTime(item.createdAt)}
                    </span>
                    <span>召回 {item.recallCount} 次</span>
                  </span>
                </button>
              </div>
              {selection.selecting ? null : (
              <div className="mem-row-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!jump.enabled}
                  title={jump.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.sourceSessionId !== null) onOpenSession(item.sourceSessionId);
                  }}
                >
                  查看来源会话
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    void copySnippet(item);
                  }}
                >
                  复制片段
                </button>
                {renderItemActions?.(item, onRefresh)}
              </div>
              )}
              {open ? (
                <div className="mem-detail">
                  {detailLoading ? <div className="pane-note">详情加载中…</div> : null}
                  {detailError !== null ? <div className="pane-note">详情加载失败：{detailError}</div> : null}
                  {detail !== null && detail.id === item.id ? (
                    <MemoryDetailBody
                      detail={detail}
                      jump={jump}
                      contentOpen={contentOpen}
                      onToggleContent={() => setContentOpen((v) => !v)}
                      onCopyContent={() => void copyContent(detail)}
                      onOpenSession={onOpenSession}
                      renderDetailActions={renderDetailActions}
                      onRefresh={onRefresh}
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {items.length > 0 && items.length < total ? (
        <div className="mem-more">
          <span className="muted">
            已显示 {items.length} / 共 {total} 条
          </span>
          <button type="button" className="btn" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : null}
      {deleteIds !== null ? (
        <MemoryDeleteDialog
          bank={bank}
          displayName={displayName}
          ids={deleteIds}
          onClose={() => setDeleteIds(null)}
          onToast={onToast}
          onDone={() => {
            setDeleteIds(null);
            selection.clearChecked();
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

function MemoryDetailBody(props: {
  detail: MemoryDetail;
  jump: SourceJump;
  contentOpen: boolean;
  onToggleContent: () => void;
  onCopyContent: () => void;
  onOpenSession: (sessionId: string) => void;
  renderDetailActions?: (detail: MemoryDetail, refresh: () => void) => ReactNode;
  onRefresh: () => void;
}): ReactNode {
  const { detail, jump, contentOpen, onToggleContent, onCopyContent, onOpenSession, renderDetailActions, onRefresh } = props;
  // 只有确实超过折叠高度（约 12 行）才提供展开，避免点了没反应的按钮。
  const expandable = detail.content.split("\n").length > 12 || detail.content.length > 600;
  return (
    <>
      <div className="mem-detail-actions">
        {expandable ? (
          <button type="button" className="btn btn-small" aria-expanded={contentOpen} onClick={onToggleContent}>
            {contentOpen ? "收起" : "展开全部"}
          </button>
        ) : null}
        <button type="button" className="btn btn-small" onClick={onCopyContent}>
          复制全文
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!jump.enabled}
          title={jump.title}
          onClick={() => {
            if (detail.sourceSessionId !== null) onOpenSession(detail.sourceSessionId);
          }}
        >
          查看来源会话
        </button>
        {renderDetailActions?.(detail, onRefresh)}
      </div>
      <div className={expandable && !contentOpen ? "mem-content mem-content-collapsed" : "mem-content"}>
        <pre className="plain-text">{detail.content}</pre>
      </div>
      {detail.truncated ? (
        <div className="pane-note">内容过长，仅显示前 {detail.content.length} 字符（全文 {detail.contentChars} 字符）。</div>
      ) : null}
      <dl className="mem-meta">
        <div>
          <dt>重要度</dt>
          <dd>{detail.importance === null ? "—" : detail.importance.toFixed(2)}</dd>
        </div>
        <div>
          <dt>可信度</dt>
          <dd>{detail.veracity ?? "—"}</dd>
        </div>
        <div>
          <dt>记忆类型</dt>
          <dd>{detail.memoryType ?? "—"}</dd>
        </div>
        <div>
          <dt>召回</dt>
          <dd>
            {detail.recallCount} 次
            {detail.lastRecalledAt === null ? "" : ` · 最近召回：${formatRelativeTime(detail.lastRecalledAt)}`}
          </dd>
        </div>
        <div>
          <dt>合并状态</dt>
          <dd>{detail.consolidated ? "已合并" : "未合并"}</dd>
        </div>
        <div>
          <dt>取代状态</dt>
          <dd>{detail.superseded ? "已被取代" : "有效"}</dd>
        </div>
        <div>
          <dt>关联边</dt>
          <dd>{detail.relatedEdges}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{detail.createdAt === null ? "未知" : formatFullTime(detail.createdAt)}</dd>
        </div>
      </dl>
      {detail.facts.length > 0 ? (
        <div className="mem-facts">
          <h4>抽取的事实（{detail.facts.length}）</h4>
          <ul>
            {detail.facts.map((f, i) => (
              <li key={`${f.key ?? "nokey"}-${i}`} className="mono">
                {[f.subject, f.predicate, f.object].filter((x) => x !== null).join(" · ") || "（空事实）"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail.summaryOf.length > 0 ? (
        <div className="mem-facts">
          <h4>摘要来源（{detail.summaryOf.length}）</h4>
          <ul>
            {detail.summaryOf.map((id) => (
              <li key={id} className="mono">
                {id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
