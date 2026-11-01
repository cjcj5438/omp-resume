/**
 * 模型库：全部模型的只读一览表（搜索 + 用途徽章 + 加入测试/单测/规格入口）。
 * 纯渲染组件：模型来自 ModelDraftState，规格来自 ModelsTab 的 getModelSpecs 快照，
 * 用途由 config.roles 反查（selector base 命中即算在用）。
 * 支持仅本应用的隐藏（hiddenModels：localStorage，不改 omp 配置）。
 */
import { useState } from "react";
import type { ModelInfo, ModelSpec } from "../types";
import { setModelHidden, useHiddenModels } from "../hiddenModels";
import { selectorBase } from "../roleCards";
import { formatContextWindow, roleInfo } from "../roleCards";
import type { ToastFn } from "./useOmpOp";
import { Eye, EyeOff, Play } from "lucide-react";
import { Ico } from "./ui";

interface ModelLibraryProps {
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  roles: Record<string, unknown>;
  agentOverrides?: Record<string, unknown>;
  specs: Map<string, ModelSpec>;
  onOpenSpec: (selector: string) => void;
  onToast: ToastFn;
  /** 跳 bench 并预选：由 models 页传入导航回调。 */
  onTestInBench?: (selector: string) => void;
  /** 表 foot 的 rev 短 hash（models.yml revision 真值）。 */
  footRevision?: string;
  /** 模型列表失败重试。 */
  onRetryModels?: () => void;
}

/** 用途徽章：角色中文名 + 引用该 base 的 agent 名（muted 小 chips，最多 2 个 +N，title 列出剩余）。 */
function UsageBadges(props: { roles: Record<string, unknown>; agentOverrides?: Record<string, unknown>; base: string }): React.ReactNode {
  const used: { key: string; label: string; agent: boolean }[] = [];
  for (const [role, raw] of Object.entries(props.roles)) {
    if (typeof raw === "string" && selectorBase(raw) === props.base) used.push({ key: role, label: roleInfo(role)?.name ?? role, agent: false });
  }
  for (const [agent, raw] of Object.entries(props.agentOverrides ?? {})) {
    if (typeof raw === "string" && selectorBase(raw) === props.base) used.push({ key: `agent:${agent}`, label: agent, agent: true });
  }
  if (used.length === 0) return null;
  const shown = used.slice(0, 2);
  const rest = used.slice(2);
  return (
    <span className="lib-usage">
      {shown.map((item) => (
        <span key={item.key} className={item.agent ? "badge badge-grey" : "badge badge-tag"} title={item.agent ? `agent 覆盖：${item.label}` : item.key}>
          {item.label}
        </span>
      ))}
      {rest.length > 0 ? <span className="badge badge-tag" title={rest.map((item) => item.label).join("、")}>+{rest.length}</span> : null}
    </span>
  );
}

