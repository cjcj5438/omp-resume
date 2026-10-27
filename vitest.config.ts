import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // 默认 5000ms 对重渲染用例（速查表整表过滤 ≈140 行）在 CPU 争用下不够：
    // 单跑该文件 9 个用例 2.6s，满载时单个用例可到 5.7–6.6s，曾因此随机变红。
    // 这里放宽上限（不是忽略失败）：真正的死锁仍会在 15s 内报错，而并发度不变。
    testTimeout: 15_000,
  },
});
