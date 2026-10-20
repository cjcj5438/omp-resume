/**
 * 备份与恢复：备份列表（newest first）+ 恢复确认 + 永久删除备份确认。
 * 恢复会先为现存库自动创建恢复前安全备份；永久删除备份不可撤销，需二次确认。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryBackups, memoryDeleteBackup, memoryRestore, normalizeError } from "../api";
import type { MemoryBackup } from "../types";
import { displayCwd, errorText, formatFullTime, formatRelativeTime, formatSize } from "../format";
import { Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";
import { BACKUP_KIND_LABEL, formatHolders, memoryWriteErrorText, useBankStatus } from "./useMemoryMaintenance";
import "./MemoryPanel.css";

type BackupView =
  | { kind: "list" }
  | { kind: "restore"; backup: MemoryBackup }
  | { kind: "deleteBackup"; backup: MemoryBackup };

export function MemoryBackupsDialog(props: {
  /** 打开时预选的库（null = 全部）；选择器可改。 */
  initialBank: string | null;
  /** 总览中的现存库（用于显示项目名；移除的库按 id + 备份 cwd 显示）。 */
  banks: { bank: string; displayName: string; cwd: string | null }[];
  liveBanks: ReadonlySet<string>;
  onClose: () => void;
  onToast: ToastFn;
  /** 恢复成功后刷新总览/列表/趋势。 */
  onChanged: () => void;
}): ReactNode {
  const { initialBank, banks, liveBanks, onClose, onToast, onChanged } = props;
  const [filter, setFilter] = useState<string | null>(initialBank);
  const [rows, setRows] = useState<MemoryBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [view, setView] = useState<BackupView>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gateToken, setGateToken] = useState(0);

  const restoreTarget = view.kind === "restore" ? view.backup : null;
  // 已移除的库（不在总览中）恢复时明确跳过占用门禁：目标目录已不存在，无需确认占用（CONTRACT §18.9）。
  const gateSkipped = restoreTarget !== null && !liveBanks.has(restoreTarget.bank);
  const gateEnabled = restoreTarget !== null && !gateSkipped;
  const gate = useBankStatus(restoreTarget?.bank ?? "", gateEnabled, gateToken);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    memoryBackups({ bank: filter })
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorText(normalizeError(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, reloadToken]);

  function displayNameOf(bank: string, cwd: string | null): ReactNode {
    const known = banks.find((b) => b.bank === bank);
    if (known) return known.displayName;
    const dir = cwd ?? null;
    return (
      <>
        <span className="mono">{bank}</span>
        {dir !== null ? <span className="usage-row-name muted">{displayCwd(dir)}</span> : null}
      </>
    );
  }

  function openView(next: BackupView): void {
    setActionError(null);
    setView(next);
  }

  const busyRef = useRef(false);

  async function confirmRestore(backup: MemoryBackup): Promise<void> {
    if (busy || busyRef.current) return;
    if (liveBanks.has(backup.bank)) {
      if (gate.loading || gate.error !== null) return;
      if (gate.status === null || gate.status.bank !== backup.bank) return;
      if (gate.status.inUse || gate.status.probeFailed) return;
    }
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const result = await memoryRestore({ backupId: backup.id });
      const name = banks.find((b) => b.bank === result.bank)?.displayName ?? result.bank;
      onToast(
        result.safetyBackup !== null
          ? `已恢复 ${name}；已为当前内容保留安全备份`
          : `已恢复 ${name}`,
        "info",
      );
      setView({ kind: "list" });
      setReloadToken((t) => t + 1);
      onChanged();
    } catch (e: unknown) {
      setActionError(memoryWriteErrorText(normalizeError(e), "restore"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmDeleteBackup(backup: MemoryBackup): Promise<void> {
    if (busy || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await memoryDeleteBackup({ backupId: backup.id });
      onToast("已永久删除备份", "info");
      setView({ kind: "list" });
      setReloadToken((t) => t + 1);
    } catch (e: unknown) {
      setActionError(memoryWriteErrorText(normalizeError(e), "backup-delete"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // 只有“本次恢复目标”的状态结果才算数：首帧（status null + loading false）与之前目标的残留都不能放行。
  const statusForTarget =
    restoreTarget !== null && gate.status !== null && gate.status.bank === restoreTarget.bank ? gate.status : null;
  const gateBlocked = statusForTarget !== null && (statusForTarget.inUse || statusForTarget.probeFailed);
  const restoreReady =
    restoreTarget !== null &&
    !busy &&
    (gateSkipped || (!gate.loading && gate.error === null && statusForTarget !== null && !gateBlocked));
  const title =
    view.kind === "restore" ? "从备份恢复" : view.kind === "deleteBackup" ? "永久删除备份" : "备份与恢复";

  return (
    <Modal
      title={title}
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        view.kind === "list" ? (
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        ) : (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => openView({ kind: "list" })}>
              返回
            </button>
            {view.kind === "restore" ? (
              <button
                type="button"
                className="btn btn-accent"
                disabled={!restoreReady}
                onClick={() => void confirmRestore(view.backup)}
              >
                {busy ? "恢复中…" : "恢复"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void confirmDeleteBackup(view.backup)}
              >
                {busy ? "删除中…" : "永久删除"}
              </button>
            )}
          </>
        )
      }
    >
      {view.kind === "list" ? (
        <>
          <div className="mem-backups-toolbar">
            <label className="mem-kind">
              项目库
              <select
                aria-label="备份项目库范围"
                value={filter ?? ""}
                onChange={(e) => setFilter(e.target.value === "" ? null : e.target.value)}
              >
                <option value="">全部</option>
                {banks.map((b) => (
                  <option key={b.bank} value={b.bank}>
                    {b.displayName}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">{loading ? "加载中…" : `共 ${rows.length} 份`}</span>
          </div>
          {loadError !== null ? (
            <p>
              加载失败：{loadError}{" "}
              <button type="button" className="btn btn-small" onClick={() => setReloadToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {!loading && loadError === null && rows.length === 0 ? (
            <div className="pane-note">还没有备份。删除记忆或移除库时会自动创建。</div>
          ) : null}
          {rows.length > 0 ? (
            <div className="mem-backups-wrap">
            <table className="usage-table mem-backups">
              <thead>
                <tr>
                  <th scope="col">项目</th>
                  <th scope="col">类型</th>
                  <th scope="col">创建时间</th>
                  <th scope="col">大小</th>
                  <th scope="col">数量</th>
                  <th scope="col">
                    <span className="mem-sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <th scope="row">{displayNameOf(b.bank, b.cwd)}</th>
                    <td>
                      <span className={b.kind === "bank-removed" ? "badge badge-label" : "badge badge-grey"}>
                        {BACKUP_KIND_LABEL[b.kind]}
                      </span>
                    </td>
                    <td title={formatFullTime(b.createdAt)}>{formatRelativeTime(b.createdAt)}</td>
                    <td>{formatSize(b.bytes)}</td>
                    <td className="muted">
                      {b.working === null || b.episodic === null ? "—" : `工作 ${b.working} · 情节 ${b.episodic}`}
                    </td>
                    <td className="mem-backup-actions">
                      <button type="button" className="btn btn-small" onClick={() => openView({ kind: "restore", backup: b })}>
                        恢复…
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => openView({ kind: "deleteBackup", backup: b })}
                      >
                        永久删除备份…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : null}
          <p className="muted mem-footnote">每个库自动保留最近 5 份删除前/恢复前备份；移除的库备份不会被自动清理。</p>
        </>
      ) : view.kind === "restore" ? (
        <>
          <p>
            备份：{displayNameOf(view.backup.bank, view.backup.cwd)} · {BACKUP_KIND_LABEL[view.backup.kind]} ·{" "}
            {formatFullTime(view.backup.createdAt)} · {formatSize(view.backup.bytes)}
          </p>
          {liveBanks.has(view.backup.bank) ? (
            <p>
              恢复将用该快照替换当前内容；恢复前会自动为当前内容创建安全备份，恢复本身也可撤销。
            </p>
          ) : (
            <p>该库当前已被移除，恢复将把它恢复回来。</p>
          )}
          {gate.loading ? <p className="muted">正在确认占用状态…</p> : null}
          {gate.error !== null ? (
            <p>
              占用状态加载失败：{gate.error}{" "}
              <button type="button" className="btn btn-small" onClick={() => setGateToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {statusForTarget?.inUse === true ? (
            <p className="mem-note-danger">
              该库正被使用：{formatHolders(statusForTarget.holders)}。先退出占用该库的 omp 会话后再试。
              <button type="button" className="btn btn-small" onClick={() => setGateToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {statusForTarget?.probeFailed === true ? (
            <p className="mem-note-danger">
              无法确认是否有 omp 会话在使用该库（占用探测失败），请稍后重试。
              <button type="button" className="btn btn-small" onClick={() => setGateToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {actionError !== null ? <p className="mem-note-danger">{actionError}</p> : null}
        </>
      ) : (
        <>
          <p>
            将永久删除{displayNameOf(view.backup.bank, view.backup.cwd)}的这份
            {BACKUP_KIND_LABEL[view.backup.kind]}备份（{formatFullTime(view.backup.createdAt)}），无法撤销。
          </p>
          {actionError !== null ? <p className="mem-note-danger">{actionError}</p> : null}
        </>
      )}
    </Modal>
  );
}
