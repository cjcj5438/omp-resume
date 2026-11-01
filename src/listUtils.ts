/** 列表过滤 / 标签过滤 / 置顶拆分 / 三态勾选 / 选择保持 / focus 节流：纯函数。 */
import type { MetaSnapshot, ProjectGroup, SessionSummary } from "./types";
import type { Pins } from "./pins";

export const FOCUS_REFRESH_MIN_INTERVAL_MS = 800;

/**
 * 会话是否命中文本查询：title / cwd / firstUserMessage + 别名 / 标签 / 备注，
 * 大小写不敏感子串匹配；`meta` 缺失（未加载/加载失败）时只按前三者匹配。
 * 项目组与置顶区共用同一匹配口径。
 */
export function sessionMatchesQuery(
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


/**
 * 置顶整理（设计稿口径：组内置顶排序，无独立置顶区）：
 * 项目组按置顶稳定上浮；组内会话按置顶稳定上浮（其余保持后端顺序）。
 * 不修改入参，未知键忽略。
 */
export function applyPins(groups: ProjectGroup[], pins: Pins): ProjectGroup[] {
  const pinnedProjects = new Set(pins.projects);
  const pinnedIds = new Set(pins.sessions);
  return pinnedFirst(groups, (g) => pinnedProjects.has(g.cwd)).map((g) => ({
    ...g,
    sessions: pinnedFirst(g.sessions, (s) => pinnedIds.has(s.id)),
  }));
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

/** 状态筛选：全部 / 运行中 / 已置顶 / 有问题。 */
export type SessionFilter = "all" | "running" | "pinned" | "issues";

export interface SessionIssue {
  code: "format" | "cwd" | "badLines" | "probe";
  label: string;
}

/**
 * 会话的问题清单（按 format → cwd → badLines → probe 顺序检查）：
 * 格式不支持 / 目录不存在 / N 行损坏 / 占用探测失败。
 */
export function sessionIssues(s: SessionSummary): SessionIssue[] {
  const out: SessionIssue[] = [];
  if (!s.formatSupported) out.push({ code: "format", label: "格式不支持" });
  if (!s.cwdExists) out.push({ code: "cwd", label: "目录不存在" });
  if (s.badLines > 0) out.push({ code: "badLines", label: `${s.badLines} 行损坏` });
  if (!s.probeOk) out.push({ code: "probe", label: "占用探测失败" });
  return out;
}

function sessionPassesStatus(s: SessionSummary, f: SessionFilter, pins: Pins, groupPinned: boolean): boolean {
  if (f === "running") return s.inUse;
  if (f === "issues") return sessionIssues(s).length > 0;
  // pinned：会话被置顶，或所属项目整组被置顶。
  return groupPinned || pins.sessions.includes(s.id);
}

/**
 * 分组级状态过滤：`all` 返回同一引用；其余丢弃空组。
 * pinned 语义：会话 id 在 pins.sessions 中，或分组 cwd 在 pins.projects 中（整组保留）。
 */
export function filterGroupsByStatus(
  groups: ProjectGroup[],
  f: SessionFilter,
  pins: Pins,
): ProjectGroup[] {
  if (f === "all") return groups;
  const out: ProjectGroup[] = [];
  for (const g of groups) {
    const groupPinned = pins.projects.includes(g.cwd);
    if (f === "pinned" && groupPinned) {
      out.push(g);
      continue;
    }
    const sessions = g.sessions.filter((s) => sessionPassesStatus(s, f, pins, groupPinned));
    if (sessions.length > 0) out.push({ ...g, sessions });
  }
  return out;
}


/**
 * 各状态计数：在置顶拆分前、不受搜索和标签影响的全量上计数。
 * pinned = id 被置顶的会话数 + cwd 被置顶的整组会话数（去重）。
 */
export function statusCounts(groups: ProjectGroup[], pins: Pins): Record<SessionFilter, number> {
  let all = 0;
  let running = 0;
  let pinned = 0;
  let issues = 0;
  const pinnedIds = new Set(pins.sessions);
  const pinnedCwds = new Set(pins.projects);
  for (const g of groups) {
    const groupPinned = pinnedCwds.has(g.cwd);
    for (const s of g.sessions) {
      all += 1;
      if (s.inUse) running += 1;
      if (groupPinned || pinnedIds.has(s.id)) pinned += 1;
      if (sessionIssues(s).length > 0) issues += 1;
    }
  }
  return { all, running, pinned, issues };
}
