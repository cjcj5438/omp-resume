/**
 * 项目库：单列排名条形图（工作 + 情节堆叠，下方细条为未召回 / 未合并占比）。
 * 点行选中库；无效库（目录已不存在 / 空库 / 不可读）标徽章并可批量清理。
 * 行内不放操作按钮；备份 / 移除在选中库的操作条里（MemoryBankHeader）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryBankStatus, memoryDeleteBank, normalizeError } from "../api";
import type { MemoryBankStatus, MemoryBankSummary } from "../types";
import { displayCwd, errorText, formatFullTime, formatRelativeTime, formatSize } from "../format";
import { Ico, Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";
import {
  BANK_INVALID_LABEL,
  MemoryGateNote,
  bankInvalidKinds,
  bankMemories,
  memoryWriteErrorText,
  useBankStatus,
} from "./useMemoryMaintenance";
import "./MemoryPanel.css";
import { Check, X } from "lucide-react";

/** 记忆多者在前，其次最近记忆，再次库名。 */
function ranked(banks: MemoryBankSummary[]): MemoryBankSummary[] {
  const at = (b: MemoryBankSummary): number => (b.lastMemoryAt === null ? -Infinity : Date.parse(b.lastMemoryAt));
  return [...banks].sort((a, b) => bankMemories(b) - bankMemories(a) || at(b) - at(a) || a.bank.localeCompare(b.bank));
}

const BankBadges = ({ b }: { b: MemoryBankSummary }): ReactNode => (
  <>
    {bankInvalidKinds(b).map((k) => (
      <span key={k} className={k === "unreadable" ? "badge badge-grey" : "badge badge-danger"}>
        {BANK_INVALID_LABEL[k]}
      </span>
    ))}
  </>
);

