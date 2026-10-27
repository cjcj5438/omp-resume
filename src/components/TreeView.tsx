/**
 * 树视图：折叠线性链、节点选择、root→node 预览、从此节点继续。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getConversation, getTree } from "../api";
import type { AppError, SessionSummary, TreeNode } from "../types";
import type { ContinueOutcome } from "../flows";
import { errorText, formatTreeTime } from "../format";
import { MAX_INDENT_DEPTH, flattenRows, foldTree, type DisplayRow } from "../tree/fold";
import { useAsyncData } from "./useAsyncData";
import { ConversationView } from "./ConversationView";
import { Ico, Modal } from "./ui";
import { Bot, ChevronDown, ChevronRight, GitBranch, Shrink, User, Wrench, type LucideIcon } from "lucide-react";

/** 角色 → 图标（同一 family，深浅主题同色）。 */
const ROLE_ICON: Record<string, LucideIcon> = {
  user: User,
  assistant: Bot,
  toolResult: Wrench,
};

/** 节点图标：压缩/分支摘要优先，其次按角色，兜底为分支点。 */
function NodeIcon({ node }: { node: TreeNode }) {
  if (node.isCompaction) return <Ico icon={Shrink} size={12} />;
  if (node.isBranchSummary) return <Ico icon={GitBranch} size={12} />;
  const icon = ROLE_ICON[node.role ?? ""];
  return icon === undefined ? <Ico icon={GitBranch} size={12} /> : <Ico icon={icon} size={12} />;
}

interface TreeViewProps {
  session: SessionSummary;
  onContinue: (nodeId: string) => Promise<ContinueOutcome>;
  refreshKey: number;
  onToast: (text: string, kind: "info" | "error") => void;
}

