/** 会话列表页：页头 + 状态筛选条 + 会话列表 + 底部计数。 */
import type { MetaSnapshot, ProjectGroup, SessionSummary } from "../types";
import type { PinKind, Pins } from "../pins";
import type { TagCount } from "../listUtils";
import type { SessionFilter } from "../listUtils";
import type { ToastFn } from "./useOmpOp";
import { EmptyState } from "./ui";
import { PageHeader, Seg } from "./page";
import { SessionList } from "./SessionList";
import { SearchX, SquarePen } from "lucide-react";
import "./SessionsPage.css";
import { Ico } from "./ui";
import type { AppError } from "../types";

interface SessionsPageProps {
  groups: ProjectGroup[];
  pinnedSessions: SessionSummary[];
  counts: Record<SessionFilter, number>;
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
  onRefresh: () => void;
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
  pinnedSessions,
  counts,
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
  onRefresh,
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
  const isEmpty = groups.length === 0 && pinnedSessions.length === 0;
  return (
    <div className="view">
      <PageHeader
        kicker={`工作区 · ${runningCount} 个会话正在运行`}
        title="会话"
        sub="按项目归档的 append-only 会话树，只读浏览；需要继续时交还给真实的 omp --resume。"
        actions={
          <>
            <button type="button" className="btn" disabled={loading} onClick={onRescan}>
              {loading ? <span className="spinner" aria-hidden="true" /> : null}
              重新扫描
            </button>
            <button type="button" className="btn btn-accent" onClick={onNewSession}>
              <Ico icon={SquarePen} size={13} />
              新建会话…
            </button>
          </>
        }
      />
      <div className="toolbar sessions-toolbar">
        <Seg
          label="状态筛选"
          value={statusFilter}
          onChange={onStatusFilter}
          options={[
            { value: "all", label: "全部", count: counts.all },
            { value: "running", label: "运行中", count: counts.running },
            { value: "pinned", label: "已置顶", count: counts.pinned },
            { value: "issues", label: "有问题", count: counts.issues },
          ]}
        />
        <span className="spacer" />
        <span className="muted">{`按最近修改排序 · 共 ${visibleCount} 个`}</span>
      </div>
      {isEmpty && listError === null ? (
        <EmptyState
          icon={SearchX}
          title="没有匹配的会话"
          action={
            <button type="button" className="btn" onClick={onClearFilters}>
              清除筛选
            </button>
          }
        >
          换个关键词，或清除筛选条件。
        </EmptyState>
      ) : (
        <SessionList
          variant="page"
          groups={groups}
          pinnedSessions={pinnedSessions}
          query={query}
          onQuery={onQuery}
          loading={loading}
          listError={listError}
          onRetry={onRetry}
          onRefresh={onRefresh}
          checked={checked}
          onToggleCheck={onToggleCheck}
          onToggleChecks={onToggleChecks}
          onClearChecks={onClearChecks}
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