export function MemoryBanks(props: {
  banks: MemoryBankSummary[];
  selected: MemoryBankSummary | null;
  onSelect: (bank: string) => void;
  onOpenBackups: (bank: string | null) => void;
  onToast: ToastFn;
  onChanged: () => void;
}): ReactNode {
  const { banks, selected, onSelect, onOpenBackups, onToast, onChanged } = props;
  const [query, setQuery] = useState("");
  const [onlyInvalid, setOnlyInvalid] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const invalid = banks.filter((b) => bankInvalidKinds(b).length > 0);
  const q = query.trim().toLowerCase();
  const rows = ranked(
    banks.filter(
      (b) =>
        (q === "" || `${b.displayName} ${b.bank} ${b.cwd ?? ""}`.toLowerCase().includes(q)) &&
        (!onlyInvalid || bankInvalidKinds(b).length > 0),
    ),
  );
  const max = Math.max(1, ...rows.map(bankMemories));

  return (
    <section className="mem-section" aria-label="项目库">
      <div className="mem-section-head">
        <h3>项目库（{rows.length}）</h3>
        <input type="search" className="filter-input" placeholder="过滤项目名 / 路径" aria-label="过滤项目库" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn btn-small" aria-pressed={onlyInvalid} disabled={invalid.length === 0} onClick={() => setOnlyInvalid((v) => !v)}>
          只看无效库（{invalid.length}）
        </button>
        <button type="button" className="btn btn-small" disabled={invalid.length === 0} onClick={() => setCleanupOpen(true)}>
          清理无效库…
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="pane-note">{banks.length === 0 ? "暂无项目库。" : "没有匹配的项目库。"}</div>
      ) : (
        <ul className="mem-bank-chart" aria-label="项目库记忆分布">
          {rows.map((b) => {
            const total = bankMemories(b);
            const kinds = bankInvalidKinds(b);
            const pct = (a: number, d: number): string => (d > 0 ? `${((a / d) * 100).toFixed(1)}%` : "—");
            const tip = b.readable
              ? `${b.displayName}\n${b.cwd ?? "—"}\n工作 ${b.working} · 情节 ${b.episodic}\n未召回 ${b.neverRecalled}/${total} (${pct(b.neverRecalled, total)})\n未合并 ${b.unconsolidated}/${b.working} (${pct(b.unconsolidated, b.working)})\n${formatSize(b.bytes)} · ${b.lastMemoryAt === null ? "无记忆" : formatRelativeTime(b.lastMemoryAt)}`
              : `${b.displayName}\n${b.cwd ?? "—"}\n${b.error ?? "项目库不可读"}`;
            return (
              <li key={b.bank}>
                <button
                  type="button"
                  className={`mem-bank-row${kinds.length > 0 ? " mem-bank-invalid" : ""}${b.bank === selected?.bank ? " mem-bank-active" : ""}`}
                  aria-pressed={b.bank === selected?.bank}
                  aria-label={b.displayName}
                  data-tip={tip}
                  onClick={() => onSelect(b.bank)}
                >
                  <span className="mem-bank-main">
                    <span className="mem-bank-title">
                      <span className="mem-bank-name">{b.displayName}</span>
                      <BankBadges b={b} />
                    </span>
                    <span className="mem-bank-sub">
                      <span className="mono">{b.cwd === null ? "—" : displayCwd(b.cwd)}</span>
                      <span>{b.readable ? `${b.working} 工作 · ${b.episodic} 情节` : "—"}</span>
                      <span>{formatSize(b.bytes)}</span>
                      <span>{b.lastMemoryAt === null ? "无记忆" : formatRelativeTime(b.lastMemoryAt)}</span>
                    </span>
                  </span>
                  <span className="mem-bank-bars" aria-hidden="true">
                    <span className="mem-bank-bar">
                      {total > 0 ? (
                        <span className="mem-bank-fill" style={{ width: `${(total / max) * 100}%` }}>
                          {b.working > 0 ? <i className="mem-bar-work" style={{ flexGrow: b.working }} /> : null}
                          {b.episodic > 0 ? <i className="mem-bar-epi" style={{ flexGrow: b.episodic }} /> : null}
                        </span>
                      ) : null}
                    </span>
                    {b.readable ? (
                      <span className="mem-bank-health">
                        <span className="mem-meter"><i className="mem-meter-never" style={{ width: `${(b.neverRecalled / Math.max(1, total)) * 100}%` }} /></span>
                        <span className="mem-meter"><i className="mem-meter-uncons" style={{ width: `${(b.unconsolidated / Math.max(1, b.working)) * 100}%` }} /></span>
                      </span>
                    ) : null}
                  </span>
                  <span className="mem-bank-num" aria-hidden="true">{total}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted mem-footnote">条 = 工作 + 情节；细条为未召回（占总条数）与未合并（占工作记忆）比例。点一行查看该库记忆。</p>
      {cleanupOpen ? (
        <CleanupDialog banks={invalid} onClose={() => setCleanupOpen(false)} onToast={onToast} onChanged={onChanged} onOpenBackups={onOpenBackups} />
      ) : null}
    </section>
  );
}

/** 选中库的操作条：名称 / 路径 / 规模 + 备份入口 + 移除（含占用门禁）。 */
export function MemoryBankHeader(props: {
  bank: MemoryBankSummary;
  onOpenBackups: (bank: string) => void;
  onToast: ToastFn;
  onChanged: () => void;
}): ReactNode {
  const { bank, onOpenBackups, onToast, onChanged } = props;
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const gate = useBankStatus(bank.bank, true, retryToken);
  const status = gate.status !== null && gate.status.bank === bank.bank ? gate.status : null;
  const ready = removing && !busy && !gate.loading && gate.error === null && status !== null && !status.inUse && !status.probeFailed;
  const busyRef = useRef(false);

  async function confirm(): Promise<void> {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await memoryDeleteBank({ bank: bank.bank });
      onToast(`已移除 ${bank.displayName}，可在「备份与恢复」中还原`, "info");
      setRemoving(false);
      onChanged();
    } catch (e: unknown) {
      setError(memoryWriteErrorText(normalizeError(e), "remove"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mem-bank-header" aria-label={`当前项目库 ${bank.displayName}`}>
      <div className="mem-bank-header-main">
        <div className="mem-bank-header-title">
          <strong>{bank.displayName}</strong>
          <BankBadges b={bank} />
          {status?.inUse === true ? <span className="badge badge-accent">使用中</span> : null}
          <span className="muted mono">{bank.cwd === null ? "—" : displayCwd(bank.cwd)}</span>
        </div>
        <div className="mem-bank-header-stats muted">
          <span>工作 {bank.working} · 情节 {bank.episodic} · 事实 {bank.facts}</span>
          <span>{formatSize(bank.bytes)}</span>
          <span title={bank.lastMemoryAt === null ? undefined : formatFullTime(bank.lastMemoryAt)}>
            最近记忆 {bank.lastMemoryAt === null ? "—" : formatRelativeTime(bank.lastMemoryAt)}
          </span>
          <span>未召回 {bank.neverRecalled} · 未合并 {bank.unconsolidated}</span>
        </div>
      </div>
      <div className="mem-bank-header-actions">
        <button type="button" className="btn btn-small" onClick={() => onOpenBackups(bank.bank)}>备份与恢复</button>
        {bank.readable ? (
          <button type="button" className="btn btn-small" onClick={() => setRemoving(true)}>移除此库…</button>
        ) : null}
      </div>
      {removing ? (
        <Modal
          title={`移除项目库（${bank.displayName}）`}
          onClose={() => !busy && setRemoving(false)}
          footer={
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setRemoving(false)}>取消</button>
              <button type="button" className="btn btn-danger" disabled={!ready} onClick={() => void confirm()}>
                {busy ? "移除中…" : "移除此库"}
              </button>
            </>
          }
        >
          <p>
            将移除「{bank.displayName}」的全部记忆（工作 {bank.working} · 情节 {bank.episodic}，共 {formatSize(bank.bytes)}）；omp 将不再看到这个库。
          </p>
          <p className="muted">会先备份并移到备份区，可在「备份与恢复」还原。</p>
          {gate.loading ? <p className="muted">正在确认占用状态…</p> : null}
          <MemoryGateNote status={status} loadError={gate.error} onRetry={() => setRetryToken((t) => t + 1)} />
          {error !== null ? <p className="mem-note-danger">{error}</p> : null}
        </Modal>
      ) : null}
    </div>
  );
}

/** 无效库批量清理：先探占用，勾选的库逐个移除（失败继续），结束时汇总。 */
function CleanupDialog(props: {
  banks: MemoryBankSummary[];
  onClose: () => void;
  onToast: ToastFn;
  onChanged: () => void;
  onOpenBackups: (bank: string | null) => void;
}): ReactNode {
  const { onClose, onToast, onChanged, onOpenBackups } = props;
  // 打开时的快照：移除过程中总览会变化，避免列表跳动。
  const [targets] = useState(props.banks);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set(targets.map((b) => b.bank)));
  const [statuses, setStatuses] = useState<ReadonlyMap<string, MemoryBankStatus> | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const [results, setResults] = useState<{ bank: string; name: string; ok: boolean; text: string }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(targets.map(async (b) => [b.bank, await memoryBankStatus({ bank: b.bank })] as const))
      .then((pairs) => !cancelled && setStatuses(new Map(pairs)))
      .catch((e: unknown) => !cancelled && setProbeError(errorText(normalizeError(e))));
    return () => {
      cancelled = true;
    };
  }, [targets]);

  /** 不可移除的原因（null = 可勾选）。 */
  function blockedReason(b: MemoryBankSummary): string | null {
    if (!b.readable) return "不可读，无法移除";
    if (statuses === null) return null;
    const s = statuses.get(b.bank);
    if (s === undefined) return "占用状态未知";
    if (s.inUse) return "使用中，先退出占用它的 omp 会话";
    if (s.probeFailed) return "占用探测失败，请稍后重试";
    return null;
  }

  const selected = targets.filter((b) => checked.has(b.bank) && blockedReason(b) === null);
  const ready = !running && statuses !== null && probeError === null && selected.length > 0;
  const totalMemories = selected.reduce((n, b) => n + bankMemories(b), 0);
  const totalBytes = selected.reduce((n, b) => n + b.bytes, 0);
  const busyRef = useRef(false);

  async function run(): Promise<void> {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setRunning(true);
    const out: { bank: string; name: string; ok: boolean; text: string }[] = [];
    for (const [i, b] of selected.entries()) {
      setProgress({ done: i, total: selected.length, name: b.displayName });
      try {
        await memoryDeleteBank({ bank: b.bank });
        out.push({ bank: b.bank, name: b.displayName, ok: true, text: "已移除（已备份）" });
      } catch (e: unknown) {
        out.push({ bank: b.bank, name: b.displayName, ok: false, text: memoryWriteErrorText(normalizeError(e), "remove") });
      }
      setResults([...out]);
    }
    setProgress(null);
    busyRef.current = false;
    setRunning(false);
    const failed = out.filter((r) => !r.ok).length;
    onToast(failed === 0 ? `已移除 ${out.length} 个无效库，均已备份` : `已移除 ${out.length - failed} 个无效库，${failed} 个失败`, failed === 0 ? "info" : "error");
    onChanged();
  }

  return (
    <Modal
      title="清理无效库"
      wide
      onClose={() => !running && onClose()}
      footer={
        results !== null ? (
          <>
            <button type="button" className="btn" onClick={() => onOpenBackups(null)}>备份与恢复</button>
            <button type="button" className="btn btn-accent" onClick={onClose}>完成</button>
          </>
        ) : (
          <>
            <button type="button" className="btn" disabled={running} onClick={onClose}>取消</button>
            <button type="button" className="btn btn-danger" disabled={!ready} onClick={() => void run()}>
              {progress !== null ? `移除中… ${progress.done}/${progress.total}` : `备份并移除 ${selected.length} 个库`}
            </button>
          </>
        )
      }
    >
      <p className="muted">无效库 = 目录已不存在、空库或不可读。会先备份并移到备份区，可在「备份与恢复」还原。</p>
      {probeError !== null ? <p className="mem-note-danger">占用状态加载失败：{probeError}。请关闭后重试。</p> : null}
      {statuses === null && probeError === null ? <p className="muted">正在确认占用状态…</p> : null}
      <ul className="mem-cleanup-list">
        {targets.map((b) => {
          const reason = blockedReason(b);
          return (
            <li key={b.bank} className={reason !== null ? "mem-cleanup-blocked" : undefined}>
              <label>
                <input
                  type="checkbox"
                  className="mem-check"
                  checked={checked.has(b.bank) && reason === null}
                  disabled={running || reason !== null}
                  onChange={(e) =>
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(b.bank);
                      else next.delete(b.bank);
                      return next;
                    })
                  }
                />
                <span className="mem-cleanup-name">
                  <span><strong>{b.displayName}</strong> <BankBadges b={b} /></span>
                  <span className="muted mono">{b.cwd ?? "—"}</span>
                </span>
                <span className="mem-cleanup-stat muted">{b.readable ? `${bankMemories(b)} 条 · ${formatSize(b.bytes)}` : "—"}</span>
              </label>
              {reason !== null ? <span className="mem-cleanup-reason">{reason}</span> : null}
              {progress?.name === b.displayName ? <span className="mem-cleanup-reason">正在移除…</span> : null}
            </li>
          );
        })}
      </ul>
      <p className="muted">
        将移除 {selected.length} 个库、共 {totalMemories} 条记忆（{formatSize(totalBytes)}）。逐个执行，某个失败会继续。
      </p>
      {results !== null ? (
        <ul className="mem-cleanup-results" aria-label="清理结果">
          {results.map((r) => (
            <li key={r.bank} className={r.ok ? undefined : "mem-step-fail"}>
              {r.ok ? <Ico icon={Check} size={12} /> : <Ico icon={X} size={12} />} {r.name}：{r.text}
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}
