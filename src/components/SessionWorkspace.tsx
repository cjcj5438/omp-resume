/** 会话工作台：左栏会话列表（rail）+ 右栏详情。 */
import type { AppError, MetaSnapshot, ProjectGroup, SessionMeta, SessionSummary } from "../types";
import type { PinKind, Pins } from "../pins";
import type { TagCount } from "../listUtils";
import type { ContinueOutcome } from "../flows";
import type { ToastFn } from "./useOmpOp";
import { SessionList } from "./SessionList";
import { DetailPane } from "./DetailPane";
import "./SessionWorkspace.css";

interface SessionWorkspaceProps {
  groups: ProjectGroup[];
  pinnedSessions: SessionSummary[];
  query: string;
  onQuery: (q: string) => void;
  loading: boolean;
  listError: AppError | null;
  onRetry: () => void;
  onRefresh: () => void;
  checked: Set<string>;
  onToggleCheck: (path: string, on: boolean) => void;
  onToggleChecks: (paths: string[], on: boolean) => void;
  onClearChecks: () => void;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
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
  onToast: ToastFn;
  onOpenIterm: (s: SessionSummary) => void;
  onRequestDelete: (paths: string[]) => void;
  onMetaSnapshot: (snap: MetaSnapshot) => void;
  // 右栏详情
  session: SessionSummary | null;
  gone: boolean;
  refreshKey: number;
  onOpenStage: (path: string) => void;
  onBack: () => void;
  metaRequest: { path: string; seq: number } | null;
  onDeleteSession: () => void;
  onContinue: (nodeId: string) => Promise<ContinueOutcome>;
  pinned: boolean;
  onToggleSessionPin: () => void;
  metaEntry: SessionMeta | null;
  metaRevision: number;
  metaError: AppError | null;
}

export function SessionWorkspace({
  groups,
  pinnedSessions,
  query,
  onQuery,
  loading,
  listError,
  onRetry,
  onRefresh,
  checked,
  onToggleCheck,
  onToggleChecks,
  onClearChecks,
  selectedPath,
  onSelectPath,
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
  onToast,
  onOpenIterm,
  onRequestDelete,
  onMetaSnapshot,
  session,
  gone,
  refreshKey,
  onOpenStage,
  onBack,
  metaRequest,
  onDeleteSession,
  onContinue,
  pinned,
  onToggleSessionPin,
  metaEntry,
  metaRevision,
  metaError,
}: SessionWorkspaceProps) {
  return (
    <div className="workspace">
      <div className="ws-rail">
        <SessionList
          variant="rail"
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
          onOpenSession={onSelectPath}
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
      </div>
      <div className="ws-main">
        <DetailPane
          session={session}
          gone={gone}
          refreshKey={refreshKey}
          onOpenIterm={onOpenIterm}
          onOpenStage={onOpenStage}
          onBack={onBack}
          metaRequest={metaRequest}
          onDelete={onDeleteSession}
          onContinue={onContinue}
          onToast={onToast}
          pinned={pinned}
          onTogglePin={onToggleSessionPin}
          metaEntry={metaEntry}
          metaRevision={metaRevision}
          metaError={metaError}
          onMetaSnapshot={onMetaSnapshot}
        />
      </div>
    </div>
  );
}
