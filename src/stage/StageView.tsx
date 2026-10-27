/**
 * 舞台视图（CONTRACT §23）：左栏运行中/回看列表 + 舞台画布 + 筛选条 +
 * 角色卡片行 + 甘特时间线 + 活动流 + 角色库。
 *
 * 只读：没有任何停止/发送按钮（CONTRACT §17 禁止对 omp 会话发信号）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, formatUsd } from "../format";
import type { StageActor, StageActorState } from "../types";
import { ActivityFeed } from "./ActivityFeed";
import { ActorCards } from "./ActorCards";
import { AgentConfigPanel } from "./AgentConfigPanel";
import { AgentLibrary } from "./AgentLibrary";
import { StageCanvas } from "./StageCanvas";
import { TimelineChart } from "./TimelineChart";
import { useAgentCatalog } from "./agentCatalog";
import { buildTimeline } from "./timeline";
import { agentKeyOf, loadStagePrefs, type StagePrefs } from "./prefs";
import { STATE_WORD } from "./stateWords";
import { useRunningSessions, useStagePoll } from "./useStageData";
import { EmptyState } from "../components/ui";
import { Theater } from "lucide-react";
import "./Stage.css";

export interface StageViewProps {
  onBack: () => void;
  selectedPath: string | null;
  /** App 转发的侧栏点击请求（path 相同也可能需要切换，seq 区分每次点击）。 */
  stageTarget: { path: string; seq: number } | null;
  selectedTitle: string | null;
  onOpenSession: (path: string) => void;
}

/** 筛选档位：`null` = 全部。 */
interface FilterDef {
  key: string;
  label: string;
  states: StageActorState[] | null;
}

const FILTERS: FilterDef[] = [
  { key: "all", label: "全部", states: null },
  { key: "running", label: "运行中", states: ["running", "queued"] },
  { key: "idle", label: "待命", states: ["idle"] },
  { key: "done", label: "完成", states: ["done"] },
  { key: "bad", label: "异常", states: ["failed", "lost"] },
];

