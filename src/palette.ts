/**
 * 命令面板条目：纯函数。页面 + 动作 + 会话，会话匹配口径与列表过滤一致。
 */
import type { MetaSnapshot, SessionSummary } from "./types";
import { displayCwd } from "./format";
import { sessionMatchesQuery } from "./listUtils";
import { NAV_GROUPS, type Route } from "./routes";

export type PaletteItem =
  | { kind: "page"; route: Route; label: string; group: string }
  | { kind: "action"; id: "new-session" | "rescan" | "toggle-theme" | "check-app" | "check-omp"; label: string }
  | { kind: "session"; path: string; label: string; sub: string };

const ACTIONS: { id: Extract<PaletteItem, { kind: "action" }>["id"]; label: string }[] = [
  { id: "new-session", label: "新建会话…" },
  { id: "rescan", label: "重新扫描会话" },
  { id: "toggle-theme", label: "切换深色或浅色" },
  { id: "check-app", label: "检查应用更新" },
  { id: "check-omp", label: "检查 omp 更新" },
];

/** 最近会话数（空查询）/ 会话上限 / 总条目上限。 */
export const PALETTE_RECENT_SESSIONS = 5;
export const PALETTE_MAX_SESSIONS = 8;
export const PALETTE_MAX_ITEMS = 12;

function sessionLabel(s: SessionSummary, meta: MetaSnapshot | null): string {
  return meta?.sessions[s.id]?.alias ?? s.title;
}

/**
 * 按查询生成面板条目：页面 → 动作 → 会话。
 * 空查询返回全部页面和动作 + 最近修改的 5 个会话；
 * 非空查询页面/动作用 label 子串匹配，会话用 sessionMatchesQuery。
 */
export function paletteItems(
  query: string,
  sessions: SessionSummary[],
  meta: MetaSnapshot | null,
): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const pages: PaletteItem[] = [];
  for (const g of NAV_GROUPS)
    for (const item of g.items)
      pages.push({ kind: "page", route: item.route, label: item.label, group: g.label });
  const actions: PaletteItem[] = ACTIONS.map((a) => ({ kind: "action", id: a.id, label: a.label }));

  if (q === "") {
    const recent = [...sessions]
      .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
      .slice(0, PALETTE_RECENT_SESSIONS)
      .map((s): PaletteItem => ({ kind: "session", path: s.path, label: sessionLabel(s, meta), sub: displayCwd(s.cwd) }));
    return [...pages, ...actions, ...recent].slice(0, PALETTE_MAX_ITEMS);
  }

  const matchedPages = pages.filter((p) => p.kind === "page" && p.label.toLowerCase().includes(q));
  const matchedActions = actions.filter((a) => a.kind === "action" && a.label.toLowerCase().includes(q));
  const matchedSessions = sessions
    .filter((s) => sessionMatchesQuery(s, q, meta))
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
    .slice(0, PALETTE_MAX_SESSIONS)
    .map((s): PaletteItem => ({ kind: "session", path: s.path, label: sessionLabel(s, meta), sub: displayCwd(s.cwd) }));
  return [...matchedPages, ...matchedActions, ...matchedSessions].slice(0, PALETTE_MAX_ITEMS);
}
