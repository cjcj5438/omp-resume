/**
 * 树视图：SVG 树图 + 节点 facts + 节点内容预览（扩展保留）+ 定位/分叉。
 * 布局见 tree/layout（fold 行 → 轨道坐标）；大树默认折叠，首屏仅数十行。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getConversation, getTree } from "../api";
import type { SessionSummary, TreeData, TreeNode } from "../types";
import { errorText, formatTreeTime } from "../format";
import { compactNumber } from "./usageFormat";
import { flattenRows, foldTree, type DisplayRow } from "../tree/fold";
import { edgePath, layoutTree, truncateLabel } from "../tree/layout";
import { useAsyncData } from "./useAsyncData";
import { ConversationView } from "./ConversationView";
import { Badge, Ico } from "./ui";
import { Panel } from "./page";
import { GitBranch, History, Info } from "lucide-react";
import "./TreeView.css";

interface TreeViewProps {
  session: SessionSummary;
  refreshKey: number;
  /** 「在对话中定位」：DetailPane 切 conv tab + 传 activeNodeId。 */
  onLocate?: (nodeId: string) => void;
  /** 分叉请求（App 级弹 ForkDialog，三入口统一，含刷新）。 */
  onForkRequest: (nodeId: string) => void;
}

function firstIdOf(row: DisplayRow): string {
  return row.type === "node" ? row.node.id : row.nodes[0].id;
}

/** 节点状态：err > 分支点（有兄弟）> 已完成。 */
function nodeKind(n: TreeNode, byId: Map<string, TreeNode>): "err" | "branch" | "ok" {
  if (n.isError) return "err";
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  if (parent && parent.childIds.length > 1) return "branch";
  return "ok";
}

function kindText(k: "err" | "branch" | "ok"): string {
  return k === "err" ? "失败" : k === "branch" ? "分支点" : "已完成";
}

function typeText(n: TreeNode): string {
  if (n.isCompaction) return "压缩";
  if (n.isBranchSummary) return "分支摘要";
  if (n.role === "toolResult") return n.toolName ? `工具 · ${n.toolName}` : "工具";
  if (n.role === "user") return "用户";
  if (n.role === "assistant") return "助手";
  return n.role ?? "消息";
}