function mmss(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function StageView({ onBack, selectedPath, stageTarget, selectedTitle, onOpenSession }: StageViewProps) {
  const running = useRunningSessions();
  const [stagePath, setStagePath] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<StagePrefs>(() => loadStagePrefs());
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [theme, setTheme] = useState<string | undefined>(() =>
    typeof document === "undefined" ? undefined : document.documentElement.dataset.theme,
  );
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  // App 的 stageTarget 从不清空：挂载时记住当时的 seq，只消费挂载后发出的新请求，
  // 否则上次进舞台的旧请求会在挂载时重放，覆盖默认选择。
  const mountSeq = useRef(stageTarget?.seq ?? -1);

  // 默认选择：第一个运行中会话 → App 传入的选中会话 → 都没有则空态。
  // 空态下迟到的运行中会话也会被采纳（否则用户得退回再进来一次）。
  useEffect(() => {
    if (stagePath !== null) return;
    if (running.length > 0) setStagePath(running[0].path);
    else if (selectedPath !== null) setStagePath(selectedPath);
  }, [running, selectedPath, stagePath]);

  const { stage, error } = useStagePoll(stagePath);
  const catalog = useAgentCatalog(libraryOpen || selectedId !== null);

  // 舞台内点侧栏会话：每次点击都带 seq，即使 path 没变也切换（不离开舞台）。
  useEffect(() => {
    if (stageTarget === null || stageTarget.seq <= mountSeq.current) return;
    setStagePath(stageTarget.path);
    setSelectedId(null);
  }, [stageTarget]);

  // 主题变化（外观面板切换）时重取调色板。
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const el = document.documentElement;
    const mo = new MutationObserver(() => setTheme(el.dataset.theme));
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // 头部「已运行」每秒刷新。
  useEffect(() => {
    const timer = window.setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 数据变化时若选中角色消失则清选。
  useEffect(() => {
    if (selectedId === null || stage === null) return;
    if (!stage.actors.some((a) => a.id === selectedId)) setSelectedId(null);
  }, [stage, selectedId]);

  const filter = useMemo(() => {
    const def = FILTERS.find((f) => f.key === filterKey);
    return def?.states === null || def === undefined ? null : new Set(def.states);
  }, [filterKey]);

  const visible = useMemo(() => {
    if (stage === null) return [];
    if (filter === null) return stage.actors;
    return stage.actors.filter((a) => a.kind === "main" || filter.has(a.state));
  }, [stage, filter]);

  const timeline = useMemo(
    () => buildTimeline(stage?.actors ?? [], Date.now()),
    [stage],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, running: 0, idle: 0, done: 0, bad: 0 };
    for (const a of stage?.actors ?? []) {
      c.all += 1;
      if (a.state === "running" || a.state === "queued") c.running += 1;
      else if (a.state === "idle") c.idle += 1;
      else if (a.state === "done") c.done += 1;
      else c.bad += 1;
    }
    return c;
  }, [stage]);

  const moveSelection = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((a) => a.id === selectedId);
      const next = index < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, index + delta));
      setSelectedId(visible[next].id);
    },
    [visible, selectedId],
  );

  // Esc 清选：捕获阶段拦下，避免同时退出视图（App 的冒泡监听）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || selectedId === null) return;
      if (document.querySelector(".modal-overlay") !== null) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedId(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [selectedId]);

  // 全部角色的状态变化都播报（第一次拿到数据不算变化）。
  const [announce, setAnnounce] = useState("");
  const lastStates = useRef<Map<string, StageActorState> | null>(null);
  useEffect(() => {
    lastStates.current = null;
    setAnnounce("");
  }, [stagePath]);
  useEffect(() => {
    if (stage === null) return;
    const next = new Map(stage.actors.map((a) => [a.id, a.state] as const));
    const prev = lastStates.current;
    lastStates.current = next;
    if (prev === null) return;
    const changed: string[] = [];
    for (const actor of stage.actors) {
      if (prev.get(actor.id) === actor.state) continue;
      changed.push(`${actor.name} ${STATE_WORD[actor.state]}`);
    }
    if (changed.length === 0) return;
    const head = changed.slice(0, 3).join("，");
    setAnnounce(changed.length > 3 ? `${head} 等 ${changed.length} 个角色状态变化` : head);
  }, [stage]);

  if (stagePath === null) {
    return (
      <main className="detail stage-view">
        <header className="detail-head">
          <div className="detail-title-row">
            <h1 className="detail-title">舞台</h1>
            <button type="button" className="btn" onClick={onBack}>返回</button>
          </div>
        </header>
        <div className="stage-empty">
          <EmptyState icon={Theater} title="没有运行中的会话">
            在左侧选择一个会话，可回看它的子代理舞台。
          </EmptyState>
        </div>
      </main>
    );
  }

  // 已运行：从主会话 startedAt 算起（每秒刷新）；已结束则不显示时长。
  const mainStarted = stage?.actors[0]?.startedAt ?? null;
  const startedSecs = mainStarted === null ? null : Math.floor(Date.parse(mainStarted) / 1000);
  const elapsedSecs =
    startedSecs === null || Number.isNaN(startedSecs) ? 0 : Math.max(0, nowSecs - startedSecs);

  const subagents = stage?.actors.filter((a) => a.kind === "subagent" || a.kind === "worker") ?? [];
  const selectedActor: StageActor | null =
    stage?.actors.find((a) => a.id === selectedId) ?? null;
  const stageAgents = [...new Set((stage?.actors ?? []).map(agentKeyOf))];
  const runningSubagents = subagents.filter((a) => a.state === "running").length;
  const totalCost = (stage?.actors ?? []).reduce((sum, a) => sum + a.cost, 0);
  const totalTools = (stage?.actors ?? []).reduce((sum, a) => sum + a.toolCalls, 0);

  return (
    <main className="detail stage-view">
      <header className="detail-head">
        <div className="detail-title-row">
          <h1 className="detail-title">舞台</h1>
          {stage !== null && !stage.inUse ? <span className="stage-badge">回看</span> : null}
          <span className="stage-head-title">{stage?.title ?? selectedTitle ?? "加载中…"}</span>
          <span className="stage-head-spacer" />
          {stage !== null ? (
            <button type="button" className="btn" onClick={() => onOpenSession(stage.path)}>
              查看会话
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onBack}>返回</button>
        </div>
        {stage !== null ? (
          <div className="detail-meta stage-meta">
            <span>{stage.inUse ? `已运行 ${mmss(elapsedSecs)}` : "已结束"}</span>
            <span>子代理 {runningSubagents}/{subagents.length}</span>
            <span>合计花费 {formatUsd(totalCost)}</span>
            <span>工具调用 {totalTools}</span>
            {stage.omitted > 0 ? <span>已省略 {stage.omitted} 个文件</span> : null}
          </div>
        ) : null}
      </header>

      <div className="stage-body">
        <aside className="stage-rail" aria-label="会话选择">
          <div className="stage-rail-group">
            <h2 className="stage-rail-head">运行中</h2>
            {running.length === 0 ? (
              <p className="stage-rail-note">没有运行中的会话</p>
            ) : (
              running.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  className={r.path === stagePath ? "stage-rail-item stage-rail-active" : "stage-rail-item"}
                  onClick={() => {
                    setStagePath(r.path);
                    setSelectedId(null);
                  }}
                >
                  <span className="stage-rail-title">{r.title}</span>
                  <span className="stage-rail-meta">
                    <span className={`stage-dot stage-dot-${r.status}`} aria-hidden="true" />
                    {r.statusText}
                    {r.subagents > 0 ? <span className="stage-chip">子 {r.subagents}</span> : null}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="stage-rail-group">
            <h2 className="stage-rail-head">回看会话</h2>
            {selectedPath === null || running.some((r) => r.path === selectedPath) ? (
              <p className="stage-rail-note">
                {selectedPath === null ? "先在左侧选一个会话" : "当前会话已在运行中分组"}
              </p>
            ) : (
              <button
                type="button"
                className={selectedPath === stagePath ? "stage-rail-item stage-rail-active" : "stage-rail-item"}
                onClick={() => {
                  setStagePath(selectedPath);
                  setSelectedId(null);
                }}
              >
                <span className="stage-rail-title">{selectedTitle ?? selectedPath.split("/").pop()}</span>
                <span className="stage-rail-meta">只读回看</span>
              </button>
            )}
          </div>
        </aside>

        <section className="stage-main">
          {error !== null ? (
            <p className="pane-note">
              {error.code === "NOT_FOUND"
                ? "会话文件不存在（可能已被删除）"
                : error.code === "UNSUPPORTED_FORMAT"
                  ? "该会话格式暂不支持"
                  : errorText(error)}
            </p>
          ) : stage === null ? (
            <p className="pane-note">加载舞台…</p>
          ) : (
            <>
              <StageCanvas
                stage={stage}
                prefs={prefs}
                filter={filter}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOpenLibrary={() => setLibraryOpen(true)}
                theme={theme}
              />
              {stage.actors.length === 1 ? (
                <p className="stage-empty-note">该会话没有子代理。</p>
              ) : null}
              <div className="stage-filters" role="group" aria-label="按状态筛选">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={f.key === filterKey ? "btn btn-small stage-filter-active" : "btn btn-small"}
                    aria-pressed={f.key === filterKey}
                    onClick={() => setFilterKey(f.key)}
                  >
                    {f.label} {counts[f.key] ?? 0}
                  </button>
                ))}
              </div>
              <ActorCards
                actors={visible}
                prefs={prefs}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={moveSelection}
              />
              <div className="stage-lower">
                <div className="stage-panel">
                  <h2 className="stage-panel-head">时间线</h2>
                  <TimelineChart timeline={timeline} selectedId={selectedId} onSelect={setSelectedId} />
                </div>
                <div className="stage-panel">
                  <h2 className="stage-panel-head">活动流</h2>
                  {selectedActor !== null ? (
                    <details className="stage-agent-config" open>
                      <summary>Agent 配置 · {agentKeyOf(selectedActor)}</summary>
                      <AgentConfigPanel
                        entryKey={agentKeyOf(selectedActor)}
                        actor={selectedActor}
                        catalog={catalog}
                      />
                    </details>
                  ) : null}
                  <ActivityFeed actors={stage.actors} selectedId={selectedId} onSelect={setSelectedId} />
                </div>
              </div>
            </>
          )}
          <p className="sr-only" aria-live="polite">{announce}</p>
        </section>
      </div>
      {libraryOpen ? (
        <AgentLibrary
          prefs={prefs}
          onChange={setPrefs}
          onClose={() => setLibraryOpen(false)}
          catalog={catalog}
          stageAgents={stageAgents}
        />
      ) : null}
    </main>
  );
}
