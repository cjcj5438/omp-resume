import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 回归：`src/api.ts` 经 `call`/`streamedCall` 发起的每个后端命令，都必须在
// `src/dev/mockBackend.ts` 的顶层 switch 里有显式的 `case "<cmd>":`
// （fallthrough 多标签逐个计数；`default:` 只抛错不算覆盖），
// 否则 dev `?mock` 下打开对应界面会抛 `UNKNOWN 未知命令`（如 memory_backups 曾丢失）。
// 注意：子 mock 内部的 `cmd === "<cmd>"` 是实现分支不是路由，故意不算——
// 否则删掉顶层 case 测试仍绿，断言就被短路成摆设。
const root = process.cwd();
const apiSrc = readFileSync(join(root, "src", "api.ts"), "utf-8");
const mockSrc = readFileSync(join(root, "src", "dev", "mockBackend.ts"), "utf-8");

// 确有不需要 mock 的命令时在此登记并注释原因（当前为空：全部命令都已覆盖）。
const EXEMPT: string[] = [];

const apiCmds = new Set<string>();
for (const m of apiSrc.matchAll(/(?:call|streamedCall)\("([a-z_]+)"/g)) apiCmds.add(m[1]);

// 只认顶层 switch 的 `case "<cmd>":`（含 fallthrough 组里的每一个标签）。
const mockCmds = new Set<string>();
for (const m of mockSrc.matchAll(/case "([a-z_]+)":/g)) mockCmds.add(m[1]);

test("api.ts 的每个后端命令在 mockBackend 都有显式分支", () => {
  expect(apiCmds.size).toBeGreaterThan(0);
  expect(mockCmds.size).toBeGreaterThan(0);
  const missing = [...apiCmds].filter((c) => !EXEMPT.includes(c) && !mockCmds.has(c));
  expect(missing, `mock 缺少命令分支：${missing.join("、")}`).toEqual([]);
});
