/**
 * 「模型」标签页：模型库（testbar 跳 bench）→ 角色分配。
 * 状态：useModelDraft（模型+角色草稿，ManageView 共享实例）+ specs 快照（ManageView 下发）。
 * bench 预选经 sessionStorage 透传（ModelTesterPanel 消费后清除）。
 */
import { useMemo, useState, type ReactNode } from "react";
import { copyText } from "../clipboard";
import { BENCH_FOCUS_KEY } from "../modelBench";
import { configFromDraft, type ModelDraftState, type ModelSpecsSnapshot } from "../modelDraft";
import { COMMON_ROLES, roleInfo, selectorBase } from "../roleCards";
import { PageHeader, Panel } from "./page";
import { ModelAddDialog } from "./ModelAddDialog";
import { ModelDraftStatus } from "./ModelDraftStatus";
import { ModelLibrary } from "./ModelLibrary";
import { ModelSpecDrawer } from "./ModelSpecDrawer";
import { ModelsSection } from "./ModelsSection";
import type { ToastFn } from "./useOmpOp";
import "./ModelsTab.css";

export function ModelsTab(props: { onToast: ToastFn; state: ModelDraftState; specs: ModelSpecsSnapshot; onNavigateBench: () => void }): ReactNode {
  const { onToast, state: s, specs, onNavigateBench } = props;
  const [specSelector, setSpecSelector] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [testSelector, setTestSelector] = useState("");

  const handleRefresh = (): void => {
    void s.loadModels(true);
    specs.loadSpecs();
  };

  const runTestInBench = (selector: string): void => {
    sessionStorage.setItem(BENCH_FOCUS_KEY, selector);
    onNavigateBench();
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

  const assigned = useMemo(() => {
    const bases = new Set(s.modelsList.map((m) => m.selector));
    const used = new Set<string>();
    for (const raw of Object.values(s.config.roles)) {
      if (typeof raw === "string") {
        const base = selectorBase(raw);
        if (bases.has(base)) used.add(base);
      }
    }
    return used;
  }, [s.modelsList, s.config.roles]);

  return (
    <div className="manage-section models-tab">
      <PageHeader kicker="环境配置 · models.yml" title="模型" sub="模型库 → 角色分配；写入前校验并携带 revision；测试在模型测试页运行。" />
      <div className="models-tab-head">
        <div className="models-tab-chips" role="status" aria-label="模型状态">
          <span className="badge badge-quiet">{s.modelsList.length} 个模型</span>
          <span className="badge badge-ok">{assigned.size} 个已分配</span>
          <span className="badge badge-warn">{s.modelsList.length - assigned.size} 个未分配</span>
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
        <button
          type="button"
          className="btn btn-small btn-quiet"
          disabled={specs.specsPath === ""}
          title={specs.specsPath}
          onClick={() => {
            void copyText(specs.specsPath).then((ok) => {
              if (ok) onToast(`已复制：${specs.specsPath}`, "info");
              else onToast("复制失败", "error");
            });
          }}
        >
          复制路径
        </button>
        <button type="button" className="btn btn-primary btn-small" onClick={() => setAddOpen(true)}>
          添加模型
        </button>
      </div>
      {specs.specsError !== null ? <div className="pane-note">规格加载失败：{specs.specsError} <button type="button" className="btn btn-small" onClick={() => specs.loadSpecs()}>重试</button></div> : null}

      <section aria-label="模型库">
        <h3 className="manage-sub">模型库</h3>
        <p className="muted models-tab-hint">全部可用模型：搜一搜，去测试页跑分或查看规格。</p>
        <ModelLibrary
          models={s.modelsList}
          modelsLoading={s.modelsLoading}
          modelsError={s.modelsError}
          roles={s.config.roles}
          agentOverrides={s.config.agentOverrides}
          specs={specs.specsBySelector}
          onOpenSpec={setSpecSelector}
          onToast={onToast}
          onTestInBench={runTestInBench}
          footRevision={specs.revision}
          onRetryModels={() => void s.loadModels(true)}
        />
        <div className="model-testbar">
          <span className="panel-title">模型测试</span>
          <span className="meta">载入基准任务，在 bench 页实际运行</span>
          <span className="spacer" />
          <select
            aria-label="选择测试模型"
            value={testSelector}
            onChange={(e) => setTestSelector(e.target.value)}
          >
            {s.modelsList.map((m) => (
              <option key={m.selector} value={m.selector}>{m.name}</option>
            ))}
          </select>
          <button type="button" className="btn btn-primary btn-small" disabled={testSelector === ""} onClick={() => runTestInBench(testSelector)}>
            运行测试
          </button>
        </div>
      </section>

      <section aria-label="角色分配">
        <h3 className="manage-sub">角色分配</h3>
        <p className="muted models-tab-hint">每个角色的主模型与兜底在这里改，测试推荐也会落到这里待保存。</p>
        <RoleRoutingPanels state={s} specs={specs} />
        <ModelDraftStatus state={s} />
        <ModelsSection state={s} />
      </section>

      <p className="pane-hint">新开的 omp 会话使用新配置；已运行的会话可能需重启后生效。</p>
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
          }}
          onToast={onToast}
        />
      ) : null}
      {addOpen ? (
        <ModelAddDialog
          providers={[...new Set(specs.specs.map((sp) => sp.provider))].sort()}
          revision={specs.revision}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            specs.loadSpecs();
            void s.loadModels(true);
          }}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}

