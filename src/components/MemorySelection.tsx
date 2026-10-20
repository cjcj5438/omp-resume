/**
 * 记忆多选：选择模式状态、500 上限、跨页保持、按当前筛选收集全部 id。
 * 选择条 UI 与收集逻辑放一起，MemoryList 只负责渲染行复选框与删除框。
 */
import { useRef, useState, type ReactNode } from "react";
import { memoryList, normalizeError } from "../api";
import type { MemoryKindFilter, MemorySort } from "../types";
import { errorText } from "../format";
import type { ToastFn } from "./useOmpOp";
import { MEMORY_DELETE_IDS_MAX } from "./useMemoryMaintenance";
import "./MemoryPanel.css";

export interface MemorySelectionFilter {
  query: string | null;
  kind: MemoryKindFilter;
  onlyNeverRecalled: boolean;
  onlyUnconsolidated: boolean;
  onlyMissingSource: boolean;
  sort: MemorySort;
}

export interface MemorySelection {
  selecting: boolean;
  setSelecting: (v: boolean) => void;
  checked: ReadonlySet<string>;
  atCap: boolean;
  toggleCheck: (id: string, on: boolean) => void;
  clearChecked: () => void;
  selectLoaded: (ids: string[]) => void;
  collecting: { done: number; total: number | null } | null;
  selectAllFiltered: () => void;
  /** 库/筛选/刷新变化时调用：取消收集中断并清空选择。 */
  reset: () => void;
}

export function useMemorySelection(
  bank: string,
  filter: MemorySelectionFilter,
  onToast: ToastFn,
): MemorySelection {
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [collecting, setCollecting] = useState<{ done: number; total: number | null } | null>(null);
  const collectSeq = useRef(0);

  function reset(): void {
    collectSeq.current += 1;
    setCollecting(null);
    setChecked(new Set());
  }

  function toggleCheck(id: string, on: boolean): void {
    setChecked((prev) => {
      if (!on) {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      if (prev.has(id) || prev.size >= MEMORY_DELETE_IDS_MAX) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function selectLoaded(ids: string[]): void {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (next.size >= MEMORY_DELETE_IDS_MAX) break;
        next.add(id);
      }
      return next;
    });
  }

  function selectAllFiltered(): void {
    if (collecting !== null) return;
    const run = ++collectSeq.current;
    setCollecting({ done: 0, total: null });
    void (async () => {
      const ids: string[] = [];
      let offset = 0;
      let total: number | null = null;
      try {
        for (;;) {
          const page = await memoryList({ bank, ...filter, limit: 200, offset });
          if (collectSeq.current !== run) return;
          if (total === null) {
            total = page.total;
            setCollecting({ done: 0, total });
          }
          for (const m of page.items) {
            if (ids.length >= MEMORY_DELETE_IDS_MAX) break;
            ids.push(m.id);
          }
          if (collectSeq.current !== run) return;
          setCollecting({ done: ids.length, total });
          offset += page.items.length;
          if (ids.length >= MEMORY_DELETE_IDS_MAX || offset >= (total ?? 0) || page.items.length === 0) break;
        }
        if (collectSeq.current !== run) return;
        setChecked(new Set(ids));
        if ((total ?? 0) > MEMORY_DELETE_IDS_MAX) {
          onToast(`筛选结果共 ${total} 条，已选中前 ${MEMORY_DELETE_IDS_MAX} 条（一次最多删除 500 条）`, "info");
        }
      } catch (e: unknown) {
        if (collectSeq.current === run) {
          onToast(`收集筛选项失败：${errorText(normalizeError(e))}`, "error");
        }
      } finally {
        if (collectSeq.current === run) setCollecting(null);
      }
    })();
  }

  return {
    selecting,
    setSelecting,
    checked,
    atCap: checked.size >= MEMORY_DELETE_IDS_MAX,
    toggleCheck,
    clearChecked: () => setChecked(new Set()),
    selectLoaded,
    collecting,
    selectAllFiltered,
    reset,
  };
}

export function MemorySelectionBar(props: {
  selection: MemorySelection;
  loadedIds: string[];
  onDelete: () => void;
}): ReactNode {
  const { selection, loadedIds, onDelete } = props;
  const busy = selection.collecting !== null;
  const busyTitle = busy ? "正在收集筛选项，请稍候" : undefined;
  return (
    <div className="mem-selectbar" aria-live="polite">
      <span>已选 {selection.checked.size} 条</span>
      <button
        type="button"
        className="btn btn-small"
        disabled={busy || loadedIds.length === 0}
        title={busyTitle}
        onClick={() => selection.selectLoaded(loadedIds)}
      >
        全选当前已加载
      </button>
      <button
        type="button"
        className="btn btn-small"
        disabled={busy || selection.checked.size === 0}
        title={busyTitle}
        onClick={() => selection.clearChecked()}
      >
        清除
      </button>
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => selection.selectAllFiltered()}>
        {busy
          ? selection.collecting?.total === null
            ? `正在收集…已取 ${selection.collecting?.done ?? 0} 条`
            : `正在收集…${selection.collecting?.done ?? 0}/${selection.collecting?.total ?? 0} 条`
          : "选中当前筛选的全部结果"}
      </button>
      <button
        type="button"
        className="btn btn-small"
        disabled={busy || selection.checked.size === 0}
        title={busyTitle}
        onClick={onDelete}
      >
        删除所选…
      </button>
      {selection.atCap ? <span className="muted">已达上限 500 条，一次最多删除 500 条</span> : null}
    </div>
  );
}
