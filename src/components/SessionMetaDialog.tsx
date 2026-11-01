/** 会话备注对话框（G1 设计稿 edit-note）：别名/标签（逗号分隔）/备注 + 保存到 meta.json。
 * 三 tab 通用（App 级渲染）；CONFLICT 重载重试 + META_CORRUPT 禁用（由 SessionMetaEditor 移植）。
 * 上限沿用：ALIAS 80 / TAG 24 / TAGS 10 / NOTE 2000。
 */
import { useState } from "react";
import { getMeta, normalizeError, setSessionMeta } from "../api";
import { errorText } from "../format";
import type { AppError, MetaSnapshot, SessionMeta } from "../types";
import { Ico, Modal } from "./ui";
import { Check } from "lucide-react";
import type { ToastFn } from "./useOmpOp";

export const ALIAS_MAX = 80;
export const TAG_MAX = 24;
export const TAGS_MAX = 10;
export const NOTE_MAX = 2000;

interface SessionMetaDialogProps {
  sessionId: string;
  sessionTitle: string;
  entry: SessionMeta | null;
  revision: number;
  loadError: AppError | null;
  onSnapshot: (snap: MetaSnapshot) => void;
  onClose: () => void;
  onToast: ToastFn;
}

/** 逗号分隔标签解析：中英文逗号拆分、去空、去重（大小写不敏感保留首个写法）。 */
export function parseTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,，]/)) {
    const t = part.trim();
    if (t === "") continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(t);
  }
  return out;
}

export function SessionMetaDialog({
  sessionId,
  sessionTitle,
  entry,
  revision,
  loadError,
  onSnapshot,
  onClose,
  onToast,
}: SessionMetaDialogProps) {
  const [alias, setAlias] = useState(entry?.alias ?? "");
  const [tagsRaw, setTagsRaw] = useState((entry?.tags ?? []).join(", "));
  const [note, setNote] = useState(entry?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);

  const corrupted = loadError?.code === "META_CORRUPT";

  async function reload(label: string) {
    try {
      onSnapshot(await getMeta());
      onToast(label, "info");
    } catch (e) {
      onToast(errorText(normalizeError(e)), "error");
    }
  }

  async function save() {
    if (saving || corrupted) return;
    if (alias.trim().length > ALIAS_MAX) {
      setSaveError({ code: "INVALID_INPUT", message: `别名最多 ${ALIAS_MAX} 个字符` });
      return;
    }
    const tags = parseTags(tagsRaw);
    const overlong = tags.find((t) => t.length > TAG_MAX);
    if (overlong !== undefined) {
      setSaveError({ code: "INVALID_INPUT", message: `单个标签最多 ${TAG_MAX} 个字符` });
      return;
    }
    if (tags.length > TAGS_MAX) {
      setSaveError({ code: "INVALID_INPUT", message: `标签最多 ${TAGS_MAX} 个` });
      return;
    }
    if (note.trim().length > NOTE_MAX) {
      setSaveError({ code: "INVALID_INPUT", message: `备注最多 ${NOTE_MAX} 个字符` });
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      onSnapshot(await setSessionMeta(sessionId, { alias, tags, note }, revision));
      onToast("备注已保存", "info");
      onClose();
    } catch (e) {
      const err = normalizeError(e);
      if (err.code === "CONFLICT") {
        setSaveError({ code: "CONFLICT", message: "备注已被外部修改，已重新载入，请检查后重试" });
        await reload("备注已被外部修改，已重新载入");
      } else {
        setSaveError(err);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="编辑会话备注"
      sub={
        <>
          别名、标签与备注只写入应用自己的 <code>meta.json</code>，不会修改会话文件。
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-autofocus
            disabled={saving || corrupted}
            title={corrupted ? "备注文件已损坏，请先修复" : undefined}
            onClick={() => void save()}
          >
            <Ico icon={Check} size={13} />
            {saving ? "保存中…" : "保存到 meta.json"}
          </button>
        </>
      }
    >
      <p className="meta" aria-label={`会话：${sessionTitle}`}>
        {sessionTitle}
      </p>
      {corrupted ? (
        <div className="inline-note warn" role="note">
          <span>备注文件已损坏（META_CORRUPT），保存已禁用，请先修复 meta.json。</span>
        </div>
      ) : null}
      <div className="fld">
        <label htmlFor="meta-alias">别名</label>
        <input
          id="meta-alias"
          value={alias}
          maxLength={ALIAS_MAX}
          placeholder="例如 tree-layout"
          onChange={(e) => setAlias(e.target.value)}
        />
      </div>
      <div className="fld">
        <label htmlFor="meta-tags">标签</label>
        <input
          id="meta-tags"
          value={tagsRaw}
          placeholder="用逗号分隔，例如 Rust, 布局"
          onChange={(e) => setTagsRaw(e.target.value)}
        />
      </div>
      <div className="fld">
        <label htmlFor="meta-note">备注</label>
        <textarea
          id="meta-note"
          rows={4}
          value={note}
          maxLength={NOTE_MAX}
          placeholder="给未来的自己留一句话"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {saveError ? (
        <div className="inline-note warn" role="alert">
          <span>{errorText(saveError)}</span>
        </div>
      ) : null}
    </Modal>
  );
}
