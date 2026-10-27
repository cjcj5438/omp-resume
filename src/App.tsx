/** 应用外壳：左侧列表 + 右侧详情、刷新保持选择、删除与提示编排。 */
import "./App.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendBranchMarker,
  checkOmpUpdate,
  chooseDirectory,
  deleteSessions,
  getMeta,
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
  MetaSnapshot,
  OmpUpdateCheck,
  SessionSummary,
} from "./types";
import { errorText } from "./format";
import { useBenchMonitor } from "./modelBench";
import { applyPins, canFocusRefresh, collectTagCounts, filterByTags, filterGroups, filterSessions, filterSessionsByTags, retainExisting } from "./listUtils";
import { runContinueFromNode, type ContinueOutcome, type DeleteTarget } from "./flows";
import { loadPins, removeSessionPins, savePins, togglePin, type PinKind, type Pins } from "./pins";
import { Sidebar } from "./components/Sidebar";
import { DetailPane } from "./components/DetailPane";
import { PromptHistoryView } from "./components/PromptHistoryView";
import { ManageView } from "./components/ManageView";
import { StatsView } from "./components/StatsView";
import { StageView } from "./stage/StageView";
import { CleanupView } from "./components/CleanupView";
import { ChartTip } from "./components/ChartTip";
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

const MAX_TOASTS = 5;

/** 并列的顶层视图；会话页是根，其余可层层进入并逐级返回。 */
type AppView = "sessions" | "manage" | "stats" | "history" | "cleanup" | "stage";

