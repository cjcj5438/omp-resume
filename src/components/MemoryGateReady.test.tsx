/**
 * 门禁首帧回归：恢复 / 移除确认钮在“本库”占用状态返回前必须禁用，
 * 首帧点击不得发出破坏性调用；已移除库的恢复明确跳过门禁。
 * 真实 hook 的首帧（status null + loading false）只存在于 effect 跑之前的那一帧，
 * RTL 的 act 会把 effect 一起刷掉，所以这里把 useBankStatus mock 成可控状态来覆盖那一帧。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { MemoryBackup, MemoryBankStatus, MemoryBankSummary, MemoryRestoreResult } from "../types";
import type { BankStatusState } from "./useMemoryMaintenance";
import type * as MaintenanceModule from "./useMemoryMaintenance";
import { MemoryBackupsDialog } from "./MemoryBackupsDialog";
import { MemoryBankActions } from "./MemoryBankActions";

const gateCtl = vi.hoisted(() => ({
  /** 当前 mock 返回的门禁状态（每测按需改写 + rerender）。 */
  value: { status: null, loading: false, error: null } as BankStatusState,
  calls: [] as { bank: string; enabled: boolean; token: number }[],
}));

vi.mock("./useMemoryMaintenance", async (importOriginal) => {
  const orig = (await importOriginal()) as typeof MaintenanceModule;
  return {
    ...orig,
    useBankStatus: (bank: string, enabled: boolean, token = 0): BankStatusState => {
      gateCtl.calls.push({ bank, enabled, token });
      return gateCtl.value;
    },
  };
});

const FIRST_FRAME: BankStatusState = { status: null, loading: false, error: null };

function statusOf(bank: string, over: Partial<MemoryBankStatus> = {}): MemoryBankStatus {
  return { bank, inUse: false, probeFailed: false, holders: [], backups: [], ...over };
}

function bankSummary(
  over: Partial<MemoryBankSummary> & Pick<MemoryBankSummary, "bank" | "displayName">,
): MemoryBankSummary {
  return {
    cwd: `/Users/demo/my/${over.bank}`,
    cwdExists: true,
    working: 3,
    episodic: 1,
    facts: 0,
    bytes: 100,
    firstMemoryAt: null,
    lastMemoryAt: null,
    neverRecalled: 0,
    unconsolidated: 0,
    sourceSessions: 0,
    missingSourceSessions: 0,
    readable: true,
    error: null,
    ...over,
  };
}

function backupOf(over: Partial<MemoryBackup> & Pick<MemoryBackup, "id" | "bank">): MemoryBackup {
  return {
    kind: "before-delete",
    createdAt: "2026-10-19T10:00:00.000Z",
    bytes: 1024,
    working: 2,
    episodic: 1,
    cwd: "/Users/demo/my/alpha",
    ...over,
  };
}

function installGateStub(backups: MemoryBackup[]) {
  const calls: { restore: unknown[]; deleteBank: unknown[] } = { restore: [], deleteBank: [] };
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "memory_backups":
        return structuredClone(backups);
      case "memory_restore": {
        calls.restore.push(args);
        const found = backups.find((b) => b.id === args["backupId"]) ?? backups[0];
        const result: MemoryRestoreResult = { bank: found.bank, restoredFrom: found, safetyBackup: null };
        return result;
      }
      case "memory_delete_bank":
        calls.deleteBank.push(args);
        return backupOf({
          id: `${args["bank"]}@20250101T000000Z-bank-removed`,
          bank: args["bank"] as string,
          kind: "bank-removed",
        });
      default:
        return null;
    }
  });
  return calls;
}

beforeEach(() => {
  clearMocks();
  gateCtl.value = FIRST_FRAME;
  gateCtl.calls = [];
});

