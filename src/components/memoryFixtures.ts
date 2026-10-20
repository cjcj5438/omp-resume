/** 记忆库测试夹具：面板与维护测试共用，避免两套近似工厂。 */
import type { MemoryBackup, MemoryBankStatus, MemoryBankSummary, MemoryItem, MemoryOverview, MemoryPage, MemoryTotals } from "../types";

export const bankOf = (over: Partial<MemoryBankSummary> & Pick<MemoryBankSummary, "bank">): MemoryBankSummary => ({
  displayName: over.bank, cwd: `/Users/demo/my/${over.bank}`, cwdExists: true, working: 0, episodic: 0, facts: 0, bytes: 0,
  firstMemoryAt: null, lastMemoryAt: null, neverRecalled: 0, unconsolidated: 0, sourceSessions: 0, missingSourceSessions: 0,
  readable: true, error: null, ...over,
});

export const itemOf = (over: Partial<MemoryItem> & Pick<MemoryItem, "id">): MemoryItem => ({
  kind: "working", snippet: `片段 ${over.id}`, contentChars: 20, createdAt: "2026-10-18T10:00:00.000Z",
  sourceSessionId: null, sourceSessionExists: null, recallCount: 0, lastRecalledAt: null,
  importance: null, veracity: null, memoryType: null, consolidated: false, superseded: false, ...over,
});

export const pageOf = (items: MemoryItem[], total = items.length): MemoryPage => ({ total, items });

export const statusOf = (bank: string, over: Partial<MemoryBankStatus> = {}): MemoryBankStatus => ({
  bank, inUse: false, probeFailed: false, holders: [], backups: [], ...over,
});

export const backupOf = (over: Partial<MemoryBackup> & Pick<MemoryBackup, "id" | "bank">): MemoryBackup => ({
  kind: "before-delete", createdAt: "2026-10-19T10:00:00.000Z", bytes: 1024, working: 2, episodic: 1, cwd: "/Users/demo/my/alpha", ...over,
});

export const TOTALS: MemoryTotals = {
  banks: 5, working: 40, episodic: 60, facts: 7, bytes: 2048,
  neverRecalled: 51, unconsolidated: 30, missingSourceSessions: 2, sourceSessions: 10,
};

export const BANKS: MemoryBankSummary[] = [
  bankOf({ bank: "alpha", working: 30, episodic: 40, bytes: 1024, neverRecalled: 30, unconsolidated: 60 }),
  bankOf({ bank: "beta", working: 10, episodic: 20, bytes: 1024 }),
  bankOf({ bank: "empty", cwd: null }),
  bankOf({ bank: "gone", cwd: "/Users/demo/old", cwdExists: false, working: 3, bytes: 100 }),
  { ...bankOf({ bank: "locked" }), readable: false, error: "目录无读取权限" },
];

export const overviewOf = (over: Partial<MemoryOverview> = {}): MemoryOverview => ({
  available: true,
  backend: "mnemopi",
  root: "/Users/demo/.omp/agent/memory",
  banks: BANKS,
  totals: TOTALS,
  ...over,
});
