/**
 * 模型测试器面板：工具条 → 标签 chips → 结果表格 → （选中行）右侧抽屉。
 * 受控组件：bench 配置、模型与角色草稿全部由 ModelsTab 下发，推荐/设为角色
 * 只回传改动，由「角色分配」统一保存。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import "./ModelTesterPanel.css";
import "./Usage.css";
import {
  modelBenchHistory,
  modelPerfList,
  normalizeError,
} from "../api";
import type { AgentDefinition, BenchRound, ModelConfig, ModelInfo, ModelPerf } from "../types";
import { errorText, formatMs, formatRate, formatTps } from "../format";
import {
  BENCH_ERROR_LABEL,
  benchRunner,
  classifyBenchError,
  addToBench,
  deriveBenchList,
  deriveTagSet,
  estimateRoundsCost,
  isPlainSelector,
  recommendChanges,
  scoreRows,
  windowStats,
  type BenchConfig,
  type BenchRowModel,
  type BenchTag,
  type BenchWindowStats,
} from "../modelBench";
import { friendlyModelName, modelProvider } from "../roleCards";
import { BenchDrawer } from "./BenchDrawer";
import { RatioCell, Sparkline, tagLabel } from "./BenchSparkline";
import { AddTagModal, ModelEntryModal } from "./ModelEntryModal";
import { BenchTagFilter } from "./BenchTagFilter";
import { BenchToolbar } from "./BenchToolbar";
import { useAlive, type ToastFn } from "./useOmpOp";
import { Play } from "lucide-react";
import { Ico } from "./ui";


/** 展示行：模型信息 + 统计 + 综合分，表格排序后的单位。 */
export interface DisplayRow {
  model: BenchRowModel;
  stats: BenchWindowStats | null;
  score: number;
  baseline: boolean;
  /** tps / 主模型 tps；无主模型数据时 null。 */
  ratio: number | null;
  perf: ModelPerf | null;
}

export interface ModelTesterPanelProps {
  onToast: ToastFn;
  /** 变化时重载历史与 perf。 */
  refreshKey?: number;
  config: BenchConfig;
  onConfigChange: (next: BenchConfig) => void;
  /** 推荐/设为角色只回传改动，由「角色分配」统一保存。 */
  onApplyRoles: (changes: Map<string, string>) => void;
  /** 规格跳转：判断某模型是否有 yml 规格；与 onEditSpec 成对出现时对话框显示「编辑规格…」。 */
  hasSpec?: (selector: string) => boolean;
  onEditSpec?: (selector: string) => void;
  models: ModelInfo[];
  modelConfig: ModelConfig;
  /** 草稿视角 roles：设为-disabled 与一键推荐按草稿算，避免重复回填。 */
  rolesOverride: Record<string, unknown>;
}