describe("恢复确认门禁首帧", () => {
  const live = backupOf({ id: "alpha@20250102T000000Z-before-delete", bank: "alpha" });
  const props = {
    initialBank: null as string | null,
    banks: [{ bank: "alpha", displayName: "alpha", cwd: "/Users/demo/my/alpha" }],
    liveBanks: new Set(["alpha"]) as ReadonlySet<string>,
    onClose: () => {},
    onToast: () => {},
    onChanged: () => {},
  };

  it("首帧禁用且点击不发 restore，状态到达后才可用", async () => {
    const calls = installGateStub([live]);
    const view = render(<MemoryBackupsDialog {...props} />);
    await screen.findByText("共 1 份");
    fireEvent.click(screen.getByRole("button", { name: "恢复…" }));
    await screen.findByText(/恢复前会自动为当前内容创建安全备份/);
    // 门禁 effect 尚未跑完的那一帧：按钮禁用，且（fireEvent 绕过 disabled 的）点击也不得发出调用。
    const confirm = screen.getByRole("button", { name: "恢复" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(calls.restore).toEqual([]);
    // 本库状态到达且空闲：放行。
    gateCtl.value = { status: statusOf("alpha"), loading: false, error: null };
    view.rerender(<MemoryBackupsDialog {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(calls.restore).toEqual([{ backupId: live.id }]));
  });

  it("之前目标的旧状态（别的库）不能放行本次恢复", async () => {
    const calls = installGateStub([live]);
    // 状态属于 beta、空闲：对 alpha 的恢复来说是过期残留。
    gateCtl.value = { status: statusOf("beta"), loading: false, error: null };
    const view = render(<MemoryBackupsDialog {...props} />);
    await screen.findByText("共 1 份");
    fireEvent.click(screen.getByRole("button", { name: "恢复…" }));
    await screen.findByText(/恢复前会自动为当前内容创建安全备份/);
    expect(screen.getByRole("button", { name: "恢复" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(calls.restore).toEqual([]);
    // 旧库的“使用中”也不得显示到本次目标页上。
    gateCtl.value = {
      status: statusOf("beta", { inUse: true, holders: [{ pid: 7, command: "omp" }] }),
      loading: false,
      error: null,
    };
    view.rerender(<MemoryBackupsDialog {...props} />);
    expect(screen.queryByText(/该库正被使用/)).toBeNull();
    expect(screen.getByRole("button", { name: "恢复" })).toBeDisabled();
  });

  it("已移除库的恢复明确跳过门禁：首帧即便无状态也可用", async () => {
    const vanished = backupOf({
      id: "vanished@20250101T000000Z-bank-removed",
      bank: "vanished",
      kind: "bank-removed",
      cwd: "/tmp/v",
    });
    const calls = installGateStub([vanished]);
    render(<MemoryBackupsDialog {...props} />);
    await screen.findByText("共 1 份");
    fireEvent.click(screen.getByRole("button", { name: "恢复…" }));
    await screen.findByText(/该库当前已被移除/);
    // 豁免是显式的：门禁 hook 以 enabled=false 调用，而非“恰好没状态”。
    expect(gateCtl.calls.length).toBeGreaterThan(0);
    expect(gateCtl.calls[gateCtl.calls.length - 1]).toMatchObject({ bank: "vanished", enabled: false });
    const confirm = screen.getByRole("button", { name: "恢复" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.restore).toEqual([{ backupId: vanished.id }]));
  });
});

describe("移除库确认门禁首帧", () => {
  const summary = bankSummary({ bank: "alpha", displayName: "alpha" });

  it("首帧禁用且点击不发 delete_bank，状态到达后才可用", async () => {
    const calls = installGateStub([]);
    const props = {
      bank: summary,
      active: false,
      onToast: () => {},
      refresh: () => {},
      onOpenBackups: () => {},
    };
    const view = render(<MemoryBankActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "移除此库…" }));
    const dialog = await screen.findByRole("dialog", { name: "移除项目库（alpha）" });
    const confirm = within(dialog).getByRole("button", { name: "移除此库" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(calls.deleteBank).toEqual([]);
    gateCtl.value = { status: statusOf("alpha"), loading: false, error: null };
    view.rerender(<MemoryBankActions {...props} />);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "移除此库" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "移除此库" }));
    await waitFor(() => expect(calls.deleteBank).toEqual([{ bank: "alpha" }]));
  });
});
