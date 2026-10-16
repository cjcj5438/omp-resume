/** 应用外壳：左侧列表 + 右侧详情、刷新保持选择、删除与提示编排。 */
import "./App.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendBranchMarker,
  checkOmpUpdate,
  chooseDirectory,
  deleteSessions,
  getOmpVersion,
  listSessions,
  normalizeError,
  openInIterm,
  newSessionInIterm,
} from "./api";
import type {
  AppError,
  DeleteResult,
  ListSessionsResult,
  OmpUpdateCheck,
  SessionSummary,
} from "./types";
import { errorText } from "./format";
import { applyPins, canFocusRefresh, filterGroups, retainExisting } from "./listUtils";
import { runContinueFromNode, type ContinueOutcome } from "./flows";
import { loadPins, removeSessionPins, savePins, togglePin, type PinKind, type Pins } from "./pins";
import { Sidebar } from "./components/Sidebar";
import { DetailPane } from "./components/DetailPane";
import { ManageView } from "./components/ManageView";
import { StatsView } from "./components/StatsView";
import { OmpUpdateDialog } from "./components/OmpUpdateDialog";
import { DeleteDialog } from "./components/DeleteDialog";
import { CheatSheetDialog } from "./components/CheatSheetDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { checkForUpdate, type Update } from "./update";

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
  const [showCheatSheet, setShowCheatSheet] = useState(false);
  const [view, setView] = useState<"sessions" | "manage" | "stats">("sessions");
  // 自动更新：启动时静默检查一次，有新版本才弹窗；失败静默忽略，不阻塞列表。
  // 手动重新检查：重启应用即可。
  const [update, setUpdate] = useState<Update | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pins, setPins] = useState<Pins>(() => loadPins());
  const [ompVersion, setOmpVersion] = useState<string | null>(null);
  const [ompChecking, setOmpChecking] = useState(false);
  const [ompCheck, setOmpCheck] = useState<OmpUpdateCheck | null>(null);
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

  // 置顶变更即持久化（仅界面偏好，存储失败静默）。
  useEffect(() => {
    savePins(pins);
  }, [pins]);

  // 启动时检查一次更新（checkForUpdate 内部已处理 DEV 跳过与静默失败）。
  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((u) => {
      if (!cancelled && u) setUpdate(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启动时读取本机 omp 版本；失败（未安装等）静默，侧栏不显示版本行。
  useEffect(() => {
    getOmpVersion()
      .then((v) => setOmpVersion(v.version))
      .catch(() => {});
  }, []);

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

  // 先置顶排序再过滤，使过滤结果保持置顶顺序。
  const orderedGroups = useMemo(
    () => applyPins(list?.groups ?? [], pins),
    [list, pins],
  );
  const groups = useMemo(
    () => filterGroups(orderedGroups, query),
    [orderedGroups, query],
  );
  const totalCount = useMemo(
    () =>
      (list?.groups ?? []).reduce((n, g) => n + g.sessions.length, 0),
    [list],
  );
  // 管理视图的项目列表：去重 cwd，仅保留目录仍存在的组，保持加载顺序。
  const manageProjects = useMemo(() => {
    const seen = new Set<string>();
    const out: { cwd: string; name: string }[] = [];
    for (const g of list?.groups ?? []) {
      if (seen.has(g.cwd)) continue;
      seen.add(g.cwd);
      if (!g.sessions.some((s) => s.cwdExists)) continue;
      out.push({ cwd: g.cwd, name: g.cwd.split("/").filter(Boolean).pop() ?? g.cwd });
    }
    return out;
  }, [list]);

  // 选中会话在刷新/删除后消失 ⇒ 详情面板展示提示（派生，不额外存状态）。
  const selected = selectedPath ? (byPath.get(selectedPath) ?? null) : null;
  const selectedGone = selectedPath != null && selected === null;
  const selectedPinned = selected != null && pins.sessions.includes(selected.id);

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

  // 新开会话：cwd 为空时先让用户选择目录；用户取消（null）静默返回。
  const handleNewSession = useCallback(
    async (cwd: string | null) => {
      try {
        const target = cwd ?? (await chooseDirectory());
        if (target === null) return;
        await newSessionInIterm(target);
        addToast("已在 iTerm 新开会话", "info");
      } catch (e: unknown) {
        addToast(errorText(normalizeError(e)), "error");
      }
    },
    [addToast],
  );

  const requestDelete = useCallback(
    async (paths: string[]): Promise<DeleteResult[]> => {
      const results = await deleteSessions({ paths });
      // 删除成功的会话同时清理其置顶；id 取自刷新前的 byPath 快照。
      const deletedIds = results
        .filter((r) => r.ok)
        .map((r) => byPath.get(r.path)?.id)
        .filter((id): id is string => id != null);
      if (deletedIds.length > 0) setPins((prev) => removeSessionPins(prev, deletedIds));
      await load();
      return results;
    },
    [byPath, load],
  );

  const handleTogglePin = useCallback(
    (kind: PinKind, key: string) => setPins((prev) => togglePin(prev, kind, key)),
    [],
  );

  const handleCheckOmp = useCallback(async () => {
    setOmpChecking(true);
    try {
      setOmpCheck(await checkOmpUpdate());
    } catch (e: unknown) {
      addToast(errorText(normalizeError(e)), "error");
    } finally {
      setOmpChecking(false);
    }
  }, [addToast]);

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
        manageActive={view === "manage"}
        onToggleManage={() => setView((v) => (v === "manage" ? "sessions" : "manage"))}
        statsActive={view === "stats"}
        onToggleStats={() => setView((v) => (v === "stats" ? "sessions" : "stats"))}
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
        onSelect={(path) => {
          setView("sessions");
          setSelectedPath(path);
        }}
        pins={pins}
        onTogglePin={handleTogglePin}
        ompVersion={ompVersion}
        ompChecking={ompChecking}
        onCheckOmp={handleCheckOmp}
        onOpenCheatSheet={() => setShowCheatSheet(true)}
        onNewSession={() => void handleNewSession(null)}
        onNewSessionIn={(cwd) => void handleNewSession(cwd)}
      />
      {view === "manage" ? (
        <ManageView
          projects={manageProjects}
          onToast={addToast}
          onBack={() => setView("sessions")}
          onCheckOmp={handleCheckOmp}
        />
      ) : view === "stats" ? <StatsView onBack={() => setView("sessions")} /> : (
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
          pinned={selectedPinned}
          onTogglePin={() => {
            if (selected) handleTogglePin("session", selected.id);
          }}
        />
      )}
      {deleteTargets ? (
        <DeleteDialog
          targets={deleteTargets}
          requestDelete={requestDelete}
          onClose={() => setDeleteTargets(null)}
        />
      ) : null}
      {showCheatSheet ? <CheatSheetDialog onClose={() => setShowCheatSheet(false)} /> : null}
      {update ? (
        <UpdateDialog
          update={update}
          onClose={() => {
            // 释放后端资源，失败忽略；对话框关闭与资源释放互不影响。
            void update.close().catch(() => {});
            setUpdate(null);
          }}
        />
      ) : null}
      {ompCheck ? (
        <OmpUpdateDialog
          check={ompCheck}
          onClose={() => setOmpCheck(null)}
          onUpdated={(after) => setOmpVersion(after)}
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
