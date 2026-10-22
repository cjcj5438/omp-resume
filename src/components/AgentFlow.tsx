/**
 * Agent 编排流程图（只读；不写任何配置）：主代理（编排器）按需把子任务派给
 * 下面的 agent，每个节点显示中文职责与「当前使用」的模型/档位。
 *
 * 手绘 SVG：viewBox 宽度固定、高度随 agent 数量；配色全部走 App.css 主题变量，
 * 不引入图表库。中文职责来自 roleCards 的 AGENT_INFO，自定义 agent 用
 * frontmatter 里的 description 原样显示。不解析 spawns/tools（语义未验证）。
 */
import type { AgentDefinition } from "../types";
import { AGENT_INFO, type AdvisorState, type AgentEffective } from "../roleCards";

export interface AgentFlowNode {
  agent: AgentDefinition;
  effective: AgentEffective;
  disabled: boolean;
  advisor: AdvisorState;
}

const FONT = 13;
const SMALL = 12;
const ORCH_X = 8;
const ORCH_W = 330;
const ORCH_H = 118;
const NODE_X = 446;
const NODE_W = 560;
const NODE_H = 74;
const GAP = 10;
const PAD = 6;
const BUS_X = 390;
const RET_X = NODE_X + NODE_W + 22;
const WIDTH = RET_X + 22;

/** 估算文本像素宽：CJK 按 1 em，其余按 0.58 em。 */
function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    width += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? fontSize : fontSize * 0.58;
  }
  return width;
}

/** 超宽截断加省略号；完整文本由节点的 `<title>` 悬停给出。 */
function fitText(text: string, maxWidth: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  let out = "";
  for (const ch of text) {
    if (textWidth(out + ch, fontSize) > maxWidth - fontSize) break;
    out += ch;
  }
  return `${out}…`;
}

/** 状态 pill：宽由文字长度驱动（徽章文案都是中文，按 11px 计）。 */
function pill(x: number, y: number, text: string, tone: "danger" | "accent" | "grey") {
  const width = text.length * 11 + 14;
  return (
    <>
      <rect
        className={tone === "grey" ? "flow-pill" : `flow-pill flow-pill-${tone}`}
        x={x}
        y={y - 12}
        width={width}
        height={17}
        rx={8.5}
      />
      <text className={`flow-pill-text-${tone}`} x={x + width / 2} y={y + 1} textAnchor="middle">
        {text}
      </text>
    </>
  );
}

