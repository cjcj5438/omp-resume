/**
 * 模型库：全部模型的只读一览表（搜索 + 用途徽章 + 加入测试/单测/规格入口）。
 * 纯渲染组件：模型来自 ModelDraftState，规格来自 ModelsTab 的 getModelSpecs 快照，
 * 用途由 config.roles 反查（selector base 命中即算在用）。
 * 支持仅本应用的隐藏（hiddenModels：localStorage，不改 omp 配置）。
 */
import { useState } from "react";
import type { ModelInfo, ModelSpec } from "../types";
import { setModelHidden, useHiddenModels } from "../hiddenModels";
import { benchRunner, type BenchConfig } from "../modelBench";
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
  bench: BenchConfig;
  onAddBench: (selector: string) => void;
  onOpenSpec: (selector: string) => void;
  onToast: ToastFn;
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

function formatMaxTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

/** 库表上下文简写：`1M 上下文` → `1M`（表头已说明，完整口径放 title）。 */
function formatContextCompact(contextWindow: number | null): string | null {
  const full = formatContextWindow(contextWindow);
  if (full === null) return null;
  return full.endsWith(" 上下文") ? full.slice(0, -" 上下文".length) : full;
}

/** 库表目录价简写：`$输入 / $输出`（单值/双空降级，完整口径放 title）。 */
function formatCostCompact(input: number | null, output: number | null): { text: string; title: string } | null {
  if (input === null && output === null) return null;
  const inText = input === null ? "–" : `$${input}`;
  const outText = output === null ? "–" : `$${output}`;
  const title = `输入 ${inText} / 输出 ${outText}（USD / 百万 token）`;
  const text = input === null ? outText : output === null ? inText : `${inText} / ${outText}`;
  return { text, title };
}

export function ModelLibrary(props: ModelLibraryProps): React.ReactNode {
  const { models, modelsLoading, modelsError, roles, agentOverrides, specs, bench, onAddBench, onOpenSpec, onToast } = props;
  const [query, setQuery] = useState("");
  const inBench = new Set(bench.entries.map((e) => e.selector));
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
        <div className="pane-note">模型列表加载失败：{modelsError}</div>
      ) : visible.length === 0 ? (
        <div className="pane-note">
          {models.length === 0
            ? "还没有可用模型。"
            : pool.length === 0
              ? "所有模型都已隐藏，点「显示已隐藏」查看。"
              : "没有命中筛选的模型。"}
        </div>
      ) : (
        <div className="lib-table-wrap">
          <table className="manage-table lib-table">
            <colgroup>
              <col className="lib-col-model" />
              <col className="lib-col-context" />
              <col className="lib-col-max" />
              <col className="lib-col-cost" />
              <col className="lib-col-thinking" />
              <col className="lib-col-act" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col">上下文</th>
                <th scope="col" className="lib-nowrap">最大输出</th>
                <th scope="col">目录价</th>
                <th scope="col">思考</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => {
                const spec = specs.get(m.selector) ?? null;
                const context = formatContextCompact(spec?.contextWindow ?? m.contextWindow);
                const maxTokens = spec?.maxTokens ?? m.maxTokens;
                const cost = formatCostCompact(spec?.costInput ?? m.costInput, spec?.costOutput ?? m.costOutput);
                const isHidden = hidden.has(m.selector);
                return (
                  <tr key={m.selector} className={isHidden ? "lib-row lib-row-hidden" : "lib-row"} onClick={() => onOpenSpec(m.selector)}>
                    <td>
                      <span className="lib-model">
                        <span className="lib-model-top">
                          <span className="lib-name" title={m.name}>{m.name}</span>
                        </span>
                        <span className="lib-model-sub">
                          <span className="lib-id muted mono" title={m.selector}>{m.selector}</span>
                          {m.reasoning ? <span className="badge badge-branch">推理</span> : null}
                          {spec !== null ? <span className="badge badge-fork">可编辑</span> : null}
                          {isHidden ? <span className="badge badge-grey">已隐藏</span> : null}
                          <UsageBadges roles={roles} agentOverrides={agentOverrides} base={m.selector} />
                        </span>
                      </span>
                    </td>
                    <td className="lib-nowrap">{context === null ? <span className="muted">—</span> : <span title={`${context} tokens`}>{context}</span>}</td>
                    <td className="lib-nowrap">{formatMaxTokens(maxTokens)}</td>
                    <td className="lib-nowrap">{cost === null ? <span className="muted">—</span> : <span title={cost.title}>{cost.text}</span>}</td>
                    <td>
                      {m.thinkingLevels.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <span className="lib-levels" title={m.thinkingLevels.join(" / ")}>
                          {m.thinkingLevels.map((lvl) => (
                            <span key={lvl} className="lib-level">
                              {lvl}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="lib-act-cell">
                      <span className="lib-actions">
                        {inBench.has(m.selector) ? null : (
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={(e) => {
                              e.stopPropagation();
                              onAddBench(m.selector);
                            }}
                          >
                            加入测试
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-small"
                          aria-label={`测试 ${m.selector}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            // 非 bench 模型先走 onAddBench 落行（否则结果无处显示），再入队。
                            if (!inBench.has(m.selector)) {
                              onAddBench(m.selector);
                              onToast(`已加入测试列表并开始测试：${m.selector}`, "info");
                            } else {
                              onToast(`已加入测试队列：${m.selector}`, "info");
                            }
                            benchRunner.enqueue(m.selector);
                          }}
                        >
                          测试 <Ico icon={Play} size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenSpec(m.selector);
                          }}
                        >
                          规格
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
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
        </div>
      )}
    </div>
  );
}
