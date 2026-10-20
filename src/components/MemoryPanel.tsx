/**
 * 记忆库面板：管理视图「记忆库」标签页（查看 + 维护）。
 * 自上而下：状态头条 → 健康卡 → 新增趋势 → 项目库表 → 选中库的记忆列表。
 * 维护 UI 默认实现经插槽接入（行级默认留空；详情级单条删除；库级备份/移除）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryGrowth, memoryOverview, normalizeError } from "../api";
import type { MemoryBankSummary, MemoryDetail, MemoryGrowthPoint, MemoryItem, MemoryOverview } from "../types";
import { displayCwd, errorText, formatFullTime, formatRelativeTime, formatSize } from "../format";
import { MemoryBackupsDialog } from "./MemoryBackupsDialog";
import { MemoryBankActions } from "./MemoryBankActions";
import { MemoryItemDeleteButton } from "./MemoryDeleteDialog";
import { MemoryGrowthChart } from "./MemoryGrowthChart";
import { MemoryList } from "./MemoryList";
import type { ToastFn } from "./useOmpOp";
import "./Usage.css";
import "./MemoryPanel.css";

type GrowthDays = 30 | 90 | 365;

const GROWTH_RANGES: { days: GrowthDays; label: string }[] = [
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
  { days: 365, label: "全部" },
];

const MISSING_SOURCE_HELP = "近似值：按来源会话 id 去重统计（只看 sessions 目录的文件名，不读内容）；会话删了，记忆本身还在。";

function pctText(part: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

function bankMemories(b: MemoryBankSummary): number {
  return b.working + b.episodic;
}

export function MemoryPanel(props: {
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  onToast: ToastFn;
  renderMemoryActions?: (item: MemoryItem, refresh: () => void) => ReactNode;
  renderDetailActions?: (detail: MemoryDetail, refresh: () => void) => ReactNode;
  renderBankActions?: (bank: MemoryBankSummary, refresh: () => void) => ReactNode;
}): ReactNode {
  const { loadedSessionIds, onOpenSession, onToast, renderMemoryActions, renderDetailActions, renderBankActions } = props;
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [bankFilter, setBankFilter] = useState("");
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [growthDays, setGrowthDays] = useState<GrowthDays>(30);
  const [growthScope, setGrowthScope] = useState<string | null>(null);
  const [growth, setGrowth] = useState<MemoryGrowthPoint[]>([]);
  const [growthLoading, setGrowthLoading] = useState(false);
  const [growthError, setGrowthError] = useState<string | null>(null);
  /** 备份面板：null = 关闭，否则为打开时预选的库（null = 全部）。 */
  const [backupsOpen, setBackupsOpen] = useState<{ bank: string | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const refresh = (): void => setRefreshToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    memoryOverview()
      .then((o) => {
        if (cancelled) return;
        setOverview(o);
        setSelectedBank((prev) => {
          if (prev !== null && o.banks.some((b) => b.bank === prev)) return prev;
          const withData = o.banks.filter((b) => b.readable && bankMemories(b) > 0);
          return withData.length === 1 ? withData[0].bank : null;
        });
        setGrowthScope((prev) => (prev !== null && o.banks.some((b) => b.bank === prev) ? prev : null));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const text = errorText(normalizeError(e));
        setLoadError(text);
        onToast(`加载记忆库失败：${text}`, "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, onToast]);

  useEffect(() => {
    if (overview === null || !overview.available) return;
    let cancelled = false;
    setGrowthLoading(true);
    setGrowthError(null);
    memoryGrowth({ bank: growthScope, days: growthDays })
      .then((points) => {
        if (!cancelled) setGrowth(points);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const text = errorText(normalizeError(e));
        setGrowthError(text);
        onToast(`加载增长趋势失败：${text}`, "error");
      })
      .finally(() => {
        if (!cancelled) setGrowthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview, growthScope, growthDays, onToast]);

  if (loading && overview === null) {
    return <div className="pane-note">记忆库加载中…</div>;
  }
  if (loadError !== null && overview === null) {
    return (
      <div>
        <div className="pane-note">加载失败：{loadError}</div>
        <button type="button" className="btn" onClick={() => setRefreshToken((t) => t + 1)}>
          重试
        </button>
      </div>
    );
  }
  if (overview === null) return null;

  if (!overview.available) {
    return (
      <div className="mem-empty">
        <h3>未找到本地记忆库</h3>
        <p>
          omp 还没有在本机保存长期记忆，或者记忆保存在其他地方，本页只展示本地 Mnemopi 记忆库。
          {overview.backend !== null && overview.backend !== "mnemopi"
            ? `当前后端为 ${overview.backend}，记忆可能存放在别处。`
            : "继续使用 omp 对话，记忆会自动积累。"}
        </p>
        <p className="muted mono">{overview.root}</p>
        <button type="button" className="btn" onClick={() => setRefreshToken((t) => t + 1)}>
          刷新
        </button>
      </div>
    );
  }

  const { totals } = overview;
  const totalMemories = totals.working + totals.episodic;
  const neverRatio = totals.working + totals.episodic > 0 ? totals.neverRecalled / totalMemories : 0;
  // 未合并只统计 working 表（§18.1），占比分母用工作记忆数。
  const unconsRatio = totals.working > 0 ? totals.unconsolidated / totals.working : 0;
  const q = bankFilter.trim().toLowerCase();
  const banks =
    q === ""
      ? overview.banks
      : overview.banks.filter((b) =>
          `${b.displayName} ${b.bank} ${b.cwd ?? ""}`.toLowerCase().includes(q),
        );
  const selected = overview.banks.find((b) => b.bank === selectedBank) ?? null;
  // 用户点选项目库时，趋势图跟随该库，并滚到记忆列表。
  function selectBank(bank: string): void {
    setSelectedBank(bank);
    setGrowthScope(bank);
    requestAnimationFrame(() => listRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
  }
  const growthBanks = overview.banks.filter((b) => b.readable);
  const growthTotal = growth.reduce((n, p) => n + p.working + p.episodic, 0);
  // 维护 UI 默认实现（调用方可经插槽覆盖；行级默认留空以保持行紧凑）。
  const bankActions =
    renderBankActions ??
    ((b: MemoryBankSummary, refreshFn: () => void) => (
      <MemoryBankActions
        bank={b}
        active={b.bank === selectedBank}
        onToast={onToast}
        refresh={refreshFn}
        onOpenBackups={(target) => setBackupsOpen({ bank: target })}
      />
    ));
  const detailActions =
    renderDetailActions ??
    ((detail: MemoryDetail, refreshFn: () => void) =>
      selected === null ? null : (
        <MemoryItemDeleteButton
          bank={selected.bank}
          displayName={selected.displayName}
          ids={[detail.id]}
          onToast={onToast}
          onDone={refreshFn}
        />
      ));

  return (
    <div className="mem-panel">
      <div className="mem-head">
        <span>
          记忆后端：{overview.backend ?? "未知"} · {totals.banks} 个项目库 · 共 {totalMemories} 条记忆 · 占用磁盘{" "}
          {formatSize(totals.bytes)}
        </span>
        <span className="mem-head-actions">
          <button type="button" className="btn btn-small" onClick={() => setBackupsOpen({ bank: null })}>
            备份与恢复
          </button>
          <button type="button" className="btn btn-small" onClick={() => setRefreshToken((t) => t + 1)}>
            刷新
          </button>
        </span>
      </div>
      <p className="muted mem-intro">omp 自动从对话中提取并长期保存的记忆；删除类操作前会自动备份。</p>
      {loadError !== null ? <div className="pane-note">刷新失败：{loadError}</div> : null}
      {overview.backend !== null && overview.backend !== "mnemopi" ? (
        <p className="muted">当前后端为 {overview.backend}；本页只展示本地 Mnemopi 库，其他后端的记忆不在这里。</p>
      ) : null}

      <div className="mem-cards" aria-label="记忆库健康状况">
        <div className="mem-card">
          <span className="mem-card-label">记忆总数</span>
          <span className="mem-card-value">{totalMemories}</span>
          <span className="mem-card-sub">
            工作 {totals.working} · 情节 {totals.episodic}
          </span>
          <span className="mem-card-hint">长期保存的全部记忆</span>
        </div>
        <div className={neverRatio > 0.5 ? "mem-card mem-card-warn" : "mem-card"}>
          <span className="mem-card-label">从未被召回</span>
          <span className="mem-card-value">{totals.neverRecalled}</span>
          <span className="mem-card-sub">占 {pctText(totals.neverRecalled, totalMemories)}</span>
          <span className="mem-card-hint">从未被 omp 再次用过</span>
        </div>
        <div className={unconsRatio > 0.5 ? "mem-card mem-card-warn" : "mem-card"}>
          <span className="mem-card-label">尚未合并</span>
          <span className="mem-card-value">{totals.unconsolidated}</span>
          <span className="mem-card-sub">占工作记忆 {pctText(totals.unconsolidated, totals.working)}</span>
          <span className="mem-card-hint">等待合并整理的工作记忆</span>
        </div>
        <div className="mem-card" title={MISSING_SOURCE_HELP}>
          <span className="mem-card-label">来源会话已不在</span>
          <span className="mem-card-value">
            {totals.missingSourceSessions}
            <span className="mem-card-dim">/{totals.sourceSessions}</span>
          </span>
          <span className="mem-card-sub">有来源标记的会话中，找不到文件的个数（近似）</span>
          <span className="mem-card-hint">会话删了，记忆还在</span>
        </div>
        <div className="mem-card">
          <span className="mem-card-label">磁盘占用</span>
          <span className="mem-card-value">{formatSize(totals.bytes)}</span>
          <span className="mem-card-sub">{totals.facts} 条事实</span>
          <span className="mem-card-hint">本地占用的磁盘空间</span>
        </div>
      </div>

      <section className="mem-section" aria-label="新增趋势">
        <div className="mem-section-head">
          <h3>新增趋势</h3>
          <div className="usage-seg" role="group" aria-label="时间范围">
            {GROWTH_RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                className="btn btn-small"
                aria-pressed={growthDays === r.days}
                onClick={() => setGrowthDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <label className="mem-kind">
            项目库
            <select
              aria-label="趋势项目库范围"
              value={growthScope ?? ""}
              onChange={(e) => setGrowthScope(e.target.value === "" ? null : e.target.value)}
            >
              <option value="">全部项目库</option>
              {growthBanks.map((b) => (
                <option key={b.bank} value={b.bank}>
                  {b.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {growthLoading ? <div className="pane-note">趋势加载中…</div> : null}
        {growthError !== null ? <div className="pane-note">趋势加载失败：{growthError}</div> : null}
        {!growthLoading && growthError === null ? (
          growthTotal === 0 ? (
            <div className="pane-note">所选范围内暂无新增记忆。</div>
          ) : (
            <MemoryGrowthChart points={growth} />
          )
        ) : null}
      </section>

      <section className="mem-section" aria-label="项目库">
        <div className="mem-section-head">
          <h3>项目库（{banks.length}）</h3>
          <input
            type="search"
            className="filter-input"
            placeholder="过滤项目名 / 路径"
            aria-label="过滤项目库"
            value={bankFilter}
            onChange={(e) => setBankFilter(e.target.value)}
          />
        </div>
        {banks.length === 0 ? (
          <div className="pane-note">{overview.banks.length === 0 ? "暂无项目库。" : "没有匹配的项目库。"}</div>
        ) : (
          <table className="usage-table mem-banks">
            <thead>
              <tr>
                <th scope="col">项目</th>
                <th scope="col">工作</th>
                <th scope="col">情节</th>
                <th scope="col" className="mem-col-facts">事实</th>
                <th scope="col">最近记忆</th>
                <th scope="col" className="mem-col-bytes">大小</th>
                <th scope="col" className="mem-col-health">健康</th>
              </tr>
            </thead>
            <tbody>
              {banks.map((b) => {
                const active = b.bank === selectedBank;
                const empty = b.readable && bankMemories(b) === 0;
                return (
                  <tr
                    key={b.bank}
                    className={b.readable ? (active ? "mem-bank-active" : undefined) : "mem-bank-unreadable"}
                    onClick={b.readable ? () => selectBank(b.bank) : undefined}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="mem-bank-name"
                        aria-pressed={active}
                        disabled={!b.readable}
                        title={b.readable ? (b.cwd ?? undefined) : (b.error ?? "项目库不可读")}
                        onClick={(e) => {
                          e.stopPropagation();
                          selectBank(b.bank);
                        }}
                      >
                        {b.displayName}
                      </button>{" "}
                      {b.cwdExists === false ? <span className="badge badge-danger">目录已不存在</span> : null}
                      {empty ? <span className="badge badge-grey">空库</span> : null}
                      {!b.readable ? <span className="badge badge-grey">{b.error ?? "不可读"}</span> : null}
                      <span className="usage-row-name muted">{b.cwd === null ? "—" : displayCwd(b.cwd)}</span>
                      {b.readable ? (
                        <span className="mem-bank-health muted">
                          未召回 {b.neverRecalled} · 未合并 {b.unconsolidated}
                        </span>
                      ) : null}
                      {bankActions(b, refresh)}
                    </th>
                    <td>{b.working}</td>
                    <td>{b.episodic}</td>
                    <td className="mem-col-facts">{b.facts}</td>
                    <td title={b.lastMemoryAt === null ? undefined : formatFullTime(b.lastMemoryAt)}>
                      {b.lastMemoryAt === null ? "—" : formatRelativeTime(b.lastMemoryAt)}
                    </td>
                    <td className="mem-col-bytes">{formatSize(b.bytes)}</td>
                    <td className="muted mem-health mem-col-health">
                      {b.readable ? (
                        <>
                          <span>未召回 {b.neverRecalled}</span>
                          <span>未合并 {b.unconsolidated}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {selected !== null && selected.readable ? (
        <div ref={listRef} className="mem-list-anchor">
          <MemoryList
            bank={selected.bank}
            displayName={selected.displayName}
            loadedSessionIds={loadedSessionIds}
            onOpenSession={onOpenSession}
            onToast={onToast}
            refreshToken={refreshToken}
            renderItemActions={renderMemoryActions}
            renderDetailActions={detailActions}
            onRefresh={refresh}
          />
        </div>
      ) : overview.banks.some((b) => b.readable) ? (
        <div className="pane-note">点击上面的项目库，查看其中的记忆。</div>
      ) : (
        <div className="pane-note">没有可读取的项目库。</div>
      )}
      {backupsOpen !== null ? (
        <MemoryBackupsDialog
          initialBank={backupsOpen.bank}
          banks={overview.banks}
          liveBanks={new Set(overview.banks.map((b) => b.bank))}
          onClose={() => setBackupsOpen(null)}
          onToast={onToast}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
