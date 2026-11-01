/**
 * 「Agent」标签页：组织图（只读总览）→ Agent 定义总览表 + 继承与覆盖 →
 * 编排编辑器（VibeCard + AgentRow + save-bar，扩展保留）。
 * 与模型页共用草稿（ManageView 上提的 useModelDraft）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./AgentsTab.css";
import { copyText } from "../clipboard";
import { configFromDraft, type ModelDraftState } from "../modelDraft";
import { COMMON_ROLES, roleInfo, rowAfterModelChange, selectorBase } from "../roleCards";
import { AgentOrgTree, agentOrgNodes } from "./AgentOrgTree";
import { AgentAddDialog } from "./AgentAddDialog";
import { AgentLibraryDialog } from "./AgentLibraryDialog";
import { AgentRolesDialog } from "./AgentRolesDialog";
import { AgentsSection } from "./AgentsSection";
import { ModelDraftStatus } from "./ModelDraftStatus";
import { PageHeader, Panel } from "./page";
import type { ToastFn } from "./useOmpOp";

/** 高亮停留时长（ms）：足够眼睛跟上滚动，又不至于赖着不走。 */
const FLASH_MS = 1600;

export function AgentsTab(props: { state: ModelDraftState; onToast: ToastFn }): ReactNode {
  const s = props.state;
  const { onToast } = props;
  const { config, draft, modelsList } = s;
  const [selected, setSelected] = useState<string | null>(null);
  const [rolesAgent, setRolesAgent] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const view = configFromDraft(config, draft);
  const advisorCount = [...draft.advisor.values()].filter((a) => a !== "default").length;

  const selectAgent = (name: string): void => {
    setSelected(name);
    const row = document.querySelector(`[data-testid="agent-row-${name}"]`);
    if (row === null) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("agent-row-flash");
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      row.classList.remove("agent-row-flash");
      flashTimer.current = null;
    }, FLASH_MS);
  };
  // 刷新会重载配置并丢弃草稿（会丢弃两个标签的未保存修改）：有未保存修改时禁用，避免误触丢编辑。
  const hasUnsaved = s.dirty.roles || s.dirty.agents || s.dirty.others;
  const handleRefresh = (): void => {
    void s.loadModels(true);
    void s.loadConfig();
  };

  const unassigned = modelsList.filter((m) => {
    for (const raw of Object.values(view.roles)) {
      if (typeof raw === "string" && selectorBase(raw) === m.selector) return false;
    }
    return true;
  });

  return (
    <div className="manage-section models-agents agents-tab">
      <PageHeader
        kicker="环境配置 · Agent 定义"
        title="Agent 组织"
        sub="主 Agent 继承默认角色，子 Agent 按任务分派。每个节点都是一份可编辑的 Agent 定义，运行动态以当前会话的 JSONL 为准。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setLibraryOpen(true)}>Agent 库</button>
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>新建 Agent</button>
            <button
              type="button"
              className="btn"
              disabled={hasUnsaved || s.modelsLoading}
              title={hasUnsaved ? "有未保存修改，先保存或还原" : undefined}
              onClick={handleRefresh}
            >
              {s.modelsLoading ? <span className="spinner" aria-hidden="true" /> : null}
              刷新
            </button>
          </>
        }
      />
      <div className="agents-tab-chips" role="status" aria-label="Agent 状态">
        <span className="badge badge-grey">编排器 {s.orchestratorText}</span>
        <span className="badge badge-grey">子代理 {config.agents.length}</span>
        <span className="badge badge-grey">停用 {draft.disabled.size}</span>
        <span className="badge badge-grey">顾问 {advisorCount}</span>
      </div>
      <p className="muted agents-tab-hint">主对话模型在『模型』页修改</p>
      <p className="muted agents-tab-hint">修改自动计入草稿，有改动时出现保存条。</p>
      <ModelDraftStatus state={s} />

      {config.agents.length > 0 ? (
        <Panel title="组织图" meta={`主 Agent → ${config.agents.length} 个子 Agent`}>
          <AgentOrgTree
            nodes={agentOrgNodes(s)}
            orchestratorText={s.orchestratorText}
            selected={selected}
            onSelect={selectAgent}
            onEditRoles={setRolesAgent}
          />
        </Panel>
      ) : null}

      <div className="grid-2 agents-panels">
        <Panel title="Agent 定义" meta="点按编辑角色">
          <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th scope="col">Agent</th><th scope="col">角色</th><th scope="col" className="r">操作</th></tr></thead>
            <tbody>
              {config.agents.map((a) => {
                const roles = COMMON_ROLES.filter((r) => typeof view.roles[r] === "string").slice(0, 4);
                return (
                  <tr key={a.name}>
                    <td><span className="strong">{a.name}</span><span className="sub">{a.description}</span></td>
                    <td className="mono">{roles.join(" · ")}</td>
                    <td className="r cell-actions">
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setRolesAgent(a.name)}>角色</button>
                      <button
                        type="button"
                        className="btn btn-small btn-quiet"
                        onClick={() => {
                          void copyText(a.name).then((ok) => {
                            if (ok) onToast(`已复制：${a.name}`, "info");
                            else onToast("复制失败", "error");
                          });
                        }}
                      >
                        复制
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Panel>
        <Panel title="继承与覆盖" meta="运行时解析">
          <dl className="detail-list">
            <div className="detail-row"><dt>主 Agent</dt><dd>继承默认角色</dd></div>
            <div className="detail-row"><dt>子 Agent</dt><dd>{config.agents.map((a) => a.name).join(" · ")}</dd></div>
            <div className="detail-row"><dt>冲突策略</dt><dd>子 Agent 显式定义优先</dd></div>
            <div className="detail-row"><dt>未分配模型</dt><dd>{unassigned.length === 0 ? "无" : `保留 ${unassigned.length} 个未分配模型的手动指定能力`}</dd></div>
          </dl>
          <div className="inline-note">组织图描述的是定义关系；实际调用链仍需以会话 JSONL 中的 spawn 记录为准。</div>
        </Panel>
      </div>

      <AgentsSection state={s} />

      <p className="pane-hint">新开的 omp 会话使用新配置；已运行的会话可能需重启后生效。</p>

      {rolesAgent !== null ? (
        rolesAgent === "orchestrator" ? (
          <AgentRolesDialog
            agent="主代理"
            rows={COMMON_ROLES.map((role) => {
              const raw = view.roles[role];
              const info = roleInfo(role);
              return { role, label: info === null ? role : `${info.name}（${role}）`, selector: typeof raw === "string" ? selectorBase(raw) : null };
            })}
            models={modelsList}
            onClose={() => setRolesAgent(null)}
            onSave={(changes) => {
              s.setDraft((prev) => {
                if (prev === null) return prev;
                const roles = new Map(prev.roles);
                for (const [role, selector] of changes) {
                  if (selector === null) continue;
                  const current = roles.get(role) ?? { selector: null, thinking: "", touched: false };
                  roles.set(role, rowAfterModelChange(current, selector, modelsList));
                }
                return { ...prev, roles };
              });
            }}
          />
        ) : (
          <AgentRolesDialog
            agent={rolesAgent}
            rows={(() => {
              const current = view.agentOverrides[rolesAgent];
              return [{ role: "override", label: "改用模型", selector: typeof current === "string" ? current : null }];
            })()}
            models={modelsList}
            onClose={() => setRolesAgent(null)}
            onSave={(changes) => {
              const next = changes.get("override");
              if (next === undefined) return;
              const current = draft.overrides.get(rolesAgent) ?? { selector: null, thinking: "", touched: false };
              s.setRow("overrides", rolesAgent, next === null ? { selector: null, thinking: "", touched: true } : rowAfterModelChange(current, next, modelsList));
            }}
          />
        )
      ) : null}
      {addOpen ? (
        <AgentAddDialog
          onClose={() => setAddOpen(false)}
          onCreated={() => void s.loadConfig()}
          onToast={onToast}
        />
      ) : null}
      {libraryOpen ? (
        <AgentLibraryDialog agents={config.agents} onClose={() => setLibraryOpen(false)} embedded />
      ) : null}
    </div>
  );
}

