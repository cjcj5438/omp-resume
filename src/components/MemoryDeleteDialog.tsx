/**
 * 记忆删除确认框：memory_delete_preview 给出可删/跳过/级联数字，
 * memory_bank_status 做占用门禁；确认后才调用 memory_delete_items。
 * 空 ids 不发任何请求。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { memoryDeleteItems, memoryDeletePreview, normalizeError } from "../api";
import type { MemoryDeletePreview } from "../types";
import { errorText } from "../format";
import { Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";
import { MemoryGateNote, memoryWriteErrorText, useBankStatus } from "./useMemoryMaintenance";
import "./MemoryPanel.css";

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
  const status = gate.status !== null && gate.status.bank === bank ? gate.status : null;
  const deletable = preview === null ? 0 : preview.deletable.working + preview.deletable.episodic;
  const ready =
    ids.length > 0 && !busy && !previewLoading && !gate.loading && preview !== null && previewError === null &&
    gate.error === null && status !== null && !status.inUse && !status.probeFailed && deletable > 0;
  const busyRef = useRef(false);

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    memoryDeletePreview({ bank, ids })
      .then((p) => !cancelled && setPreview(p))
      .catch((e: unknown) => !cancelled && setPreviewError(errorText(normalizeError(e))))
      .finally(() => !cancelled && setPreviewLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, idsKey, retryToken]);

  async function confirm(): Promise<void> {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      const result = await memoryDeleteItems({ bank, ids });
      const skipped = result.skipped.length;
      onToast(
        skipped > 0 ? `已删除 ${result.deleted.length} 条，跳过 ${skipped} 条，已备份` : `已删除 ${result.deleted.length} 条，已备份`,
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

  const reasons = preview === null ? [] : [
    ...(preview.notFound > 0 ? [`${preview.notFound} 条已不在库中`] : []),
    ...(preview.unsupported > 0 ? [`${preview.unsupported} 条暂不支持`] : []),
  ];
  const cascade = preview === null ? "" : ([
    ["facts", "事实", " 条"], ["embeddings", "向量", " 个"], ["annotations", "标注", " 条"],
    ["edges", "关联边", " 条"], ["other", "其他", " 条"],
  ] as const).filter(([k]) => preview.cascade[k] > 0).map(([k, label, unit]) => `${label} ${preview.cascade[k]}${unit}`).join(" · ");

  return (
    <Modal
      title={`删除记忆（${displayName}）`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn-danger" disabled={!ready} onClick={() => void confirm()}>
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
          <p>确认信息加载失败：{previewError ?? gate.error}</p>
          <button type="button" className="btn btn-small" onClick={() => setRetryToken((t) => t + 1)}>重试</button>
        </>
      ) : preview !== null ? (
        <>
          <p>
            将从「{displayName}」删除 {deletable} 条记忆（工作 {preview.deletable.working} · 情节 {preview.deletable.episodic}）。
          </p>
          {preview.notFound > 0 ? <p className="muted">{preview.notFound} 条已不在库中，将跳过。</p> : null}
          {preview.unsupported > 0 ? <p className="muted">该库的情节摘要暂不支持删除：{preview.unsupported} 条，将跳过。</p> : null}
          {preview.citedBySummaries > 0 ? (
            <p className="mem-note-amber">
              有 {preview.citedBySummaries} 条情节摘要引用了这些记忆，删除后摘要保留但不再对应原文。
            </p>
          ) : null}
          <p className="muted">{cascade === "" ? "无附带清理项。" : `同时清理：${cascade}。`}</p>
          <p className="muted">删除前会自动备份整库，可在「备份与恢复」中还原。</p>
          <MemoryGateNote status={status} loadError={null} onRetry={() => setRetryToken((t) => t + 1)} />
          {deletable === 0 ? <p>所选记忆都无法删除（{reasons.join("，")}）。</p> : null}
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
      <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>{label}</button>
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
