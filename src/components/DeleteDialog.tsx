/** 删除确认对话框：列出目标、跳过在用会话、展示逐条结果。
 * - 默认变体：设计稿 deleteSessionsDialog（标题「永久删除 N 个会话」+ kv + warn note + 逐会话明细扩展 + 结果态扩展）。
 * - 全在用 → 「无法删除」单按钮变体（G4/G5 行内入口启用后接此处）。
 * - variant="cleanup"：清理页用（fe-insight3 接线），kv 为 将删除/释放合计/已排除/不可撤销 + 确认「删除 N 项」。
 */
import { useState } from "react";
import type { DeleteResult } from "../types";
import { displayCwd, formatSize } from "../format";
import { planDelete, type DeleteTarget } from "../flows";
import { Modal } from "./ui";

interface CleanupInfo {
  count: number;
  bytes: number;
  excluded: number;
}

interface DeleteDialogProps {
  targets: DeleteTarget[];
  /** 仅提交可删除路径；App 侧负责刷新与清理选择。 */
  requestDelete: (paths: string[]) => Promise<DeleteResult[]>;
  onClose: () => void;
  variant?: "cleanup";
  /** cleanup 变体必填：计数/字节/已排除（由调用方按候选算好传入）。 */
  cleanup?: CleanupInfo;
}

export function DeleteDialog({ targets, requestDelete, onClose, variant, cleanup }: DeleteDialogProps) {
  const [results, setResults] = useState<DeleteResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = planDelete(
    new Map(targets.map((t) => [t.path, t])),
    targets.map((t) => t.path),
  );
  const targetByPath = new Map(targets.map((t) => [t.path, t]));
  const isCleanup = variant === "cleanup";

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

  // 全在用 → 「无法删除」单按钮变体（默认变体才有；cleanup 由调用方保证候选非空）。
  if (!isCleanup && plan.deletable.length === 0) {
    return (
      <Modal
        title="无法删除"
        sub="选中的会话正在被 omp 持有。flock 探测未通过时，omp-resume 不会删除任何文件。"
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-ghost" data-autofocus onClick={onClose}>
            知道了
          </button>
        }
      >
        <div className="inline-note warn" role="note">
          <span>请先在终端结束对应会话，再回到这里重试。</span>
        </div>
      </Modal>
    );
  }

  if (isCleanup) {
    const info = cleanup ?? { count: targets.length, bytes: 0, excluded: 0 };
    return (
      <Modal
        title="删除清理候选"
        sub="删除前会再次做占用探测；正在使用的会话会被排除。"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-autofocus
              disabled={busy || plan.deletable.length === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  setResults(await requestDelete(plan.deletable));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "删除中…" : `删除 ${info.count} 项`}
            </button>
          </>
        }
      >
        <div className="dlg-kv">
          <div>
            <span>将删除</span>
            <span>{info.count} 项</span>
          </div>
          <div>
            <span>释放空间合计</span>
            <span>{formatSize(info.bytes)}</span>
          </div>
          <div>
            <span>占用中已排除</span>
            <span>{info.excluded} 项</span>
          </div>
          <div>
            <span>撤销</span>
            <span>不可用</span>
          </div>
        </div>
        <div className="inline-note warn" role="note">
          <span>删除前会再次做占用探测；正在使用的会话会被排除。</span>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`永久删除 ${targets.length} 个会话`}
      sub="删除是永久的：没有废纸篓，也没有撤销。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" data-autofocus disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
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
      <div className="dlg-kv">
        <div>
          <span>将删除</span>
          <span>{plan.deletable.length} 个会话</span>
        </div>
        {plan.skippedInUse.length > 0 ? (
          <div>
            <span>占用中已排除</span>
            <span>{plan.skippedInUse.length} 个</span>
          </div>
        ) : null}
        <div>
          <span>占用检查</span>
          <span>flock 探测</span>
        </div>
      </div>
      {plan.skippedInUse.length > 0 ? (
        <div className="inline-note warn" role="note">
          <span>
            「{targetByPath.get(plan.skippedInUse[0])?.title ?? "某会话"}」正在运行，已自动排除。
          </span>
        </div>
      ) : null}
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
