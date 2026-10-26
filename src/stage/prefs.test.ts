import { describe, expect, test } from "vitest";
import { GUEST_POOL, hasCharacter } from "./sprites";
import {
  ADVISOR_KEY,
  DEFAULT_AGENT_CHARS,
  MAIN_KEY,
  STAGE_PREFS_KEY,
  agentKeyOf,
  charFor,
  charForKey,
  defaultStagePrefs,
  loadStagePrefs,
  parseStagePrefs,
  saveStagePrefs,
} from "./prefs";

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("stage prefs", () => {
  test("缺省读取与损坏数据都退回空表", () => {
    const storage = memStorage();
    expect(loadStagePrefs(storage)).toEqual(defaultStagePrefs());
    storage.setItem(STAGE_PREFS_KEY, "{not json");
    expect(loadStagePrefs(storage)).toEqual(defaultStagePrefs());
    expect(parseStagePrefs(null)).toEqual(defaultStagePrefs());
    expect(parseStagePrefs([1, 2])).toEqual(defaultStagePrefs());
    expect(parseStagePrefs({ chars: 7 })).toEqual(defaultStagePrefs());
  });

  test("parseStagePrefs 只保留值合法的条目", () => {
    const got = parseStagePrefs({ chars: { scout: "ops", bad: "nope", task: 3, "": "coder" } });
    expect(got.chars).toEqual({ scout: "ops" });
  });

  test("保存写 v2 并清掉 v1", () => {
    const storage = memStorage();
    storage.setItem("omp-resume:stage:v1", JSON.stringify({ mainChar: "ops" }));
    const prefs = { chars: { scout: "ops" as const } };
    saveStagePrefs(prefs, storage);
    expect(loadStagePrefs(storage)).toEqual(prefs);
    expect(storage.getItem("omp-resume:stage:v1")).toBeNull();
  });

  test("agent 键：主会话/顾问有专用键，其余按 agent 名", () => {
    expect(agentKeyOf({ kind: "main", agent: null })).toBe(MAIN_KEY);
    expect(agentKeyOf({ kind: "advisor", agent: null })).toBe(ADVISOR_KEY);
    expect(agentKeyOf({ kind: "subagent", agent: "scout" })).toBe("scout");
    // 派发调用没写 agent 时后端给 null，按 omp 的默认 agent 处理。
    expect(agentKeyOf({ kind: "subagent", agent: null })).toBe("task");
  });

  test("默认形象按 agent 固定", () => {
    const prefs = defaultStagePrefs();
    expect(charForKey(prefs, MAIN_KEY)).toBe("admin");
    expect(charForKey(prefs, "task")).toBe("coder");
    expect(charForKey(prefs, "scout")).toBe("scholar");
    expect(charForKey(prefs, "sonic")).toBe("ops");
    expect(charForKey(prefs, "reviewer")).toBe("tester");
    expect(charForKey(prefs, "security-reviewer")).toBe("guard");
    expect(charForKey(prefs, ADVISOR_KEY)).toBe("designer");
    expect(DEFAULT_AGENT_CHARS.seance).toBeUndefined();
  });

  test("用户选择优先，未知 agent 确定性兜底", () => {
    const prefs = { chars: { scout: "ops" as const } };
    expect(charForKey(prefs, "scout")).toBe("ops");
    const a = charForKey(defaultStagePrefs(), "deployer");
    const b = charForKey(defaultStagePrefs(), "deployer");
    expect(a).toBe(b);
    expect(GUEST_POOL).toContain(a);
    expect(hasCharacter(a)).toBe(true);
    // 不同 agent 名应能分到不同形象（至少不是全集同一个）。
    const names = ["a1", "a2", "a3", "a4", "reviewer", "seance"];
    expect(new Set(names.map((n) => charForKey(defaultStagePrefs(), n))).size).toBeGreaterThan(1);
  });

  test("charFor 走 agent 键", () => {
    const prefs = { chars: { scout: "ops" as const } };
    expect(charFor(prefs, { kind: "subagent", agent: "scout" })).toBe("ops");
    expect(charFor(prefs, { kind: "main", agent: null })).toBe("admin");
    expect(charFor(prefs, { kind: "subagent", agent: null })).toBe("coder");
  });
});
