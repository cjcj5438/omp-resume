/** 记忆库面板：管理视图「记忆库」标签页——概览头条 → 健康卡 → 项目库图表 →（选中库）右侧抽屉。 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryOverview, normalizeError } from "../api";
import type { MemoryBankSummary, MemoryOverview } from "../types";
import { displayCwd, errorText, formatSize } from "../format";
import { Drawer } from "./Drawer";
import { MemoryBackupsDialog } from "./MemoryBackupsDialog";
import { MemoryBankHeader, MemoryBanks } from "./MemoryBanks";
import { MemoryGraph } from "./MemoryGraph";
import { MemoryList } from "./MemoryList";
import { bankMemories } from "./useMemoryMaintenance";
import type { ToastFn } from "./useOmpOp";
import "./Usage.css";
import "./MemoryPanel.css";

function pctText(part: number, total: number): string {
  return total <= 0 ? "—" : `${Math.round((part / total) * 100)}%`;
}

export function MemoryPanel(props: {
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  onToast: ToastFn;
}): ReactNode {
  const { loadedSessionIds, onOpenSession, onToast } = props;
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  /** 选中库的展示视图：默认列表；关系图故障时回退也不影响列表。 */
  const [memView, setMemView] = useState<"list" | "graph">("list");
  /** 从关系图跳过来的定位 id（列表拉详情置顶展示，可跨分页）。 */
  const [graphFocusId, setGraphFocusId] = useState<string | null>(null);
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
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const text = errorText(normalizeError(e));
        setLoadError(text);
        onToast(`加载记忆库失败：${text}`, "error");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshToken, onToast]);

  if (loading && overview === null) return <div className="pane-note">记忆库加载中…</div>;
  if (overview === null) {
    return (
      <div>
        <div className="pane-note">加载失败：{loadError}</div>
        <button type="button" className="btn" onClick={refresh}>重试</button>
      </div>
    );
  }
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
        <button type="button" className="btn" onClick={refresh}>刷新</button>
      </div>
    );
  }

  const { totals } = overview;
  const totalMemories = totals.working + totals.episodic;
  const neverRatio = totalMemories > 0 ? totals.neverRecalled / totalMemories : 0;
  // 未合并只统计 working 表（§18.1），占比分母用工作记忆数。
  const unconsRatio = totals.working > 0 ? totals.unconsolidated / totals.working : 0;
  const selected: MemoryBankSummary | null = overview.banks.find((b) => b.bank === selectedBank) ?? null;
  /** 选中库：右侧抽屉展示该库记忆；再点同一行不重复打开。 */
  function selectBank(bank: string): void {
    setSelectedBank(bank);
    setMemView("list");
    setGraphFocusId(null);
  }

  return (
    <div className="mem-panel">
      <div className="mem-main">
        <div className="mem-head">
          <span>
            记忆后端：{overview.backend ?? "未知"} · {totals.banks} 个项目库 · 共 {totalMemories} 条记忆 · 占用磁盘{" "}
            {formatSize(totals.bytes)}
          </span>
          <span className="mem-head-actions">
            <button type="button" className="btn btn-small" onClick={() => setBackupsOpen({ bank: null })}>备份与恢复</button>
            <button type="button" className="btn btn-small" onClick={refresh}>刷新</button>
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
            <span className="mem-card-sub">工作 {totals.working} · 情节 {totals.episodic}</span>
          </div>
          <div className={neverRatio > 0.5 ? "mem-card mem-card-warn" : "mem-card"}>
            <span className="mem-card-label">从未被召回</span>
            <span className="mem-card-value">{totals.neverRecalled}</span>
            <span className="mem-card-sub">占 {pctText(totals.neverRecalled, totalMemories)} · 从未被再次用过</span>
          </div>
          <div className={unconsRatio > 0.5 ? "mem-card mem-card-warn" : "mem-card"}>
            <span className="mem-card-label">尚未合并</span>
            <span className="mem-card-value">{totals.unconsolidated}</span>
            <span className="mem-card-sub">占工作记忆 {pctText(totals.unconsolidated, totals.working)} · 等待合并</span>
          </div>
          <div className="mem-card">
            <span className="mem-card-label">磁盘占用</span>
            <span className="mem-card-value">{formatSize(totals.bytes)}</span>
            <span className="mem-card-sub">{totals.facts} 条事实 · 本地占用</span>
          </div>
        </div>

        <MemoryBanks banks={overview.banks} selected={selected} onSelect={selectBank} onOpenBackups={(bank) => setBackupsOpen({ bank })} onToast={onToast} onChanged={refresh} />

        {selected === null ? (
          <div className="pane-note">
            {overview.banks.length === 0 ? "暂无项目库。" : "点上面的项目库，在右侧查看其中的记忆。"}
          </div>
        ) : null}
      </div>

      {selected === null ? null : (
        <Drawer
          inline
          label={`项目库 ${selected.displayName}`}
          title={
            <span className="mem-drawer-title">
              <span>{selected.displayName}</span>
              <span className="muted mono">{selected.cwd === null ? "—" : displayCwd(selected.cwd)}</span>
            </span>
          }
          onClose={() => setSelectedBank(null)}
        >
          <div ref={listRef} className="mem-list-anchor">
            <MemoryBankHeader
              bank={selected}
              onOpenBackups={(bank) => setBackupsOpen({ bank })}
              onToast={onToast}
              onChanged={() => {
                setSelectedBank(null);
                refresh();
              }}
            />
            {selected.readable ? (
              <div className="mem-view-switch mem-chips" role="group" aria-label="记忆视图">
                {(["list", "graph"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="btn btn-small"
                    aria-pressed={memView === v}
                    onClick={() => {
                      setMemView(v);
                      if (v === "graph") setGraphFocusId(null);
                    }}
                  >
                    {v === "list" ? "列表" : "关系图"}
                  </button>
                ))}
              </div>
            ) : null}
            {selected.readable ? (
              memView === "graph" ? (
                <MemoryGraph
                  key={selected.bank}
                  bank={selected.bank}
                  displayName={selected.displayName}
                  onToast={onToast}
                  onOpenInList={(id) => {
                    setGraphFocusId(id);
                    setMemView("list");
                    requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: "start" }));
                  }}
                />
              ) : (
                <MemoryList
                  key={selected.bank}
                  bank={selected.bank}
                  displayName={selected.displayName}
                  loadedSessionIds={loadedSessionIds}
                  onOpenSession={onOpenSession}
                  onToast={onToast}
                  refreshToken={refreshToken}
                  onRefresh={refresh}
                  focusId={graphFocusId}
                  onClearFocus={() => setGraphFocusId(null)}
                />
              )
            ) : (
              <div className="pane-note">该库不可读：{selected.error ?? "未知原因"}。</div>
            )}
          </div>
        </Drawer>
      )}
      {backupsOpen !== null ? (
        <MemoryBackupsDialog initialBank={backupsOpen.bank} banks={overview.banks} onClose={() => setBackupsOpen(null)} onToast={onToast} onChanged={refresh} />
      ) : null}
    </div>
  );
}
