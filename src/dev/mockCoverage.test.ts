import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 回归：`src/api.ts` 经 `call`/`streamedCall` 发起的每个后端命令，都必须在
// `src/dev/mockBackend.ts` 有显式的 `case "<cmd>":`（或子 mock 的 `cmd === "<cmd>"`），
// 否则 dev `?mock` 下打开对应界面会抛 `UNKNOWN 未知命令`（如 memory_backups 曾丢失）。
// 注意：mockIPC 的 `default:` 分支只抛错，不算覆盖。
const root = process.cwd();
const apiSrc = readFileSync(join(root, "src", "api.ts"), "utf-8");
const mockSrc = readFileSync(join(root, "src", "dev", "mockBackend.ts"), "utf-8");

// 确有不需要 mock 的命令时在此登记并注释原因（当前为空：全部命令都已覆盖）。
const EXEMPT: string[] = [];

const apiCmds = new Set<string>();
for (const m of apiSrc.matchAll(/(?:call|streamedCall)\("([a-z_]+)"/g)) apiCmds.add(m[1]);

const mockCmds = new Set<string>();
for (const m of mockSrc.matchAll(/case "([a-z_]+)":/g)) mockCmds.add(m[1]);
for (const m of mockSrc.matchAll(/cmd === "([a-z_]+)"/g)) mockCmds.add(m[1]);

test("api.ts 的每个后端命令在 mockBackend 都有显式分支", () => {
  expect(apiCmds.size).toBeGreaterThan(0);
  expect(mockCmds.size).toBeGreaterThan(0);
  const missing = [...apiCmds].filter((c) => !EXEMPT.includes(c) && !mockCmds.has(c));
  expect(missing, `mock 缺少命令分支：${missing.join("、")}`).toEqual([]);
});
