/** 列表过滤 / 选择保持 / focus 刷新节流：纯函数。 */
import type { ProjectGroup } from "./types";
import type { Pins } from "./pins";

export const FOCUS_REFRESH_MIN_INTERVAL_MS = 800;

/** 过滤分组：title / cwd / firstUserMessage 大小写不敏感子串匹配；空组隐藏。保持后端顺序。 */
export function filterGroups(
  groups: ProjectGroup[],
  query: string,
): ProjectGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: ProjectGroup[] = [];
  for (const g of groups) {
    const sessions = g.sessions.filter((s) => {
      const hay = [s.title, s.cwd, s.firstUserMessage ?? ""]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
    if (sessions.length > 0) out.push({ ...g, sessions });
  }
  return out;
}

/** 跨刷新保留：只保留仍存在的 path。 */
export function retainExisting<T>(paths: Iterable<T>, exists: Set<T>): T[] {
  const out: T[] = [];
  for (const p of paths) if (exists.has(p)) out.push(p);
  return out;
}

/** focus/visible 刷新节流：加载中跳过；距上次开始不足 800ms 跳过。 */
export function canFocusRefresh(
  inFlight: boolean,
  lastStartMs: number,
  nowMs: number,
): boolean {
  if (inFlight) return false;
  return nowMs - lastStartMs >= FOCUS_REFRESH_MIN_INTERVAL_MS;
}

/** 稳定分区：置顶项在前，其余保持原相对顺序。 */
function pinnedFirst<T>(items: T[], isPinned: (item: T) => boolean): T[] {
  return [...items.filter(isPinned), ...items.filter((item) => !isPinned(item))];
}

/** 置顶排序：项目与组内会话各自稳定分区（置顶在前）；不修改入参，未知键忽略。 */
export function applyPins(groups: ProjectGroup[], pins: Pins): ProjectGroup[] {
  const pinnedProjects = new Set(pins.projects);
  const pinnedSessions = new Set(pins.sessions);
  return pinnedFirst(groups, (g) => pinnedProjects.has(g.cwd)).map((g) => ({
    ...g,
    sessions: pinnedFirst(g.sessions, (s) => pinnedSessions.has(s.id)),
  }));
}
