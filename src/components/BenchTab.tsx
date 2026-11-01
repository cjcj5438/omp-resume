/**
 * 「模型测试」独立页（ManageView 内渲染，与 models 页共享同一草稿实例与 specs 快照）。
 * PageHeader 自带（工具 · omp bench / 模型测试）；测试台主体复用 ModelTesterPanel。
 */
import { useMemo, useState, type ReactNode } from "react";
import { PageHeader } from "./page";
import { applyBenchRoles, loadBenchConfig, saveBenchConfig, type BenchConfig } from "../modelBench";
import { configFromDraft, type ModelDraftState, type ModelSpecsSnapshot } from "../modelDraft";
import { roleInfo, selectorBase } from "../roleCards";
import { ModelSpecDrawer } from "./ModelSpecDrawer";
import { ModelTesterPanel } from "./ModelTesterPanel";
import type { ToastFn } from "./useOmpOp";

interface BenchTabProps {
  onToast: ToastFn;
  state: ModelDraftState;
  specs: ModelSpecsSnapshot;
  /** ManageView 内渲染时去掉外层 view 壳（页头保留，ManageView 的共享页头已跳过 bench）。 */
  bare?: boolean;
}

export function BenchTab(props: BenchTabProps): ReactNode {
  const { onToast, state: s, specs, bare = false } = props;
  const [bench, setBench] = useState<BenchConfig>(() => loadBenchConfig());
  const [testerKey, setTesterKey] = useState(0);
  const [specSelector, setSpecSelector] = useState<string | null>(null);

  const updateBench = (next: BenchConfig): void => {
    setBench(next);
    saveBenchConfig(next);
  };

  const specModel = specSelector === null ? null : (s.modelsList.find((m) => m.selector === specSelector) ?? null);
  const specEntry = specSelector === null ? null : (specs.specsBySelector.get(specSelector) ?? null);
  const specUsedRoles = useMemo(() => {
    if (specSelector === null) return [];
    const out: string[] = [];
    for (const [role, raw] of Object.entries(s.config.roles)) {
      if (typeof raw === "string" && selectorBase(raw) === specSelector) out.push(roleInfo(role)?.name ?? role);
    }
    return out;
  }, [specSelector, s.config.roles]);
  const body = (
    <>
      <PageHeader
        kicker="工具 · omp bench"
        title="模型测试"
        sub="跑 bench 看速度与稳定性，推荐结果回填到模型页的角色分配。"
        actions={<span className="badge badge-outline"><span className="dot ok" aria-hidden="true" />本机 · macOS arm64</span>}
      />
      <div className="page-body">
        <ModelTesterPanel
          key={testerKey}
          onToast={onToast}
          config={bench}
          onConfigChange={updateBench}
          onApplyRoles={(changes) => applyBenchRoles(changes, { expandRole: s.expandRole, setMoreOpen: (open) => s.setMoreOpen(open), setDraft: s.setDraft, modelsList: s.modelsList })}
          hasSpec={(selector) => specs.specsBySelector.has(selectorBase(selector))}
          onEditSpec={(selector) => setSpecSelector(selectorBase(selector))}
          models={s.modelsList}
          modelConfig={s.config}
          rolesOverride={configFromDraft(s.config, s.draft).roles}
        />
        {specSelector !== null ? (
          <ModelSpecDrawer
            key={specSelector}
            selector={specSelector}
            model={specModel}
            spec={specEntry}
            revision={specs.revision}
            specsPath={specs.specsPath}
            editable={specEntry !== null}
            reloading={specs.specsReloading}
            usedByRoles={specUsedRoles}
            onClose={() => setSpecSelector(null)}
            onSaved={(result) => {
              specs.specSaved(result);
              setTesterKey((k) => k + 1);
            }}
            onToast={onToast}
          />
        ) : null}
      </div>
    </>
  );
  return bare ? body : <div className="view manage">{body}</div>;
}
