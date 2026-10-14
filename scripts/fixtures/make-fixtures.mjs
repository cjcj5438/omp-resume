#!/usr/bin/env node
// 生成合成 sessions 根目录 + owners 目录 + manifest，用于无风险地冒烟测试真机 app。
// 用法：node scripts/fixtures/make-fixtures.mjs <outDir>
// 形状依据 docs/CONTRACT.md 附录 A（真实 omp v18.10.3 行格式）。Node 22，无第三方依赖。
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "");
if (!outDir || process.argv[2] === undefined) {
  console.error("用法：node scripts/fixtures/make-fixtures.mjs <outDir>");
  process.exit(1);
}

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const L = (o) => JSON.stringify(o);

// 确定性条目 id：8 位 hex，全局唯一。
let seq = 0;
const eid = () => (0x1a000000 + seq++).toString(16).padStart(8, "0");
// 确定性会话 id：uuid 形。
const sid = (n) => `01afe${n}-1111-4111-8111-${String(n).padStart(12, "0")}`;

const S = {
  A: sid("001"), // 线性工具链
  B: sid("002"), // 三分支
  C1: sid("003"), // fork（by id）
  C2: sid("004"), // fork 幽灵
  D: sid("005"), // v2
  E: sid("006"), // 隐藏 stub
  F: sid("007"), // 坏行
  G: sid("008"), // 大会话
  H: sid("009"), // artifacts/bak/dotfile
  MISS: sid("010"), // cwd 缺失
  HELD: sid("011"), // 占用中
};

const T = (h) => h * 3600 * 1000; // hours → ms ago
const DAY = 24 * 3600 * 1000;

// ---- 行构造 ----
const title = (text, ago) => L({ type: "title", v: 1, title: text, source: "auto", updatedAt: iso(ago), pad: "   " });
const head = (id, cwd, ago, extra = {}) =>
  L({ type: "session", version: 3, id, timestamp: iso(ago), cwd, ...extra });
const mc = (id, parent, ago) =>
  L({ type: "model_change", id, parentId: parent, timestamp: iso(ago), model: "5438-claude/claude-sonnet-5-5", resolvedModelIsFallback: false });
const tlc = (id, parent, ago) =>
  L({ type: "thinking_level_change", id, parentId: parent, timestamp: iso(ago), thinkingLevel: "high", configured: null });
const umsg = (id, parent, ago, text) =>
  L({ type: "message", id, parentId: parent, timestamp: iso(ago),
    message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: NOW - ago } });
const cstart = (id, parent, ago, callId, name, args) =>
  L({ type: "custom", customType: "tool_execution_start", data: { toolCallId: callId, toolName: name, startedAt: iso(ago), args }, id, parentId: parent, timestamp: iso(ago) });
const amsg = (id, parent, ago, blocks) =>
  L({ type: "message", id, parentId: parent, timestamp: iso(ago),
    message: { role: "assistant", content: blocks, api: "openai-completions", provider: "5438", model: "m", stopReason: "stop", timestamp: NOW - ago } });
const tres = (id, parent, ago, callId, name, text, isError = false) =>
  L({ type: "message", id, parentId: parent, timestamp: iso(ago),
    message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError, timestamp: NOW - ago } });
const bexec = (id, parent, ago, command, output) =>
  L({ type: "message", id, parentId: parent, timestamp: iso(ago),
    message: { role: "bashExecution", command, output, exitCode: 0, cancelled: false, truncated: false, timestamp: NOW - ago, excludeFromContext: false } });
const dev = (id, parent, ago, text) =>
  L({ type: "message", id, parentId: parent, timestamp: iso(ago),
    message: { role: "developer", content: [{ type: "text", text }], attribution: "agent", timestamp: NOW - ago } });
const comp = (id, parent, ago, summary) =>
  L({ type: "compaction", id, parentId: parent, timestamp: iso(ago), summary, shortSummary: summary.slice(0, 10), firstKeptEntryId: "u0" });
const bs = (id, parent, ago, fromId, summary) =>
  L({ type: "branch_summary", id, parentId: parent, timestamp: iso(ago), fromId, summary });
