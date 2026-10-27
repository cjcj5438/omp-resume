/**
 * 舞台外观偏好（仅 localStorage，绝不触碰会话文件与 omp 配置）：
 * 每个 agent 用哪个像素形象。键是 agent 名（`task`、`scout`…），
 * 主会话用 `main`、顾问用 `advisor`。
 */
import { readJson, writeJson } from "../storage";
import { GUEST_POOL, hasCharacter, type CharacterId } from "./sprites";
import type { StageActor } from "../types";

export const STAGE_PREFS_KEY = "omp-resume:stage:v2";
/** 旧版（管理员/访客/随机）偏好：语义已变，不迁移，保存时删除。 */
const LEGACY_PREFS_KEY = "omp-resume:stage:v1";
export const MAIN_KEY = "main";
export const ADVISOR_KEY = "advisor";

export interface StagePrefs {
  /** agent 键 → 形象；没记录的走内置默认。 */
  chars: Record<string, CharacterId>;
}

/** 每种 agent 的默认形象（用户可在 Agent 库里覆盖）。 */
export const DEFAULT_AGENT_CHARS: Readonly<Record<string, CharacterId>> = {
  [MAIN_KEY]: "admin",
  task: "coder",
  scout: "scholar",
  sonic: "ops",
  reviewer: "tester",
  "security-reviewer": "guard",
  [ADVISOR_KEY]: "designer",
};

export function defaultStagePrefs(): StagePrefs {
  return { chars: {} };
}

/** 任意输入 → 合法偏好（只保留值合法的条目，其余退回空表）。 */
export function parseStagePrefs(data: unknown): StagePrefs {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return defaultStagePrefs();
  }
  const raw = (data as Record<string, unknown>).chars;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultStagePrefs();
  }
  const chars: Record<string, CharacterId> = {};
  for (const [key, value] of Object.entries(raw)) {
    // "__proto__" 经普通赋值写不进自有属性（会被原型 setter 吞掉），直接丢弃。
    if (key === "" || key === "__proto__") continue;
    if (hasCharacter(value)) chars[key] = value;
  }
  return { chars };
}

export function loadStagePrefs(storage?: Storage): StagePrefs {
  return parseStagePrefs(readJson(STAGE_PREFS_KEY, storage));
}

export function saveStagePrefs(prefs: StagePrefs, storage?: Storage): void {
  writeJson(STAGE_PREFS_KEY, prefs, storage);
  try {
    (storage ?? globalThis.localStorage).removeItem(LEGACY_PREFS_KEY);
  } catch {
    // 存储不可用：忽略。
  }
}

/** FNV-1a 32 位（按 UTF-16 码元），确定性、无需依赖。 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 角色对应的 agent 键：主会话/顾问各有专用键，其余用 agent 名（缺省为 `task`）。 */
export function agentKeyOf(actor: Pick<StageActor, "kind" | "agent">): string {
  if (actor.kind === "main") return MAIN_KEY;
  if (actor.kind === "advisor") return ADVISOR_KEY;
  return actor.agent ?? "task";
}

/** agent 键 → 形象：用户偏好 → 内置默认 → 按名字哈希兜底（只读自有属性）。 */
export function charForKey(prefs: StagePrefs, key: string): CharacterId {
  // agent 名来自用户 md 文件，"constructor" 等原型成员名必须走哈希兜底，不能命中继承成员。
  const picked = Object.hasOwn(prefs.chars, key)
    ? prefs.chars[key]
    : Object.hasOwn(DEFAULT_AGENT_CHARS, key)
      ? DEFAULT_AGENT_CHARS[key]
      : undefined;
  if (picked !== undefined && hasCharacter(picked)) return picked;
  const fallback = GUEST_POOL[fnv1a(key) % GUEST_POOL.length];
  return hasCharacter(fallback) ? fallback : "coder";
}

export function charFor(prefs: StagePrefs, actor: Pick<StageActor, "kind" | "agent">): CharacterId {
  return charForKey(prefs, agentKeyOf(actor));
}
