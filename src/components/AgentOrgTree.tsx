/**
 * Agent 组织图（设计稿 org-tree）：主 Agent（编排器）→ 子 Agent 纵向树。
 * 只读展示 + 定位/编辑入口：点节点滚动到下方配置行并高亮；「编辑角色」进角色对话框。
 */
import type { ReactNode } from "react";
import { AGENT_INFO, resolveAgentEffective } from "../roleCards";
import { configFromDraft, type ModelDraftState } from "../modelDraft";

export interface AgentOrgNode {
  name: string;
  description: string;
  source: string;
  roles: { role: string; model: string }[];
  roleCount: number;
  enabled: boolean;
  current: string;
}

export function agentOrgNodes(state: ModelDraftState): AgentOrgNode[] {
  const { config, draft, modelsList } = state;
  const view = configFromDraft(config, draft);
  return config.agents.map((agent) => {
    const effective = resolveAgentEffective(agent, view.agentOverrides[agent.name], view.roles, modelsList);
    const roles: { role: string; model: string }[] = [];
    for (const [role, raw] of Object.entries(view.roles)) {
      if (typeof raw !== "string") continue;
      roles.push({ role, model: raw });
    }
    return {
      name: agent.name,
      description: AGENT_INFO[agent.name]?.duty ?? agent.description,
      source: agent.source,
      roles: roles.slice(0, 4),
      roleCount: roles.length,
      enabled: !draft.disabled.has(agent.name),
      current: `${effective.modelText}${effective.thinking !== "" ? ` · ${effective.thinking}` : ""}`,
    };
  });
}

interface AgentOrgTreeProps {
  nodes: AgentOrgNode[];
  orchestratorText: string;
  selected?: string | null;
  onSelect?: (agent: string) => void;
  onEditRoles?: (agent: string) => void;
}

function NodeCard(props: { node: AgentOrgNode; root: boolean; selected: boolean; onSelect?: (agent: string) => void; onEditRoles?: (agent: string) => void }): ReactNode {
  const { node, root, selected, onSelect, onEditRoles } = props;
  const interactive = onSelect !== undefined;
  return (
    <article
      className={root ? "org-node org-root" : "org-node"}
      data-testid={root ? "agent-org-node-orchestrator" : `agent-org-node-${node.name}`}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `定位到 ${node.name} 的配置行`,
            "aria-pressed": selected,
            onClick: () => onSelect?.(node.name),
            onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect?.(node.name);
              }
            },
          }
        : {})}
    >
      <div className="org-node-head">
        <span className="org-avatar" aria-hidden="true">{node.name.slice(0, 2)}</span>
        <span className="org-name">{root ? "主代理" : node.name}</span>
        <span className="org-desc">{root ? "编排器" : node.description}</span>
        {node.enabled ? <span className="badge badge-ok">已启用</span> : <span className="badge badge-grey">已停用</span>}
      </div>
      <div className="org-roles">
        {root ? (
          <span className="org-chip"><b>模型</b> {node.current}</span>
        ) : (
          node.roles.map(({ role, model }) => (
            <span key={role} className="org-chip" title={`${role} → ${model}`}><b>{role}</b> {model}</span>
          ))
        )}
      </div>
      <div className="org-node-foot">
        <span className="muted">{root ? "编排器" : `${node.roleCount} 个角色`}</span>
        {onEditRoles !== undefined ? (
          <button
            type="button"
            className="btn btn-small btn-quiet"
            aria-label={root ? "编辑主代理的角色" : `编辑 ${node.name} 的角色`}
            onClick={(e) => {
              e.stopPropagation();
              onEditRoles(root ? "orchestrator" : node.name);
            }}
          >
            编辑角色
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function AgentOrgTree(props: AgentOrgTreeProps): ReactNode {
  const { nodes, orchestratorText, selected = null, onSelect, onEditRoles } = props;
  if (nodes.length === 0) return null;
  const root: AgentOrgNode = {
    name: "orchestrator",
    description: "编排器",
    source: "builtin",
    roles: [],
    roleCount: 0,
    enabled: true,
    current: orchestratorText,
  };
  return (
    <div className="org-board" data-testid="agent-org">
      <div className="org-tree">
        <NodeCard node={root} root selected={false} onEditRoles={onEditRoles} />
        <span className="org-link" aria-hidden="true" />
        <div className="org-level">
          {nodes.map((node) => (
            <NodeCard key={node.name} node={node} root={false} selected={selected === node.name} onSelect={onSelect} onEditRoles={onEditRoles} />
          ))}
        </div>
      </div>
      <div className="org-legend">
        <span><span className="dot live" aria-hidden="true" />默认模型</span>
        <span>子 Agent 可覆盖任意角色</span>
        <span className="mono">定义来源：~/.omp/agent/agents/</span>
      </div>
    </div>
  );
}
