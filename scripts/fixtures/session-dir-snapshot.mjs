#!/usr/bin/env node
// 快照目录文件清单：排序输出 `<相对路径> <字节数> <sha256>`（制表符分隔）。
// 用法：node scripts/fixtures/session-dir-snapshot.mjs <dir> [> before.txt]
// 删除 / marker 测试前后各跑一次，用 diff 对比。
// Node 22，无第三方依赖。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!root || process.argv[2] === undefined) {
  console.error("用法：node scripts/fixtures/session-dir-snapshot.mjs <dir>");
  process.exit(1);
}

const rows = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs);
    } else if (st.isFile()) {
      const data = readFileSync(abs);
      rows.push([relative(root, abs), st.size, createHash("sha256").update(data).digest("hex")]);
    }
  }
})(root);
rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
for (const [rel, size, sha] of rows) console.log(`${rel}\t${size}\t${sha}`);
