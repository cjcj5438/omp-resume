/**
 * 记忆删除确认框：由 memory_delete_preview 驱动显示删除/跳过/级联数量，
 * 由 memory_bank_status 做占用门禁；确认后调用 memory_delete_items。
 * 空 ids 时不发任何请求；破坏性命令只在明确点确认后触发。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryDeleteItems, memoryDeletePreview, normalizeError } from "../api";
import type { MemoryDeletePreview } from "../types";
import { errorText } from "../format";
import { Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";
import { formatHolders, memoryWriteErrorText, useBankStatus } from "./useMemoryMaintenance";
import "./MemoryPanel.css";

function cascadeText(p: MemoryDeletePreview): string {
  const parts: string[] = [];
  if (p.cascade.facts > 0) parts.push(`事实 ${p.cascade.facts} 条`);
  if (p.cascade.embeddings > 0) parts.push(`向量 ${p.cascade.embeddings} 个`);
  if (p.cascade.annotations > 0) parts.push(`标注 ${p.cascade.annotations} 条`);
  if (p.cascade.edges > 0) parts.push(`关联边 ${p.cascade.edges} 条`);
  if (p.cascade.other > 0) parts.push(`其他 ${p.cascade.other} 条`);
  return parts.length > 0 ? `同时清理：${parts.join(" · ")}。` : "无附带清理项。";
}

/** 全不可删时说明各原因条数。 */
function unavailableReasons(p: MemoryDeletePreview): string {
  const parts: string[] = [];
  if (p.notFound > 0) parts.push(`${p.notFound} 条已不在库中`);
  if (p.unsupported > 0) parts.push(`${p.unsupported} 条暂不支持`);
  return parts.join("，");
}
export function MemoryDeleteDialog(props: {
  bank: string;
  displayName: string;
  ids: string[];
  onClose: () => void;
  onToast: ToastFn;
  /** 成功后由调用方刷新并关闭。 */
  onDone: () => void;
}): ReactNode {
  const { bank, displayName, ids, onClose, onToast, onDone } = props;
  const [preview, setPreview] = useState<MemoryDeletePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(ids.length > 0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const gate = useBankStatus(bank, ids.length > 0, retryToken);
  const idsKey = ids.join("\n");

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    memoryDeletePreview({ bank, ids })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPreviewError(errorText(normalizeError(e)));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, idsKey, retryToken]);

  const deletable = preview === null ? 0 : preview.deletable.working + preview.deletable.episodic;
  const blocked =
    gate.status !== null && (gate.status.inUse || gate.status.probeFailed);
  const ready =
    ids.length > 0 &&
    !busy &&
    !previewLoading &&
    !gate.loading &&
    preview !== null &&
    previewError === null &&
    gate.error === null &&
    !blocked &&
    deletable > 0;

  const busyRef = useRef(false);

  async function confirm(): Promise<void> {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      const result = await memoryDeleteItems({ bank, ids });
      const skipped = result.skipped.length;
      onToast(
        skipped > 0
          ? `已删除 ${result.deleted.length} 条，跳过 ${skipped} 条，已备份`
          : `已删除 ${result.deleted.length} 条，已备份`,
        "info",
      );
      onDone();
    } catch (e: unknown) {
      setSubmitError(memoryWriteErrorText(normalizeError(e), "delete"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`删除记忆（${displayName}）`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!ready}
            title={
              ready
                ? undefined
                : gate.status?.inUse === true
                  ? "该库正被 omp 会话使用，先退出后再试"
                  : gate.status?.probeFailed === true
                    ? "无法确认占用状态，请稍后重试"
                    : deletable === 0 && preview !== null
                      ? "所选记忆都无法删除"
                      : undefined
            }
            onClick={() => void confirm()}
          >
            {busy ? "删除中…" : `备份并删除 ${deletable} 条`}
          </button>
        </>
      }
    >
      {ids.length === 0 ? (
        <p>未选择任何记忆。</p>
      ) : previewLoading || gate.loading ? (
        <p>正在确认可删除内容与占用状态…</p>
      ) : previewError !== null || gate.error !== null ? (
        <>
          <p>
            确认信息加载失败：
            {previewError ?? gate.error}
          </p>
          <button type="button" className="btn btn-small" onClick={() => setRetryToken((t) => t + 1)}>
            重试
          </button>
        </>
      ) : preview !== null && gate.status !== null ? (
        <>
          <p>
            将从「{displayName}」删除 {deletable} 条记忆（工作 {preview.deletable.working} · 情节{" "}
            {preview.deletable.episodic}）。
          </p>
          {preview.notFound > 0 ? <p className="muted">{preview.notFound} 条已不在库中，将跳过。</p> : null}
          {preview.unsupported > 0 ? (
            <p className="muted">该库的情节摘要暂不支持删除：{preview.unsupported} 条，将跳过。</p>
          ) : null}
          {preview.citedBySummaries > 0 ? (
            <p className="mem-note-amber">
              有 {preview.citedBySummaries} 条情节摘要引用了这些记忆，删除后摘要保留但不再对应原文。
            </p>
          ) : null}
          <p className="muted">{cascadeText(preview)}</p>
          <p className="muted">删除前会自动备份整库，可在「备份与恢复」中还原。</p>
          {gate.status.inUse ? (
            <p className="mem-note-danger">
              该库正被使用：{formatHolders(gate.status.holders)}。先退出占用该库的 omp 会话后再试。
              <button type="button" className="btn btn-small" onClick={() => setRetryToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {gate.status.probeFailed ? (
            <p className="mem-note-danger">
              无法确认是否有 omp 会话在使用该库（占用探测失败），请稍后重试。
              <button type="button" className="btn btn-small" onClick={() => setRetryToken((t) => t + 1)}>
                重试
              </button>
            </p>
          ) : null}
          {deletable === 0 ? <p>所选记忆都无法删除（{unavailableReasons(preview)}）。</p> : null}
          {submitError !== null ? <p className="mem-note-danger">{submitError}</p> : null}
        </>
      ) : null}
    </Modal>
  );
}

/** 单条删除入口（详情操作区用）：按钮 + 上述确认框。 */
export function MemoryItemDeleteButton(props: {
  bank: string;
  displayName: string;
  ids: string[];
  label?: string;
  onToast: ToastFn;
  onDone: () => void;
}): ReactNode {
  const { bank, displayName, ids, label = "删除这条…", onToast, onDone } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <MemoryDeleteDialog
          bank={bank}
          displayName={displayName}
          ids={ids}
          onClose={() => setOpen(false)}
          onToast={onToast}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
        />
      ) : null}
    </>
  );
}
