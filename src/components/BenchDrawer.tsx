/**
 * bench 行抽屉：标签开关、监控开关、设为角色、编辑/删除、KPI、图表、最近错误。
 * 从 ModelTesterPanel.tsx 逐字拆出，无行为变化。
 */
import { useState, type ReactNode } from "react";
import type { BenchRound, ModelInfo } from "../types";
import {
  BENCH_ERROR_LABEL,
  bucketizeRounds,
  classifyBenchError,
  formatMs,
  formatRate,
  formatTps,
  formatUsd,
  rangeStats,
  type BenchBucketUnit,
  type BenchConfig,
  type BenchTag,
} from "../modelBench";
import { friendlyModelName, modelProvider } from "../roleCards";
import { tagLabel } from "./BenchSparkline";
import { Drawer } from "./Drawer";
import { BenchRateChart, BenchTpsChart } from "./UsageCharts";
import type { ToastFn } from "./useOmpOp";
import type { DisplayRow } from "./ModelTesterPanel";

export interface BenchDrawerProps {
  row: DisplayRow;
  models: ModelInfo[];
  rounds: BenchRound[];
  tags: BenchTag[];
  config: BenchConfig;
  roles: Record<string, unknown>;
  /** 受控保存模式：设为角色的 toast 指向「角色分配」。 */
  applyHint?: boolean;
  onClose: () => void;
  onUpdateConfig: (c: BenchConfig) => void;
  onStage: (tag: string) => void;
  onToast: ToastFn;
  onAddTag: () => void;
  onEdit: () => void;
}