/** 角色路由总览 + 写入与校验（只读，数据源自草稿视角与 specs 快照）。 */
function RoleRoutingPanels(props: { state: ModelDraftState; specs: ModelSpecsSnapshot }): ReactNode {
  const { state: s, specs } = props;
  const view = configFromDraft(s.config, s.draft);
  const bySelector = new Map(s.modelsList.map((m) => [m.selector, m]));
  const used = new Set<string>();
  const rows = COMMON_ROLES.slice(0, 5).map((role) => {
    const raw = view.roles[role];
    const base = typeof raw === "string" ? selectorBase(raw) : null;
    if (base !== null) used.add(base);
    const model = base === null ? null : (bySelector.get(base) ?? null);
    return { role, info: roleInfo(role), base, model };
  });
  const unrouted = s.modelsList.filter((m) => !used.has(m.selector)).length;
  const revShort = specs.revision === "" ? "—" : specs.revision.slice(0, 12);
  return (
    <div className="grid-2 models-panels">
      <Panel title="角色路由" meta="由角色配置汇总">
        <table className="tbl">
          <thead><tr><th scope="col">角色</th><th scope="col">当前模型</th><th scope="col" className="r">来源</th></tr></thead>
          <tbody>
            {rows.map(({ role, info, base, model }) => (
              <tr key={role}>
                <td><span className="strong">{role}</span><span className="sub">{info?.blurb ?? "自定义角色"}</span></td>
                <td className="mono">{model === null ? "—" : (model.name ?? base)}</td>
                <td className="r">{model === null ? <span className="badge badge-warn">未分配</span> : <span className="badge badge-quiet">{model.provider}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="panel-foot"><span>{unrouted} 个模型未参与路由，仍可被手动指定。</span><span className="mono">5 个角色</span></div>
      </Panel>
      <Panel title="写入与校验" meta="乐观锁">
        <dl className="detail-list">
          <div className="detail-row"><dt>配置文件</dt><dd className="mono">{specs.specsPath === "" ? "models.yml" : specs.specsPath}</dd></div>
          <div className="detail-row"><dt>当前修订</dt><dd className="mono">rev {revShort}</dd></div>
          <div className="detail-row"><dt>写入前</dt><dd>校验名称、上下文与价格形状</dd></div>
          <div className="detail-row"><dt>冲突策略</dt><dd>版本不一致时拒绝写入</dd></div>
          <div className="detail-row"><dt>回滚</dt><dd>保留上一版副本</dd></div>
        </dl>
        <div className="inline-note">这里展示的是配置层。真实调用仍由 omp 运行时完成，应用不会代理模型请求。</div>
      </Panel>
    </div>
  );
}