function App() {
  const [list, setList] = useState<ListSessionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<AppError | null>(null);
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // 舞台内点侧栏会话：即使 path 没变（重复点同一行），seq 递增也会让 StageView 收到切换请求。
  const [stageTarget, setStageTarget] = useState<{ path: string; seq: number } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<DeleteTarget[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCheatSheet, setShowCheatSheet] = useState(false);
  // 视图栈：顶层是当前视图，往回退是上一级（而不是永远回到会话页）。
  const [viewStack, setViewStack] = useState<AppView[]>(["sessions"]);
  const view = viewStack[viewStack.length - 1];
  const navigate = useCallback((next: AppView) => {
    setViewStack((prev) => (prev[prev.length - 1] === next ? prev : [...prev, next]));
  }, []);
  const goBack = useCallback(() => {
    setViewStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);
  /** 看/选某个会话：栈回到会话页（不是「上一级」，避免从统计退回会话再退回统计）。 */
  const showSessions = useCallback(() => setViewStack(["sessions"]), []);
  const toggleView = useCallback(
    (target: AppView) => {
      if (view === target) goBack();
      else navigate(target);
    },
    [view, goBack, navigate],
  );
  // 清理候选项在每次删除后要重新扫描（只读命令，代价可接受）。
  const [cleanupVersion, setCleanupVersion] = useState(0);
  // 自动更新：启动时静默检查一次，有新版本才弹窗；失败静默忽略，不阻塞列表。
  // 手动重新检查：重启应用即可。
  const [update, setUpdate] = useState<Update | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pins, setPins] = useState<Pins>(() => loadPins());
  // 应用侧备注快照（别名/标签/备注）：启动加载，向下传；保存后用返回快照更新。
  const [meta, setMeta] = useState<MetaSnapshot | null>(null);
  const [metaError, setMetaError] = useState<AppError | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [ompVersion, setOmpVersion] = useState<string | null>(null);
  const [ompChecking, setOmpChecking] = useState(false);
  const [ompCheck, setOmpCheck] = useState<OmpUpdateCheck | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const rerun = useRef(false);
  const lastStart = useRef(0);
  const toastId = useRef(0);
  const toastTimers = useRef(new Map<number, number>());

  const addToast = useCallback((text: string, kind: "info" | "error") => {
    const id = ++toastId.current;
    setToasts((prev) => {
      const next = [...prev, { id, text, kind }].slice(-MAX_TOASTS);
      const evicted = prev.filter((t) => !next.some((n) => n.id === t.id));
      for (const t of evicted) {
        const timer = toastTimers.current.get(t.id);
        if (timer !== undefined) {
          clearTimeout(timer);
          toastTimers.current.delete(t.id);
        }
      }
      return next;
    });
    const timer = window.setTimeout(() => {
      toastTimers.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
    toastTimers.current.set(id, timer);
  }, []);

  useEffect(() => () => {
    for (const t of toastTimers.current.values()) clearTimeout(t);
  }, []);

  const load = useCallback((): Promise<void> => {
    if (inFlight.current) { rerun.current = true; return inFlight.current; }
    inFlight.current = (async () => {
      do {
        rerun.current = false;
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
          setLoading(false);
        }
      } while (rerun.current);
      inFlight.current = null;
    })();
    return inFlight.current;
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await getMeta());
      setMetaError(null);
    } catch (e) {
      const err = normalizeError(e);
      setMetaError(err);
      if (err.code !== "META_CORRUPT") addToast(errorText(err), "error");
    }
  }, [addToast]);
  useEffect(() => {
    void load();
    void loadMeta();
  }, [load, loadMeta]);

  // 模型测试定时监控：应用开着才跑，退出就停。
  useBenchMonitor();
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
      if (canFocusRefresh(inFlight.current !== null, lastStart.current, Date.now()))
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

  // 统一返回：Esc 从非会话视图退回上一级（对话框自己先吃掉 Esc，见各 Dialog）。
  useEffect(() => {
    if (view === "sessions") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".modal-overlay") !== null) return;
      if (document.querySelector('[role="complementary"]') !== null) return;
      goBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, goBack]);

  const byPath = useMemo(() => {
    const m = new Map<string, SessionSummary>();
    for (const g of list?.groups ?? [])
      for (const s of g.sessions) m.set(s.path, s);
    return m;
  }, [list]);

  // 提示词历史视图：已加载会话 id，用于判断「跳到来源会话」是否可用。
  const loadedSessionIds = useMemo(() => new Set([...byPath.values()].map((s) => s.id)), [byPath]);

  // 先拆分置顶（项目上浮、会话聚合）再过滤，使过滤结果保持既有顺序。
  const pinnedSplit = useMemo(
    () => applyPins(list?.groups ?? [], pins),
    [list, pins],
  );
  const tagCounts = useMemo(() => collectTagCounts(list?.groups ?? [], meta), [list, meta]);
  const groups = useMemo(
    () => filterGroups(filterByTags(pinnedSplit.groups, activeTags, meta), query, meta),
    [pinnedSplit, activeTags, query, meta],
  );
  // 置顶区与分组用同一过滤口径；无匹配时整区隐藏（Sidebar 按空数组处理）。
  const pinnedSessions = useMemo(
    () =>
      filterSessions(filterSessionsByTags(pinnedSplit.pinnedSessions, activeTags, meta), query, meta),
    [pinnedSplit, activeTags, query, meta],
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

  // 提示词历史「跳到来源会话」：切回会话视图并选中该会话（不在列表中则无操作）。
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      for (const s of byPath.values()) {
        if (s.id !== sessionId) continue;
        showSessions();
        setSelectedPath(s.path);
        return;
      }
    },
    [byPath, showSessions],
  );

  const requestDelete = useCallback(
    async (paths: string[]): Promise<DeleteResult[]> => {
      const results = await deleteSessions({ paths });
      // 删除成功的会话同时清理其置顶；id 优先取当前删除目标的快照
      // （清理候选中可能有未出现在会话列表里的会话），再回退 byPath。
      const targetIds = new Map((deleteTargets ?? []).map((t) => [t.path, t.id]));
      const deletedIds = results
        .filter((r) => r.ok)
        .map((r) => targetIds.get(r.path) ?? byPath.get(r.path)?.id)
        .filter((id): id is string => id != null);
      if (deletedIds.length > 0) setPins((prev) => removeSessionPins(prev, deletedIds));
      await load();
      // 后端删除成功会联动清应用侧条目：刷新快照以同步 revision。
      await loadMeta();
      setCleanupVersion((v) => v + 1);
      return results;
    },
    [byPath, load, loadMeta, deleteTargets],
  );

  const handleTogglePin = useCallback(
    (kind: PinKind, key: string) => setPins((prev) => togglePin(prev, kind, key)),
    [],
  );

  const handleToggleTag = useCallback(
    (tag: string) =>
      setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])),
    [],
  );

  const handleMetaSnapshot = useCallback((snap: MetaSnapshot) => {
    setMeta(snap);
    setMetaError(null);
  }, []);

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

  const handleOpenIterm = useCallback(
    (s: SessionSummary) => {
      openInIterm({ path: s.path })
        .then(() => addToast("已在 iTerm 打开", "info"))
        .catch((e: unknown) => addToast(errorText(normalizeError(e)), "error"));
    },
    [addToast],
  );

  const handleRequestDelete = useCallback(
    (paths: string[]) => {
      const targets = paths
        .map((p) => byPath.get(p))
        .filter((s): s is SessionSummary => s != null);
      if (targets.length > 0) setDeleteTargets(targets);
    },
    [byPath],
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
        pinnedSessions={pinnedSessions}
        totalCount={totalCount}
        hiddenEmpty={list?.hiddenEmpty ?? 0}
        query={query}
        onQuery={setQuery}
        loading={loading}
        listError={listError}
        onRetry={() => void load()}
        onRefresh={() => void load()}
        manageActive={view === "manage"}
        onToggleManage={() => toggleView("manage")}
        statsActive={view === "stats"}
        onToggleStats={() => toggleView("stats")}
        stageActive={view === "stage"}
        onToggleStage={() => toggleView("stage")}
        historyActive={view === "history"}
        onToggleHistory={() => toggleView("history")}
        cleanupActive={view === "cleanup"}
        onToggleCleanup={() => toggleView("cleanup")}
        checked={checked}
        onToggleCheck={(path, on) =>
          setChecked((prev) => {
            const next = new Set(prev);
            if (on) next.add(path);
            else next.delete(path);
            return next;
          })
        }
        onToggleChecks={(paths, on) =>
          setChecked((prev) => {
            const next = new Set(prev);
            for (const p of paths) {
              if (on) next.add(p);
              else next.delete(p);
            }
            return next;
          })
        }
        onClearChecks={() => setChecked(new Set())}
        selectedPath={selectedPath}
        onSelect={(path) => {
          if (view !== "stage") showSessions();
          else setStageTarget((prev) => ({ path, seq: (prev?.seq ?? -1) + 1 }));
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
        meta={meta}
        tagCounts={tagCounts}
        activeTags={activeTags}
        onToggleTag={handleToggleTag}
        onToast={addToast}
        onOpenIterm={handleOpenIterm}
        onRequestDelete={handleRequestDelete}
        onMetaSnapshot={handleMetaSnapshot}
      />
      {view === "history" ? (
        <PromptHistoryView
          onBack={goBack}
          loadedSessionIds={loadedSessionIds}
          onOpenSession={handleOpenSession}
          onNewSessionIn={(cwd) => void handleNewSession(cwd)}
          onToast={addToast}
        />
      ) : view === "manage" ? (
        <ManageView
          projects={manageProjects}
          onToast={addToast}
          onBack={goBack}
          onCheckOmp={handleCheckOmp}
          loadedSessionIds={loadedSessionIds}
          onOpenSession={handleOpenSession}
        />
      ) : view === "stage" ? (
        <StageView
          onBack={goBack}
          selectedPath={selectedPath}
          stageTarget={stageTarget}
          selectedTitle={
            selectedPath === null
              ? null
              : (() => {
                  const s = byPath.get(selectedPath);
                  return s ? (meta?.sessions[s.id]?.alias ?? s.title) : null;
                })()
          }
          onOpenSession={(path) => {
            showSessions();
            setSelectedPath(path);
          }}
        />
      ) : view === "stats" ? <StatsView onBack={goBack} sessionTitle={(path) => { const s = byPath.get(path); return s ? (meta?.sessions[s.id]?.alias ?? s.title) : null; }} onOpenSession={(path) => { showSessions(); setSelectedPath(path); }} /> : view === "cleanup" ? (
        <CleanupView
          onBack={goBack}
          canView={(path) => byPath.has(path)}
          onView={(path) => {
            showSessions();
            setSelectedPath(path);
          }}
          onDelete={setDeleteTargets}
          refreshToken={cleanupVersion}
        />
      ) : (
        <DetailPane
          session={selected}
          gone={selectedGone}
          checkedCount={checked.size}
          refreshKey={refreshKey}
          onOpenIterm={handleOpenIterm}
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
          metaEntry={selected ? (meta?.sessions[selected.id] ?? null) : null}
          metaRevision={meta?.revision ?? 0}
          metaError={metaError}
          onMetaSnapshot={handleMetaSnapshot}
        />
      )}
      {deleteTargets ? (
        <DeleteDialog
          targets={deleteTargets}
          requestDelete={requestDelete}
          onClose={() => setDeleteTargets(null)}
        />
      ) : null}
      {showCheatSheet ? (
        <CheatSheetDialog
          installedVersion={ompVersion}
          onClose={() => setShowCheatSheet(false)}
        />
      ) : null}
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
      <ChartTip />
    </div>
  );
}

export default App;
