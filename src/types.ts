/**
 * 前端类型镜像：必须与 `src-tauri/src/model.rs` 逐字段对应。
 * 命名：JSON 侧一律 camelCase；语义规则见 `docs/CONTRACT.md`。
 */

export type ErrorCode =
  | "IN_USE"
  | "PROBE_FAILED"
  | "CWD_MISSING"
  | "NOT_FOUND"
  | "OUTSIDE_ROOT"
  | "UNSUPPORTED_FORMAT"
  | "INVALID_NODE"
  | "IO"
  | "ITERM_FAILED"
  | "UNKNOWN";

export interface AppError {
  code: ErrorCode;
  message: string;
}

export interface GetConfigResult {
  sessionsDir: string;
  ownersDir: string;
}

export interface ListSessionsResult {
  sessionsDir: string;
  hiddenEmpty: number;
  groups: ProjectGroup[];
}

export interface ProjectGroup {
  cwd: string;
  dirName: string;
  sessions: SessionSummary[];
}

export interface ForkInfo {
  parentRaw: string;
  parentTitle: string | null;
  parentPath: string | null;
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  cwdExists: boolean;
  title: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
  messageCount: number;
  branchCount: number;
  inUse: boolean;
  probeOk: boolean;
  fork: ForkInfo | null;
  formatSupported: boolean;
  version: number | null;
  badLines: number;
  firstUserMessage: string | null;
}

export interface GetConversationRequest {
  path: string;
  nodeId?: string | null;
}

export interface Conversation {
  path: string;
  leafId: string | null;
  targetId: string;
  items: ConversationItem[];
}

export type ConversationItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; blocks: AssistantBlock[] }
  | {
      kind: "toolResult";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "bashExecution";
      command: string;
      text: string;
      truncated: boolean;
      exitCode: number | null;
      cancelled: boolean;
    }
  | { kind: "compaction"; summary: string }
  | { kind: "branchSummary"; summary: string }
  | { kind: "other"; role: string; text: string };

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; id: string; name: string; args: unknown };

export interface GetTreeRequest {
  path: string;
}

export interface TreeData {
  path: string;
  leafId: string | null;
  rootIds: string[];
  activePathIds: string[];
  nodes: TreeNode[];
}

export type TreeNodeKind = "message" | "compaction" | "branchSummary";

export interface TreeNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  kind: TreeNodeKind;
  role: string | null;
  timestamp: string;
  preview: string;
  label: string | null;
  isCompaction: boolean;
  isBranchSummary: boolean;
}

export interface CheckSessionRequest {
  path: string;
}

export interface CheckSessionResult {
  inUse: boolean;
  probeOk: boolean;
}

export interface DeleteSessionsRequest {
  paths: string[];
}

export interface DeleteResult {
  path: string;
  ok: boolean;
  error: AppError | null;
}

export interface AppendBranchMarkerRequest {
  path: string;
  nodeId: string;
}

export interface AppendBranchMarkerResult {
  /** 新标记条目 id；nodeId 已是 leaf 时为 null（无操作）。 */
  markerId: string | null;
}

export interface OpenInItermRequest {
  path: string;
}
