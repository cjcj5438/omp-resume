/**
 * 组合用法单测：数量与唯一性、引用的命令必须存在于 OMP_COMMANDS（含别名）、过滤行为。
 */
import { describe, expect, it } from "vitest";
import { findOmpCommand } from "./ompCommands";
import { filterOmpCombos, findUnknownComboStep, OMP_COMBOS } from "./ompCombos";

describe("OMP_COMBOS", () => {
  it("id 与标题唯一", () => {
    expect(new Set(OMP_COMBOS.map((c) => c.id)).size).toBe(OMP_COMBOS.length);
    expect(new Set(OMP_COMBOS.map((c) => c.title)).size).toBe(OMP_COMBOS.length);
  });

  it("每个组合至少两步，场景说明与步骤说明都不为空", () => {
    for (const combo of OMP_COMBOS) {
      expect(combo.steps.length).toBeGreaterThanOrEqual(2);
      expect(combo.when.length).toBeGreaterThan(0);
      for (const step of combo.steps) {
        expect(step.cmd.startsWith("/")).toBe(true);
        expect(step.note.length).toBeGreaterThan(0);
      }
    }
  });

  it("每步引用的命令都存在于 OMP_COMMANDS（含别名）", () => {
    for (const combo of OMP_COMBOS) {
      expect(findUnknownComboStep(combo)).toBeUndefined();
    }
  });

  it("命令查找命中的是命令名或别名本身", () => {
    expect(findOmpCommand("/worktree")?.name).toBe("wt");
    expect(findOmpCommand("models")?.name).toBe("model");
    expect(findOmpCommand("不存在的命令")).toBeUndefined();
  });
});

describe("filterOmpCombos", () => {
  it("空查询返回原数组", () => {
    expect(filterOmpCombos(OMP_COMBOS, "")).toBe(OMP_COMBOS);
    expect(filterOmpCombos(OMP_COMBOS, "   ")).toBe(OMP_COMBOS);
  });

  it("命中场景标题、说明与步骤内容", () => {
    expect(filterOmpCombos(OMP_COMBOS, "上下文").map((c) => c.id)).toContain("context-full");
    expect(filterOmpCombos(OMP_COMBOS, "/memory").map((c) => c.id)).toContain("memory");
  });

  it("无命中返回空数组", () => {
    expect(filterOmpCombos(OMP_COMBOS, "不存在的场景xyz")).toEqual([]);
  });
});
