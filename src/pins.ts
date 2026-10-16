/**
 * 置顶偏好：项目（按 cwd）与会话（按 id）两级。纯界面状态，仅存 localStorage，
 * 绝不触碰会话文件或后端。读写均容错：存储缺失/抛错/内容损坏都退化为空置顶。
 */

export const PINS_STORAGE_KEY = "omp-resume:pins:v1";

export interface Pins {
  projects: string[];
  sessions: string[];
}

export type PinKind = "project" | "session";

export function emptyPins(): Pins {
  return { projects: [], sessions: [] };
}

/** 只保留字符串条目并去重，保持首次出现的顺序。 */
function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string"))];
}

function parsePins(raw: string | null): Pins {
  if (raw == null) return emptyPins();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyPins();
  }
  if (typeof data !== "object" || data === null) return emptyPins();
  const obj = data as Record<string, unknown>;
  return { projects: stringList(obj.projects), sessions: stringList(obj.sessions) };
}

/** 读取置顶；任何异常（无存储、抛错、JSON/结构非法）都返回有效的空置顶。 */
export function loadPins(storage?: Storage): Pins {
  try {
    return parsePins((storage ?? globalThis.localStorage).getItem(PINS_STORAGE_KEY));
  } catch {
    return emptyPins();
  }
}

/** 写入置顶；存储不可用时静默忽略（置顶仅在本次运行内有效）。 */
export function savePins(pins: Pins, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage).setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // 存储不可用：忽略，界面状态仍然有效。
  }
}

/** 切换单个键的置顶：不在则加入，在则移除。返回新对象，不修改入参。 */
export function togglePin(pins: Pins, kind: PinKind, key: string): Pins {
  const field = kind === "project" ? "projects" : "sessions";
  const current = pins[field];
  const next = current.includes(key)
    ? current.filter((k) => k !== key)
    : [...current, key];
  return { ...pins, [field]: next };
}

/** 会话被删除后清理其置顶。返回新对象，不修改入参。 */
export function removeSessionPins(pins: Pins, ids: Iterable<string>): Pins {
  const gone = new Set(ids);
  return { ...pins, sessions: pins.sessions.filter((id) => !gone.has(id)) };
}