export function TreeView({ session, refreshKey, onLocate, onForkRequest }: TreeViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const tree = useAsyncData(() => getTree({ path: session.path }), [session.path, refreshKey]);
  const preview = useAsyncData(
    () => getConversation({ path: session.path, nodeId: selectedId! }),
    [session.path, selectedId, refreshKey],
    { enabled: selectedId !== null, keepPrevious: true },
  );

  useEffect(() => {
    if (!tree.data) return;
    setSelectedId((cur) =>
      cur && tree.data?.nodes.some((n) => n.id === cur) ? cur : (tree.data?.leafId ?? null),
    );
  }, [tree.data]);

  const rows = useMemo(() => (tree.data ? foldTree(tree.data) : []), [tree.data]);
  const visible = useMemo(() => flattenRows(rows, expanded), [rows, expanded]);
  const layout = useMemo(() => layoutTree(visible), [visible]);
  const byId = useMemo(() => {
    const m = new Map<string, TreeNode>();
    for (const n of tree.data?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [tree.data]);

  const toggleFold = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = visible.findIndex((r) => firstIdOf(r) === selectedId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const next = visible[idx + dir];
      if (next) setSelectedId(firstIdOf(next));
      return;
    }
    if (e.key === "Enter") {
      const sel = visible[idx];
      if (sel?.type === "fold") {
        e.preventDefault();
        toggleFold(sel.key);
      }
    }
  };

  const selectedNode = selectedId ? (byId.get(selectedId) ?? null) : null;
  const leafCount = tree.data ? tree.data.nodes.filter((n) => n.childIds.length === 0).length : 0;
  // 缺 cwd/在用时禁用：append 后端本就会拒，前端不弹空框。
  const forkDisabled = session.inUse || !session.cwdExists || !session.formatSupported || selectedId === null;
  const forkTip = session.inUse
    ? "会话正在使用中"
    : !session.cwdExists
      ? "项目目录不存在"
      : !session.formatSupported
        ? "该会话格式不支持分叉"
        : selectedId === null
          ? "请先选择节点"
          : undefined;

  if (tree.error) {
    return (
      <div className="banner banner-error" role="alert">
        <span>{errorText(tree.error)}</span>
        <button type="button" className="btn btn-small" onClick={tree.reload}>
          重试
        </button>
      </div>
    );
  }
  if (tree.loading && !tree.data) return <div className="pane-note">加载中…</div>;
  const data: TreeData | null = tree.data ?? null;
  if (!data || data.nodes.length === 0) return <div className="pane-note">该会话没有树节点</div>;

  return (
    <div className="split">
      <div className="tree-canvas">
        <div className="tree-scroll" tabIndex={0} role="tree" aria-label="会话树" onKeyDown={onKeyDown}>
          <svg
            ref={svgRef}
            className="tree-svg"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={`会话树：${data.nodes.length} 个节点，${leafCount} 条活跃分支`}
          >
            {layout.edges.map((e) => (
              <path key={`${e.from}->${e.to}`} className={e.branch ? "tree-edge branch" : "tree-edge"} d={edgePath(e)} />
            ))}
            {layout.points.map((p) => {
              const n = byId.get(p.id);
              if (!n) return null;
              const kind = nodeKind(n, byId);
              const cls = `tree-node${kind === "err" ? " err" : kind === "branch" ? " branch" : ""}${p.id === selectedId ? " is-on" : ""}`;
              const label = truncateLabel(n.preview.split("\n")[0] || n.id);
              const sub = `${n.id} · ${n.role ?? n.kind}`;
              return (
                <g
                  key={p.id}
                  className={cls}
                  transform={`translate(${p.x} ${p.y})`}
                  role="treeitem"
                  aria-selected={p.id === selectedId}
                  aria-label={`节点 ${n.id}：${n.preview}${p.foldable ? "（已折叠，点击展开）" : ""}`}
                  data-fold-key={p.foldable && p.foldKey ? p.foldKey : undefined}
                  tabIndex={-1}
                  onClick={() => {
                    if (p.foldable && p.foldKey) toggleFold(p.foldKey);
                    setSelectedId(p.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (p.foldable && p.foldKey) toggleFold(p.foldKey);
                      setSelectedId(p.id);
                    }
                  }}
                >
                  <rect className="node-ring" x="-14" y="-14" width="28" height="28" rx="7" />
                  <circle className="node-dot" cx="0" cy="0" r="3.2" />
                  <text className="tree-label" x="22" y="-1">
                    {label}
                  </text>
                  <text className="tree-sub" x="22" y="12">
                    {truncateLabel(sub, 26)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="tree-legend">
          <span>
            <span className="dot ok" />
            成功完成
          </span>
          <span>
            <span className="dot bad" />
            失败或放弃
          </span>
          <span>
            <span className="dot warn" />
            分支点
          </span>
          <span style={{ marginLeft: "auto" }}>
            {data.nodes.length} 个节点 · {leafCount} 条活跃分支
          </span>
        </div>
      </div>

      <aside className="section-stack">
        {selectedNode ? (
          <Panel
            title={`节点 ${selectedNode.id}`}
            icon={GitBranch}
            meta={
              <Badge tone={nodeKind(selectedNode, byId) === "err" ? "danger" : nodeKind(selectedNode, byId) === "branch" ? "warn" : "ok"}>
                {kindText(nodeKind(selectedNode, byId))}
              </Badge>
            }
          >
            <h3 className="node-title">{selectedNode.preview.split("\n")[0] || selectedNode.id}</h3>
            <p className="meta node-sub mono">
              {selectedNode.id} · {selectedNode.role ?? selectedNode.kind}
            </p>
            <dl className="detail-list node-facts">
              <div className="detail-row">
                <dt>类型</dt>
                <dd>{typeText(selectedNode)}</dd>
              </div>
              <div className="detail-row">
                <dt>模型</dt>
                <dd className="mono">{selectedNode.model ?? "—"}</dd>
              </div>
              <div className="detail-row">
                <dt>累计 token</dt>
                <dd className="mono">
                  {selectedNode.tokens == null ? "—" : compactNumber(selectedNode.tokens)}
                </dd>
              </div>
              <div className="detail-row">
                <dt>时间</dt>
                <dd className="mono">{formatTreeTime(selectedNode.timestamp)}</dd>
              </div>
              <div className="detail-row">
                <dt>父节点</dt>
                <dd className="mono">{selectedNode.parentId ?? "—"}</dd>
              </div>
              <div className="detail-row">
                <dt>子节点</dt>
                <dd className="mono">
                  {selectedNode.childIds.length > 0 ? selectedNode.childIds.join("、") : "—"}
                </dd>
              </div>
            </dl>
            <div className="side-actions">
              <button
                type="button"
                className="btn btn-ghost btn-block"
                disabled={forkDisabled}
                title={forkTip}
                onClick={() => onForkRequest(selectedNode.id)}
              >
                <Ico icon={GitBranch} size={13} />
                从此节点分叉
              </button>
              {onLocate ? (
                <button
                  type="button"
                  className="btn btn-quiet btn-block"
                  onClick={() => onLocate(selectedNode.id)}
                >
                  在对话中定位
                </button>
              ) : null}
            </div>
          </Panel>
        ) : null}
        <Panel title="节点内容预览" icon={History}>
          <ConversationView
            conversation={preview.data}
            loading={preview.loading}
            error={preview.error}
            onRetry={preview.reload}
            emptyNote="选择左侧节点查看其路径内容"
          />
        </Panel>
        <div className="inline-note">
          <Ico icon={Info} size={12} />
          <span>
            分支标记是一条 <code>custom</code> 记录，omp 的上下文构建器会忽略它，因此不会污染真实对话。
          </span>
        </div>
      </aside>
    </div>
  );
}
