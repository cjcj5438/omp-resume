/** 命令速查过滤单测：只测过滤行为，不锁中文文案与数据条数。 */
import { describe, expect, it } from "vitest";
import { OMP_COMMANDS, filterOmpCommands } from "./ompCommands";

describe("filterOmpCommands", () => {
  it("空查询返回原分组引用", () => {
    expect(filterOmpCommands(OMP_COMMANDS, "")).toBe(OMP_COMMANDS);
    expect(filterOmpCommands(OMP_COMMANDS, "   ")).toBe(OMP_COMMANDS);
  });

  it("命令名带或不带前导斜杠都能命中", () => {
    const a = filterOmpCommands(OMP_COMMANDS, "compact");
    const b = filterOmpCommands(OMP_COMMANDS, "/compact");
    expect(a.flatMap((g) => g.commands.map((c) => c.name))).toContain("compact");
    expect(b).toEqual(a);
  });

  it("别名命中", () => {
    const rows = filterOmpCommands(OMP_COMMANDS, "worktree").flatMap((g) => g.commands);
    expect(rows.map((c) => c.name)).toContain("wt");
  });

  it("中文说明命中", () => {
    const rows = filterOmpCommands(OMP_COMMANDS, "工作目录").flatMap((g) => g.commands);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.zh.includes("工作目录"))).toBe(true);
  });

  it("大小写不敏感", () => {
    const lower = filterOmpCommands(OMP_COMMANDS, "ssh");
    const upper = filterOmpCommands(OMP_COMMANDS, "SSH");
    expect(upper).toEqual(lower);
  });

  it("中文说明大小写不敏感：小写 html 命中导出命令", () => {
    const rows = filterOmpCommands(OMP_COMMANDS, "html").flatMap((g) => g.commands);
    expect(rows.map((c) => c.name)).toContain("export");
  });

  it("无命中返回空数组", () => {
    expect(filterOmpCommands(OMP_COMMANDS, "不存在的命令xyz")).toEqual([]);
  });

  it("空组被隐藏、命中组保留原分组顺序", () => {
    const groups = filterOmpCommands(OMP_COMMANDS, "compact");
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.commands.length > 0)).toBe(true);
    const order = OMP_COMMANDS.map((g) => g.group);
    const got = groups.map((g) => g.group);
    expect(got).toEqual(order.filter((name) => got.includes(name)));
  });
});