export function ModelLibrary(props: ModelLibraryProps): React.ReactNode {
  const { models, modelsLoading, modelsError, roles, agentOverrides, specs, onOpenSpec, onToast, onTestInBench, footRevision, onRetryModels } = props;
  const [query, setQuery] = useState("");
  const hidden = useHiddenModels();
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = models.filter((m) => hidden.has(m.selector)).length;
  const pool = showHidden ? models : models.filter((m) => !hidden.has(m.selector));

  const needle = query.trim().toLowerCase();
  const visible = needle === ""
    ? pool
    : pool.filter(
        (m) =>
          m.name.toLowerCase().includes(needle) ||
          m.provider.toLowerCase().includes(needle) ||
          m.id.toLowerCase().includes(needle) ||
          m.selector.toLowerCase().includes(needle),
      );
  const defaultBase = typeof roles.default === "string" ? selectorBase(roles.default) : null;

  return (
    <div className="model-lib">
      <div className="lib-toolbar">
        <input
          className="filter-input lib-search"
          type="search"
          placeholder="搜索模型名称、供应商或 id…"
          aria-label="搜索模型库"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted">
          {needle === "" ? `共 ${pool.length} 个` : `命中 ${visible.length} / ${pool.length} 个`}
        </span>
        {hiddenCount > 0 ? (
          <button type="button" className="btn btn-small" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? "收起已隐藏" : `显示已隐藏 (${hiddenCount})`}
          </button>
        ) : null}
      </div>
      {modelsLoading && models.length === 0 ? (
        <div className="pane-note">模型列表加载中（首次加载可能需要几秒）…</div>
      ) : modelsError !== null && models.length === 0 ? (
        <div className="pane-note">模型列表加载失败：{modelsError} <button type="button" className="btn btn-small" disabled={onRetryModels === undefined} onClick={() => onRetryModels?.()}>重试</button></div>
      ) : visible.length === 0 ? (
        <div className="pane-note">
          {models.length === 0
            ? "还没有可用模型。"
            : pool.length === 0
              ? "所有模型都已隐藏，点「显示已隐藏」查看。"
              : "没有命中筛选的模型。"}
        </div>
      ) : (
        <div className="tbl-wrap lib-table-wrap">
          <table className="tbl lib-table">
            <colgroup>
              <col className="lib-col-model" />
              <col className="lib-col-context" />
              <col className="lib-col-max" />
              <col className="lib-col-thinking" />
              <col className="lib-col-default" />
              <col className="lib-col-input" />
              <col className="lib-col-cost" />
              <col className="lib-col-cost" />
              <col className="lib-col-roles" />
              <col className="lib-col-act" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col" className="r">上下文</th>
                <th scope="col" className="r">最大输出</th>
                <th scope="col" className="c">思考</th>
                <th scope="col" className="c">默认</th>
                <th scope="col">输入</th>
                <th scope="col" className="r">输入价</th>
                <th scope="col" className="r">输出价</th>
                <th scope="col">角色</th>
                <th scope="col" aria-label="操作"><span aria-hidden="true" /></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => {
                const spec = specs.get(m.selector) ?? null;
                const context = spec?.contextWindow ?? m.contextWindow;
                const maxTokens = spec?.maxTokens ?? m.maxTokens;
                const costIn = spec?.costInput ?? m.costInput;
                const costOut = spec?.costOutput ?? m.costOutput;
                const inputs = (spec?.input ?? m.input ?? []).join(" / ");
                const isHidden = hidden.has(m.selector);
                const isDefault = defaultBase !== null && m.selector === defaultBase;
                return (
                  <tr
                    key={m.selector}
                    className={isHidden ? "is-click lib-row lib-row-hidden" : "is-click lib-row"}
                    tabIndex={0}
                    role="button"
                    aria-label={`查看 ${m.selector} 的规格`}
                    onClick={() => onOpenSpec(m.selector)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      if (e.target !== e.currentTarget) return;
                      e.preventDefault();
                      onOpenSpec(m.selector);
                    }}
                  >
                    <td>
                      <span className="strong lib-name" title={m.name}>{m.name}</span>
                      <span className="sub mono" title={m.selector}>{m.selector}</span>
                    </td>
                    <td className="r mono">{context === null || context === undefined ? <span className="muted">—</span> : <span title={`${context.toLocaleString()} tokens`}>{formatContextWindow(context)}</span>}</td>
                    <td className="r mono">{maxTokens === null || maxTokens === undefined ? <span className="muted">—</span> : maxTokens.toLocaleString()}</td>
                    <td className="c">{m.reasoning ? <span className="mark-yes" aria-label="支持推理">✓</span> : <span className="muted">—</span>}</td>
                    <td className="c">{isDefault ? <span className="mark-yes" aria-label="默认模型">✓</span> : <span className="muted">—</span>}</td>
                    <td>{inputs === "" ? <span className="muted">—</span> : <span title={inputs}>{inputs}</span>}</td>
                    <td className="r mono">{costIn === null || costIn === undefined ? <span className="muted">—</span> : `$${costIn}`}</td>
                    <td className="r mono">{costOut === null || costOut === undefined ? <span className="muted">—</span> : `$${costOut}`}</td>
                    <td>
                      <UsageBadges roles={roles} agentOverrides={agentOverrides} base={m.selector} />
                    </td>
                    <td className="cell-actions">
                      <span className="lib-actions">
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
                          onClick={(e) => {
                            e.stopPropagation();
                            onTestInBench?.(m.selector);
                          }}
                        >
                          测试 <Ico icon={Play} size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
                          aria-label={isHidden ? `取消隐藏 ${m.selector}` : `隐藏 ${m.selector}`}
                          title={isHidden ? "取消隐藏" : "隐藏（仅本应用，不改 omp 配置）"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setModelHidden(m.selector, !isHidden);
                            onToast(
                              isHidden ? `已取消隐藏：${m.selector}` : `已隐藏：${m.selector}（可在「显示已隐藏」中恢复）`,
                              "info",
                            );
                          }}
                        >
                          <Ico icon={isHidden ? Eye : EyeOff} size={12} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {footRevision === undefined || footRevision === "" ? null : (
            <div className="panel-foot"><span>价格单位：每百万 token（USD）。</span><span className="mono">models.yml · rev {footRevision.slice(0, 12)}</span></div>
          )}
        </div>
      )}
    </div>
  );
}
