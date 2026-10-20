/** DEV-ONLY 记忆库 mock（虚构数据）。探针标记：__OMP_RESUME_FIXTURE_ONLY__。 */
/** 参数：`?memory=off`（不可用）、`?memoryBackend=<名>`、`?memoryInUse=<bank>`（写报 IN_USE）、`?memoryProbe=fail`（写报 PROBE_FAILED）、`?memoryBanks=N`（批量库）。 */
import type {
  MemoryBackup,
  MemoryBankStatus,
  MemoryBankSummary,
  MemoryDeletePreview,
  MemoryDeleteResult,
  MemoryDeleteSkipped,
  MemoryDetail,
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
  "发布前必须跑 typecheck 与全部单测",
  "组件样式用手写 CSS，不引入组件库",
  "中文文案里的数字与英文两侧各留一个空格",
  "截图存放到 /tmp，禁止提交到仓库",
  "重构时保持对外接口不变，内部可随意调整",
];

const EPISODIC_SNIPPETS = [
  "2026 年 9 月：把侧栏分组从单列改成可折叠，解决了长列表难找的问题",
  "上次排查登录超时，最终原因是代理把 Set-Cookie 头吃掉了",
  "10 月初上线用量统计，用户反馈趋势图比表格更直观",
  "修复过一次深色模式下按钮看不清的问题，原因是变量漏覆盖",
  "之前讨论过是否引入图表库，决定手写 SVG 以控制体积",
  "曾经因为时区 bug 把「昨天」算错，改用本地日历比较修复",
];

const FACT_POOL: MemoryDetail["facts"] = [
  { subject: "用户", predicate: "偏好", object: "中文提交信息", key: "pref:commit-lang" },
  { subject: "项目", predicate: "包管理", object: "pnpm", key: "proj:pkg" },
  { subject: "前端", predicate: "主题切换", object: "data-theme", key: "fe:theme" },
  { subject: null, predicate: null, object: null, key: "note:unparsed" },
];

const pick = <T,>(rand: () => number, arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

function isoDaysAgo(daysAgo: number, hour = 10): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
}

function makeItem(bank: string, i: number, kind: MemoryKind, snippet: string, rand: () => number, daysAgo: number): FullMemory {
  // 来源会话三态：已加载（夹具会话）/ 存在但未加载 / 已不在。
  const r = rand();
  const source =
    r < 0.3
      ? { id: null, exists: null }
      : r < 0.55
        ? { id: FIXTURE_SESSIONS[i % FIXTURE_SESSIONS.length].summary.id, exists: true }
        : r < 0.75
          ? { id: `0199-mem-only-${String(i).padStart(4, "0")}`, exists: true }
          : { id: `0199-mem-gone-${String(i).padStart(4, "0")}`, exists: false };
  const recallCount = rand() < 0.6 ? 0 : 1 + Math.floor(rand() * 20);
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
    consolidated: kind === "episodic" ? true : rand() < 0.5,
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
      ...store,
      working: 0, episodic: 0, facts: 0, bytes: 0, firstMemoryAt: null, lastMemoryAt: null,
      neverRecalled: 0, unconsolidated: 0, sourceSessions: 0, missingSourceSessions: 0,
    } as MemoryBankSummary;
  }
  const times = store.items.map((m) => m.createdAt).filter((t): t is string => t !== null).sort();
  return {
    bank: store.bank,
    displayName: store.displayName,
    cwd: store.cwd,
    cwdExists: store.cwdExists,
    working: store.items.filter((m) => m.kind === "working").length,
    episodic: store.items.filter((m) => m.kind === "episodic").length,
    facts: store.items.reduce((n, m) => n + m.facts.length, 0),
    bytes: store.items.reduce((n, m) => n + m.contentChars, 0),
    firstMemoryAt: times[0] ?? null,
    lastMemoryAt: times[times.length - 1] ?? null,
    neverRecalled: store.items.filter((m) => m.recallCount === 0).length,
    unconsolidated: store.items.filter((m) => !m.consolidated).length,
    sourceSessions: new Set(store.items.map((m) => m.sourceSessionId).filter((s) => s !== null)).size,
    missingSourceSessions: new Set(
      store.items.filter((m) => m.sourceSessionExists === false).map((m) => m.sourceSessionId),
    ).size,
    readable: true,
    error: null,
  };
}