export function ModelTesterPanel(props: ModelTesterPanelProps): ReactNode {
  const { onToast, refreshKey = 0, config, onConfigChange, onApplyRoles, hasSpec, onEditSpec, models, modelConfig, rolesOverride } = props;
  const alive = useAlive();
  const histSeq = useRef(0);
  const [history, setHistory] = useState<BenchRound[]>([]);
  const [perfs, setPerfs] = useState<ModelPerf[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const runnerSnap = useSyncExternalStore(benchRunner.subscribe, benchRunner.getSnapshot);
  const runningSet = useMemo(() => new Set(runnerSnap.running), [runnerSnap.running]);

  const updateConfig = useCallback((next: BenchConfig): void => {
    onConfigChange(next);
  }, [onConfigChange]);
  const load = useCallback(async () => {
    const id = ++histSeq.current;
    try {
      const [h, p] = await Promise.all([modelBenchHistory(), modelPerfList()]);
      if (!alive.current || id !== histSeq.current) return;
      setHistory(h);
      setPerfs(p);
      setLoadError(null);
    } catch (e: unknown) {
      if (!alive.current || id !== histSeq.current) return;
      const text = errorText(normalizeError(e));
      setLoadError(text);
      onToast(`加载模型测试失败：${text}`, "error");
    } finally {
      if (alive.current && id === histSeq.current) setLoading(false);
    }
  }, [alive, onToast]);
  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, refreshKey]);

  // 重载历史：运行器有新轮次、或抽屉里删了记录时调用（后台自动刷新失败静默，界面上是旧数据）。
  const reloadHistory = useCallback((notify = false) => {
    const id = ++histSeq.current;
    modelBenchHistory()
      .then((h) => {
        if (alive.current && id === histSeq.current) setHistory(h);
      })
      .catch((e: unknown) => {
        if (notify && alive.current && id === histSeq.current) {
          onToast(`刷新记录失败：${errorText(normalizeError(e))}`, "error");
        }
      });
  }, [alive, onToast]);

  // 运行器有轮次完成 → 重载历史（补上该 selector 的新轮次）。只依赖计数器。
  const completedRuns = runnerSnap.completedRuns;
  useEffect(() => {
    if (completedRuns === 0) return;
    reloadHistory();
  }, [completedRuns, reloadHistory]);

  // 父级 rolesOverride 无引用稳定保证，浅比较内容一致时复用上次
  // 引用，避免下游 bench/tags memo 失效（ModelsTab 不得改，只能在消费侧稳定）。
  const rolesSource: Record<string, unknown> = rolesOverride;
  const rolesRef = useRef<Record<string, unknown>>(rolesSource);
  const prevRoles = rolesRef.current;
  const prevKeys = Object.keys(prevRoles);
  const nextKeys = Object.keys(rolesSource);
  const rolesSame =
    prevKeys.length === nextKeys.length && prevKeys.every((k) => Object.is(prevRoles[k], rolesSource[k]));
  if (!rolesSame) rolesRef.current = rolesSource;
  const roles: Record<string, unknown> = rolesRef.current;
  const agents: AgentDefinition[] = modelConfig.agents;

  const benchList = useMemo(() => deriveBenchList(config, roles), [config, roles]);
  const benchSelectors = useMemo(() => benchList.map((r) => r.selector), [benchList]);
  const tags: BenchTag[] = useMemo(
    () => deriveTagSet(config, roles, modelConfig.agentOverrides, agents),
    [config, roles, modelConfig, agents],
  );
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of benchList) {
      for (const t of row.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return counts;
  }, [benchList]);

  const roundsBySelector = useMemo(() => {
    const m = new Map<string, BenchRound[]>();
    for (const r of history) {
      const list = m.get(r.selector);
      if (list === undefined) m.set(r.selector, [r]);
      else list.push(r);
    }
    return m;
  }, [history]);
  const perfByBase = useMemo(() => new Map(perfs.map((p) => [p.selector, p])), [perfs]);
  const primarySelector = isPlainSelector(roles.default) ? (roles.default as string) : null;

  /** 全量展示行：stats/score/ratio 一次算好，表格/抽屉/推荐共用。 */
  const allRows: DisplayRow[] = useMemo(() => {
    const withStats = benchList.map((model) => ({
      model,
      stats: windowStats(roundsBySelector.get(model.selector) ?? []),
    }));
    const scores = scoreRows(withStats.map((r) => r.stats));
    const primaryTps =
      primarySelector === null ? null : (windowStats(roundsBySelector.get(primarySelector) ?? [])?.tpsP50 ?? null);
    return withStats.map((r, i) => ({
      model: r.model,
      stats: r.stats,
      score: scores[i],
      baseline: r.model.selector === primarySelector,
      ratio:
        r.model.selector === primarySelector || r.stats?.tpsP50 == null || primaryTps == null || primaryTps <= 0
          ? null
          : r.stats.tpsP50 / primaryTps,
      perf: perfByBase.get(r.model.base) ?? null,
    }));
  }, [benchList, roundsBySelector, perfByBase, primarySelector]);

  const displayRows: DisplayRow[] = useMemo(() => {
    const filtered = tagFilter === null ? [...allRows] : allRows.filter((r) => r.model.tags.includes(tagFilter));
    // 主模型置顶；其余综合分降序；从没测过沉底（同分按 selector 稳定）。
    filtered.sort(
      (a, b) =>
        (b.baseline ? 1 : 0) - (a.baseline ? 1 : 0) ||
        ((b.stats === null ? -1 : b.score) - (a.stats === null ? -1 : a.score)) ||
        (a.model.selector < b.model.selector ? -1 : a.model.selector > b.model.selector ? 1 : 0),
    );
    return filtered;
  }, [allRows, tagFilter]);

  const hasHistory = history.length > 0;
  const showPerfColumn = perfs.length > 0;
  const drawerRow = selected === null ? null : (allRows.find((r) => r.model.selector === selected) ?? null);

  const estimateAll = estimateRoundsCost(benchList.map((r) => r.base), models);
  const monitoredCount = benchList.filter((r) => r.monitor).length;
  const dailyEstimate =
    config.intervalMin > 0 && monitoredCount > 0
      ? estimateRoundsCost(
          benchList.filter((r) => r.monitor).map((r) => r.base),
          models,
        ) * ((24 * 60) / config.intervalMin)
      : 0;

  function stageChange(role: string, selector: string): void {
    onApplyRoles(new Map([[role, selector]]));
  }

  function handleRecommend(): void {
    const changes = recommendChanges(
      allRows.map((r) => ({ selector: r.model.selector, tags: r.model.tags, stats: r.stats, score: r.score })),
      tags,
      roles,
    );
    if (changes.size === 0) {
      onToast("没有满足条件的候选（24h 成功率≥95% 且样本≥5）", "info");
      return;
    }
    onApplyRoles(changes);
    onToast("已加入「角色分配」的待保存修改", "info");
  }

  if (loading) return <div className="pane-note">模型测试加载中…</div>;

  const filterTag = tags.find((t) => t.id === tagFilter) ?? null;
  const filterCurrent = filterTag === null ? null : roles[filterTag.id];

  function removeCustomTag(tag: string): void {
    updateConfig({
      ...config,
      customTags: config.customTags.filter((t) => t !== tag),
      entries: config.entries.map((e) => ({ ...e, tags: e.tags.filter((t) => t !== tag) })),
    });
    if (tagFilter === tag) setTagFilter(null);
  }

  return (
    <div className="manage-section bench-panel">
      {loadError !== null ? <div className="pane-note">刷新失败：{loadError}</div> : null}

      <BenchToolbar
        benchCount={benchList.length}
        selectors={benchSelectors}
        estimateAll={estimateAll}
        dailyEstimate={dailyEstimate}
        config={config}
        onUpdateConfig={updateConfig}
        onAdd={() => setAddOpen(true)}
        onRecommend={handleRecommend}
      />

      <BenchTagFilter
        tags={tags}
        tagCounts={tagCounts}
        benchCount={benchList.length}
        tagFilter={tagFilter}
        filterTag={filterTag}
        filterCurrent={filterCurrent}
        onFilter={setTagFilter}
        onRemoveCustomTag={removeCustomTag}
        onAddTag={() => setTagModalOpen(true)}
      />

      {!hasHistory ? <div className="muted bench-hint">还没有测试数据，点「测试全部」跑一轮即可看到速度与稳定性。</div> : null}
      {displayRows.length === 0 ? (
        <div className="pane-note">{tagFilter === null ? "还没有模型，点「添加模型」加一个。" : "这个标签下还没有模型。"}</div>
      ) : (
        <div className="bench-table-wrap">
        <table className="manage-table bench-table">
          <colgroup>
            <col />
            <col className="bench-col-tags" />
            <col className="bench-col-rate" />
            <col className="bench-col-ttft" />
            <col className="bench-col-tps" />
            <col className="bench-col-ratio" />
            {showPerfColumn ? <col className="bench-col-perf" /> : null}
            <col className="bench-col-trend" />
            <col className="bench-col-act" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col">标签</th>
              <th scope="col" className="bench-num">成功率</th>
              <th scope="col" className="bench-num">TTFT p50/p95</th>
              <th scope="col" className="bench-num">tok/s(±CV)</th>
              <th scope="col" className="bench-num" title="tok/s 相对主模型（基线）的倍率">对比基线</th>
              {showPerfColumn ? <th scope="col" className="bench-num">日常实测</th> : null}
              <th scope="col">趋势</th>
              <th scope="col" aria-label="操作"><span aria-hidden="true" /></th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              const { model, stats } = row;
              const name = friendlyModelName(model.base, models);
              const provider = modelProvider(model.base, models);
              const running = runningSet.has(model.selector);
              const queued = runnerSnap.queued.includes(model.selector);
              const lastError = runnerSnap.errors[model.selector];
              const classify = row.stats === null ? null : (roundsBySelector.get(model.selector) ?? []).slice(-1)[0]?.errors[0];
              return (
                <tr
                  key={model.selector}
                  className={selected === model.selector ? "bench-row bench-row-selected" : "bench-row"}
                  tabIndex={0}
                  onClick={() => setSelected(selected === model.selector ? null : model.selector)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    // 焦点在行内按钮/输入框时交给控件自己处理，避免行切换与按钮双触发。
                    if (e.target !== e.currentTarget) return;
                    e.preventDefault();
                    setSelected(selected === model.selector ? null : model.selector);
                  }}
                >
                  <td>
                    <span className="bench-model">
                      <span className="bench-name" title={model.selector}>
                        {name ?? <span className="mono">{model.selector}</span>}
                      </span>
                      {provider !== null ? <span className="badge badge-grey">{provider}</span> : null}
                      {model.thinking !== "" ? <span className="badge badge-branch">{model.thinking}</span> : null}
                      {row.baseline ? <span className="badge badge-fork">基线</span> : null}
                      {name === null ? <span className="badge badge-grey">未知值 · 保留</span> : null}
                    </span>
                    {running || queued ? (
                      <span className="bench-running"><span className="spinner" aria-hidden="true" /> 测试中…</span>
                    ) : lastError !== undefined ? (
                      <span className="bench-errline" title={lastError}>上次失败：{lastError}</span>
                    ) : classify !== undefined && classify !== null ? (
                      <span className="badge badge-danger">{BENCH_ERROR_LABEL[classifyBenchError(classify)]}</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="bench-tags">
                      {model.tags.map((t) => (
                        <span key={t} className="badge badge-tag">{tagLabel(t)}</span>
                      ))}
                    </span>
                  </td>
                  <td className="bench-num">{stats === null ? <span className="muted">未测试</span> : formatRate(stats.rate)}</td>
                  <td className="bench-num bench-nowrap">
                    {stats === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span title={stats.fallback ? "24 小时内无数据，显示最近一轮" : undefined}>
                        {formatMs(stats.ttftP50Ms)} / {formatMs(stats.ttftP95Ms)}
                      </span>
                    )}
                  </td>
                  <td className="bench-num bench-nowrap">
                    {stats === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span>
                        {formatTps(stats.tpsP50)}
                        {stats.tpsCv === null ? null : <span className="muted"> ±{(stats.tpsCv * 100).toFixed(0)}%</span>}
                      </span>
                    )}
                  </td>
                  <td className="bench-num">{row.baseline ? <span className="muted">—</span> : <RatioCell ratio={row.ratio} />}</td>
                  {showPerfColumn ? (
                    <td className="bench-num bench-nowrap">
                      {row.perf === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span title={`omp 日常记录 ${row.perf.samples} 个样本：平均生成速度 · 平均首字延迟`}>
                          {formatTps(row.perf.tps)} · {formatMs(row.perf.ttftMs)}
                        </span>
                      )}
                    </td>
                  ) : null}
                  <td>
                    <Sparkline rounds={roundsBySelector.get(model.selector) ?? []} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={`测试 ${model.selector}`}
                      disabled={running || queued}
                      onClick={(e) => {
                        e.stopPropagation();
                        benchRunner.enqueue(model.selector);
                      }}
                    >
                      <Ico icon={Play} size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {drawerRow !== null ? (
        <BenchDrawer
          row={drawerRow}
          models={models}
          rounds={roundsBySelector.get(drawerRow.model.selector) ?? []}
          tags={tags}
          config={config}
          roles={roles}
          onClose={() => setSelected(null)}
          onUpdateConfig={updateConfig}
          onStage={(tag) => stageChange(tag, drawerRow.model.selector)}
          onToast={onToast}
          onAddTag={() => setTagModalOpen(true)}
          onEdit={() => setEditTarget(drawerRow.model.selector)}
          onRecordsChanged={() => reloadHistory(true)}
        />
      ) : null}

      {addOpen ? (
        <ModelEntryModal
          mode="add"
          models={models}
          existing={new Set(benchSelectors)}
          customTags={config.customTags}
          onClose={() => setAddOpen(false)}
          onSave={(selector, outTags) => {
            updateConfig(addToBench(config, selector, outTags));
            setAddOpen(false);
          }}
          hasSpec={hasSpec}
          onEditSpec={onEditSpec}
        />
      ) : null}
      {editTarget !== null ? (
        <ModelEntryModal
          mode="edit"
          models={models}
          existing={new Set(benchSelectors.filter((s) => s !== editTarget))}
          customTags={config.customTags}
          initial={(() => { const found = config.entries.find((e) => e.selector === editTarget); return found === undefined ? { selector: editTarget, tags: [] } : { selector: found.selector, tags: found.tags }; })()}
          onClose={() => setEditTarget(null)}
          onSave={(selector, outTags) => {
            const prev = config.entries.find((e) => e.selector === editTarget);
            const kept = prev === undefined ? { tags: outTags, monitor: false } : { tags: outTags, monitor: prev.monitor };
            updateConfig({
              ...config,
              entries: [
                ...config.entries.filter((e) => e.selector !== editTarget),
                { selector, ...kept },
              ],
            });
            setEditTarget(null);
            setSelected(selector);
          }}
          hasSpec={hasSpec}
          onEditSpec={onEditSpec}
        />
      ) : null}
      {tagModalOpen ? (
        <AddTagModal
          existing={new Set(tags.map((t) => t.id))}
          onClose={() => setTagModalOpen(false)}
          onAdd={(tag) => {
            updateConfig({ ...config, customTags: [...config.customTags, tag] });
            setTagModalOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

