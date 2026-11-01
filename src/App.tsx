/** 应用外壳：标题栏 + 导航 + 路由页面、刷新保持选择、删除与提示编排。 */
import "./App.css";
import "./components/shell/Shell.css";
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
import { applyPins, canFocusRefresh, collectTagCounts, filterByTags, filterGroups, filterGroupsByStatus, filterSessions, filterSessionsByStatus, filterSessionsByTags, retainExisting, statusCounts, type SessionFilter } from "./listUtils";
import { planBulkResume } from "./bulkResume";
import { runContinueFromNode, type ContinueOutcome, type DeleteTarget } from "./flows";
import { loadPins, removeSessionPins, savePins, togglePin, type PinKind, type Pins } from "./pins";
import { loadAppPrefs, saveAppPrefs } from "./appPrefs";
import { useAppearance } from "./useAppearance";
import { isConfigRoute, type Route } from "./routes";
import { ErrorBanner } from "./components/page";
import { Titlebar } from "./components/shell/Titlebar";
import { NavSidebar } from "./components/shell/NavSidebar";
import { CommandPalette } from "./components/shell/CommandPalette";
import { SessionsPage } from "./components/SessionsPage";
import { SessionWorkspace } from "./components/SessionWorkspace";
import { BulkResumeDialog } from "./components/BulkResumeDialog";
import { PromptHistoryView } from "./components/PromptHistoryView";
import { ManageView } from "./components/ManageView";
import { StatsView } from "./components/StatsView";
import { StageView } from "./stage/StageView";
import { CleanupView } from "./components/CleanupView";
import { ChartTip } from "./components/ChartTip";
import { OmpUpdateDialog } from "./components/OmpUpdateDialog";
import { DeleteDialog } from "./components/DeleteDialog";
import { CheatSheetView } from "./components/CheatSheetView";
import { TrayView } from "./components/TrayView";
import { SettingsView } from "./components/SettingsView";
import { UpdateDialog } from "./components/UpdateDialog";
import { checkForUpdate, checkForUpdateManually, onCheckAppUpdateRequest, type Update } from "./update";
import { onOpenTraySettingsRequest } from "./traySettings";
import { getVersion } from "@tauri-apps/api/app";

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

const MAX_TOASTS = 5;