export function BenchDrawer(props: BenchDrawerProps): ReactNode {
  const { row, models, rounds, tags, config, roles, applyHint = false, onClose, onUpdateConfig, onStage, onToast, onAddTag, onEdit } = props;
  const [unit, setUnit] = useState<BenchBucketUnit>("hour");
  const { model } = row;
  const entry = config.entries.find((e) => e.selector === model.selector) ?? null;
  const deletable = model.usedByRoles.length === 0;
  const usedByNames = model.usedByRoles.map(tagLabel).join("、");

  const rangeMs = unit === "hour" ? 24 * 3600000 : 7 * 24 * 3600000;
  const kpis = rangeStats(rounds, rangeMs);
  const buckets = bucketizeRounds(rounds, unit);
  const latestErrors = rounds.length === 0 ? [] : (rounds[rounds.length - 1].errors ?? []);
  const name = friendlyModelName(model.base, models);
  const provider = modelProvider(model.base, models);

  function toggleEntryTag(tag: string): void {
    const tags = entry === null ? [] : entry.tags;
    const nextTags = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
    const next = entry === null
      ? [...config.entries, { selector: model.selector, tags: nextTags, monitor: false }]
      : config.entries.map((e) => (e.selector === model.selector ? { ...e, tags: nextTags } : e));
    onUpdateConfig({ ...config, entries: next });
  }

  function toggleMonitor(): void {
    const next = entry === null
      ? [...config.entries, { selector: model.selector, tags: [], monitor: true }]
      : config.entries.map((e) => (e.selector === model.selector ? { ...e, monitor: !e.monitor } : e));
    onUpdateConfig({ ...config, entries: next });
  }

  function handleDelete(): void {
    if (!deletable) return;
    onUpdateConfig({ ...config, entries: config.entries.filter((e) => e.selector !== model.selector) });
    onClose();
  }

  return (
    <Drawer
      label={`模型 ${model.selector}`}
      title={<span className="mono">{model.selector}</span>}
      onClose={onClose}
    >
      <div className="bench-drawer-meta">
        <span>{name ?? "未知模型"}</span>
        {provider !== null ? <span className="badge badge-grey">{provider}</span> : null}
        {model.thinking !== "" ? <span className="badge badge-branch">思考强度：{model.thinking}</span> : null}
      </div>

      <div className="bench-drawer-block">
        <div className="bench-drawer-title">标签</div>
        <div className="bench-chips">
          {tags.map((t) => {
            const on = model.tags.includes(t.id);
            const implicit = model.usedByRoles.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                className={on ? "tag-chip tag-chip-on" : "tag-chip"}
                aria-pressed={on}
                disabled={implicit}
                title={implicit ? `正在被${t.label}角色使用，自动带有该标签` : undefined}
                onClick={() => toggleEntryTag(t.id)}
              >
                {t.label}
              </button>
            );
          })}
          <button type="button" className="tag-chip" aria-label="添加自定义标签" onClick={onAddTag}>+</button>
        </div>
      </div>

      <div className="bench-drawer-block">
        <label className="bench-check">
          <input type="checkbox" checked={entry?.monitor ?? false} onChange={toggleMonitor} />
          定时监控这个模型
        </label>
        {model.tags.length > 0 ? (
          <div className="bench-setrole">
            {model.tags.map((t) => (
              <button
                key={t}
                type="button"
                className="btn btn-small"
                disabled={roles[t] === model.selector}
                title={roles[t] === model.selector ? "已经是该角色的模型" : applyHint ? `加入「角色分配」的待保存：${tagLabel(t)} → ${model.selector}` : `把待保存改成 ${tagLabel(t)} → ${model.selector}`}
                onClick={() => {
                  onStage(t);
                  onToast(applyHint ? "已加入「角色分配」的待保存修改" : `已加入待保存：${tagLabel(t)} → ${model.selector}`, "info");
                }}
              >
                设为 {tagLabel(t)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="bench-drawer-actions">
          <button
            type="button"
            className="btn btn-small"
            disabled={!deletable}
            title={deletable ? undefined : `正在被${usedByNames}角色使用，不能编辑`}
            onClick={onEdit}
          >
            编辑
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!deletable}
            title={deletable ? undefined : `正在被${usedByNames}角色使用，不能删除`}
            onClick={handleDelete}
          >
            删除
          </button>
          {!deletable ? <span className="muted"> 正在被{usedByNames}角色使用</span> : null}
        </div>
      </div>

      <div className="bench-drawer-block">
        <div className="segment bench-segment" role="radiogroup" aria-label="统计范围">
          {(["hour", "day"] as const).map((u) => (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={unit === u}
              className={unit === u ? "segment-item segment-item-active" : "segment-item"}
              onClick={() => setUnit(u)}
            >
              {u === "hour" ? "24h" : "7d"}
            </button>
          ))}
        </div>
        {kpis === null ? (
          <div className="pane-note">这段时间没有测试数据。</div>
        ) : (
          <div className="kpi-grid bench-kpis">
            <div className="kpi-card">
              <span className="kpi-label">成功率</span>
              <strong className="kpi-value">{formatRate(kpis.rate)}</strong>
              <span className="kpi-sub">{kpis.samples} 个样本</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">TTFT p50</span>
              <strong className="kpi-value bench-nowrap">{formatMs(kpis.ttftP50Ms)}</strong>
              <span className="kpi-sub">p95 {formatMs(kpis.ttftP95Ms)}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">tok/s</span>
              <strong className="kpi-value">{formatTps(kpis.tpsP50)}</strong>
              <span className="kpi-sub">{kpis.tpsCv === null ? "—" : `CV ±${(kpis.tpsCv * 100).toFixed(0)}%`}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">花费</span>
              <strong className="kpi-value bench-nowrap">{formatUsd(kpis.cost)}</strong>
              <span className="kpi-sub">本范围合计</span>
            </div>
          </div>
        )}
      </div>

      {rounds.length === 0 ? null : (
        <div className="bench-drawer-block">
          <div className="bench-drawer-title">成功率</div>
          <BenchRateChart unit={unit === "hour" ? "hour" : "day"} buckets={buckets} />
          <div className="bench-drawer-title">生成速度（tok/s）</div>
          <BenchTpsChart unit={unit === "hour" ? "hour" : "day"} buckets={buckets} />
        </div>
      )}

      <div className="bench-drawer-block">
        <div className="bench-drawer-title">最近错误</div>
        {latestErrors.length === 0 ? (
          <span className="muted">最近一轮没有错误。</span>
        ) : (
          <ul className="bench-errors">
            {latestErrors.map((e, i) => (
              <li key={i}>
                <span className="badge badge-danger">{BENCH_ERROR_LABEL[classifyBenchError(e)]}</span>{" "}
                <span className="mono">{e}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
