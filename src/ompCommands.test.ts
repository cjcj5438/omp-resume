/**
 * 命令速查单测：过滤行为、版本提示、组合引用的命令必须真实存在。
 * 不锁中文文案与数据条数。
 */
import { describe, expect, it } from "vitest";
import {
  OMP_COMMANDS,
  OMP_PINNED_COMMANDS,
  OMP_VERSION,
  filterOmpCommands,
  findOmpCommand,
  versionMismatch,
} from "./ompCommands";
import { OMP_CLI_COMMANDS, OMP_CLI_VERSION } from "./ompCliCommands";

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

  it("参数提示命中", () => {
    const headless = filterOmpCommands(OMP_COMMANDS, "headless").flatMap((g) => g.commands);
    expect(headless.map((c) => c.name)).toContain("browser");
    const pane = filterOmpCommands(OMP_COMMANDS, "pane").flatMap((g) => g.commands);
    expect(pane.map((c) => c.name)).toContain("fork");
  });

  it("意图关键词命中", () => {
    const names = (q: string) =>
      filterOmpCommands(OMP_COMMANDS, q).flatMap((g) => g.commands.map((c) => c.name));
    expect(names("压缩")).toContain("compact");
    expect(names("模型")).toContain("model");
    expect(names("分叉")).toContain("fork");
    expect(names("排队")).toContain("queue");
    expect(names("思考")).toContain("effort");
    expect(names("批准")).toContain("forget-approvals");
    expect(names("预算")).toContain("goal");
    expect(names("额度")).toContain("usage");
    expect(names("协作")).toEqual(expect.arrayContaining(["collab", "join", "leave"]));
    expect(names("插件")).toEqual(expect.arrayContaining(["plugins", "extensions"]));
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
    expect(versionMismatch("18.12.3-beta.1")).toBe(true);
  });

  it("OMP_VERSION 固定为速查基准版本", () => {
    expect(OMP_VERSION).toBe("18.12.6");
  });
});

describe("OMP_PINNED_COMMANDS", () => {
  it("每个置顶名字都存在于 OMP_COMMANDS 且不重复", () => {
    expect(OMP_PINNED_COMMANDS.length).toBeGreaterThan(0);
    for (const n of OMP_PINNED_COMMANDS) expect(findOmpCommand(n)?.name).toBe(n);
    expect(new Set(OMP_PINNED_COMMANDS).size).toBe(OMP_PINNED_COMMANDS.length);
  });
});

describe("使用示例", () => {
  const all = OMP_COMMANDS.flatMap((g) => g.commands.map((c) => ({ group: g.group, c })));

  it("每条命令都有 1–3 条示例", () => {
    for (const { c } of all) {
      expect(c.examples.length, c.name).toBeGreaterThanOrEqual(1);
      expect(c.examples.length, c.name).toBeLessThanOrEqual(3);
    }
  });

  it("示例首个 token 指向命令本身（名称或别名）", () => {
    for (const { c } of all) {
      for (const ex of c.examples) {
        const head = ex.split(/\s+/)[0];
        expect(head.startsWith("/"), `${c.name}: ${ex}`).toBe(true);
        expect(findOmpCommand(head)?.name, `${c.name}: ${ex}`).toBe(c.name);
      }
    }
  });

  it("参数非空的命令至少有一条带参数的示例", () => {
    for (const { c } of all) {
      if (c.args === "") {
        for (const ex of c.examples) expect(ex.split(/\s+/).length, `${c.name}: ${ex}`).toBe(1);
        continue;
      }
      const withArgs = c.examples.filter((ex) => ex.split(/\s+/).length > 1);
      expect(withArgs.length, c.name).toBeGreaterThanOrEqual(1);
    }
  });

  it("示例可被过滤命中，且扩展命令单列分组", () => {
    const byExample = filterOmpCommands(OMP_COMMANDS, "/compact remote");
    expect(byExample.flatMap((g) => g.commands.map((c) => c.name))).toContain("compact");
    const ext = OMP_COMMANDS.find((g) => g.group === "扩展命令");
    expect(ext?.commands.map((c) => c.name)).toEqual(["review", "green", "annotate"]);
    for (const name of ["review", "green", "annotate"]) {
      expect(OMP_PINNED_COMMANDS).not.toContain(name);
    }
  });

  it("内置命令表本身不含扩展命令（扩展命令只在扩展分组里）", () => {
    const builtin = OMP_COMMANDS.filter((g) => g.group !== "扩展命令");
    const names = builtin.flatMap((g) => g.commands.map((c) => c.name));
    expect(names).toHaveLength(87);
    for (const n of ["review", "green", "annotate"]) expect(names).not.toContain(n);
  });
});

describe("终端子命令", () => {
  it("名称唯一、按字母序、示例以 omp 开头", () => {
    const names = OMP_CLI_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    for (const c of OMP_CLI_COMMANDS) {
      expect(c.examples.length, c.name).toBeGreaterThanOrEqual(1);
      for (const ex of c.examples) {
        expect(ex.startsWith("omp "), `${c.name}: ${ex}`).toBe(true);
        // 第二个 token 必须是子命令本身，避免示例跑到别的子命令上。
        expect(ex.split(/\s+/)[1], `${c.name}: ${ex}`).toBe(c.name);
      }
    }
  });

  it("基准版本与斜杠命令表一致", () => {
    expect(OMP_CLI_VERSION).toBe(OMP_VERSION);
  });
});
