/**
 * 后端命令的类型化封装：每个命令一个函数，错误归一化为 `AppError`。
 * 命令名 snake_case，参数/返回值 JSON camelCase（见 docs/CONTRACT.md）。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AppendBranchMarkerRequest,
  AppendBranchMarkerResult,
  AppError,
  CheckSessionRequest,
  CheckSessionResult,
  Conversation,
  DeleteResult,
  DeleteSessionsRequest,
  ErrorCode,
  GetConfigResult,
  GetConversationRequest,
  GetTreeRequest,
  ListSessionsResult,
  OpenInItermRequest,
  TreeData,
} from "./types";

const KNOWN_CODES: Record<string, true> = {
  IN_USE: true,
  PROBE_FAILED: true,
  CWD_MISSING: true,
  NOT_FOUND: true,
  OUTSIDE_ROOT: true,
  UNSUPPORTED_FORMAT: true,
  INVALID_NODE: true,
  IO: true,
  ITERM_FAILED: true,
  UNKNOWN: true,
};

/** 把 `invoke` 抛出的任意值归一化为 `AppError`。 */
export function normalizeError(e: unknown): AppError {
  if (e !== null && typeof e === "object" && "code" in e && "message" in e) {
    const code = e.code;
    const message = e.message;
    if (typeof code === "string" && typeof message === "string") {
      return {
        code: KNOWN_CODES[code] ? (code as ErrorCode) : "UNKNOWN",
        message,
      };
    }
  }
  if (typeof e === "string") return { code: "UNKNOWN", message: e };
  if (e instanceof Error) return { code: "UNKNOWN", message: e.message };
  try {
    return { code: "UNKNOWN", message: JSON.stringify(e) };
  } catch {
    return { code: "UNKNOWN", message: "未知错误" };
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw normalizeError(e);
  }
}

export function getConfig(): Promise<GetConfigResult> {
  return call("get_config");
}

export function listSessions(): Promise<ListSessionsResult> {
  return call("list_sessions");
}

export function getConversation(
  req: GetConversationRequest,
): Promise<Conversation> {
  return call("get_conversation", { path: req.path, nodeId: req.nodeId ?? null });
}

export function getTree(req: GetTreeRequest): Promise<TreeData> {
  return call("get_tree", { path: req.path });
}

export function checkSession(req: CheckSessionRequest): Promise<CheckSessionResult> {
  return call("check_session", { path: req.path });
}

export function deleteSessions(
  req: DeleteSessionsRequest,
): Promise<DeleteResult[]> {
  return call("delete_sessions", { paths: req.paths });
}

export function appendBranchMarker(
  req: AppendBranchMarkerRequest,
): Promise<AppendBranchMarkerResult> {
  return call("append_branch_marker", { path: req.path, nodeId: req.nodeId });
}

export function openInIterm(req: OpenInItermRequest): Promise<void> {
  return call("open_in_iterm", { path: req.path });
}
