/**
 * 会话别名 / 标签 / 备注编辑器：挂在 DetailPane 头部下方。
 * 只读写应用侧 meta.json（`get_meta` / `set_session_meta`），绝不碰会话文件。
 * 保存冲突（CONFLICT）→ 提示并重载快照，用户重试；文件损坏（META_CORRUPT）→ 禁用保存。
 */
import { useEffect, useState } from "react";
import { getMeta, normalizeError, setSessionMeta } from "../api";
import { errorText } from "../format";
import type { AppError, MetaSnapshot, SessionMeta } from "../types";
import "./SessionMetaEditor.css";
import { X } from "lucide-react";
import { Ico } from "./ui";

export const ALIAS_MAX = 80;
export const TAG_MAX = 24;
export const TAGS_MAX = 10;
export const NOTE_MAX = 2000;

interface SessionMetaEditorProps {
  sessionId: string;
  /** 该会话当前条目；null = 尚无备注。 */
  entry: SessionMeta | null;
  /** 快照 revision；保存时作为 expectedRevision。 */
  revision: number;
  /** 快照加载失败（尤其 META_CORRUPT）：禁用保存。 */
  loadError: AppError | null;
  /** 保存/重载成功后向上同步完整快照。 */
  onSnapshot: (snap: MetaSnapshot) => void;
  onToast: (text: string, kind: "info" | "error") => void;
}

export function SessionMetaEditor({
  sessionId,
  entry,
  revision,
  loadError,
  onSnapshot,
  onToast,
}: SessionMetaEditorProps) {
  const [alias, setAlias] = useState(entry?.alias ?? "");
  const [tags, setTags] = useState<string[]>(entry?.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [note, setNote] = useState(entry?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);

  // 切换会话或外部快照变化（保存/重载/冲突后）→ 用新条目重置表单；
  // 不清 saveError：冲突提示要在重载后保留，供用户检查后重试。
  useEffect(() => {
    setAlias(entry?.alias ?? "");
    setTags(entry?.tags ?? []);
    setTagDraft("");
    setNote(entry?.note ?? "");
  }, [sessionId, entry]);

  // 只在切换会话时清错误。
  useEffect(() => {
    setSaveError(null);
  }, [sessionId]);

  const corrupted = loadError?.code === "META_CORRUPT";
  const dirty =
    alias !== (entry?.alias ?? "") ||
    note !== (entry?.note ?? "") ||
    tags.join("\n") !== (entry?.tags ?? []).join("\n");

  function addTag(raw: string) {
    const t = raw.trim();
    if (!t || saving || corrupted) return;
    if (t.length > TAG_MAX) {
      setSaveError({ code: "INVALID_INPUT", message: `单个标签最多 ${TAG_MAX} 个字符` });
      return;
    }
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setTagDraft("");
      return;
    }
    if (tags.length >= TAGS_MAX) {
      setSaveError({ code: "INVALID_INPUT", message: `标签最多 ${TAGS_MAX} 个` });
      return;
    }
    setTags([...tags, t]);
    setTagDraft("");
    setSaveError(null);
  }

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
    if (note.trim().length > NOTE_MAX) {
      setSaveError({ code: "INVALID_INPUT", message: `备注最多 ${NOTE_MAX} 个字符` });
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      onSnapshot(await setSessionMeta(sessionId, { alias, tags, note }, revision));
      onToast("备注已保存", "info");
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

  function revert() {
    setAlias(entry?.alias ?? "");
    setTags(entry?.tags ?? []);
    setTagDraft("");
    setNote(entry?.note ?? "");
    setSaveError(null);
  }

  return (
    <section className="meta-editor" aria-label="别名、标签与备注">
      {corrupted ? (
        <div className="banner banner-error" role="alert">
          <span>备注文件已损坏（{errorText(loadError)}），保存已禁用。请手动修复或删除备注文件后刷新。</span>
          <button type="button" className="btn btn-small" onClick={() => void reload("备注已重新载入")}>
            重新载入
          </button>
        </div>
      ) : null}
      <label className="meta-field">
        <span className="meta-label">别名</span>
        <input
          className="filter-input meta-alias"
          placeholder="给会话起个好记的名字（只在本应用显示）"
          value={alias}
          maxLength={ALIAS_MAX + 20}
          disabled={saving || corrupted}
          onChange={(e) => setAlias(e.target.value)}
          aria-label="会话别名"
        />
      </label>
      <div className="meta-field">
        <span className="meta-label" id="meta-tags-label">标签</span>
        <div className="meta-tags" role="group" aria-labelledby="meta-tags-label">
          {tags.map((t) => (
            <span key={t.toLowerCase()} className="meta-tag">
              {t}
              <button
                type="button"
                className="meta-tag-x"
                aria-label={`删除标签 ${t}`}
                disabled={saving || corrupted}
                onClick={() => setTags(tags.filter((x) => x !== t))}
              >
                <Ico icon={X} size={12} />
              </button>
            </span>
          ))}
          <input
            className="filter-input meta-tag-input"
            placeholder={tags.length === 0 ? "回车添加标签" : "继续添加…"}
            value={tagDraft}
            disabled={saving || corrupted}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag(tagDraft);
              }
            }}
            onBlur={() => {
              if (tagDraft.trim()) addTag(tagDraft);
            }}
            aria-label="添加标签"
          />
        </div>
      </div>
      <label className="meta-field">
        <span className="meta-label">备注</span>
        <textarea
          className="filter-input meta-note"
          placeholder="关于这个会话的备注（只在本应用显示）"
          value={note}
          rows={3}
          disabled={saving || corrupted}
          onChange={(e) => setNote(e.target.value)}
          aria-label="会话备注"
        />
      </label>
      {saveError ? (
        <div className="banner banner-error" role="alert">
          {errorText(saveError)}
        </div>
      ) : null}
      <div className="meta-actions">
        <button
          type="button"
          className="btn btn-accent btn-small"
          disabled={!dirty || saving || corrupted}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!dirty || saving}
          onClick={revert}
        >
          还原
        </button>
        <span className="muted meta-hint">别名/标签/备注只存于本应用，不写入会话文件；`omp --resume` 里仍显示原标题。</span>
      </div>
    </section>
  );
}
