/**
 * DEV-ONLY 记忆库 mock：本地 Mnemopi 库的合成数据（虚构中文内容，无真实用户数据）。
 * 探针标记（用于 build 后 grep 验证）：__OMP_RESUME_FIXTURE_ONLY__
 * URL 参数：`?memory=off`（available:false）、`?memoryBackend=<name>`（改 backend 字段）。
 */
import type {
  MemoryBackup,
  MemoryBankStatus,
  MemoryBankSummary,
  MemoryDeletePreview,
  MemoryDeleteResult,
  MemoryDeleteSkipped,
  MemoryDetail,
  MemoryGrowthPoint,
  MemoryItem,
  MemoryKind,
  MemoryOverview,
  MemoryPage,
  MemoryRestoreResult,
  MemoryTotals,
} from "../types";
import { FIXTURE_SESSIONS } from "./fixtures";

const DAY = 86400000;
/** detail 全文上限（UTF-8 字节），镜像 CONTRACT §18.3 的 MEMORY_CONTENT_CAP_BYTES。 */
const MEMORY_TRUNCATE_AT = 200 * 1024;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FullMemory extends MemoryItem {
  content: string;
  embedText: string | null;
  metadata: Record<string, unknown> | null;
  facts: MemoryDetail["facts"];
  summaryOf: string[];
  relatedEdges: number;
}

interface BankStore {
  bank: string;
  displayName: string;
  cwd: string | null;
  cwdExists: boolean | null;
  readable: boolean;
  error: string | null;
  items: FullMemory[];
}

const WORKING_SNIPPETS = [
  "用户偏好：提交信息用中文，首行不超过 50 字",
  "项目使用 pnpm 管理依赖，锁文件必须提交",
  "该仓库禁止直接推送 main，只能走合并请求",
  "测试命令是 npm run test，跑单测用 vitest -t",
  "接口返回的 createdAt 是 ISO 字符串，前端直接解析",
  "深色模式用 data-theme 切换，不要用媒体查询硬编码",
  "后端错误统一走 AppError，前端用 normalizeError 归一",
  "用户习惯先看类型定义再看实现，注释写在文件头",
  "发布前必须跑 typecheck 与全部单测",
  "组件样式用手写 CSS，不引入组件库",
  "中文文案里的数字与英文两侧各留一个空格",
  "截图存放到 /tmp，禁止提交到仓库",
  "该项目 Node 版本要求 22，CI 会校验",
  "遇到 flaky 测试先复现三次再修",
  "重构时保持对外接口不变，内部可随意调整",
];

const EPISODIC_SNIPPETS = [
  "2026 年 9 月：把侧栏分组从单列改成可折叠，解决了长列表难找的问题",
  "上次排查登录超时，最终原因是代理把 Set-Cookie 头吃掉了",
  "10 月初上线用量统计，用户反馈趋势图比表格更直观",
  "修复过一次深色模式下按钮看不清的问题，原因是变量漏覆盖",
  "之前讨论过是否引入图表库，决定手写 SVG 以控制体积",
  "上季度做过清理功能：空会话与过期会话是主要的可删项",
  "曾经因为时区 bug 把「昨天」算错，改用本地日历比较修复",
  "去年底迁移过一次配置格式，旧字段保留兼容读取",
];

const FACT_POOL: MemoryDetail["facts"] = [
  { subject: "用户", predicate: "偏好", object: "中文提交信息", key: "pref:commit-lang" },
  { subject: "项目", predicate: "包管理", object: "pnpm", key: "proj:pkg" },
  { subject: "前端", predicate: "主题切换", object: "data-theme", key: "fe:theme" },
  { subject: null, predicate: null, object: null, key: "note:unparsed" },
];

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function isoDaysAgo(daysAgo: number, hour = 10): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface SourcePlan {
  id: string | null;
  exists: boolean | null;
}

/** 来源会话三态：已加载（夹具会话）/ 存在但未加载 / 已不在。 */
function planSource(rand: () => number, i: number): SourcePlan {
  const r = rand();
  if (r < 0.3) return { id: null, exists: null };
  if (r < 0.55) {
    const s = FIXTURE_SESSIONS[i % FIXTURE_SESSIONS.length].summary;
    return { id: s.id, exists: true };
  }
  if (r < 0.75) return { id: `0199-mem-only-${String(i).padStart(4, "0")}`, exists: true };
  return { id: `0199-mem-gone-${String(i).padStart(4, "0")}`, exists: false };
}

