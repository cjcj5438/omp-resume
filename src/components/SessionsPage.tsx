/** 会话列表页：页头 + 状态筛选条 + 会话列表 + 底部计数。 */
import { useState } from "react";
import type { MetaSnapshot, ProjectGroup, SessionSummary } from "../types";
import type { PinKind, Pins } from "../pins";
import type { SessionFilter, TagCount } from "../listUtils";
import type { ToastFn } from "./useOmpOp";
import { EmptyState } from "./ui";
import { PageHeader, SearchInput } from "./page";
import { SessionList } from "./SessionList";
import { ListChecks, Plus, RefreshCw, SearchX } from "lucide-react";
import "./SessionsPage.css";
import { Ico } from "./ui";
import type { AppError } from "../types";
interface SessionsPageProps {
  groups: ProjectGroup[];
  statusFilter: SessionFilter;
  onStatusFilter: (f: SessionFilter) => void;
  /** 当前可见会话数（过滤后）。 */
  visibleCount: number;
  /** 运行中会话数（kicker 用）。 */
  runningCount: number;
  totalCount: number;
  hiddenEmpty: number;
  query: string;
  onQuery: (q: string) => void;
  loading: boolean;
  listError: AppError | null;
  onRetry: () => void;
  onRescan: () => void;
  onNewSession: () => void;
  checked: Set<string>;
  onToggleCheck: (path: string, on: boolean) => void;
  onToggleChecks: (paths: string[], on: boolean) => void;
  onClearChecks: () => void;
  selectedPath: string | null;
  onOpenSession: (path: string) => void;
  onOpenMeta: (path: string) => void;
  onBulkResume: (targets: SessionSummary[]) => void;
  collapsed: ReadonlySet<string>;
  onCollapsedChange: (next: Set<string>) => void;
  pins: Pins;
  onTogglePin: (kind: PinKind, key: string) => void;
  onNewSessionIn: (cwd: string) => void;
  meta: MetaSnapshot | null;
  tagCounts: TagCount[];
  activeTags: readonly string[];
  onToggleTag: (tag: string) => void;
  onClearFilters: () => void;
  onToast: ToastFn;
  onOpenIterm: (s: SessionSummary) => void;
  onRequestDelete: (paths: string[]) => void;
  onMetaSnapshot: (snap: MetaSnapshot) => void;
}

export function SessionsPage({
  groups,
  statusFilter,
  onStatusFilter,
  visibleCount,
  runningCount,
  totalCount,
  hiddenEmpty,
  query,
  onQuery,
  loading,
  listError,
  onRetry,
  onRescan,
  onNewSession,
  checked,
  onToggleCheck,
  onToggleChecks,
  onClearChecks,
  selectedPath,
  onOpenSession,
  onOpenMeta,
  onBulkResume,
  collapsed,
  onCollapsedChange,
  pins,
  onTogglePin,
  onNewSessionIn,
  meta,
  tagCounts,
  activeTags,
  onToggleTag,
  onClearFilters,
  onToast,
  onOpenIterm,
  onRequestDelete,
  onMetaSnapshot,
}: SessionsPageProps) {
  const isEmpty = groups.length === 0;
  // 多选模式（S1）：toolbar 行尾开关持有；打开后勾选框常显、选择条常驻。
  const [multiMode, setMultiMode] = useState(false);
  const toggleMulti = () => {
    if (multiMode || checked.size > 0) {
      setMultiMode(false);
      onClearChecks();
    } else {
      setMultiMode(true);
    }
  };
  const chips: Array<{ value: SessionFilter; label: string }> = [
    { value: "all", label: "全部" },
    { value: "running", label: "运行中" },
    { value: "pinned", label: "已置顶" },
    { value: "issues", label: "有问题" },
  ];
  return (
    <div className="view">
      <PageHeader
        kicker={`工作区 · ${runningCount} 个会话正在运行`}
        title="会话"
        sub="按项目归档的 append-only 会话树，只读浏览；需要继续时交还给真实的 omp --resume。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" disabled={loading} onClick={onRescan}>
              {loading ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <Ico icon={RefreshCw} size={13} />
              )}
              重新扫描
            </button>
            <button type="button" className="btn btn-primary" onClick={onNewSession}>
              <Ico icon={Plus} size={13} />
              新建会话
            </button>
          </>
        }
      />
      <div className="toolbar sessions-toolbar" role="search">
        <SearchInput
          icon
          label="搜索会话"
          placeholder="搜索标题、路径或模型"
          value={query}
          onChange={onQuery}
        />
        {chips.map((c) => (
          <button
            key={c.value}
            type="button"
            className={statusFilter === c.value ? "chip is-on" : "chip"}
            aria-pressed={statusFilter === c.value}
            aria-label={`状态筛选：${c.label}`}
            onClick={() => onStatusFilter(c.value)}
          >
            {c.value === "running" ? <span className="dot live" aria-hidden="true" /> : null}
            {c.label}
          </button>
        ))}
        <span className="spacer" />
        <span className="muted sessions-sort">{`按最近使用排序 · 共 ${visibleCount} 个`}</span>
        <button
          type="button"
          className="btn icon-btn icon-btn-multi"
          aria-label="多选"
          aria-pressed={multiMode || checked.size > 0}
          title="多选"
          onClick={toggleMulti}
        >
          <Ico icon={ListChecks} size={13} />
        </button>
      </div>
      {isEmpty && listError === null ? (
        <div className="panel">
          <EmptyState
            icon={SearchX}
            title="没有匹配的会话"
            action={
              <button type="button" className="btn btn-ghost" onClick={onClearFilters}>
              </button>
            }
          >
            换个关键词，或清除运行中 / 已置顶筛选。
          </EmptyState>
        </div>
      ) : (
        <SessionList
          groups={groups}
          listError={listError}
          onRetry={onRetry}
          checked={checked}
          onToggleCheck={onToggleCheck}
          onToggleChecks={onToggleChecks}
          onClearChecks={onClearChecks}
          multiMode={multiMode}
          selectedPath={selectedPath}
          onOpenSession={onOpenSession}
          onOpenMeta={onOpenMeta}
          onBulkResume={onBulkResume}
          collapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          pins={pins}
          onTogglePin={onTogglePin}
          onNewSessionIn={onNewSessionIn}
          meta={meta}
          tagCounts={tagCounts}
          activeTags={activeTags}
          onToggleTag={onToggleTag}
          onToast={onToast}
          onOpenIterm={onOpenIterm}
          onRequestDelete={onRequestDelete}
          onMetaSnapshot={onMetaSnapshot}
        />
      )}
      <p className="muted sessions-foot">{`共 ${totalCount} 个会话 · 已隐藏 ${hiddenEmpty} 个空会话`}</p>
    </div>
  );
}