function App() {
  const [list, setList] = useState<ListSessionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<AppError | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SessionFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // 行内「备注」请求：seq 区分每次点击，DetailPane 消费后展开备注编辑器。
  const [metaRequest, setMetaRequest] = useState<{ path: string; seq: number } | null>(null);
  // 舞台内点侧栏会话：即使 path 没变（重复点同一行），seq 递增也会让 StageView 收到切换请求。
  const [stageTarget, setStageTarget] = useState<{ path: string; seq: number } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<DeleteTarget[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // 路由栈：栈顶是当前路由；同族路由（usage/health、配置类）切换时常驻组件不卸载。
  const [history, setHistory] = useState<Route[]>(["sessions"]);
  const route = history[history.length - 1];
  const navigate = useCallback((next: Route) => {
    setHistory((prev) => (prev[prev.length - 1] === next ? prev : [...prev, next]));
  }, []);
  const goBack = useCallback(() => {
    setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);
  /** 看/选某个会话：选中并进工作台。 */
  const openSession = useCallback(
    (path: string) => {
      setSelectedPath(path);
      navigate("session");
    },
    [navigate],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [prefs, setPrefs] = useState(() => loadAppPrefs());
  const appearance = useAppearance();
  // 清理候选项在每次删除后要重新扫描（只读命令，代价可接受）。
  const [cleanupVersion, setCleanupVersion] = useState(0);
  // 自动更新：启动时静默检查一次，有新版本才弹窗；失败静默忽略，不阻塞列表。
  // 手动检查：侧栏「检查应用更新」/托盘「检查更新…」。
  const [update, setUpdate] = useState<Update | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [appChecking, setAppChecking] = useState(false);
  const appCheckingRef = useRef(false);
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
  // 应用偏好变更即持久化（侧栏折叠、启动检查更新）。
  useEffect(() => {
    saveAppPrefs(prefs);
  }, [prefs]);

  // 启动时检查一次更新（checkForUpdate 内部已处理 DEV 跳过与静默失败）。
  // 用户可在设置页关闭启动检查。
  const checkOnLaunch = prefs.checkUpdateOnLaunch;
  useEffect(() => {
    if (!checkOnLaunch) return;
    let cancelled = false;
    void checkForUpdate().then((u) => {
      if (!cancelled && u) setUpdate(u);
    });
    return () => {
      cancelled = true;
    };
  }, [checkOnLaunch]);

  // 启动时读取本机 omp 版本；失败（未安装等）静默，侧栏不显示版本行。
  useEffect(() => {
    getOmpVersion()
      .then((v) => setOmpVersion(v.version))
      .catch(() => {});
  }, []);

  // 本应用版本（侧栏版本行）；读不到就不显示。
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
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

  // 统一返回：Esc 从非会话列表路由退回上一级（对话框自己先吃掉 Esc）。
  useEffect(() => {
    if (route === "sessions") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (paletteOpen) return;
      if (document.querySelector(".modal-overlay") !== null) return;
      if (document.querySelector('[role="complementary"]') !== null) return;
      goBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [route, goBack, paletteOpen]);

  const toggleCollapse = useCallback(() => {
    setPrefs((prev) => ({ ...prev, sidebarCollapsed: !prev.sidebarCollapsed }));
  }, []);

  const toggleTheme = useCallback(() => {
    appearance.setMode(appearance.resolved === "dark" ? "light" : "dark");
  }, [appearance]);

  // 全局快捷键：⌘K 命令面板（输入态也生效）；⌘B 折叠；⌘N 新会话；⌘, 设置。
  // handleNewSession 在下方声明，这里用 ref 桥接避免重排整个组件。
  const newSessionRef = useRef<(cwd: string | null) => Promise<void>>(async () => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      const t = e.target as HTMLElement | null;
      const inInput =
        t !== null &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (key === "b") {
        if (inInput) return;
        e.preventDefault();
        toggleCollapse();
      } else if (key === "n") {
        if (inInput) return;
        if (document.querySelector(".modal-overlay") !== null) return;
        e.preventDefault();
        void newSessionRef.current(null);
      } else if (key === ",") {
        e.preventDefault();
        navigate("settings");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, toggleCollapse]);

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
  const counts = useMemo(() => statusCounts(list?.groups ?? [], pins), [list, pins]);
  const groups = useMemo(
    () =>
      filterGroups(
        filterGroupsByStatus(filterByTags(pinnedSplit.groups, activeTags, meta), statusFilter, pins),
        query,
        meta,
      ),
    [pinnedSplit, activeTags, statusFilter, pins, query, meta],
  );
  // 置顶区与分组用同一过滤口径；无匹配时整区隐藏（SessionList 按空数组处理）。
  const pinnedSessions = useMemo(
    () =>
      filterSessions(
        filterSessionsByStatus(
          filterSessionsByTags(pinnedSplit.pinnedSessions, activeTags, meta),
          statusFilter,
          pins,
        ),
        query,
        meta,
      ),
    [pinnedSplit, activeTags, statusFilter, pins, query, meta],
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
  // 快捷键 effect 在上方声明：这里把最新回调写入 ref 供 ⌘N 使用。
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
  newSessionRef.current = handleNewSession;
  // 提示词历史「跳到来源会话」：进工作台并选中该会话（不在列表中则无操作）。
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      for (const s of byPath.values()) {
        if (s.id !== sessionId) continue;
        openSession(s.path);
        return;
      }
    },
    [byPath, openSession],
  );

  /** 工作台「舞台」：进舞台回看该会话（seq 递增保证重复进入也切换）。 */
  const handleOpenStage = useCallback(
    (path: string) => {
      setStageTarget((prev) => ({ path, seq: (prev?.seq ?? -1) + 1 }));
      navigate("stage");
    },
    [navigate],
  );

  /** 行内「备注」：选中会话并进工作台，DetailPane 消费 metaRequest 后展开编辑器。 */
  const handleOpenMeta = useCallback(
    (path: string) => {
      setSelectedPath(path);
      setMetaRequest((prev) => ({ path, seq: (prev?.seq ?? -1) + 1 }));
      navigate("session");
    },
    [navigate],
  );

  const [bulkTargets, setBulkTargets] = useState<SessionSummary[] | null>(null);
  const bulkPlan = useMemo(() => (bulkTargets ? planBulkResume(bulkTargets) : null), [bulkTargets]);

  /** 批量恢复确认：顺序打开 iTerm，ITERM_FAILED 立即停止，其余错误计数后继续。 */
  const runBulkResume = useCallback(
    async (open: SessionSummary[]) => {
      let ok = 0;
      let fail = 0;
      let firstError: string | null = null;
      for (const s of open) {
        try {
          await openInIterm({ path: s.path });
          ok += 1;
        } catch (e: unknown) {
          const err = normalizeError(e);
          if (firstError === null) firstError = errorText(err);
          fail += 1;
          if (err.code === "ITERM_FAILED") break;
        }
      }
      setBulkTargets(null);
      const text =
        fail > 0 && firstError !== null
          ? `已打开 ${ok} 个 iTerm 标签页，${fail} 个失败：${firstError}`
          : `已打开 ${ok} 个 iTerm 标签页`;
      addToast(text, fail > 0 ? "error" : "info");
    },
    [addToast],
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
      // 工作台当前会话被删：栈顶替换为会话列表。
      const deletedPaths = new Set(results.filter((r) => r.ok).map((r) => r.path));
      if (selectedPath !== null && deletedPaths.has(selectedPath)) {
        setHistory((prev) =>
          prev[prev.length - 1] === "session" ? [...prev.slice(0, -1), "sessions"] : prev,
        );
      }
      return results;
    },
    [byPath, load, loadMeta, deleteTargets, selectedPath],
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

  const handleCheckApp = useCallback(async () => {
    // 更新窗已开或检查进行中：不重复检查。
    if (update !== null || appCheckingRef.current) return;
    appCheckingRef.current = true;
    setAppChecking(true);
    try {
      const u = await checkForUpdateManually();
      if (u) setUpdate(u);
      else addToast(appVersion ? `已是最新版本 ${appVersion}` : "已是最新版本", "info");
    } catch (e: unknown) {
      addToast(`检查更新失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      appCheckingRef.current = false;
      setAppChecking(false);
    }
  }, [addToast, appVersion, update]);

  // 托盘「设置 ▸ 检查更新…」：Rust 拉起主窗口后发事件，这里走与侧栏按钮相同的流程。
  const checkAppRef = useRef(handleCheckApp);
  checkAppRef.current = handleCheckApp;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onCheckAppUpdateRequest(() => void checkAppRef.current())
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 托盘「设置 ▸ 更多菜单栏设置…」：切到菜单栏页。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onOpenTraySettingsRequest(() => navigate("tray"))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate]);

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

  const sessionName =
    selected === null ? null : (meta?.sessions[selected.id]?.alias ?? selected.title);
  const paletteSessions = useMemo(
    () => [...byPath.values()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list],
  );

  let page: React.ReactNode;
  if (route === "usage" || route === "health") {
    page = (
      <StatsView
        key="stats"
        tab={route}
        onToast={addToast}
        sessionTitle={(path) => {
          const s = byPath.get(path);
          return s ? (meta?.sessions[s.id]?.alias ?? s.title) : null;
        }}
        onOpenSession={openSession}
      />
    );
  } else if (isConfigRoute(route)) {
    page = (
      <ManageView
        key="manage"
        projects={manageProjects}
        onToast={addToast}
        tab={route}
        onCheckOmp={handleCheckOmp}
        loadedSessionIds={loadedSessionIds}
        onOpenSession={handleOpenSession}
      />
    );
  } else if (route === "history") {
    page = (
      <PromptHistoryView
        loadedSessionIds={loadedSessionIds}
        onOpenSession={handleOpenSession}
        onNewSessionIn={(cwd) => void handleNewSession(cwd)}
        onToast={addToast}
      />
    );
  } else if (route === "stage") {
    page = (
      <StageView
        selectedPath={selectedPath}
        stageTarget={stageTarget}
        selectedTitle={sessionName}
        onOpenSession={openSession}
      />
    );
  } else if (route === "cleanup") {
    page = (
      <CleanupView
        canView={(path) => byPath.has(path)}
        onView={openSession}
        onDelete={setDeleteTargets}
        refreshToken={cleanupVersion}
      />
    );
  } else if (route === "session") {
    page = (
      <SessionWorkspace
        groups={groups}
        pinnedSessions={pinnedSessions}
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
        onSelectPath={setSelectedPath}
        onOpenMeta={handleOpenMeta}
        onBulkResume={(targets) => setBulkTargets(targets)}
        collapsed={collapsed}
        onCollapsedChange={(next) => setCollapsed(next)}
        pins={pins}
        onTogglePin={handleTogglePin}
        onNewSessionIn={(cwd) => void handleNewSession(cwd)}
        meta={meta}
        tagCounts={tagCounts}
        activeTags={activeTags}
        onToggleTag={handleToggleTag}
        onToast={addToast}
        onOpenIterm={handleOpenIterm}
        onRequestDelete={handleRequestDelete}
        onMetaSnapshot={handleMetaSnapshot}
        session={selected}
        gone={selectedGone}
        refreshKey={refreshKey}
        onOpenStage={handleOpenStage}
        onBack={() => navigate("sessions")}
        metaRequest={metaRequest}
        onDeleteSession={() => {
          if (selected) handleRequestDelete([selected.path]);
        }}
        onContinue={handleContinue}
        pinned={selectedPinned}
        onToggleSessionPin={() => {
          if (selected) handleTogglePin("session", selected.id);
        }}
        metaEntry={selected ? (meta?.sessions[selected.id] ?? null) : null}
        metaRevision={meta?.revision ?? 0}
        metaError={metaError}
      />
    );
  } else if (route === "cheatsheet") {
    page = <CheatSheetView installedVersion={ompVersion} />;
  } else if (route === "settings") {
    page = (
      <SettingsView
        appearance={appearance.appearance}
        onSetMode={appearance.setMode}
        onSetAccent={appearance.setAccent}
        prefs={prefs}
        onPrefs={setPrefs}
        appVersion={appVersion}
        appChecking={appChecking}
        ompVersion={ompVersion}
        ompChecking={ompChecking}
        onCheckApp={() => void handleCheckApp()}
        onCheckOmp={handleCheckOmp}
        onNavigate={navigate}
        onToast={addToast}
      />
    );
  } else if (route === "tray") {
    page = (
      <TrayView sessions={paletteSessions} onOpenSession={openSession} onToast={addToast} />
    );
  } else {
    const visibleCount =
      pinnedSessions.length + groups.reduce((n, g) => n + g.sessions.length, 0);
    page = (
      <SessionsPage
        groups={groups}
        pinnedSessions={pinnedSessions}
        counts={counts}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        visibleCount={visibleCount}
        runningCount={counts.running}
        totalCount={totalCount}
        hiddenEmpty={list?.hiddenEmpty ?? 0}
        query={query}
        onQuery={setQuery}
        loading={loading}
        listError={listError}
        onRetry={() => void load()}
        onRefresh={() => void load()}
        onRescan={() => void load()}
        onNewSession={() => void handleNewSession(null)}
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
        onOpenSession={openSession}
        onOpenMeta={handleOpenMeta}
        onBulkResume={(targets) => setBulkTargets(targets)}
        collapsed={collapsed}
        onCollapsedChange={(next) => setCollapsed(next)}
        pins={pins}
        onTogglePin={handleTogglePin}
        onNewSessionIn={(cwd) => void handleNewSession(cwd)}
        meta={meta}
        tagCounts={tagCounts}
        activeTags={activeTags}
        onToggleTag={handleToggleTag}
        onClearFilters={() => {
          setQuery("");
          setActiveTags([]);
          setStatusFilter("all");
        }}
        onToast={addToast}
        onOpenIterm={handleOpenIterm}
        onRequestDelete={handleRequestDelete}
        onMetaSnapshot={handleMetaSnapshot}
      />
    );
  }

  return (
    <div className="app">
      <Titlebar
        route={route}
        sessionName={route === "session" ? sessionName : null}
        collapsed={prefs.sidebarCollapsed}
        onToggleCollapse={toggleCollapse}
        onOpenPalette={() => setPaletteOpen(true)}
        resolved={appearance.resolved}
        onSetMode={appearance.setMode}
      />
      <div className={prefs.sidebarCollapsed ? "shell shell-collapsed" : "shell"}>
        <NavSidebar
          route={route}
          collapsed={prefs.sidebarCollapsed}
          totalCount={totalCount}
          appVersion={appVersion}
          appChecking={appChecking}
          ompVersion={ompVersion}
          ompChecking={ompChecking}
          onNavigate={navigate}
          onCheckApp={() => void handleCheckApp()}
          onCheckOmp={handleCheckOmp}
          onToast={addToast}
        />
        <main className="main-pane">{page}</main>
      </div>
      {deleteTargets ? (
        <DeleteDialog
          targets={deleteTargets}
          requestDelete={requestDelete}
          onClose={() => setDeleteTargets(null)}
        />
      ) : null}
      {bulkTargets !== null && bulkPlan !== null ? (
        <BulkResumeDialog
          total={bulkTargets.length}
          plan={bulkPlan}
          onCancel={() => setBulkTargets(null)}
          onConfirm={() => void runBulkResume(bulkPlan.open)}
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
        {listError ? <ErrorBanner error={listError} onRetry={() => void load()} /> : null}
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
      {paletteOpen ? (
        <CommandPalette
          sessions={paletteSessions}
          meta={meta}
          onNavigate={navigate}
          onOpenSession={openSession}
          onNewSession={() => void handleNewSession(null)}
          onRescan={() => void load()}
          onToggleTheme={toggleTheme}
          onCheckApp={() => void handleCheckApp()}
          onCheckOmp={handleCheckOmp}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
    </div>
  );
}

export default App;