function makeItem(
  bank: string,
  i: number,
  kind: MemoryKind,
  snippet: string,
  rand: () => number,
  daysAgo: number,
): FullMemory {
  const source = planSource(rand, i);
  const neverRecalled = rand() < 0.6;
  const recallCount = neverRecalled ? 0 : 1 + Math.floor(rand() * 20);
  const consolidated = kind === "episodic" ? true : rand() < 0.5;
  const body = `${snippet}。\n\n补充说明：这是第 ${i + 1} 条合成记忆（${bank}/${kind}），内容为虚构，用于开发与截图验证。\n关键细节：${pick(rand, WORKING_SNIPPETS)}；${pick(rand, EPISODIC_SNIPPETS)}。`;
  return {
    id: `mem-${bank}-${String(i).padStart(4, "0")}`,
    kind,
    snippet,
    contentChars: body.length,
    createdAt: isoDaysAgo(daysAgo, 8 + Math.floor(rand() * 12)),
    sourceSessionId: source.id,
    sourceSessionExists: source.id === null ? null : source.exists,
    recallCount,
    lastRecalledAt: recallCount === 0 ? null : isoDaysAgo(Math.max(0, daysAgo - 1 - Math.floor(rand() * 10))),
    importance: rand() < 0.2 ? null : Math.round(rand() * 100) / 100,
    veracity: rand() < 0.3 ? null : pick(rand, ["confirmed", "likely", "uncertain"] as const),
    memoryType: rand() < 0.3 ? null : pick(rand, ["preference", "fact", "procedure"] as const),
    consolidated,
    superseded: rand() < 0.05,
    content: body,
    embedText: rand() < 0.5 ? snippet : null,
    metadata: rand() < 0.4 ? { bank, lane: kind, weight: Math.round(rand() * 100) / 100 } : null,
    facts: rand() < 0.45 ? [pick(rand, FACT_POOL)] : [],
    summaryOf: [],
    relatedEdges: Math.floor(rand() * 6),
  };
}

function summarize(store: BankStore): MemoryBankSummary {
  if (!store.readable) {
    return {
      bank: store.bank,
      displayName: store.displayName,
      cwd: store.cwd,
      cwdExists: store.cwdExists,
      working: 0,
      episodic: 0,
      facts: 0,
      bytes: 0,
      firstMemoryAt: null,
      lastMemoryAt: null,
      neverRecalled: 0,
      unconsolidated: 0,
      sourceSessions: 0,
      missingSourceSessions: 0,
      readable: false,
      error: store.error,
    };
  }
  const items = store.items;
  const times = items.map((m) => m.createdAt).filter((t): t is string => t !== null).sort();
  const sources = new Set(items.map((m) => m.sourceSessionId).filter((s): s is string => s !== null));
  const missingSources = new Set(
    items.filter((m) => m.sourceSessionExists === false).map((m) => m.sourceSessionId),
  );
  return {
    bank: store.bank,
    displayName: store.displayName,
    cwd: store.cwd,
    cwdExists: store.cwdExists,
    working: items.filter((m) => m.kind === "working").length,
    episodic: items.filter((m) => m.kind === "episodic").length,
    facts: items.reduce((n, m) => n + m.facts.length, 0),
    bytes: items.reduce((n, m) => n + m.contentChars, 0),
    firstMemoryAt: times[0] ?? null,
    lastMemoryAt: times.length > 0 ? times[times.length - 1] : null,
    neverRecalled: items.filter((m) => m.recallCount === 0).length,
    unconsolidated: items.filter((m) => !m.consolidated).length,
    sourceSessions: sources.size,
    missingSourceSessions: missingSources.size,
    readable: true,
    error: null,
  };
}

