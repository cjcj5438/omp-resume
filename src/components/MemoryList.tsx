/** 记忆列表：搜索 / 过滤 / 排序 / 分页 / 详情 / 多选删除（删除走 MemoryDeleteDialog）。 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryDetail, memoryList, normalizeError } from "../api";
import type { MemoryDetail, MemoryItem, MemoryKindFilter, MemorySort } from "../types";
import { copyText } from "../clipboard";
import { errorText, formatFullTime, formatRelativeTime } from "../format";
import type { ToastFn } from "./useOmpOp";
import { MemoryDeleteDialog, MemoryItemDeleteButton } from "./MemoryDeleteDialog";
import { MEMORY_DELETE_IDS_MAX } from "./useMemoryMaintenance";
import "./MemoryPanel.css";

const KIND_LABEL: Record<MemoryItem["kind"], string> = { working: "工作记忆", episodic: "情节摘要" };

interface SourceJump {
  enabled: boolean;
  title: string | undefined;
}

function sourceJumpOf(item: MemoryItem, loaded: ReadonlySet<string>): SourceJump {
  if (item.sourceSessionId === null) return { enabled: false, title: "该记忆未记录来源会话" };
  if (loaded.has(item.sourceSessionId)) return { enabled: true, title: undefined };
  if (item.sourceSessionExists === false) return { enabled: false, title: "来源会话已不在（可能已被删除）" };
  return { enabled: false, title: "来源会话未加载到当前列表" };
}

function highlightSnippet(snippet: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  const idx = q === "" ? -1 : snippet.toLowerCase().indexOf(q);
  if (idx < 0) return snippet;
  return (
    <>
      {snippet.slice(0, idx)}
      <mark>{snippet.slice(idx, idx + q.length)}</mark>
      {snippet.slice(idx + q.length)}
    </>
  );
}

async function copyWithToast(text: string, what: string, onToast: ToastFn): Promise<void> {
  onToast((await copyText(text)) ? `已复制${what}` : "复制失败：剪贴板不可用", "info");
}

interface Selection {
  selecting: boolean;
  checked: ReadonlySet<string>;
  collecting: { done: number; total: number | null } | null;
  toggle: (id: string, on: boolean) => void;
  clear: () => void;
  selectLoaded: (ids: string[]) => void;
  selectAllFiltered: () => void;
}

export function MemoryList(props: {
  bank: string;
  displayName: string;
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  onToast: ToastFn;
  refreshToken?: number;
  /** 写操作成功后的统一失效入口（总览 + 列表 + 详情缓存）。 */
  onRefresh: () => void;
  /** 从关系图跳过来的定位 id：走 memoryDetail 直取，可跨分页，置顶展示。 */
  focusId?: string | null;
  onClearFocus?: () => void;
}): ReactNode {
  const { bank, displayName, loadedSessionIds, onOpenSession, onToast, refreshToken = 0, onRefresh, focusId = null, onClearFocus } = props;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<MemoryKindFilter>("all");
  const [flags, setFlags] = useState({ never: false, uncons: false, missing: false });
  const [sort, setSort] = useState<MemorySort>("newest");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<{ id: string; detail: MemoryDetail | null; loading: boolean; error: string | null; open: boolean } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [collecting, setCollecting] = useState<{ done: number; total: number | null } | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const collectSeq = useRef(0);
  const detailCache = useRef(new Map<string, MemoryDetail>());
  /** 关系图定位：走 memoryDetail 直取（可跨分页），置顶展示，与列表筛选无关。 */
  const [focus, setFocus] = useState<{ detail: MemoryDetail; open: boolean } | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);
  const focusSeq = useRef(0);
  const focusRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (focusId === null) {
      focusSeq.current += 1;
      setFocus(null);
      setFocusError(null);
      setFocusLoading(false);
      return;
    }
    const cached = detailCache.current.get(focusId);
    if (cached !== undefined) {
      focusSeq.current += 1;
      setFocus({ detail: cached, open: false });
      setFocusError(null);
      setFocusLoading(false);
      return;
    }
    const run = ++focusSeq.current;
    setFocus(null);
    setFocusError(null);
    setFocusLoading(true);
    memoryDetail({ bank, id: focusId })
      .then((d) => {
        if (focusSeq.current !== run) return;
        detailCache.current.set(focusId, d);
        setFocus({ detail: d, open: false });
      })
      .catch((e: unknown) => {
        if (focusSeq.current !== run) return;
        setFocusError(errorText(normalizeError(e)));
      })
      .finally(() => focusSeq.current === run && setFocusLoading(false));
  }, [bank, focusId]);

  useEffect(() => {
    if (focus !== null) focusRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focus]);
  const filter = {
    query: debounced.trim() === "" ? null : debounced.trim(),
    kind,
    onlyNeverRecalled: flags.never,
    onlyUnconsolidated: flags.uncons,
    onlyMissingSource: flags.missing,
    sort,
  };

  function clearChecked(): void {
    collectSeq.current += 1;
    setCollecting(null);
    setChecked(new Set());
  }
  const selection: Selection = {
    selecting,
    checked,
    collecting,
    clear: clearChecked,
    toggle: (id, on) =>
      setChecked((prev) => {
        if (!on) {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        }
        return prev.has(id) || prev.size >= MEMORY_DELETE_IDS_MAX ? prev : new Set(prev).add(id);
      }),
    selectLoaded: (ids) =>
      setChecked((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (next.size >= MEMORY_DELETE_IDS_MAX) break;
          next.add(id);
        }
        return next;
      }),
    selectAllFiltered: () => {
      if (collecting !== null) return;
      const run = ++collectSeq.current;
      setCollecting({ done: 0, total: null });
      void (async () => {
        const ids: string[] = [];
        let offset = 0;
        let seen: number | null = null;
        try {
          for (;;) {
            const page = await memoryList({ bank, ...filter, limit: 200, offset });
            if (collectSeq.current !== run) return;
            seen ??= page.total;
            for (const m of page.items) {
              if (ids.length >= MEMORY_DELETE_IDS_MAX) break;
              ids.push(m.id);
            }
            setCollecting({ done: ids.length, total: seen });
            offset += page.items.length;
            if (ids.length >= MEMORY_DELETE_IDS_MAX || offset >= seen || page.items.length === 0) break;
          }
          if (collectSeq.current !== run) return;
          setChecked(new Set(ids));
          if (seen > MEMORY_DELETE_IDS_MAX) onToast(`共 ${seen} 条，已选中前 500 条（一次最多删除 500 条）`, "info");
        } catch (e: unknown) {
          if (collectSeq.current === run) onToast(`收集筛选项失败：${errorText(normalizeError(e))}`, "error");
        } finally {
          if (collectSeq.current === run) setCollecting(null);
        }
      })();
    },
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // 切库、改筛选或刷新：丢弃选择与详情，从第 0 条重查；seq 守卫丢弃过期响应。
  useEffect(() => {
    const id = ++listSeq.current;
    ++detailSeq.current;
    clearChecked();
    setLoading(true);
    setListError(null);
    setExpanded(null);
    memoryList({ bank, ...filter, limit: 50, offset: 0 })
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
      .finally(() => listSeq.current === id && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, debounced, kind, flags, sort, refreshToken]);

  useEffect(() => {
    setSelecting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank]);

  function loadMore(): void {
    if (loadingMore || items.length >= total) return;
    const id = ++listSeq.current;
    setLoadingMore(true);
    memoryList({ bank, ...filter, limit: 50, offset: items.length })
      .then((page) => {
        if (listSeq.current !== id) return;
        setItems((prev) => [...prev, ...page.items]);
        setTotal(page.total);
      })
      .catch((e: unknown) => listSeq.current === id && setListError(errorText(normalizeError(e))))
      .finally(() => listSeq.current === id && setLoadingMore(false));
  }

  function toggleDetail(item: MemoryItem): void {
    if (expanded?.id === item.id) {
      setExpanded(null);
      return;
    }
    setExpanded({ id: item.id, detail: null, loading: true, error: null, open: false });
    const cached = detailCache.current.get(item.id);
    if (cached !== undefined) {
      ++detailSeq.current;
      setExpanded({ id: item.id, detail: cached, loading: false, error: null, open: false });
      return;
    }
    const id = ++detailSeq.current;
    memoryDetail({ bank, id: item.id })
      .then((d) => {
        if (detailSeq.current !== id) return;
        detailCache.current.set(item.id, d);
        setExpanded((prev) => (prev?.id === item.id ? { ...prev, detail: d, loading: false } : prev));
      })
      .catch((e: unknown) => {
        if (detailSeq.current !== id) return;
        setExpanded((prev) => (prev?.id === item.id ? { ...prev, loading: false, error: errorText(normalizeError(e)) } : prev));
      });
  }

  const filtering = debounced.trim() !== "" || kind !== "all" || flags.never || flags.uncons || flags.missing;

  return (
    <section className="mem-list" aria-label={`${displayName}的记忆列表`}>
      <div className="mem-list-head">
        <h3 className="mem-list-title">{displayName} 的记忆</h3>
        <button type="button" className="btn btn-small" aria-pressed={selecting} onClick={() => setSelecting(!selecting)}>
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
        <label className="mem-kind" title="工作记忆：零散知识点与偏好；情节摘要：从某次对话提炼的事件摘要。">
          类型
          <select aria-label="记忆类型" value={kind} onChange={(e) => setKind(e.target.value as MemoryKindFilter)}>
            <option value="all">全部</option>
            <option value="working">工作记忆</option>
            <option value="episodic">情节摘要</option>
          </select>
        </label>
        <div className="mem-chips" role="group" aria-label="记忆过滤">
          {([
            ["never", "从未召回"],
            ["uncons", "未合并"],
            ["missing", "来源已不在"],
          ] as const).map(([key, label]) => (
            <button key={key} type="button" className="btn btn-small" aria-pressed={flags[key]} onClick={() => setFlags((prev) => ({ ...prev, [key]: !prev[key] }))}>
              {label}
            </button>
          ))}
        </div>
        <label className="mem-kind">
          排序
          <select aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value as MemorySort)}>
            <option value="newest">最新在前</option>
            <option value="oldest">最早在前</option>
            <option value="mostRecalled">召回最多</option>
          </select>
        </label>
        <span className="muted" aria-live="polite">{loading ? "加载中…" : `共 ${total} 条`}</span>
      </div>
      {selecting ? <SelectionBar selection={selection} loadedIds={items.map((m) => m.id)} onDelete={() => setDeleteIds([...checked])} /> : null}
      {listError !== null ? <div className="pane-note">加载失败：{listError}</div> : null}
      {items.length === 0 && !loading && listError === null ? (
        <div className="pane-note">{filtering ? "没有匹配的记忆" : "该项目库暂无记忆"}</div>
      ) : null}
      {focusId !== null ? (
        <ul className="mem-items" aria-label="定位的记忆">
          <li ref={focusRef} className="mem-item mem-focus-item">
            {focusLoading ? <div className="pane-note">定位记忆加载中…</div> : null}
            {focusError !== null ? <div className="pane-note">定位记忆加载失败：{focusError}</div> : null}
            {focus !== null ? (
              <>
                <div className="mem-row">
                  <span className={`mem-pill mem-pill-${focus.detail.kind}`}>{KIND_LABEL[focus.detail.kind]}</span>
                  <span className="mem-snippet">{focus.detail.snippet}</span>
                  <span className="mem-row-meta">
                    <span title={focus.detail.createdAt === null ? undefined : formatFullTime(focus.detail.createdAt)}>
                      {focus.detail.createdAt === null ? "时间未知" : formatRelativeTime(focus.detail.createdAt)}
                    </span>
                    <span>召回 {focus.detail.recallCount} 次</span>
                  </span>
                </div>
                <div className="mem-row-actions">
                  <span className="muted">从关系图定位</span>
                  <button type="button" className="btn btn-small" onClick={() => onClearFocus?.()}>
                    取消定位
                  </button>
                </div>
                <div className="mem-detail">
                  <DetailBody
                    detail={focus.detail}
                    jump={sourceJumpOf(focus.detail, loadedSessionIds)}
                    open={focus.open}
                    onToggle={() => setFocus((f) => (f === null ? f : { ...f, open: !f.open }))}
                    onOpenSession={onOpenSession}
                    onToast={onToast}
                    actions={
                      <MemoryItemDeleteButton bank={bank} displayName={displayName} ids={[focus.detail.id]} onToast={onToast} onDone={() => { detailCache.current.delete(focus.detail.id); onClearFocus?.(); onRefresh(); }} />
                    }
                  />
                </div>
              </>
            ) : null}
          </li>
        </ul>
      ) : null}
      <ul className="mem-items">
        {items.map((item) => {
          const jump = sourceJumpOf(item, loadedSessionIds);
          const open = expanded?.id === item.id;
          const busy = collecting !== null;
          const atCap = !checked.has(item.id) && checked.size >= MEMORY_DELETE_IDS_MAX;
          return (
            <li key={item.id} className="mem-item">
              <div className="mem-row">
                {selecting ? (
                  <input
                    type="checkbox"
                    className="mem-check"
                    aria-label={`选择：${item.snippet}`}
                    checked={checked.has(item.id)}
                    disabled={busy || atCap}
                    title={busy ? "正在收集筛选项，请稍候" : atCap ? "一次最多删除 500 条" : undefined}
                    onChange={(e) => selection.toggle(item.id, e.target.checked)}
                  />
                ) : null}
                <button type="button" className="mem-open" aria-expanded={open} onClick={() => toggleDetail(item)}>
                  <span className={`mem-pill mem-pill-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                  <span className="mem-snippet" title={item.snippet}>
                    {highlightSnippet(item.snippet, debounced)}
                  </span>
                  <span className="mem-row-meta">
                    <span title={item.createdAt === null ? undefined : formatFullTime(item.createdAt)}>
                      {item.createdAt === null ? "时间未知" : formatRelativeTime(item.createdAt)}
                    </span>
                    <span>召回 {item.recallCount} 次</span>
                  </span>
                </button>
              </div>
              {selecting ? null : (
                <div className="mem-row-actions">
                  <button type="button" className="btn btn-small" disabled={!jump.enabled} title={jump.title}
                    onClick={() => item.sourceSessionId !== null && onOpenSession(item.sourceSessionId)}>
                    查看来源会话
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => void copyWithToast(item.snippet, "记忆片段", onToast)}>复制片段</button>
                </div>
              )}
              {open && expanded !== null ? (
                <div className="mem-detail">
                  {expanded.loading ? <div className="pane-note">详情加载中…</div> : null}
                  {expanded.error !== null ? <div className="pane-note">详情加载失败：{expanded.error}</div> : null}
                  {expanded.detail !== null ? (
                    <DetailBody
                      detail={expanded.detail}
                      jump={jump}
                      open={expanded.open}
                      onToggle={() => setExpanded({ ...expanded, open: !expanded.open })}
                      onOpenSession={onOpenSession}
                      onToast={onToast}
                      actions={<MemoryItemDeleteButton bank={bank} displayName={displayName} ids={[item.id]} onToast={onToast} onDone={onRefresh} />}
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
          <span className="muted">已显示 {items.length} / 共 {total} 条</span>
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
            clearChecked();
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

function SelectionBar(props: { selection: Selection; loadedIds: string[]; onDelete: () => void }): ReactNode {
  const { selection: s, loadedIds, onDelete } = props;
  const busy = s.collecting !== null;
  const title = busy ? "正在收集筛选项，请稍候" : undefined;
  const collectLabel = busy
    ? `正在收集…${s.collecting?.total == null ? `已取 ${s.collecting?.done ?? 0} 条` : `${s.collecting?.done ?? 0}/${s.collecting.total} 条`}`
    : "选中当前筛选的全部结果";
  return (
    <div className="mem-selectbar" aria-live="polite">
      <span>已选 {s.checked.size} 条</span>
      <button type="button" className="btn btn-small" disabled={busy || loadedIds.length === 0} title={title} onClick={() => s.selectLoaded(loadedIds)}>
        全选当前已加载
      </button>
      <button type="button" className="btn btn-small" disabled={busy || s.checked.size === 0} title={title} onClick={s.clear}>
        清除
      </button>
      <button type="button" className="btn btn-small" disabled={busy} onClick={s.selectAllFiltered}>
        {collectLabel}
      </button>
      <button type="button" className="btn btn-small" disabled={busy || s.checked.size === 0} title={title} onClick={onDelete}>
        删除所选…
      </button>
      {s.checked.size >= MEMORY_DELETE_IDS_MAX ? <span className="muted">已达上限 500 条</span> : null}
    </div>
  );
}

const META_FIELDS: { label: string; value: (d: MemoryDetail) => ReactNode }[] = [
  { label: "重要度", value: (d) => (d.importance === null ? "—" : d.importance.toFixed(2)) },
  { label: "可信度", value: (d) => d.veracity ?? "—" },
  { label: "记忆类型", value: (d) => d.memoryType ?? "—" },
  { label: "召回", value: (d) => `${d.recallCount} 次${d.lastRecalledAt === null ? "" : ` · 最近 ${formatRelativeTime(d.lastRecalledAt)}`}` },
  { label: "合并状态", value: (d) => (d.consolidated ? "已合并" : "未合并") },
  { label: "取代状态", value: (d) => (d.superseded ? "已被取代" : "有效") },
  { label: "关联边", value: (d) => d.relatedEdges },
  { label: "创建时间", value: (d) => (d.createdAt === null ? "未知" : formatFullTime(d.createdAt)) },
];

function DetailBody(props: {
  detail: MemoryDetail;
  jump: SourceJump;
  open: boolean;
  onToggle: () => void;
  onOpenSession: (sessionId: string) => void;
  onToast: ToastFn;
  actions: ReactNode;
}): ReactNode {
  const { detail, jump, open, onToggle, onOpenSession, onToast, actions } = props;
  // 只有确实超过折叠高度（约 12 行）才提供展开，避免点了没反应的按钮。
  const expandable = detail.content.split("\n").length > 12 || detail.content.length > 600;
  return (
    <>
      <div className="mem-detail-actions">
        {expandable ? (
          <button type="button" className="btn btn-small" aria-expanded={open} onClick={onToggle}>
            {open ? "收起" : "展开全部"}
          </button>
        ) : null}
        <button type="button" className="btn btn-small" onClick={() => void copyWithToast(detail.content, "记忆全文", onToast)}>
          复制全文
        </button>
        <button type="button" className="btn btn-small" disabled={!jump.enabled} title={jump.title}
          onClick={() => detail.sourceSessionId !== null && onOpenSession(detail.sourceSessionId)}>
          查看来源会话
        </button>
        {actions}
      </div>
      <div className={expandable && !open ? "mem-content mem-content-collapsed" : "mem-content"}>
        <pre className="plain-text">{detail.content}</pre>
      </div>
      {detail.truncated ? (
        <div className="pane-note">内容过长，仅显示前 {detail.content.length} 字符（全文 {detail.contentChars} 字符）。</div>
      ) : null}
      <dl className="mem-meta">
        {META_FIELDS.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value(detail)}</dd>
          </div>
        ))}
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