/** 批量库的固定分布：空库 / 目录已删 / 不可读，其余规模递减。 */
export const BULK_IN_USE_BANK = "bulk-01";

function bulkStores(count: number): BankStore[] {
  const rand = mulberry32(20261020);
  const sizes = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 120];
  return Array.from({ length: count }, (_, i) => {
    const id = `bulk-${String(i + 1).padStart(2, "0")}`;
    const readable = i !== 6;
    const items = !readable
      ? []
      : Array.from({ length: sizes[i % sizes.length] }, (_, k) => {
          const kind: MemoryKind = k % 3 === 2 ? "episodic" : "working";
          return makeItem(id, k, kind, `${pick(rand, kind === "working" ? WORKING_SNIPPETS : EPISODIC_SNIPPETS)}（${id}）`, rand, Math.floor(rand() * 240));
        });
    return {
      bank: id,
      displayName: id,
      cwd: `/Users/demo/my/${id}`,
      cwdExists: ![2, 8, 14].includes(i),
      readable,
      error: readable ? null : "目录无读取权限",
      items,
    };
  });
}

function buildStores(bulkBanks = 0): BankStore[] {
  const rand = mulberry32(20261019);
  const bank = (id: string, items: FullMemory[], over: Partial<BankStore> = {}): BankStore => ({
    bank: id,
    displayName: id,
    cwd: `/Users/demo/my/${id}`,
    cwdExists: true,
    readable: true,
    error: null,
    items,
    ...over,
  });
  // 大库：~120 条，混合全部状态；含通配符字面量、30KB 长文与超限条目。
  const big = Array.from({ length: 120 }, (_, i) => {
    const kind: MemoryKind = i % 3 === 2 ? "episodic" : "working";
    return makeItem("omp-resume", i, kind, `${pick(rand, kind === "working" ? WORKING_SNIPPETS : EPISODIC_SNIPPETS)}（${i + 1}）`, rand, Math.floor(rand() * 200));
  });
  const special = (i: number, snippet: string, content: string): void => {
    big[i] = { ...big[i], snippet, content, contentChars: content.length };
  };
  special(5, "CPU 占用跑到 100% 时先看火焰图再下结论", "CPU 占用跑到 100% 时先看火焰图再下结论。\n\n虚构的性能排查记忆。");
  special(6, "表名统一用 snake_case，如 session_meta", "表名统一用 snake_case，如 session_meta。\n\n虚构的命名规范记忆。");
  const longPara = "这是一段很长的合成记忆正文，用于验证详情折叠逻辑。包含中文标点，。！？与换行。\n";
  special(7, longPara.slice(0, 120).repeat(1), longPara.repeat(Math.ceil((30 * 1024) / longPara.length)).slice(0, 30 * 1024));
  const capPara = "这是一段超过上限的合成记忆正文，用于验证截断标注。同样包含中文标点，。！？与换行。\n";
  big[8] = { ...big[8], content: capPara.repeat(Math.ceil((210 * 1024) / capPara.length)).slice(0, 210 * 1024) };
  big[8].contentChars = big[8].content.length;
  big[8].snippet = big[8].content.slice(0, 120);
  big[8].facts = [];
  const workingIds = big.filter((m) => m.kind === "working").map((m) => m.id);
  for (const m of big) if (m.kind === "episodic") m.summaryOf = [workingIds[Math.floor(rand() * workingIds.length)]];
  const small = (seed: number, id: string, n: number, tag: string): FullMemory[] => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, (_, i) =>
      makeItem(id, i, i % 2 === 0 ? "working" : "episodic", `${pick(r, WORKING_SNIPPETS)}（${tag} ${i + 1}）`, r, 2 + Math.floor(r() * 60)),
    );
  };
  return [
    bank("omp-resume", big),
    bank("notes-app", small(77, "notes-app", 8, "备忘")),
    bank("empty-proj", []),
    bank("gone-proj", small(913, "gone-proj", 3, "旧项目"), { cwd: "/Users/demo/my/gone-proj", cwdExists: false }),
    bank("locked-proj", [], { readable: false, error: "目录无读取权限" }),
    ...bulkStores(bulkBanks),
  ];
}