function buildStores(extraItems = 0): BankStore[] {
  const rand = mulberry32(20261019);

  // 大库：~120 条，混合全部状态。
  const big: FullMemory[] = [];
  for (let i = 0; i < 120; i += 1) {
    const kind: MemoryKind = i % 3 === 2 ? "episodic" : "working";
    const pool = kind === "working" ? WORKING_SNIPPETS : EPISODIC_SNIPPETS;
    big.push(makeItem("omp-resume", i, kind, `${pick(rand, pool)}（${i + 1}）`, rand, Math.floor(rand() * 200)));
  }
  // 通配符字面量：搜索 % / _ 时必须按字面匹配。
  big[5] = { ...big[5], snippet: "CPU 占用跑到 100% 时先看火焰图再下结论", content: "CPU 占用跑到 100% 时先看火焰图再下结论。\n\n虚构的性能排查记忆。" };
  big[5].contentChars = big[5].content.length;
  big[6] = { ...big[6], snippet: "表名统一用 snake_case，如 session_meta", content: "表名统一用 snake_case，如 session_meta。\n\n虚构的命名规范记忆。" };
  big[6].contentChars = big[6].content.length;
  // 30KB 长条目：验证详情的折叠 / 展开（未超过 200KB 上限，truncated=false）。
  const longPara = "这是一段很长的合成记忆正文，用于验证详情折叠逻辑。包含中文标点，。！？与换行。\n";
  const longContent = longPara.repeat(Math.ceil((30 * 1024) / longPara.length)).slice(0, 30 * 1024);
  big[7] = {
    ...big[7],
    snippet: longContent.slice(0, 120),
    content: longContent,
    contentChars: longContent.length,
    facts: [FACT_POOL[0], FACT_POOL[1]],
  };
  // 超过 200KB 上限的条目：detail 必须截断并标注。
  const capPara = "这是一段超过上限的合成记忆正文，用于验证截断标注。同样包含中文标点，。！？与换行。\n";
  const capContent = capPara.repeat(Math.ceil((210 * 1024) / capPara.length)).slice(0, 210 * 1024);
  big[8] = {
    ...big[8],
    snippet: capContent.slice(0, 120),
    content: capContent,
    contentChars: capContent.length,
    facts: [],
  };
  // 可选：额外条目（`?memoryMany`），用于验证「全选筛选结果」在 500 上限时的截断。
  for (let i = 0; i < extraItems; i += 1) {
    const kind: MemoryKind = i % 3 === 2 ? "episodic" : "working";
    const pool = kind === "working" ? WORKING_SNIPPETS : EPISODIC_SNIPPETS;
    big.push(makeItem("omp-resume", 120 + i, kind, `${pick(rand, pool)}（批量 ${i + 1}）`, rand, Math.floor(rand() * 200)));
  }
  // episodic 的 summaryOf 指向同库 working 条目。
  const workingIds = big.filter((m) => m.kind === "working").map((m) => m.id);
  for (const m of big) {
    if (m.kind === "episodic") m.summaryOf = [workingIds[Math.floor(rand() * workingIds.length)]];
  }

  const smallRand = mulberry32(77);
  const notes: FullMemory[] = [];
  for (let i = 0; i < 8; i += 1) {
    notes.push(makeItem("notes-app", i, i % 2 === 0 ? "working" : "episodic", `${pick(smallRand, WORKING_SNIPPETS)}（备忘 ${i + 1}）`, smallRand, 2 + Math.floor(smallRand() * 60)));
  }
  const goneRand = mulberry32(913);
  const gone: FullMemory[] = [];
  for (let i = 0; i < 3; i += 1) {
    gone.push(makeItem("gone-proj", i, "working", `${pick(goneRand, WORKING_SNIPPETS)}（旧项目 ${i + 1}）`, goneRand, 60 + Math.floor(goneRand() * 300)));
  }
  const homeRand = mulberry32(451);
  const home: FullMemory[] = [];
  for (let i = 0; i < 3; i += 1) {
    home.push(makeItem("home-lab", i, "working", `${pick(homeRand, WORKING_SNIPPETS)}（家庭 ${i + 1}）`, homeRand, 30 + Math.floor(homeRand() * 300)));
  }

  return [
    { bank: "omp-resume", displayName: "omp-resume", cwd: "/Users/demo/my/omp-resume", cwdExists: true, readable: true, error: null, items: big },
    { bank: "notes-app", displayName: "notes-app", cwd: "/Users/demo/my/notes-app", cwdExists: true, readable: true, error: null, items: notes },
    { bank: "empty-proj", displayName: "empty-proj", cwd: "/Users/demo/my/empty-proj", cwdExists: true, readable: true, error: null, items: [] },
    { bank: "gone-proj", displayName: "gone-proj", cwd: "/Users/demo/my/gone-proj", cwdExists: false, readable: true, error: null, items: gone },
    { bank: "locked-proj", displayName: "locked-proj", cwd: "/Users/demo/my/locked-proj", cwdExists: true, readable: false, error: "目录无读取权限", items: [] },
    { bank: "home-lab", displayName: "home-lab", cwd: null, cwdExists: null, readable: true, error: null, items: home },
  ];
}

