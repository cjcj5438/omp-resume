/**
 * 添加模型对话框（设计稿 model-add）：模型名（provider/id）/ 上下文 / 最大输出
 * → create_model_spec 写 models.yml。128k/16k 前端严格解析为整数。
 */
import { useMemo, useState, type ReactNode } from "react";
import { createModelSpec, normalizeError } from "../api";
import { errorText } from "../format";
import { Modal } from "./ui";
import type { ToastFn } from "./useOmpOp";

interface ModelAddDialogProps {
  providers: string[];
  revision: string;
  onClose: () => void;
  onCreated: () => void;
  onToast: ToastFn;
}

/** 128k/16k/1M → 整数（只接受纯数字与 k/m 后缀，不接受小数/空格/符号）。 */
export function parseCapacity(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)([km])?$/.exec(trimmed);
  if (match === null) return { ok: false };
  const mult = match[2] === "m" ? 1000000 : match[2] === "k" ? 1000 : 1;
  const value = Number(match[1]) * mult;
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false };
  return { ok: true, value };
}

export function ModelAddDialog(props: ModelAddDialogProps): ReactNode {
  const { providers, revision, onClose, onCreated, onToast } = props;
  const [provider, setProvider] = useState(providers[0] ?? "");
  const [id, setId] = useState("");
  const [contextWindow, setContextWindow] = useState("128k");
  const [maxTokens, setMaxTokens] = useState("16k");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    if (provider === "") return { ok: false as const, error: "请选择提供方" };
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id.trim())) return { ok: false as const, error: "模型 id 须为字母数字开头，可含 . _ -" };
    const ctx = parseCapacity(contextWindow);
    if (!ctx.ok) return { ok: false as const, error: "上下文须为正整数或 128k/1M 形式" };
    const maxParsed = parseCapacity(maxTokens);
    if (!maxParsed.ok) return { ok: false as const, error: "最大输出须为正整数或 16k/1M 形式" };
    return { ok: true as const, contextWindow: ctx.value, maxTokens: maxParsed.value };
  }, [provider, id, contextWindow, maxTokens]);

  async function handleCreate(): Promise<void> {
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await createModelSpec({
        provider,
        id: id.trim(),
        patch: { contextWindow: parsed.contextWindow, maxTokens: parsed.maxTokens },
        expectedRevision: revision,
      });
      onToast(`已添加模型：${provider}/${id.trim()}`, "info");
      onCreated();
      onClose();
    } catch (e: unknown) {
      const text = errorText(normalizeError(e));
      setFormError(text);
      onToast(`添加模型失败：${text}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="添加模型"
      sub="会先写入 models.yml，再刷新模型库。"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy || !parsed.ok} onClick={() => void handleCreate()}>
            {busy ? "添加中…" : "添加"}
          </button>
        </>
      }
    >
      <div className="fld">
        <label htmlFor="model-add-provider">提供方</label>
        <select id="model-add-provider" value={provider} disabled={busy} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <span className="help">只能加入已有提供方；新建提供方需手动改 models.yml（baseUrl 与凭据无法编造）。</span>
      </div>
      <div className="fld">
        <label htmlFor="model-add-id">模型 id</label>
        <input id="model-add-id" value={id} disabled={busy} placeholder="model-id" onChange={(e) => setId(e.target.value)} />
      </div>
      <div className="fld-2">
        <div className="fld">
          <label htmlFor="model-add-ctx">上下文</label>
          <input id="model-add-ctx" value={contextWindow} disabled={busy} onChange={(e) => setContextWindow(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="model-add-out">最大输出</label>
          <input id="model-add-out" value={maxTokens} disabled={busy} onChange={(e) => setMaxTokens(e.target.value)} />
        </div>
      </div>
      {formError !== null ? <div className="spec-error" role="alert">{formError}</div> : null}
    </Modal>
  );
}
