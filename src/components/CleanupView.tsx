/**
 * 清理视图：只读列出「可清理」的会话候选（后端规则扫描，见 CONTRACT §14）。
 *
 * 本视图不自己删除任何东西：勾选后交给 App 的既有批量永久删除编排
 * （DeleteDialog + delete_sessions，含占用拒绝与逐条独立失败）。
 */
import { useEffect, useState } from "react";
import { listCleanupCandidates, normalizeError } from "../api";
import { errorText, formatRelativeTime, formatSize } from "../format";
import { retainExisting } from "../listUtils";
import type { AppError, CleanupCandidate } from "../types";
import {
  REASON_LABEL,
  isSelectable,
  selectionTotals,
  sortCandidates,
  toDeleteTargets,
  toggleAllSelectable,
  type CleanupSortDir,
} from "../cleanup";
import type { DeleteTarget } from "../flows";
import { Badge, EmptyState } from "./ui";
import { Sparkles } from "lucide-react";

interface CleanupViewProps {
  onBack: () => void;
  /** 会话是否在当前已加载列表中（决定「查看」能否跳回主列表）。 */
  canView: (path: string) => boolean;
  onView: (path: string) => void;
  /** 复用 App 的批量删除编排（弹 DeleteDialog、清置顶、刷新列表）。 */
  onDelete: (targets: DeleteTarget[]) => void;
  /** 会话列表刷新计数：变化后重新扫描候选（删除后自动刷新）。 */
  refreshToken: number;
}

/** 只接受合法的正整数输入；非法（空串/0/非数字）返回 null 由调用方忽略。 */
function positiveInt(raw: string, min: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  return floored >= min ? floored : null;
}

