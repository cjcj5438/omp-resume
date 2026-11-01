/** 会话工作台：左栏会话列表（rail）+ 右栏详情。 */
import type { AppError, MetaSnapshot, ProjectGroup, SessionMeta, SessionSummary } from "../types";
import type { PinKind, Pins } from "../pins";
import type { ToastFn } from "./useOmpOp";
import { SessionRail } from "./SessionRail";
import { DetailPane } from "./DetailPane";
import "./SessionWorkspace.css";

interface SessionWorkspaceProps {
  groups: ProjectGroup[];
  totalCount: number;
  query: string;
  onQuery: (q: string) => void;
  listError: AppError | null;
  onRetry: () => void;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  onNewSession: () => void;
  onNewSessionIn: (cwd: string) => void;
  collapsed: ReadonlySet<string>;
  onCollapsedChange: (next: Set<string>) => void;
  pins: Pins;
  onTogglePin: (kind: PinKind, key: string) => void;
  meta: MetaSnapshot | null;
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
  onOpenMetaDialog: () => void;
  onForkRequest: (nodeId: string) => void;
  onDeleteSession: () => void;
  pinned: boolean;
  onToggleSessionPin: () => void;
  metaEntry: SessionMeta | null;
  detailTab: "overview" | "conv" | "tree";
  onDetailTabChange: (t: "overview" | "conv" | "tree") => void;
}

export function SessionWorkspace({
  groups,
  totalCount,
  query,
  onQuery,
  listError,
  onRetry,
  selectedPath,
  onSelectPath,
  onNewSession,
  onNewSessionIn,
  collapsed,
  onCollapsedChange,
  pins,
  onTogglePin,
  meta,
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
  onOpenMetaDialog,
  onForkRequest,
  onDeleteSession,
  pinned,
  onToggleSessionPin,
  metaEntry,
  detailTab,
  onDetailTabChange,
}: SessionWorkspaceProps) {
  return (
    <div className="workspace">
      <SessionRail
        groups={groups}
        totalCount={totalCount}
        query={query}
        onQuery={onQuery}
        listError={listError}
        onRetry={onRetry}
        selectedPath={selectedPath}
        onSelectPath={onSelectPath}
        onNewSession={onNewSession}
        onNewSessionIn={onNewSessionIn}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
        pins={pins}
        onTogglePin={onTogglePin}
        meta={meta}
        onToast={onToast}
        onOpenIterm={onOpenIterm}
        onRequestDelete={onRequestDelete}
        onMetaSnapshot={onMetaSnapshot}
      />
      <div className="ws-main">
        <DetailPane
          session={session}
          gone={gone}
          refreshKey={refreshKey}
          onOpenIterm={onOpenIterm}
          onOpenStage={onOpenStage}
          onBack={onBack}
          metaRequest={metaRequest}
          onOpenMetaDialog={onOpenMetaDialog}
          onForkRequest={onForkRequest}
          onDelete={onDeleteSession}
          onToast={onToast}
          pinned={pinned}
          onTogglePin={onToggleSessionPin}
          metaEntry={metaEntry}
          detailTab={detailTab}
          onDetailTabChange={onDetailTabChange}
        />
      </div>
    </div>
  );
}
