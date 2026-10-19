/** 列表过滤 / 标签过滤 / 置顶拆分 / 三态勾选 / 选择保持 / focus 节流：纯函数。 */
import type { MetaSnapshot, ProjectGroup, SessionSummary } from "./types";
import type { Pins } from "./pins";

export const FOCUS_REFRESH_MIN_INTERVAL_MS = 800;

/**
 * 会话是否命中文本查询：title / cwd / firstUserMessage + 别名 / 标签 / 备注，
 * 大小写不敏感子串匹配；`meta` 缺失（未加载/加载失败）时只按前三者匹配。
 * 项目组与置顶区共用同一匹配口径。
 */
function sessionMatchesQuery(
  s: SessionSummary,
  q: string,
  meta?: MetaSnapshot | null,
): boolean {
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
}

/**
 * 会话级文本过滤；空查询返回原数组（同一引用，避免下游 memo 失效）。
 * 置顶区（已脱离分组）用它过滤，匹配口径与 filterGroups 一致。
 */
export function filterSessions(
  sessions: SessionSummary[],
  query: string,
  meta?: MetaSnapshot | null,
): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => sessionMatchesQuery(s, q, meta));
}

/**
 * 过滤分组：空查询返回原分组（同一引用）；否则只保留命中会话，
 * 空组隐藏。保持后端顺序。
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
    const sessions = g.sessions.filter((s) => sessionMatchesQuery(s, q, meta));
    if (sessions.length > 0) out.push({ ...g, sessions });
  }
  return out;
}

/**
 * 会话是否同时带有全部选中标签（精确匹配）。
 */
function sessionHasTags(
  s: SessionSummary,
  wanted: ReadonlySet<string>,
  meta?: MetaSnapshot | null,
): boolean {
  const have = new Set(meta?.sessions[s.id]?.tags ?? []);
  for (const t of wanted) if (!have.has(t)) return false;
  return true;
}

/**
 * 会话级标签过滤（多选为 AND）；空选中返回原数组（同一引用）。
 * 置顶区用它过滤，口径与 filterByTags 一致。
 */
export function filterSessionsByTags(
  sessions: SessionSummary[],
  tags: readonly string[],
  meta?: MetaSnapshot | null,
): SessionSummary[] {
  if (tags.length === 0) return sessions;
  const wanted = new Set(tags);
  return sessions.filter((s) => sessionHasTags(s, wanted, meta));
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
    const sessions = g.sessions.filter((s) => sessionHasTags(s, wanted, meta));
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

export interface PinnedSplit {
  /** 跨项目聚合的置顶会话，按 modifiedAt 新→旧；已从 `groups` 中移出，不重复出现。 */
  pinnedSessions: SessionSummary[];
  /** 项目置顶上浮后、移出置顶会话的分组；被掏空的组保留组壳（由调用方展示占位）。 */
  groups: ProjectGroup[];
}

/**
 * 置顶拆分：项目组按置顶稳定上浮；会话按 id 跨项目聚合为置顶区，
 * 从原组移出（不出现两次），置顶区内按 modifiedAt 新→旧。
 * 不修改入参，未知键忽略。
 */
export function applyPins(groups: ProjectGroup[], pins: Pins): PinnedSplit {
  const pinnedProjects = new Set(pins.projects);
  const pinnedIds = new Set(pins.sessions);
  const pinnedSessions: SessionSummary[] = [];
  const rest = pinnedFirst(groups, (g) => pinnedProjects.has(g.cwd)).map((g) => ({
    ...g,
    sessions: g.sessions.filter((s) => {
      if (!pinnedIds.has(s.id)) return true;
      pinnedSessions.push(s);
      return false;
    }),
  }));
  pinnedSessions.sort((a, b) =>
    a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0,
  );
  return { pinnedSessions, groups: rest };
}

/** 组头三态复选：组内可见会话相对勾选集的状态；空组视为 none（无可选项）。 */
export type CheckState = "all" | "some" | "none";

/** 三态计算：勾选集里组外的路径不影响结果。 */
export function checkState(paths: readonly string[], checked: ReadonlySet<string>): CheckState {
  if (paths.length === 0) return "none";
  let n = 0;
  for (const p of paths) if (checked.has(p)) n += 1;
  if (n === 0) return "none";
  return n === paths.length ? "all" : "some";
}
