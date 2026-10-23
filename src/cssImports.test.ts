import { expect, test } from "vitest";

// 回归：每个 CSS 文件都必须被显式引用，防止样式表因误删 import 而静默失效。
const cssFiles = Object.keys(import.meta.glob("./**/*.css")).map((p) => p.split("/").pop()!);
const raw = (m: Record<string, unknown>) => Object.values(m).join("\n");
const haystack =
  raw(import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true })) +
  raw(import.meta.glob("../index.html", { query: "?raw", import: "default", eager: true })) +
  raw(import.meta.glob("./**/*.css", { query: "?raw", import: "default", eager: true }));
const missing = cssFiles.filter((f) => {
  const name = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`(?:import|from)\\s+["'][^"']*${name}["']`).test(haystack);
});

test("每个 CSS 文件都被源码导入（防止样式表被误删导入）", () => {
  expect(missing, `未被任何来源引用的 CSS：${missing.join("、")}`).toEqual([]);
});