export function AgentFlow(props: {
  nodes: AgentFlowNode[];
  orchestratorText: string;
  /** 提供后节点可点击/键盘选中（AgentsTab 用）；不提供时与原来完全一致。 */
  onSelect?: (agent: string) => void;
  selected?: string | null;
}) {
  const { nodes, orchestratorText, onSelect, selected } = props;
  if (nodes.length === 0) return null;
  const nodesHeight = nodes.length * NODE_H + (nodes.length - 1) * GAP;
  const height = Math.max(nodesHeight, ORCH_H) + PAD * 2;
  const orchY = (height - ORCH_H) / 2;
  const orchCenter = orchY + ORCH_H / 2;
  const centers = nodes.map((_, index) => PAD + index * (NODE_H + GAP) + NODE_H / 2);
  const firstCenter = centers[0];
  const lastCenter = centers[centers.length - 1];
  const orchBottom = orchY + ORCH_H;
  const orchMidX = ORCH_X + ORCH_W / 2;
  return (
    <div className="agent-flow" data-testid="agent-flow">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label="Agent 编排流程图：主代理把子任务派给各个 agent，子任务结果回传"
      >
        {/* 编排器 → 各 agent 的派发总线 */}
        <path className="flow-edge" d={`M ${ORCH_X + ORCH_W} ${orchCenter} H ${BUS_X}`} />
        <path className="flow-edge" d={`M ${BUS_X} ${firstCenter} V ${lastCenter}`} />
        {centers.map((center, index) => (
          <path
            key={nodes[index].agent.name}
            className={nodes[index].disabled ? "flow-edge flow-edge-off" : "flow-edge"}
            d={`M ${BUS_X} ${center} H ${NODE_X - 9}`}
          />
        ))}
        {centers.map((center, index) => (
          <path
            key={`${nodes[index].agent.name}-head`}
            className={nodes[index].disabled ? "flow-head flow-head-off" : "flow-head"}
            d={`M ${NODE_X} ${center} l -8 -4 v 8 z`}
          />
        ))}
        {/* 结果回传（虚线） */}
        <path
          className="flow-edge flow-return"
          d={`M ${RET_X} ${lastCenter} V ${orchBottom} H ${orchMidX}`}
        />
        <path
          className="flow-head"
          d={`M ${orchMidX} ${orchBottom} l -4 8 h 8 z`}
        />
        <text
          className="flow-muted"
          x={RET_X - 6}
          y={(lastCenter + orchBottom) / 2}
          textAnchor="middle"
          transform={`rotate(-90 ${RET_X - 6} ${(lastCenter + orchBottom) / 2})`}
        >
          结果回传
        </text>

        {/* 主代理（编排器） */}
        <g data-testid="agent-flow-node-orchestrator">
          <title>
            {`主代理（编排器）\n当前模型：${orchestratorText}\n按需把可并行的子任务派给下面的 agent`}
          </title>
          <rect
            className="flow-node flow-orch"
            x={ORCH_X}
            y={orchY}
            width={ORCH_W}
            height={ORCH_H}
            rx={10}
          />
          <text className="flow-title" x={ORCH_X + 16} y={orchY + 30}>
            主代理
          </text>
          {pill(ORCH_X + 16 + textWidth("主代理", 15) + 10, orchY + 30, "编排器", "accent")}
          <text className="flow-muted" x={ORCH_X + 16} y={orchY + 58}>
            {fitText("规划、拆分任务，把子任务派给下面的 agent", ORCH_W - 32, SMALL)}
          </text>
          <text className="flow-muted" x={ORCH_X + 16} y={orchY + 84}>
            当前模型：
          </text>
          <text x={ORCH_X + 16 + textWidth("当前模型：", SMALL)} y={orchY + 84}>
            {fitText(orchestratorText, ORCH_W - 32 - textWidth("当前模型：", SMALL), SMALL)}
          </text>
        </g>

        {/* 每个 agent 一个节点 */}
        {nodes.map((node, index) => {
          const y = PAD + index * (NODE_H + GAP);
          const info = AGENT_INFO[node.agent.name];
          const duty = info?.duty ?? node.agent.description;
          const label = info?.label ?? (node.agent.source === "user" ? "自定义" : "内置");
          const modelText = `${node.effective.modelText}${
            node.effective.thinking !== "" ? ` · ${node.effective.thinking}` : ""
          }${node.effective.modelUnknown ? "（未知值）" : ""}`;
          const nameX = NODE_X + 14;
          const labelX = nameX + textWidth(node.agent.name, FONT) + 10;
          const pillX = labelX + textWidth(label, FONT) + 12;
          const statePill = node.disabled
            ? pill(pillX, y + 24, "已停用", "danger")
            : node.advisor === "on"
              ? pill(pillX, y + 24, "顾问开", "accent")
              : node.advisor === "off"
                ? pill(pillX, y + 24, "顾问关", "grey")
                : null;
          const interactive = onSelect !== undefined;
          return (
            <g
              key={node.agent.name}
              data-testid={`agent-flow-node-${node.agent.name}`}
              {...(interactive
                ? {
                    role: "button",
                    tabIndex: 0,
                    "aria-label": `定位到 ${node.agent.name} 的配置行`,
                    "aria-pressed": selected === node.agent.name,
                    className: selected === node.agent.name ? "flow-node-selected" : undefined,
                    onClick: () => onSelect?.(node.agent.name),
                    onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect?.(node.agent.name);
                      }
                    },
                  }
                : {})}
            >
              <title>
                {`${node.agent.name}（${label}）：${duty}\n当前使用：${modelText}\n${node.effective.sourceText}`}
              </title>
              <rect
                className={node.disabled ? "flow-node flow-node-off" : "flow-node"}
                x={NODE_X}
                y={y}
                width={NODE_W}
                height={NODE_H}
                rx={10}
              />
              <text className="flow-mono flow-name" x={nameX} y={y + 24}>
                {node.agent.name}
              </text>
              <text x={labelX} y={y + 24}>
                {label}
              </text>
              {statePill}
              {statePill === null && info !== undefined && node.agent.source === "user"
                ? pill(pillX, y + 24, "自定义", "grey")
                : null}
              <text className="flow-muted" x={nameX} y={y + 45}>
                {fitText(duty, NODE_W - 28, SMALL)}
              </text>
              <text className="flow-muted" x={nameX} y={y + 64}>
                当前使用：
              </text>
              <text x={nameX + textWidth("当前使用：", SMALL)} y={y + 64}>
                {fitText(modelText, NODE_W - 28 - textWidth("当前使用：", SMALL), SMALL)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
