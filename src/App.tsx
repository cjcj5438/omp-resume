/** 应用外壳：左侧列表 + 右侧详情、刷新保持选择、删除与提示编排。 */
import "./App.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendBranchMarker,
  deleteSessions,
  listSessions,
  normalizeError,
  openInIterm,
} from "./api";
import type {
  AppError,
  DeleteResult,
  ListSessionsResult,
  SessionSummary,
} from "./types";
import { errorText } from "./format";
import { canFocusRefresh, filterGroups, retainExisting } from "./listUtils";
import { runContinueFromNode, type ContinueOutcome } from "./flows";
import { Sidebar } from "./components/Sidebar";
import { DetailPane } from "./components/DetailPane";
import { DeleteDialog } from "./components/DeleteDialog";

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

function App() {
  const [list, setList] = useState<ListSessionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<AppError | null>(null);
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<SessionSummary[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const inFlight = useRef(false);
  const lastStart = useRef(0);
  const toastId = useRef(0);

  const addToast = useCallback((text: string, kind: "info" | "error") => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastStart.current = Date.now();
    setLoading(true);
    try {
      const res = await listSessions();
      setList(res);
      setListError(null);
      const paths = new Set(
        res.groups.flatMap((g) => g.sessions.map((s) => s.path)),
      );
      setChecked((prev) => new Set(retainExisting(prev, paths)));
    } catch (e) {
      setListError(normalizeError(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refocus = () => {
      if (canFocusRefresh(inFlight.current, lastStart.current, Date.now()))
        void load();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refocus();
    };
    window.addEventListener("focus", refocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const byPath = useMemo(() => {
    const m = new Map<string, SessionSummary>();
    for (const g of list?.groups ?? [])
      for (const s of g.sessions) m.set(s.path, s);
    return m;
  }, [list]);

  const groups = useMemo(
    () => filterGroups(list?.groups ?? [], query),
    [list, query],
  );
  const totalCount = useMemo(
    () =>
      (list?.groups ?? []).reduce((n, g) => n + g.sessions.length, 0),
    [list],
  );

  // 选中会话在刷新/删除后消失 ⇒ 详情面板展示提示（派生，不额外存状态）。
  const selected = selectedPath ? (byPath.get(selectedPath) ?? null) : null;
  const selectedGone = selectedPath != null && selected === null;

  const refreshAfterContinue = useCallback(async () => {
    await load();
    setRefreshKey((k) => k + 1);
  }, [load]);

  const handleContinue = useCallback(
    (nodeId: string): Promise<ContinueOutcome> => {
      if (!selectedPath) return Promise.reject({ code: "UNKNOWN", message: "未选中会话" });
      return runContinueFromNode(
        {
          appendBranchMarker: async (p, n) =>
            (await appendBranchMarker({ path: p, nodeId: n })).markerId,
          openInIterm: (p) => openInIterm({ path: p }),
          refresh: refreshAfterContinue,
        },
        selectedPath,
        nodeId,
      );
    },
    [selectedPath, refreshAfterContinue],
  );

  const requestDelete = useCallback(
    async (paths: string[]): Promise<DeleteResult[]> => {
      const results = await deleteSessions({ paths });
      await load();
      return results;
    },
    [load],
  );

  const deleteTargetsFrom = useCallback(
    (checkedPaths: Set<string>, selPath: string | null) => {
      const paths = checkedPaths.size > 0 ? [...checkedPaths] : selPath ? [selPath] : [];
      return paths
        .map((p) => byPath.get(p))
        .filter((s): s is SessionSummary => s != null);
    },
    [byPath],
  );

  return (
    <div className="app">
      <Sidebar
        groups={groups}
        totalCount={totalCount}
        hiddenEmpty={list?.hiddenEmpty ?? 0}
        query={query}
        onQuery={setQuery}
        loading={loading}
        listError={listError}
        onRetry={() => void load()}
        onRefresh={() => void load()}
        checked={checked}
        onToggleCheck={(path, on) =>
          setChecked((prev) => {
            const next = new Set(prev);
            if (on) next.add(path);
            else next.delete(path);
            return next;
          })
        }
        selectedPath={selectedPath}
        onSelect={(path) => setSelectedPath(path)}
      />
      <DetailPane
        session={selected}
        gone={selectedGone}
        checkedCount={checked.size}
        refreshKey={refreshKey}
        onOpenIterm={(s) => {
          openInIterm({ path: s.path })
            .then(() => addToast("已在 iTerm 打开", "info"))
            .catch((e: unknown) => addToast(errorText(normalizeError(e)), "error"));
        }}
        onDelete={() => {
          const targets = deleteTargetsFrom(checked, selectedPath);
          if (targets.length > 0) setDeleteTargets(targets);
        }}
        onContinue={handleContinue}
        onToast={addToast}
      />
      {deleteTargets ? (
        <DeleteDialog
          targets={deleteTargets}
          requestDelete={requestDelete}
          onClose={() => setDeleteTargets(null)}
        />
      ) : null}
      <div className="toast-area" role="status" aria-live="polite">
        {listError ? (
          <div className="banner banner-error">
            <span>{errorText(listError)}</span>
            <button type="button" className="btn btn-small" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}
        {toasts.map((t) => (
          <div
            key={t.id}
            className={t.kind === "error" ? "toast toast-error" : "toast"}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
