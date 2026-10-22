/// <reference types="vite/client" />

// A1 样式回归测试要读 CSS 文件文本；仓库无 @types/node，这里声明用到的最小集。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf-8"): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare const process: { cwd(): string };
