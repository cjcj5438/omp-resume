/**
 * 速查详解数据的不变量（数据由 `src/commandDetails/part1..4.ts` 提供）。
 * 只校验结构与引用，不锁文案本身。
 */
import { describe, expect, it } from "vitest";
import { OMP_COMMANDS, findOmpCommand } from "./ompCommands";
import { OMP_COMMAND_DETAILS } from "./ompCommandDetails";
import { OMP_LEARNING_PATHS } from "./ompLearningPaths";

const COMMANDS = OMP_COMMANDS.flatMap((g) => g.commands);

describe("命令详解", () => {
  it("每条命令都有详解，且没有多余条目", () => {
    const names = COMMANDS.map((c) => c.name).sort();
    expect(Object.keys(OMP_COMMAND_DETAILS).sort()).toEqual(names);
  });

  it("when 非空；params 的 token 逐字来自该命令的 args；args 为空不写 params", () => {
    for (const c of COMMANDS) {
      const d = OMP_COMMAND_DETAILS[c.name];
      expect(d, c.name).toBeDefined();
      expect(d.when.length, c.name).toBeGreaterThan(8);
      const params = d.params ?? [];
      if (c.args === "") {
        expect(params, c.name).toEqual([]);
        continue;
      }
      expect(params.length, c.name).toBeGreaterThan(0);
      for (const p of params) {
        expect(c.args, `${c.name}: ${p.token}`).toContain(p.token);
        expect(p.zh.length, `${c.name}: ${p.token}`).toBeGreaterThan(1);
      }
    }
  });

  it("related 只引用真实存在的命令（名称或别名）", () => {
    for (const c of COMMANDS) {
      for (const r of OMP_COMMAND_DETAILS[c.name].related ?? []) {
        expect(findOmpCommand(r), `${c.name} → ${r}`).toBeDefined();
      }
    }
  });

  it("cautions 非空时每条都有实际内容", () => {
    for (const c of COMMANDS) {
      for (const x of OMP_COMMAND_DETAILS[c.name].cautions ?? []) {
        expect(x.length, c.name).toBeGreaterThan(6);
      }
    }
  });
});

describe("入门路径", () => {
  it("id 唯一、步骤引用的命令存在、tryIt 与该命令对得上", () => {
    const ids = OMP_LEARNING_PATHS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const path of OMP_LEARNING_PATHS) {
      expect(path.steps.length, path.id).toBeGreaterThanOrEqual(3);
      if (path.after !== undefined) expect(ids, path.id).toContain(path.after);
      for (const s of path.steps) {
        expect(findOmpCommand(s.cmd)?.name, `${path.id}: ${s.cmd}`).toBe(s.cmd);
        expect(s.tryIt.split(/\s+/)[0], `${path.id}: ${s.tryIt}`).toBe(`/${s.cmd}`);
        expect(s.why.length, `${path.id}: ${s.cmd}`).toBeGreaterThan(6);
      }
    }
  });
});