const err = (code: string, message: string): { code: string; message: string } => ({ code, message });

export interface MemoryMockOptions {
  available: boolean;
  backend: string | null;
  inUseBank?: string | null;
  probeFailed?: boolean;
  bulkBanks?: number;
}

export function createMemoryMock(opts: MemoryMockOptions): (cmd: string, args: Record<string, unknown>) => unknown {
  const stores = buildStores(opts.bulkBanks ?? 0);
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
    if ((opts.inUseBank != null && opts.inUseBank === bank) || ((opts.bulkBanks ?? 0) > 0 && bank === BULK_IN_USE_BANK)) {
      throw err("IN_USE", "库正被 omp 会话使用：omp (pid 4242)");
    }
  }

  function overview(): MemoryOverview {
    const empty: MemoryOverview = {
      available: false,
      backend: opts.backend,
      root: "/Users/demo/.omp/agent/memory",
      banks: [],
      totals: { banks: 0, working: 0, episodic: 0, facts: 0, bytes: 0, neverRecalled: 0, unconsolidated: 0, missingSourceSessions: 0, sourceSessions: 0 },
    };
    if (!opts.available) return empty;
    // 与后端一致：lastMemoryAt 倒序（null 视为最小），再按 bank 名升序。
    const order = (b: MemoryBankSummary): number => (b.lastMemoryAt === null ? -Infinity : Date.parse(b.lastMemoryAt));
    const banks = [...byBank.values()].map(summarize).sort((a, b) => order(b) - order(a) || a.bank.localeCompare(b.bank));
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
    const sort = args["sort"] ?? "newest";
    if (sort !== "newest" && sort !== "oldest" && sort !== "mostRecalled") throw err("INVALID_INPUT", "sort 非法");
    const limit = Math.min(200, Math.max(1, Math.floor(Number(args["limit"] ?? 50))));
    const offset = Math.floor(Number(args["offset"] ?? 0));
    if (!Number.isFinite(limit) || !Number.isFinite(offset) || offset < 0) throw err("INVALID_INPUT", "分页参数非法");
    let rows = store.items;
    if (q !== "") rows = rows.filter((m) => `${m.id}\n${m.content}\n${m.embedText ?? ""}`.toLowerCase().includes(q));
    if (kind === "working" || kind === "episodic") rows = rows.filter((m) => m.kind === kind);
    if (args["onlyNeverRecalled"] === true) rows = rows.filter((m) => m.recallCount === 0);
    if (args["onlyUnconsolidated"] === true) rows = rows.filter((m) => !m.consolidated);
    if (args["onlyMissingSource"] === true) rows = rows.filter((m) => m.sourceSessionExists === false);
    const time = (t: string | null): number => (t === null ? -1 : Date.parse(t));
    rows = [...rows].sort((a, b) =>
      sort === "oldest"
        ? time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id)
        : sort === "mostRecalled"
          ? b.recallCount - a.recallCount || time(b.createdAt) - time(a.createdAt)
          : time(b.createdAt) - time(a.createdAt) || a.id.localeCompare(b.id),
    );
    const items = rows.map(({ content: _c, embedText: _e, metadata: _m, facts: _f, summaryOf: _s, relatedEdges: _r, ...rest }) => rest);
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

  const utcStamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

  /** 整库快照：before-delete / before-restore 只留最新 5 份，bank-removed 永不剪。 */
  function takeBackup(store: BankStore, kind: MemoryBackup["kind"]): MemoryBackup {
    backupSeq += 1;
    const at = Date.now() + backupSeq * 1000;
    const record: MemoryBackup = {
      id: `${store.bank}@${utcStamp(at)}-${kind}`,
      bank: store.bank,
      kind,
      createdAt: new Date(at).toISOString(),
      bytes: store.items.reduce((n, m) => n + m.contentChars, 0),
      working: store.items.filter((m) => m.kind === "working").length,
      episodic: store.items.filter((m) => m.kind === "episodic").length,
      cwd: store.cwd,
    };
    backups.push({ record, snapshot: structuredClone(store.items) });
    if (kind !== "bank-removed") {
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

  const bankBackups = (bank: string): MemoryBackup[] =>
    backups
      .filter((b) => b.record.bank === bank)
      .map((b) => b.record)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function bankStatus(bank: unknown): MemoryBankStatus {
    if (typeof bank !== "string" || bank === "") throw err("INVALID_INPUT", "bank 不能为空");
    if (opts.probeFailed === true) return { bank, inUse: false, probeFailed: true, holders: [], backups: bankBackups(bank) };
    const inUse =
      byBank.has(bank) &&
      ((opts.inUseBank != null && opts.inUseBank === bank) || ((opts.bulkBanks ?? 0) > 0 && bank === BULK_IN_USE_BANK));
    return { bank, inUse, probeFailed: false, holders: inUse ? [{ pid: 4242, command: "omp" }] : [], backups: bankBackups(bank) };
  }

  function deletePreview(args: Record<string, unknown>): MemoryDeletePreview {
    const store = requireStore(args["bank"]);
    const ids = uniqueIds(args["ids"]);
    const { deletable, skipped } = planDelete(store, ids);
    const selectedWorking = new Set(deletable.filter((m) => m.kind === "working").map((m) => m.id));
    return {
      requested: ids.length,
      deletable: { working: deletable.filter((m) => m.kind === "working").length, episodic: deletable.filter((m) => m.kind === "episodic").length },
      unsupported: skipped.filter((s) => s.reason === "unsupported").length,
      notFound: skipped.filter((s) => s.reason === "not_found").length,
      cascade: {
        facts: deletable.reduce((n, m) => n + m.facts.length, 0),
        embeddings: deletable.filter((m) => m.embedText !== null).length,
        annotations: 0,
        edges: deletable.reduce((n, m) => n + m.relatedEdges, 0),
        other: 0,
      },
      citedBySummaries: store.items.filter((m) => m.kind === "episodic" && m.summaryOf.some((id) => selectedWorking.has(id))).length,
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
    const badShape = bank === "" || bank === "." || bank === ".." || bank.includes("/") || bank.includes("\\") || bank.includes("\0");
    if (badShape || !/^\d{8}T\d{6}Z-(before-delete|before-restore|bank-removed)$/.test(dirname)) throw err("OUTSIDE_ROOT", "备份标识非法");
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
      gate(record.bank);
      const meta = removed.get(record.bank);
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
      case "memory_overview": return structuredClone(overview());
      case "memory_list": return structuredClone(list(args));
      case "memory_detail": return structuredClone(detail(args));
      case "memory_bank_status": return structuredClone(bankStatus(args["bank"]));
      case "memory_backups":
        return structuredClone(
          (args["bank"] == null ? backups.map((b) => b.record) : bankBackups(args["bank"] as string)).sort((a, b) =>
            a.createdAt < b.createdAt ? 1 : -1,
          ),
        );
      case "memory_delete_preview": return structuredClone(deletePreview(args));
      case "memory_delete_items": return structuredClone(deleteItems(args));
      case "memory_delete_bank": return structuredClone(deleteBank(args));
      case "memory_restore": return structuredClone(restore(args));
      case "memory_delete_backup": return structuredClone(deleteBackup(args));
      default:
        throw err("UNKNOWN", `未知命令：${cmd}`);
    }
  };
}
