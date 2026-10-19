/**
 * 命令速查单测：过滤行为、版本提示、组合引用的命令必须真实存在。
 * 不锁中文文案与数据条数。
 */
import { describe, expect, it } from "vitest";
import {
  OMP_COMMANDS,
  OMP_VERSION,
  filterOmpCommands,
  versionMismatch,
} from "./ompCommands";

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

describe("版本提示", () => {
  it("已安装版本与基准一致或未知时不提示", () => {
    expect(versionMismatch(OMP_VERSION)).toBe(false);
    expect(versionMismatch(` ${OMP_VERSION} `)).toBe(false);
    expect(versionMismatch(null)).toBe(false);
    expect(versionMismatch(undefined)).toBe(false);
    expect(versionMismatch("")).toBe(false);
    expect(versionMismatch("   ")).toBe(false);
  });

  it("版本不同即提示，不做 semver 比较", () => {
    expect(versionMismatch("18.10.3")).toBe(true);
    expect(versionMismatch("18.12.2-beta.1")).toBe(true);
  });

  it("OMP_VERSION 固定为速查基准版本", () => {
    expect(OMP_VERSION).toBe("18.12.2");
  });
});
