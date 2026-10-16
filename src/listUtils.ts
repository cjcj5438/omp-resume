/** 列表过滤 / 标签过滤 / 选择保持 / focus 刷新节流：纯函数。 */
import type { MetaSnapshot, ProjectGroup } from "./types";
import type { Pins } from "./pins";

export const FOCUS_REFRESH_MIN_INTERVAL_MS = 800;

/**
 * 过滤分组：title / cwd / firstUserMessage + 别名 / 标签 / 备注，
 * 大小写不敏感子串匹配；空组隐藏。保持后端顺序。
 * `meta` 缺失（未加载/加载失败）时只按前三者匹配。
 */
export function filterGroups(
  groups: ProjectGroup[],
  query: string,
  meta?: MetaSnapshot | null,
): ProjectGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: ProjectGroup[] = [];
  for (const g of groups) {
    const sessions = g.sessions.filter((s) => {
      const m = meta?.sessions[s.id];
      const hay = [
        s.title,
        s.cwd,
        s.firstUserMessage ?? "",
        m?.alias ?? "",
        (m?.tags ?? []).join("\n"),
        m?.note ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
    if (sessions.length > 0) out.push({ ...g, sessions });
  }
  return out;
}

/**
 * 标签过滤：只保留同时带有全部选中标签的会话（多选为 AND，精确匹配）；
 * 空选中返回原分组（同一引用，避免下游 memo 失效）。
 */
export function filterByTags(
  groups: ProjectGroup[],
  tags: readonly string[],
  meta?: MetaSnapshot | null,
): ProjectGroup[] {
  if (tags.length === 0) return groups;
  const wanted = new Set(tags);
  const out: ProjectGroup[] = [];
  for (const g of groups) {
    const sessions = g.sessions.filter((s) => {
      const have = new Set(meta?.sessions[s.id]?.tags ?? []);
      for (const t of wanted) if (!have.has(t)) return false;
      return true;
    });
    if (sessions.length > 0) out.push({ ...g, sessions });
  }
  return out;
}

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * 统计全部会话正在使用的标签及计数（每个标签计含它的会话数）；
 * 按计数倒序、标签名升序。`meta` 缺失时返回空数组。
 */
export function collectTagCounts(
  groups: ProjectGroup[],
  meta?: MetaSnapshot | null,
): TagCount[] {
  if (!meta) return [];
  const counts = new Map<string, number>();
  for (const g of groups)
    for (const s of g.sessions)
      for (const t of new Set(meta.sessions[s.id]?.tags ?? []))
        counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"));
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