const lab = (id, parent, ago, targetId, label) => {
  const o = { type: "label", id, parentId: parent, timestamp: iso(ago), targetId };
  if (label !== undefined) o.label = label;
  return L(o);
};
const sessExit = (id, parent, ago) =>
  L({ type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal", recordedAt: iso(ago) }, id, parentId: parent, timestamp: iso(ago) });
const THINK = (t) => ({ type: "thinking", thinking: t, thinkingSignature: "sig", summary: false });
const TXT = (t) => ({ type: "text", text: t });
const CALL = (id, name, args) => ({ type: "toolCall", id, name, arguments: args, partialArgs: "{}" });

// ---- 目录 ----
const sessionsRoot = join(outDir, "sessions");
const ownersDir = join(outDir, "owners");
const cwdBase = join(outDir, "cwd");
const DIRS = { alpha: "-my-proj-alpha", beta: "-my-proj-beta", gamma: "-my-proj-gamma" };
const CWDS = { alpha: join(cwdBase, "alpha"), beta: join(cwdBase, "beta"), gamma: join(cwdBase, "gamma") };
for (const d of [sessionsRoot, ownersDir, CWDS.alpha, CWDS.beta, CWDS.gamma]) mkdirSync(d, { recursive: true });
for (const d of Object.values(DIRS)) mkdirSync(join(sessionsRoot, d), { recursive: true });

const written = []; // {rel, abs, mtimeMsAgo}
function put(dirName, stem, lines, mtimeAgo) {
  const abs = join(sessionsRoot, dirName, stem + ".jsonl");
  writeFileSync(abs, lines.join("\n") + "\n");
  const mtime = new Date(NOW - mtimeAgo);
  utimesSync(abs, mtime, mtime);
  written.push({ rel: `sessions/${dirName}/${stem}.jsonl`, abs, stem });
  return abs;
}
const stem = (date, id) => `${date}_${id}`;
const manifestSessions = {};
function expect(id, facts) { manifestSessions[id] = facts; }

// ============ (a) 线性工具链（手工 id，parent 链写死） ============
{
  const id = S.A, ago = T(50);
  const [m1, t1, c1] = ["1a000010", "1a000011", "1a000012"];
  const lines = [
    title("🔧 Alpha：线性工具链会话", ago),
    head(id, CWDS.alpha, ago),
    mc(m1, null, ago),
    tlc(t1, m1, ago),
    umsg("aa000001", t1, ago, "请读一下配置文件"),
    cstart(c1, "aa000001", ago, "call_aaa001", "read", { path: "/tmp/x", i: "读" }),
    amsg("aa000002", c1, ago, [THINK("先看看文件"), TXT("正在读取"), CALL("call_aaa001", "read", { path: "/tmp/x" })]),
    tres("aa000003", "aa000002", ago, "call_aaa001", "read", "文件内容第一行\n第二行"),
    bexec("aa000004", "aa000003", ago, "ls /tmp", "a\nb"),
    dev("aa000005", "aa000004", ago, "<system-reminder>继续</system-reminder>"),
    amsg("aa000006", "aa000005", ago, [TXT("读完了")]),
  ];
  const abs = put(DIRS.alpha, stem("2026-10-11T08-00-00-000Z", id), lines, ago);
  expect(id, { file: `sessions/${DIRS.alpha}/${stem("2026-10-11T08-00-00-000Z", id)}.jsonl`, title: "🔧 Alpha：线性工具链会话", branchCount: 1, messageCount: 3, formatSupported: true, version: 3, badLines: 0, cwdExists: true, inUse: false, fork: null, leafId: "aa000006", activePath: ["aa000006", "aa000005", "aa000004", "aa000003", "aa000002", "aa000001"], convItems: 6, abs });
}

// ============ (b) 三分支（手工 id，parent 链写死） ============
{
  const id = S.B, ago = T(30);
  const lines = [
    title("🌳 Alpha：三分支会话", ago),
    head(id, CWDS.alpha, ago),
    mc("1b000001", null, ago),
    tlc("1b000002", "1b000001", ago),
    umsg("bb000000", "1b000002", ago, "根用户消息"),
    amsg("bb000001", "bb000000", ago, [TXT("根回答")]),
    umsg("bb000002", "bb000001", ago, "分支一追问"),
    amsg("bb000003", "bb000002", ago, [TXT("分支一回答")]),
    bs("bb000008", "bb000003", ago, "bb000002", "废弃分支摘要"),
    umsg("bb000004", "bb000002", ago, "嵌套分支追问"),
    amsg("bb000005", "bb000004", ago, [TXT("嵌套分支回答")]),
    umsg("bb000006", "bb000001", ago, "分支三追问"),
    comp("bb000009", "bb000006", ago, "压缩摘要内容"),
    amsg("bb000007", "bb000009", ago, [TXT("分支三回答")]),
    lab("bb000010", "bb000007", ago, "bb000005", "重要"),
    sessExit("bb000011", "bb000007", ago),
  ];
  const abs = put(DIRS.alpha, stem("2026-10-12T09-30-00-000Z", id), lines, ago);
  expect(id, { file: `sessions/${DIRS.alpha}/${stem("2026-10-12T09-30-00-000Z", id)}.jsonl`, title: "🌳 Alpha：三分支会话", branchCount: 3, messageCount: 4, formatSupported: true, version: 3, badLines: 0, cwdExists: true, inUse: false, fork: null, leafId: "bb000007", activePath: ["bb000007", "bb000009", "bb000006", "bb000001", "bb000000"], convItems: 5, abs });
}

// ============ (c) forks ============
{
  const ago = T(20);
  const aFile = `sessions/${DIRS.alpha}/${stem("2026-10-11T08-00-00-000Z", S.A)}.jsonl`;
  const lines1 = [
    title("🍴 Beta：fork 自线性会话", ago),
    head(S.C1, CWDS.beta, ago, { parentSession: S.A }),
    umsg("cc000001", null, ago, "fork 后第一句话"),
  ];
  const abs1 = put(DIRS.beta, stem("2026-10-12T20-00-00-000Z", S.C1), lines1, ago);
  expect(S.C1, { file: `sessions/${DIRS.beta}/${stem("2026-10-12T20-00-00-000Z", S.C1)}.jsonl`, title: "🍴 Beta：fork 自线性会话", branchCount: 1, messageCount: 1, formatSupported: true, version: 3, badLines: 0, cwdExists: true, inUse: false, fork: { parentRaw: S.A, parentId: S.A, parentTitle: "🔧 Alpha：线性工具链会话" }, leafId: "cc000001", activePath: ["cc000001"], convItems: 1, abs: abs1, _parentFile: aFile });

  const ghost = sid("999");
  const ago2 = T(19); // 比 C1 更新，beta 组内排第一
  const lines2 = [
    title("👻 Beta：幽灵 fork", ago2),
    head(S.C2, CWDS.beta, ago2, { parentSession: ghost }),
    umsg("cc000002", null, ago2, "找不到爹"),
  ];
  const abs2 = put(DIRS.beta, stem("2026-10-12T21-00-00-000Z", S.C2), lines2, ago2);
  expect(S.C2, { file: `sessions/${DIRS.beta}/${stem("2026-10-12T21-00-00-000Z", S.C2)}.jsonl`, title: "👻 Beta：幽灵 fork", branchCount: 1, messageCount: 1, formatSupported: true, version: 3, badLines: 0, cwdExists: true, inUse: false, fork: { parentRaw: ghost, parentId: null, parentTitle: null }, leafId: "cc000002", activePath: ["cc000002"], convItems: 1, abs: abs2 });
}

// ============ (d) v2 ============
{
  const ago = T(60);
  const lines = [
    title("📼 Beta：老格式会话", ago),
    L({ type: "session", version: 2, id: S.D, timestamp: iso(ago), cwd: CWDS.beta }),
    umsg("dd000001", null, ago, "hi"),
  ];
  const abs = put(DIRS.beta, stem("2026-10-10T10-00-00-000Z", S.D), lines, ago);
  expect(S.D, { file: `sessions/${DIRS.beta}/${stem("2026-10-10T10-00-00-000Z", S.D)}.jsonl`, title: "📼 Beta：老格式会话", branchCount: 0, messageCount: 0, formatSupported: false, version: 2, badLines: 0, cwdExists: true, inUse: false, fork: null, abs });
}

// ============ (e) 隐藏 stub ============
{
  const ago = T(10);
  const lines = [
    title("", ago),
    head(S.E, CWDS.gamma, ago),
    mc(eid(), null, ago),
  ];
  put(DIRS.gamma, stem("2026-10-13T10-00-00-000Z", S.E), lines, ago);
  // hidden：不在 manifest.sessions，计 hiddenEmpty
}

// ============ (f) 坏行 ============
{
  const ago = T(15);
  const lines = [
    title("🧪 Gamma：坏行会话", ago),
    head(S.F, CWDS.gamma, ago),
    "{这不是 json",
    '{"no-type":true}',
    umsg("ff000001", null, ago, "还能读吗"),
  ];
  const abs = put(DIRS.gamma, stem("2026-10-13T05-00-00-000Z", S.F), lines, ago);
  expect(S.F, { file: `sessions/${DIRS.gamma}/${stem("2026-10-13T05-00-00-000Z", S.F)}.jsonl`, title: "🧪 Gamma：坏行会话", branchCount: 1, messageCount: 1, formatSupported: true, version: 3, badLines: 2, cwdExists: true, inUse: false, fork: null, leafId: "ff000001", activePath: ["ff000001"], convItems: 1, abs });
}

// ============ (g) 大会话 ~3000 条 ============
{
  const ago = T(40);
  const lines = [title("🐘 Gamma：大号会话", ago), head(S.G, CWDS.gamma, ago)];
  let parent = null;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const id = `g${String(i).padStart(7, "0")}`;
    if (i % 2 === 0) lines.push(umsg(id, parent, ago, `问题 ${i}`));
    else lines.push(amsg(id, parent, ago, [TXT(`回答 ${i} ` + "好".repeat(20))]));
    parent = id;
  }
  const abs = put(DIRS.gamma, stem("2026-10-11T12-00-00-000Z", S.G), lines, ago);
  const lastId = `g${String(N - 1).padStart(7, "0")}`;
  expect(S.G, { file: `sessions/${DIRS.gamma}/${stem("2026-10-11T12-00-00-000Z", S.G)}.jsonl`, title: "🐘 Gamma：大号会话", branchCount: 1, messageCount: 3000, formatSupported: true, version: 3, badLines: 0, cwdExists: true, inUse: false, fork: null, leafId: lastId, abs, skipTree: true, skipConv: true });
}

// ============ (h) artifacts / bak / dotfile ============
{
  const ago = T(25);
  const id = S.H;
  const fname = stem("2026-10-12T10-00-00-000Z", id);
  const lines = [title("📦 Gamma：附件会话", ago), head(id, CWDS.gamma, ago), umsg("hh000001", null, ago, "有附件")];
  const abs = put(DIRS.gamma, fname, lines, ago);
  // sibling artifacts 目录 + 嵌套子 agent 会话（必须不被列出）
  const art = join(sessionsRoot, DIRS.gamma, fname);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "OmpFacts.jsonl"), L({ type: "session", version: 3, id: sid("777"), timestamp: iso(ago), cwd: CWDS.gamma }) + "\n" + umsg("zz000001", null, ago, "子 agent") + "\n");
  writeFileSync(join(art, "7.bash.log"), "log\n");
  // .bak 残留
  writeFileSync(abs + ".7718473544351234567.bak", lines.join("\n") + "\n");
  // 点文件锁
  writeFileSync(join(sessionsRoot, DIRS.gamma, `.${fname}.jsonl.lock.os`), "lock\n");
  expect(id, { file: `sessions/${DIRS.gamma}/${fname}.jsonl`, title: "📦 Gamma：附件会话", branchCount: 1, messageCount: 1, formatSupported: true, version: 3, badLines: 0, cwdExists: true, inUse: false, fork: null, leafId: "hh000001", activePath: ["hh000001"], convItems: 1, abs, artifactsDir: `sessions/${DIRS.gamma}/${fname}`, bakFile: `sessions/${DIRS.gamma}/${fname}.jsonl.7718473544351234567.bak` });
}

