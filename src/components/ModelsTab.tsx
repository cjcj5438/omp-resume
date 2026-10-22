/**
 * 「模型」标签页：模型库 → 测试 → 角色分配，一页闭环。
 * 状态：useModelDraft（模型+角色草稿）+ 本地 specs 快照 + 受控 bench 配置。
 * bench 的推荐/设为角色回填到角色草稿，统一在「角色分配」保存。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getModelSpecs, normalizeError } from "../api";
import { errorText } from "../format";
import { parseSelectorValue } from "../modelConfig";
import {
  loadBenchConfig,
  saveBenchConfig,
  type BenchConfig,
} from "../modelBench";
import { configFromDraft, useModelDraft } from "../modelDraft";
import { friendlyModelName, rowAfterModelChange, selectorBase } from "../roleCards";
import type { ModelSpec, ModelSpecUpdateResult } from "../types";
import { ModelDraftStatus } from "./ModelDraftStatus";
import { ModelLibrary } from "./ModelLibrary";
import { ModelSpecDrawer } from "./ModelSpecDrawer";
import { ModelTesterPanel } from "./ModelTesterPanel";
import { ModelsSection } from "./ModelsSection";
import type { ToastFn } from "./useOmpOp";
import { useAlive } from "./useOmpOp";
import "./ModelsTab.css";

const MORE_ROLE_SET: Record<string, true> = { image: true, web: true, speech: true, dictation: true, vision: true, judge: true };

export function ModelsTab(props: { onToast: ToastFn }): ReactNode {
  const { onToast } = props;
  const loaded = useModelDraft(onToast);
  const alive = useAlive();
  const [specs, setSpecs] = useState<ModelSpec[]>([]);
  const [specsPath, setSpecsPath] = useState("");
  const [revision, setRevision] = useState("");
  const [specsError, setSpecsError] = useState<string | null>(null);
  const [specsReloading, setSpecsReloading] = useState(false);
  const [bench, setBench] = useState<BenchConfig>(() => loadBenchConfig());
  const [testerKey, setTesterKey] = useState(0);
  const [specSelector, setSpecSelector] = useState<string | null>(null);

  const loadSpecs = useCallback(async () => {
    setSpecsReloading(true);
    try {
      const result = await getModelSpecs();
      if (!alive.current) return;
      setSpecs(result.available ? result.specs : []);
      setSpecsPath(result.path);
      setRevision(result.revision);
      setSpecsError(result.error);
    } catch (e: unknown) {
      if (!alive.current) return;
      setSpecsError(errorText(normalizeError(e)));
    } finally {
      if (alive.current) setSpecsReloading(false);
    }
  }, [alive]);

  useEffect(() => {
    void loadSpecs();
  }, [loadSpecs]);

  const updateBench = useCallback((next: BenchConfig): void => {
    setBench(next);
    saveBenchConfig(next);
  }, []);

  const specsBySelector = useMemo(() => new Map(specs.map((s) => [s.selector, s])), [specs]);

  if (loaded.status === "loading") {
    return <div className="pane-note">正在读取模型配置…</div>;
  }
  if (loaded.status === "error") {
    return (
      <div className="manage-section">
        <div className="banner banner-error" role="alert">
          <div>{loaded.loadError ?? "读取模型配置失败"}</div>
          <button type="button" className="btn btn-small" onClick={() => void loaded.loadConfig()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const s = loaded.state;
  const baselineRaw = s.config.roles.default;
  const baseline = typeof baselineRaw === "string"
    ? (friendlyModelName(parseSelectorValue(baselineRaw).selector, s.modelsList) ?? baselineRaw)
    : "未设置";

  const handleApplyRoles = (changes: Map<string, string>): void => {
    // 用 expandRole 保证 shownRoles/展开态，再按 bench 条目精确值写行。
    for (const [role] of changes) {
      s.expandRole(role);
      if (MORE_ROLE_SET[role] === true) s.setMoreOpen(true);
    }
    s.setDraft((prev) => {
      if (prev === null) return prev;
      const roles = new Map(prev.roles);
      for (const [role, selector] of changes) {
        const current = roles.get(role) ?? { selector: null, thinking: "", touched: false };
        const parsed = parseSelectorValue(selector);
        const levels = s.modelsList.find((m) => m.selector === parsed.selector)?.thinkingLevels ?? [];
        // 恒覆盖：bench 条目的 thinking 合法才保留，否则回默认（防旧值残留与非法后缀）。
        const thinking = parsed.thinking !== "" && levels.includes(parsed.thinking) ? parsed.thinking : "";
        const row = rowAfterModelChange(current, parsed.selector, s.modelsList);
        roles.set(role, { ...row, thinking });
      }
      return { ...prev, roles };
    });
  };

  const handleRefresh = (): void => {
    void s.loadModels(true);
    void loadSpecs();
    setTesterKey((k) => k + 1);
  };

  const handleSpecSaved = (result: ModelSpecUpdateResult | null): void => {
    // 成功即先用返回的 revision/spec 顶掉本地，再异步 reload；快速连存不自冲突。
    if (result !== null) {
      setRevision(result.revision);
      setSpecs((prev) => prev.map((entry) => (entry.selector === result.spec.selector ? result.spec : entry)));
      setTesterKey((k) => k + 1);
    }
    void s.loadModels(true);
    void loadSpecs();
  };

  const specModel = specSelector === null ? null : (s.modelsList.find((m) => m.selector === specSelector) ?? null);
  const specEntry = specSelector === null ? null : (specsBySelector.get(specSelector) ?? null);

  return (
    <div className="manage-section models-tab">
      <div className="models-tab-head">
        <p className="muted models-tab-intro">从模型库挑选 → 跑测试验证 → 分配给角色，一页完成。</p>
        <div className="models-tab-chips" role="status" aria-label="模型状态">
          <span className="badge badge-grey">可用模型 {s.modelsList.length}</span>
          <span className="badge badge-grey">可编辑规格 {specs.length}</span>
          <span className="badge badge-grey">测试列表 {bench.entries.length}</span>
          <span className="badge badge-grey">基线 {baseline}</span>
        </div>
        <button
          type="button"
          className="btn btn-small"
          disabled={s.busyBlock !== null || s.modelsLoading}
          onClick={handleRefresh}
        >
          {s.modelsLoading ? <span className="spinner" aria-hidden="true" /> : null}
          刷新模型
        </button>
      </div>
      {specsError !== null ? <div className="pane-note">规格加载失败：{specsError}</div> : null}

      <section aria-label="模型库">
        <h3 className="manage-sub">模型库</h3>
        <p className="muted models-tab-hint">全部可用模型：搜一搜，加入测试或查看规格。</p>
        <ModelLibrary
          models={s.modelsList}
          modelsLoading={s.modelsLoading}
          modelsError={s.modelsError}
          roles={s.config.roles}
          agentOverrides={s.config.agentOverrides}
          specs={specsBySelector}
          bench={bench}
          onAddBench={(selector) => {
            updateBench({ ...bench, entries: [...bench.entries, { selector, tags: [], monitor: false }] });
            onToast(`已加入测试列表：${selector}`, "info");
          }}
          onOpenSpec={setSpecSelector}
          onToast={onToast}
        />
      </section>

      <section aria-label="测试">
        <h3 className="manage-sub">测试</h3>
        <p className="muted models-tab-hint">跑 bench 看速度与稳定性，推荐结果回填到下面的角色分配。</p>
        <ModelTesterPanel
          onToast={onToast}
          embedded
          refreshKey={testerKey}
          config={bench}
          onConfigChange={updateBench}
          onApplyRoles={handleApplyRoles}
          hasSpec={(selector) => specsBySelector.has(selectorBase(selector))}
          onEditSpec={(selector) => setSpecSelector(selectorBase(selector))}
          models={s.modelsList}
          modelConfig={s.config}
          rolesOverride={configFromDraft(s.config, s.draft).roles}
        />
      </section>

      <section aria-label="角色分配">
        <h3 className="manage-sub">角色分配</h3>
        <p className="muted models-tab-hint">每个角色的主模型与兜底在这里改，测试推荐也会落到这里待保存。</p>
        <ModelDraftStatus state={s} />
        <ModelsSection state={s} />
      </section>

      <div className="pane-note">新开的 omp 会话使用新配置；已运行的会话可能需重启后生效。</div>
      {specSelector !== null ? (
        <ModelSpecDrawer
          key={specSelector}
          selector={specSelector}
          model={specModel}
          spec={specEntry}
          revision={revision}
          specsPath={specsPath}
          editable={specEntry !== null}
          reloading={specsReloading}
          onClose={() => setSpecSelector(null)}
          onSaved={handleSpecSaved}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