export function TreeView({
  session,
  onContinue,
  refreshKey,
  onToast,
}: TreeViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogNode, setDialogNode] = useState<TreeNode | null>(null);
  const [continueError, setContinueError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const tree = useAsyncData(() => getTree({ path: session.path }), [session.path, refreshKey]);
  const preview = useAsyncData(() => getConversation({ path: session.path, nodeId: selectedId! }), [session.path, selectedId, refreshKey], { enabled: selectedId !== null, keepPrevious: true });

  useEffect(() => {
    if (!tree.data) return;
    setSelectedId((cur) =>
      cur && tree.data?.nodes.some((n) => n.id === cur) ? cur : tree.data?.leafId ?? null,
    );
  }, [tree.data]);

  const rows = useMemo(() => (tree.data ? foldTree(tree.data) : []), [tree.data]);
  const visible = useMemo(() => flattenRows(rows, expanded), [rows, expanded]);

  const toggleFold = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = visible.findIndex((r) =>
      r.type === "node"
        ? r.node.id === selectedId
        : r.nodes.some((n) => n.id === selectedId),
    );
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const next = visible[idx + dir];
      if (next) setSelectedId(next.type === "node" ? next.node.id : firstIdOf(next));
      return;
    }
    const sel = visible[idx];
    if (!sel) return;
    if (e.key === "ArrowRight" && sel.type === "fold") {
      e.preventDefault();
      if (!expanded.has(sel.key)) toggleFold(sel.key);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (sel.type === "fold" && expanded.has(sel.key)) {
        toggleFold(sel.key);
      } else if (sel.type === "fold") {
        // 已收起：回到父节点
        const parent = sel.parentId;
        if (parent) setSelectedId(parent);
      } else {
        for (const r of rows) {
          if (r.type === "fold" && r.nodes.some((n) => n.id === sel.node.id)) {
            toggleFold(r.key);
            setSelectedId(r.nodes[0].id);
            break;
          }
        }
      }
    }
  };

  const previewNode = selectedId
    ? tree.data?.nodes.find((n) => n.id === selectedId) ?? null
    : null;
  // 缺 cwd 时禁用：续聊必然打不开 iTerm，不得改动会话文件（与“在 iTerm 继续”同规则）。
  const continueDisabled =
    busy || session.inUse || !session.cwdExists || selectedId === null;
  const continueTip = session.inUse
    ? "会话正在被另一个 omp 使用"
    : !session.cwdExists
      ? "项目目录不存在"
      : selectedId === null
        ? "请先选择节点"
        : undefined;

  const confirmContinue = async () => {
    if (!dialogNode) return;
    setBusy(true);
    setContinueError(null);
    try {
      const out = await onContinue(dialogNode.id);
      if (out.notice) onToast(out.notice, "info");
    } catch (e) {
      setContinueError(e as AppError);
    } finally {
      setBusy(false);
      setDialogNode(null);
    }
  };

  return (
    <div className="tree-pane">
      {continueError ? (
        <div className="banner banner-error" role="alert">
          {errorText(continueError)}
        </div>
      ) : null}
      <div className="tree-cols">
        <div
          className="tree-list"
          ref={listRef}
          role="tree"
          aria-label="会话树"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {tree.error ? (
            <div className="banner banner-error" role="alert">
              <span>{errorText(tree.error)}</span>
              <button type="button" className="btn btn-small" onClick={tree.reload}>
                重试
              </button>
            </div>
          ) : tree.loading && !tree.data ? (
            <div className="pane-note">加载中…</div>
          ) : (
            visible.map((r) => (
              <TreeRow
                key={r.key}
                row={r}
                selected={
                  r.type === "node"
                    ? r.node.id === selectedId
                    : !expanded.has(r.key) && r.nodes.some((n) => n.id === selectedId)
                }
                expanded={r.type === "fold" ? expanded.has(r.key) : false}
                leafId={tree.data?.leafId ?? null}
                onSelect={setSelectedId}
                onToggleFold={toggleFold}
              />
            ))
          )}
        </div>
        <div className="tree-preview">
          <div className="tree-preview-head">
            <button
              type="button"
              className="btn btn-accent"
              disabled={continueDisabled}
              title={continueTip}
              onClick={() => previewNode && setDialogNode(previewNode)}
            >
              从此节点继续
            </button>
            {previewNode ? (
              <span className="muted tree-preview-meta">
                {previewNode.role ?? (previewNode.isCompaction ? "压缩" : "分支摘要")} ·{" "}
                {formatTreeTime(previewNode.timestamp)}
              </span>
            ) : null}
          </div>
          <ConversationView
            conversation={preview.data}
            loading={preview.loading}
            error={preview.error}
            onRetry={preview.reload}
            emptyNote="选择左侧节点查看其路径内容"
          />
        </div>
      </div>
      {dialogNode ? (
        <Modal
          title="从此节点继续？"
          onClose={() => setDialogNode(null)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                data-autofocus
                disabled={busy}
                onClick={() => setDialogNode(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-accent"
                disabled={busy}
                onClick={() => void confirmContinue()}
              >
                {busy ? "处理中…" : "追加标记并在 iTerm 打开"}
              </button>
            </>
          }
        >
          <p>
            将向该会话文件追加一行分支标记（omp-resume-branch），使 omp
            恢复后从所选节点继续，新内容会在同一文件里形成新分支。此操作会修改会话文件。
          </p>
          <div className="modal-node-preview">
            <span className="muted">
              <NodeIcon node={dialogNode} />
            </span>{" "}
            {dialogNode.preview}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function firstIdOf(row: DisplayRow): string {
  return row.type === "fold" ? row.nodes[0].id : row.node.id;
}

interface TreeRowProps {
  row: DisplayRow;
  selected: boolean;
  expanded: boolean;
  leafId: string | null;
  onSelect: (id: string) => void;
  onToggleFold: (key: string) => void;
}

function TreeRow({ row, selected, expanded, leafId, onSelect, onToggleFold }: TreeRowProps) {
  const indent = Math.min(row.depth, MAX_INDENT_DEPTH) * 14;
  const depthMark = row.depth > MAX_INDENT_DEPTH ? `d${row.depth}` : "";
  if (row.type === "fold") {
    return (
      <div
        className={
          selected
            ? "tree-row tree-row-selected"
            : row.onActivePath
              ? "tree-row tree-row-active"
              : "tree-row"
        }
        style={{ paddingLeft: 8 + indent }}
      >
        {depthMark ? <span className="depth-mark">{depthMark}</span> : null}
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={expanded}
          onClick={() => onToggleFold(row.key)}
        >
          <Ico icon={expanded ? ChevronDown : ChevronRight} size={12} /> {row.nodes.length} 条消息
        </button>
        <span className="tree-preview-text muted">
          {row.nodes[0].preview}
        </span>
      </div>
    );
  }
  const n = row.node;
  return (
    <div
      className={
        selected
          ? "tree-row tree-row-selected"
          : row.onActivePath
            ? "tree-row tree-row-active"
            : "tree-row"
      }
      style={{ paddingLeft: 8 + indent }}
      role="treeitem"
      aria-selected={selected}
      onClick={() => onSelect(n.id)}
    >
      {depthMark ? <span className="depth-mark">{depthMark}</span> : null}
      <span className="tree-icon" aria-hidden="true">
        <NodeIcon node={n} />
      </span>
      <span className="tree-preview-text" title={n.preview}>
        {n.preview}
      </span>
      {n.label != null ? <span className="badge badge-label">{n.label}</span> : null}
      {n.isCompaction ? <span className="badge badge-grey">压缩</span> : null}
      {n.id === leafId ? <span className="badge badge-leaf">当前位置</span> : null}
      <span className="tree-time muted">{formatTreeTime(n.timestamp)}</span>
    </div>
  );
}
