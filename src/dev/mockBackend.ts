/**
 * DEV-ONLY mock 后端：通过 `mockIPC` 实现全部命令，有状态。
 * 仅在 DEV + `?mock` 时由 main.tsx 动态 import，生产包不包含。
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppError } from "../types";
import {
  FIXTURE_SESSIONS,
  buildListResult,
  conversationForPath,
  generateLargeConversation,
  type FixtureSession,
} from "./fixtures";

interface FailAs {
  code: string;
  message: string;
}

function err(code: string, message: string): FailAs {
  return { code, message };
}

function randomHex8(existing: Set<string>): string {
  let id = "";
  do {
    id = Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  } while (existing.has(id));
  return id;
}

export interface MockHandle {
  itermCalls: string[];
}

export async function installMockBackend(): Promise<MockHandle> {
  const params = new URLSearchParams(window.location.search);
  const latency = Number(params.get("latency") ?? "0") || 0;
  const fail = new Set(
    (params.get("fail") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // 深拷贝夹具，保持跨测试/刷新有状态。
  let sessions: FixtureSession[] = structuredClone(FIXTURE_SESSIONS);
  const itermCalls: string[] = [];

  const find = (path: string): FixtureSession | undefined =>
    sessions.find((s) => s.summary.path === path);

  (window as unknown as { __ompMock?: unknown }).__ompMock = {
    calls: itermCalls,
    get sessions() {
      return sessions;
    },
  };

  mockIPC(async (cmd: string, rawArgs?: unknown) => {
    if (latency > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, latency);
      await promise;
    }
    if (fail.has(cmd)) throw err("IO", `mock 强制失败：${cmd}`);
    const args =
      rawArgs !== null && typeof rawArgs === "object"
        ? (rawArgs as Record<string, unknown>)
        : {};

    switch (cmd) {
      case "get_config":
        return {
          sessionsDir: "/Users/chenjing/.omp/agent/sessions",
          ownersDir: "/Users/chenjing/.omp/run/session-owners",
        };
      case "list_sessions":
        return buildListResult(sessions);
      case "check_session": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        return { inUse: s.summary.inUse, probeOk: s.summary.probeOk };
      }
      case "get_conversation": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (!s.summary.formatSupported)
          throw err("UNSUPPORTED_FORMAT", "该会话格式暂不支持预览");
        if (params.has("big")) return generateLargeConversation(3000);
        try {
          return conversationForPath(
            s,
            (args["nodeId"] as string | null) ?? null,
          );
        } catch (e) {
          throw e as AppError;
        }
      }
      case "get_tree": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (!s.summary.formatSupported)
          throw err("UNSUPPORTED_FORMAT", "该会话格式暂不支持预览");
        return s.tree;
      }
      case "delete_sessions": {
        const paths = (args["paths"] as string[]) ?? [];
        return paths.map((p) => {
          const s = find(p);
          if (!s) return { path: p, ok: false, error: err("NOT_FOUND", "会话文件不存在") };
          if (s.summary.inUse)
            return { path: p, ok: false, error: err("IN_USE", "会话正被另一个 omp 使用") };
          if (!s.summary.probeOk)
            return { path: p, ok: false, error: err("PROBE_FAILED", "占用探测失败，不敢删除") };
          sessions = sessions.filter((x) => x.summary.path !== p);
          return { path: p, ok: true, error: null };
        });
      }
      case "append_branch_marker": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (s.summary.inUse) throw err("IN_USE", "会话正被另一个 omp 使用");
        if (!s.summary.probeOk) throw err("PROBE_FAILED", "占用探测失败");
        const nodeId = args["nodeId"] as string;
        const byId = new Map(s.tree.nodes.map((n) => [n.id, n]));
        if (!byId.has(nodeId)) throw err("INVALID_NODE", "节点不存在");
        if (s.tree.leafId === nodeId) return { markerId: null };
        const markerId = randomHex8(new Set(byId.keys()));
        // marker 为 custom 行：树上不可见节点，但 leaf/active 语义变为指向该节点。
        const chain: string[] = [];
        let cur: string | null = nodeId;
        while (cur && byId.has(cur) && !chain.includes(cur)) {
          chain.unshift(cur);
          cur = byId.get(cur)?.parentId ?? null;
        }
        s.tree = {
          ...s.tree,
          leafId: nodeId,
          activePathIds: chain.slice().reverse(),
        };
        return { markerId };
      }
      case "open_in_iterm": {
        const s = find(args["path"] as string);
        if (!s) throw err("NOT_FOUND", "会话文件不存在");
        if (s.summary.inUse) throw err("IN_USE", "会话正被另一个 omp 使用");
        if (!s.summary.cwdExists) throw err("CWD_MISSING", "项目目录不存在");
        itermCalls.push(s.summary.path);
        return null;
      }
      default:
        throw err("UNKNOWN", `未知命令：${cmd}`);
    }
  });

  return { itermCalls };
}
