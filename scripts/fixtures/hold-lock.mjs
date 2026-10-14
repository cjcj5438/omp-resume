#!/usr/bin/env node
// 在 <ownersDir>/<sessionId>.lock 上持有 flock(LOCK_EX)，直到被 kill。
// 用法：node scripts/fixtures/hold-lock.mjs <ownersDir> <sessionId>
// 就绪后打印 "HELD <sessionId>"（供 verifier 等待），之后阻塞；SIGTERM/SIGINT 时释放退出。
// macOS 说明：Node 无 flock 绑定，此处 spawn `python3`（系统自带）用 fcntl.flock 持锁；
// 若无 python3，可用 `perl -MIO::Handle -e '...; flock(STDIN, 2); sleep'` 等价替代。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ownersDir = resolve(process.argv[2] ?? "");
const sessionId = process.argv[3] ?? "";
if (!ownersDir || !sessionId || process.argv[2] === undefined) {
  console.error("用法：node scripts/fixtures/hold-lock.mjs <ownersDir> <sessionId>");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
  console.error(`非法 sessionId：${sessionId}`);
  process.exit(1);
}
mkdirSync(ownersDir, { recursive: true });
const lockFile = join(ownersDir, `${sessionId}.lock`);

const PY = `
import fcntl, sys, time
p = sys.argv[1]
f = open(p, "a+b")
fcntl.flock(f.fileno(), fcntl.LOCK_EX)
print("HELD " + sys.argv[2], flush=True)
while True:
    time.sleep(3600)
`;

const child = spawn("python3", ["-c", PY, lockFile, sessionId], { stdio: ["ignore", "pipe", "inherit"] });
let ready = false;
child.stdout.on("data", (d) => {
  const line = String(d).trim();
  if (line.startsWith("HELD ") && !ready) {
    ready = true;
    console.log(line);
  }
});
child.on("exit", (code) => {
  console.error(`lock holder 退出（code=${code}）`);
  process.exit(code ?? 1);
});
const kill = () => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000);
};
process.on("SIGTERM", kill);
process.on("SIGINT", kill);
// 永久等待（持锁），直到被 kill
await new Promise(() => {});
