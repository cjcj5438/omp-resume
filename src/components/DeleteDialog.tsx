/** 删除确认对话框：列出目标、跳过在用会话、展示逐条结果。 */
import { useState } from "react";
import type { DeleteResult } from "../types";
import { displayCwd, formatSize } from "../format";
import { planDelete, type DeleteTarget } from "../flows";
import { Modal } from "./ui";

interface DeleteDialogProps {
  targets: DeleteTarget[];
  /** 仅提交可删除路径；App 侧负责刷新与清理选择。 */
  requestDelete: (paths: string[]) => Promise<DeleteResult[]>;
  onClose: () => void;
}

export function DeleteDialog({ targets, requestDelete, onClose }: DeleteDialogProps) {
  const [results, setResults] = useState<DeleteResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = planDelete(
    new Map(targets.map((t) => [t.path, t])),
    targets.map((t) => t.path),
  );
  const targetByPath = new Map(targets.map((t) => [t.path, t]));

  if (results) {
    const okCount = results.filter((r) => r.ok).length;
    const failures = results.filter((r) => !r.ok);
    return (
      <Modal
        title="删除结果"
        onClose={onClose}
        footer={
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            关闭
          </button>
        }
      >
        <p>成功删除 {okCount} 个会话。</p>
        {failures.length > 0 ? (
          <ul className="delete-results">
            {failures.map((r) => (
              <li key={r.path}>
                <span className="mono">{targetByPath.get(r.path)?.title ?? r.path}</span>
                ：{r.error?.message ?? "未知错误"}
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>
    );
  }

  return (
    <Modal
      title={`永久删除 ${targets.length} 个会话？`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-autofocus disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || plan.deletable.length === 0}
            title={plan.deletable.length === 0 ? "所有选中会话都在使用中" : undefined}
            onClick={async () => {
              setBusy(true);
              try {
                setResults(await requestDelete(plan.deletable));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "删除中…" : "永久删除"}
          </button>
        </>
      }
    >
      <p className="delete-warning">
        此操作无法撤销，不会进入废纸篓。将删除会话文件及其附属目录（工具日志、子 agent 会话）。
      </p>
      <ul className="delete-list">
        {targets.map((t) => (
          <li key={t.path} className="delete-item">
            <div className="row-title">{t.title}</div>
            <div className="row-meta">
              <span className="mono">{displayCwd(t.cwd)}</span>
              <span>{formatSize(t.sizeBytes)}</span>
              {t.messageCount != null ? <span>{t.messageCount} 条消息</span> : null}
              {t.inUse ? <span className="badge badge-accent">使用中，将被跳过</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