// ============ cwd 缺失 ============
{
  const ago = T(12);
  const lines = [title("🕳️ Gamma：目录已删", ago), head(S.MISS, "/nonexistent-omp-resume-xyz-123", ago), umsg("mm000001", null, ago, "cwd 没了")];
  const abs = put(DIRS.gamma, stem("2026-10-13T08-00-00-000Z", S.MISS), lines, ago);
  expect(S.MISS, { file: `sessions/${DIRS.gamma}/${stem("2026-10-13T08-00-00-000Z", S.MISS)}.jsonl`, title: "🕳️ Gamma：目录已删", branchCount: 1, messageCount: 1, formatSupported: true, version: 3, badLines: 0, cwdExists: false, inUse: false, fork: null, leafId: "mm000001", activePath: ["mm000001"], convItems: 1, abs });
}

// ============ (i) 占用中 ============
{
  const ago = T(5);
  const lines = [title("🔒 Gamma：占用中会话", ago), head(S.HELD, CWDS.gamma, ago), umsg("kk000001", null, ago, "别删我")];
  const abs = put(DIRS.gamma, stem("2026-10-13T12-00-00-000Z", S.HELD), lines, ago);
  expect(S.HELD, { file: `sessions/${DIRS.gamma}/${stem("2026-10-13T12-00-00-000Z", S.HELD)}.jsonl`, title: "🔒 Gamma：占用中会话", branchCount: 1, messageCount: 1, formatSupported: true, version: 3, badLines: 0, cwdExists: true, inUse: true, fork: null, leafId: "kk000001", activePath: ["kk000001"], convItems: 1, abs });
}

// ---- manifest ----
const manifest = {
  generatedAt: new Date(NOW).toISOString(),
  sessionsDir: "sessions",
  ownersDir: "owners",
  heldSessionId: S.HELD,
  groups: [
    { dirName: DIRS.gamma, sessions: [S.HELD, S.MISS, S.F, S.H, S.G] }, // 组内最新 5h 前
    { dirName: DIRS.beta, sessions: [S.C2, S.C1, S.D] }, // 组内最新 19h 前
    { dirName: DIRS.alpha, sessions: [S.B, S.A] }, // 组内最新 30h 前
  ],
  hiddenEmpty: 1,
  sessions: manifestSessions,
};
for (const [id, f] of Object.entries(manifestSessions)) delete f.abs;
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