function err(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

export interface MemoryMockOptions {
  available: boolean;
  backend: string | null;
  /** 该 bank 报占用中（`?memoryInUse=<bank>`），写操作报 IN_USE。 */
  inUseBank?: string | null;
  /** 占用探测失败（`?memoryProbe=fail`），写操作报 PROBE_FAILED。 */
  probeFailed?: boolean;
  /** 额外生成 560 条记忆（`?memoryMany`），用于 500 上限的可视化验证。 */
  manyItems?: boolean;
}

export function createMemoryMock(opts: MemoryMockOptions): (cmd: string, args: Record<string, unknown>) => unknown {
  const stores = buildStores(opts.manyItems === true ? 560 : 0);
  const byBank = new Map(stores.map((s) => [s.bank, s]));
  /** 已移除的库（目录已“移走”，可从 bank-removed 备份恢复）。 */
  const removed = new Map<string, BankStore>();
  /** 备份记录 + 整库快照（恢复用）；mock 内内存态。 */
  const backups: { record: MemoryBackup; snapshot: FullMemory[] }[] = [];
  let backupSeq = 0;

  /** 写命令的库校验：已移除的库报 NOT_FOUND（可从备份恢复），不可读报 IO。 */
  function requireStore(bank: unknown): BankStore {
    if (typeof bank !== "string" || bank === "") throw err("INVALID_INPUT", "bank 不能为空");
    if (removed.has(bank)) throw err("NOT_FOUND", "项目库已被移除，可从备份恢复");
    const store = byBank.get(bank);
    if (!store) throw err("NOT_FOUND", "项目库不存在");
    if (!store.readable) throw err("IO", store.error ?? "项目库不可读");
    return store;
  }

  /** 占用门禁：与真实后端同码（IN_USE 含 pid + 命令名，探测失败 PROBE_FAILED）。 */
  function gate(bank: string): void {
    if (opts.probeFailed === true) throw err("PROBE_FAILED", "占用探测失败：无法确认是否有 omp 会话在使用该库");
    if (opts.inUseBank != null && opts.inUseBank !== "" && opts.inUseBank === bank) {
      throw err("IN_USE", "库正被 omp 会话使用：omp (pid 4242)");
    }
  }
  function overview(): MemoryOverview {
    if (!opts.available) {
      return {
        available: false,
        backend: opts.backend,
        root: "/Users/demo/.omp/agent/memory",
        banks: [],
        totals: { banks: 0, working: 0, episodic: 0, facts: 0, bytes: 0, neverRecalled: 0, unconsolidated: 0, missingSourceSessions: 0, sourceSessions: 0 },
      };
    }
    // 与后端一致：lastMemoryAt 倒序（null 视为最小），再按 bank 名升序。
    const order = (b: MemoryBankSummary): number =>
      b.lastMemoryAt === null ? Number.NEGATIVE_INFINITY : Date.parse(b.lastMemoryAt);
    const banks = [...byBank.values()]
      .map(summarize)
      .sort((a, b) => order(b) - order(a) || a.bank.localeCompare(b.bank));
    const readable = banks.filter((b) => b.readable);
    const totals: MemoryTotals = {
      banks: banks.length,
      working: readable.reduce((n, b) => n + b.working, 0),
      episodic: readable.reduce((n, b) => n + b.episodic, 0),
      facts: readable.reduce((n, b) => n + b.facts, 0),
      bytes: readable.reduce((n, b) => n + b.bytes, 0),
      neverRecalled: readable.reduce((n, b) => n + b.neverRecalled, 0),
      unconsolidated: readable.reduce((n, b) => n + b.unconsolidated, 0),
      missingSourceSessions: readable.reduce((n, b) => n + b.missingSourceSessions, 0),
      sourceSessions: readable.reduce((n, b) => n + b.sourceSessions, 0),
    };
    return { available: true, backend: opts.backend, root: "/Users/demo/.omp/agent/memory", banks, totals };
  }

  function list(args: Record<string, unknown>): MemoryPage {
    const store = requireStore(args["bank"]);
    const q = typeof args["query"] === "string" ? args["query"].trim().toLowerCase() : "";
    const kind = args["kind"];
    if (kind !== undefined && kind !== "all" && kind !== "working" && kind !== "episodic") throw err("INVALID_INPUT", "kind 非法");
    let rows: FullMemory[] = store.items;
    if (q !== "") {
      rows = rows.filter((m) =>
        `${m.id}\n${m.content}\n${m.embedText ?? ""}`.toLowerCase().includes(q),
      );
    }
    if (kind === "working" || kind === "episodic") rows = rows.filter((m) => m.kind === kind);
    if (args["onlyNeverRecalled"] === true) rows = rows.filter((m) => m.recallCount === 0);
    if (args["onlyUnconsolidated"] === true) rows = rows.filter((m) => !m.consolidated);
    if (args["onlyMissingSource"] === true) rows = rows.filter((m) => m.sourceSessionExists === false);
    const sort = args["sort"] ?? "newest";
    if (sort !== "newest" && sort !== "oldest" && sort !== "mostRecalled") throw err("INVALID_INPUT", "sort 非法");
    const time = (t: string | null): number => (t === null ? -1 : Date.parse(t));
    rows.sort((a, b) =>
      sort === "oldest"
        ? time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id)
        : sort === "mostRecalled"
          ? b.recallCount - a.recallCount || time(b.createdAt) - time(a.createdAt)
          : time(b.createdAt) - time(a.createdAt) || a.id.localeCompare(b.id),
    );
    const limitRaw = Number(args["limit"] ?? 50);
    const offsetRaw = Number(args["offset"] ?? 0);
    if (!Number.isFinite(limitRaw) || !Number.isFinite(offsetRaw) || offsetRaw < 0) throw err("INVALID_INPUT", "分页参数非法");
    const limit = Math.min(200, Math.max(1, Math.floor(limitRaw)));
    const offset = Math.floor(offsetRaw);
    const items: MemoryItem[] = rows.map(({ content: _c, embedText: _e, metadata: _m, facts: _f, summaryOf: _s, relatedEdges: _r, ...rest }) => rest);
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  function detail(args: Record<string, unknown>): MemoryDetail {
    const store = requireStore(args["bank"]);
    const id = args["id"];
    if (typeof id !== "string" || id === "") throw err("INVALID_INPUT", "id 不能为空");
    const found = store.items.find((m) => m.id === id);
    if (!found) throw err("NOT_FOUND", "记忆不存在");
    const truncated = found.content.length > MEMORY_TRUNCATE_AT;
    const { content, ...rest } = found;
    return { ...rest, content: truncated ? content.slice(0, MEMORY_TRUNCATE_AT) : content, truncated };
  }

  function growth(args: Record<string, unknown>): MemoryGrowthPoint[] {
    const daysRaw = Number(args["days"]);
    if (!Number.isFinite(daysRaw) || daysRaw < 1 || daysRaw > 365) throw err("INVALID_INPUT", "days 非法");
    const days = Math.floor(daysRaw);
    const bankArg = args["bank"];
    const live = [...byBank.values()];
    const targets = bankArg == null ? live.filter((s) => s.readable) : live.filter((s) => s.bank === bankArg && s.readable);
    const buckets = new Map<string, { working: number; episodic: number }>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i -= 1) {
      buckets.set(localDay(new Date(today.getTime() - i * DAY)), { working: 0, episodic: 0 });
    }
    for (const s of targets) {
      for (const m of s.items) {
        if (m.createdAt === null) continue;
        const key = localDay(new Date(Date.parse(m.createdAt)));
        const b = buckets.get(key);
        if (b) b[m.kind] += 1;
      }
    }
    return [...buckets.entries()].map(([date, v]) => ({ date, working: v.working, episodic: v.episodic }));
  }

  /** ids 去重（保序）；非字符串元素视为非法。 */
  function uniqueIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) throw err("INVALID_INPUT", "ids 须为 id 数组");
    const seen = new Set<string>();
    for (const v of raw) {
      if (typeof v !== "string" || v === "") throw err("INVALID_INPUT", "ids 含空 id");
      seen.add(v);
    }
    const ids = [...seen];
    if (ids.length === 0) throw err("INVALID_INPUT", "未选择任何记忆");
    if (ids.length > 500) throw err("INVALID_INPUT", "一次最多删除 500 条");
    return ids;
  }

  /** 删除规划：preview 与实际删除共用，保证数字一致。mock 中可删 = 存在即删。 */
  function planDelete(store: BankStore, ids: string[]): { deletable: FullMemory[]; skipped: MemoryDeleteSkipped[] } {
    const byId = new Map(store.items.map((m) => [m.id, m]));
    const deletable: FullMemory[] = [];
    const skipped: MemoryDeleteSkipped[] = [];
    for (const id of ids) {
      const found = byId.get(id);
      if (found) deletable.push(found);
      else skipped.push({ id, reason: "not_found" });
    }
    return { deletable, skipped };
  }

  function snapshotBytes(items: FullMemory[]): number {
    return items.reduce((n, m) => n + m.contentChars, 0);
  }

  function utcStamp(ms: number): string {
    const d = new Date(ms);
    const p = (n: number, w = 2): string => String(n).padStart(w, "0");
    return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }

  /** 整库快照：before-delete / before-restore 只留最新 5 份，bank-removed 永不剪。 */
  function takeBackup(store: BankStore, kind: MemoryBackup["kind"]): MemoryBackup {
    backupSeq += 1;
    const at = Date.now() + backupSeq * 1000;
    const record: MemoryBackup = {
      id: `${store.bank}@${utcStamp(at)}-${kind}`,
      bank: store.bank,
      kind,
      createdAt: new Date(at).toISOString(),
      bytes: snapshotBytes(store.items),
      working: store.items.filter((m) => m.kind === "working").length,
      episodic: store.items.filter((m) => m.kind === "episodic").length,
      cwd: store.cwd,
    };
    backups.push({ record, snapshot: structuredClone(store.items) });
    if (kind === "before-delete" || kind === "before-restore") {
      const same = backups.filter((b) => b.record.bank === store.bank && b.record.kind === kind);
      while (same.length > 5) {
        const oldest = same.shift();
        if (!oldest) break;
        const at0 = backups.indexOf(oldest);
        if (at0 >= 0) backups.splice(at0, 1);
      }
    }
    return record;
  }

  function bankBackups(bank: string): MemoryBackup[] {
    return backups
      .filter((b) => b.record.bank === bank)
      .map((b) => b.record)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function bankStatus(bank: unknown): MemoryBankStatus {
    if (typeof bank !== "string" || bank === "") throw err("INVALID_INPUT", "bank 不能为空");
    if (opts.probeFailed === true) return { bank, inUse: false, probeFailed: true, holders: [], backups: bankBackups(bank) };
    const live = byBank.has(bank);
    const inUse = live && opts.inUseBank === bank;
    return {
      bank,
      inUse,
      probeFailed: false,
      holders: inUse ? [{ pid: 4242, command: "omp" }] : [],
      backups: bankBackups(bank),
    };
  }

  function backupsList(args: Record<string, unknown>): MemoryBackup[] {
    const bank = args["bank"];
    const rows = (bank == null ? backups : backups.filter((b) => b.record.bank === bank)).map((b) => b.record);
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function deletePreview(args: Record<string, unknown>): MemoryDeletePreview {
    const store = requireStore(args["bank"]);
    const ids = uniqueIds(args["ids"]);
    const { deletable, skipped } = planDelete(store, ids);
    const selectedWorking = new Set(deletable.filter((m) => m.kind === "working").map((m) => m.id));
    return {
      requested: ids.length,
      deletable: {
        working: deletable.filter((m) => m.kind === "working").length,
        episodic: deletable.filter((m) => m.kind === "episodic").length,
      },
      unsupported: skipped.filter((s) => s.reason === "unsupported").length,
      notFound: skipped.filter((s) => s.reason === "not_found").length,
      cascade: {
        facts: deletable.reduce((n, m) => n + m.facts.length, 0),
        embeddings: deletable.filter((m) => m.embedText !== null).length,
        annotations: 0,
        edges: deletable.reduce((n, m) => n + m.relatedEdges, 0),
        other: 0,
      },
      citedBySummaries: store.items.filter(
        (m) => m.kind === "episodic" && m.summaryOf.some((id) => selectedWorking.has(id)),
      ).length,
    };
  }

  function deleteItems(args: Record<string, unknown>): MemoryDeleteResult {
    const store = requireStore(args["bank"]);
    const ids = uniqueIds(args["ids"]);
    gate(store.bank);
    const { deletable, skipped } = planDelete(store, ids);
    if (deletable.length === 0) throw err("INVALID_INPUT", "所选记忆均不可删除（不存在或暂不支持）");
    const backup = takeBackup(store, "before-delete");
    const gone = new Set(deletable.map((m) => m.id));
    store.items = store.items.filter((m) => !gone.has(m.id));
    return { deleted: deletable.map((m) => m.id), skipped, backup };
  }

  function deleteBank(args: Record<string, unknown>): MemoryBackup {
    const store = requireStore(args["bank"]);
    gate(store.bank);
    const backup = takeBackup(store, "bank-removed");
    byBank.delete(store.bank);
    removed.set(store.bank, store);
    return backup;
  }

  function findBackup(raw: unknown): { record: MemoryBackup; snapshot: FullMemory[] } {
    if (typeof raw !== "string" || raw === "") throw err("INVALID_INPUT", "backupId 不能为空");
    const at = raw.lastIndexOf("@");
    const bank = at < 0 ? "" : raw.slice(0, at);
    const dirname = at < 0 ? "" : raw.slice(at + 1);
    const badShape =
      bank === "" || bank === "." || bank === ".." || bank.includes("/") || bank.includes("\\") || bank.includes("\0");
    if (badShape || !/^\d{8}T\d{6}Z-(before-delete|before-restore|bank-removed)$/.test(dirname)) {
      throw err("OUTSIDE_ROOT", "备份标识非法");
    }
    const found = backups.find((b) => b.record.id === raw);
    if (!found) throw err("NOT_FOUND", "备份不存在");
    return found;
  }

  function restore(args: Record<string, unknown>): MemoryRestoreResult {
    const { record, snapshot } = findBackup(args["backupId"]);
    const live = byBank.get(record.bank);
    let safetyBackup: MemoryBackup | null = null;
    if (live) {
      if (!live.readable) throw err("IO", live.error ?? "项目库不可读");
      gate(live.bank);
      safetyBackup = takeBackup(live, "before-restore");
      live.items = structuredClone(snapshot);
    } else {
      const meta = removed.get(record.bank);
      gate(record.bank);
      const store: BankStore = meta ?? {
        bank: record.bank,
        displayName: record.bank,
        cwd: record.cwd,
        cwdExists: null,
        readable: true,
        error: null,
        items: [],
      };
      store.items = structuredClone(snapshot);
      store.readable = true;
      store.error = null;
      byBank.set(record.bank, store);
      removed.delete(record.bank);
    }
    return { bank: record.bank, restoredFrom: record, safetyBackup };
  }

  function deleteBackup(args: Record<string, unknown>): null {
    const found = findBackup(args["backupId"]);
    backups.splice(backups.indexOf(found), 1);
    return null;
  }

  return (cmd: string, args: Record<string, unknown>): unknown => {
    switch (cmd) {
      case "memory_overview":
        return structuredClone(overview());
      case "memory_list":
        return structuredClone(list(args));
      case "memory_detail":
        return structuredClone(detail(args));
      case "memory_growth":
        return structuredClone(growth(args));
      case "memory_bank_status":
        return structuredClone(bankStatus(args["bank"]));
      case "memory_backups":
        return structuredClone(backupsList(args));
      case "memory_delete_preview":
        return structuredClone(deletePreview(args));
      case "memory_delete_items":
        return structuredClone(deleteItems(args));
      case "memory_delete_bank":
        return structuredClone(deleteBank(args));
      case "memory_restore":
        return structuredClone(restore(args));
      case "memory_delete_backup":
        return structuredClone(deleteBackup(args));
      default:
        throw err("UNKNOWN", `未知命令：${cmd}`);
    }
  };
}