export function CleanupView({
  onBack,
  canView,
  onView,
  onDelete,
  refreshToken,
}: CleanupViewProps) {
  const [days, setDays] = useState(30);
  const [topN, setTopN] = useState(10);
  const [rescan, setRescan] = useState(0);
  const [daysText, setDaysText] = useState("30");
  const [topNText, setTopNText] = useState("10");
  const [candidates, setCandidates] = useState<CleanupCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [sortDir, setSortDir] = useState<CleanupSortDir>("desc");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void listCleanupCandidates(days, topN)
      .then((list) => {
        if (!alive) return;
        setCandidates(list);
        // 刷新后丢弃已消失或已变为不可勾选的选中项。
        setChecked(
          (prev) =>
            new Set(
              retainExisting(
                prev,
                new Set(list.filter(isSelectable).map((c) => c.path)),
              ),
            ),
        );
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setCandidates(null);
        setError(normalizeError(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [days, topN, refreshToken, rescan]);

  // 展示顺序完全由前端决定（后端固定体积降序），勾选集合按 path，换序不丢选中。
  const list = sortCandidates(candidates ?? [], sortDir);
  const selectableCount = list.filter(isSelectable).length;
  const totals = selectionTotals(list, checked);
  const allSelected =
    selectableCount > 0 && list.filter(isSelectable).every((c) => checked.has(c.path));

  return (
    <main className="detail">
      <header className="detail-head">
        <div className="detail-title-row">
          <h1 className="detail-title">清理</h1>
          <span className="detail-actions">
            <button type="button" className="btn" onClick={onBack}>
              返回
            </button>
          </span>
        </div>
        <p className="detail-sub">
          只读扫描本机会话，按规则列出候选；删除走既有永久删除流程（不进废纸篓）。
        </p>
      </header>
      <div className="toolbar cleanup-controls">
        <label className="cleanup-field">
          超过
          <input
            type="number"
            className="filter-input cleanup-number"
            min={1}
            value={daysText}
            aria-label="久未更新的天数"
            onChange={(e) => {
              setDaysText(e.target.value);
              const n = positiveInt(e.target.value, 1);
              if (n !== null) setDays(n);
            }}
            onBlur={() => setDaysText(String(days))}
          />
        </label>
        <label className="cleanup-field">
          体积前
          <input
            type="number"
            className="filter-input cleanup-number"
            min={0}
            value={topNText}
            aria-label="体积前 N 名"
            onChange={(e) => {
              setTopNText(e.target.value);
              const n = positiveInt(e.target.value, 0);
              if (n !== null) setTopN(n);
            }}
            onBlur={() => setTopNText(String(topN))}
          />
        </label>
        <div className="seg" role="group" aria-label="排序方向">
          <button
            type="button"
            className="btn"
            aria-pressed={sortDir === "desc"}
            onClick={() => setSortDir("desc")}
          >
            体积倒序
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={sortDir === "asc"}
            onClick={() => setSortDir("asc")}
          >
            体积正序
          </button>
        </div>
        <button
          type="button"
          className="btn"
          disabled={selectableCount === 0}
          onClick={() => setChecked(toggleAllSelectable(list, checked))}
        >
          {allSelected ? "取消全选" : "全选可勾选项"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={loading}
          onClick={() => setRescan((v) => v + 1)}
        >
          {loading ? <span className="spinner" aria-hidden="true" /> : null}
          重新扫描
        </button>
        <span className="cleanup-total" role="status">
          已选 {totals.count} 个，可释放 {formatSize(totals.bytes)}
        </span>
        <button
          type="button"
          className="btn btn-danger"
          disabled={totals.count === 0}
          onClick={() => onDelete(toDeleteTargets(list, checked))}
        >
          删除所选…
        </button>
      </div>
      <div className="cleanup-body" aria-busy={loading}>
        {error ? (
          <div className="banner banner-error" role="alert">
            <span>{errorText(error)}</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setRescan((v) => v + 1)}
            >
              重试
            </button>
          </div>
        ) : null}
        {loading && list.length === 0 && !error ? (
          <div className="pane-note" role="status">
            正在扫描可清理的会话…
          </div>
        ) : null}
        {!loading && !error && list.length === 0 ? (
          <EmptyState icon={Sparkles} title="很干净">
            没有符合清理规则的会话（空会话 / 目录已删除 / 体积大 / 久未更新）。
          </EmptyState>
        ) : null}
        {list.length > 0 ? (
          <table className="manage-table cleanup-table">
            <thead>
              <tr>
                <th scope="col">选择</th>
                <th scope="col">会话</th>
                <th scope="col">原因</th>
                <th scope="col">体积</th>
                <th scope="col">修改时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const selectable = isSelectable(c);
                return (
                  <tr key={c.path} className={selectable ? undefined : "cleanup-locked"}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!selectable}
                        checked={checked.has(c.path)}
                        aria-label={`选择 ${c.title}`}
                        onChange={(e) =>
                          setChecked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.path);
                            else next.delete(c.path);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <div className="row-title" title={c.title}>
                        {c.title}
                      </div>
                      <div className="row-meta">
                        <span className="mono" title={c.cwd}>
                          {c.cwd.split("/").filter(Boolean).pop() ?? c.cwd}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="cleanup-reasons">
                        {c.reasons.map((r) => (
                          <Badge key={r} tone="grey">
                            {REASON_LABEL[r]}
                          </Badge>
                        ))}
                      </span>
                    </td>
                    <td>{formatSize(c.bytes)}</td>
                    <td>{formatRelativeTime(c.mtime)}</td>
                    <td>
                      <span className="cleanup-actions">
                        {c.inUse ? (
                          <Badge tone="accent">占用中</Badge>
                        ) : !c.probeOk ? (
                          <Badge tone="grey" title="占用探测失败，不敢断言空闲，不可删除">
                            占用未知
                          </Badge>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={!canView(c.path)}
                          title={
                            canView(c.path)
                              ? "在主列表中选中该会话"
                              : "该会话当前不在会话列表中（可能因无标题且无用户消息被隐藏）"
                          }
                          onClick={() => onView(c.path)}
                        >
                          查看
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </main>
  );
}
