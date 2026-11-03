/** 新建会话对话框（G10 设计稿 newSessionDialog）：工作目录 + 选择… + 留空说明 + 模型下拉 + 在 iTerm2 启动。
 * cwd 为 null = 留空（用上次目录，localStorage 记）；模型首项「默认（不指定）」，加载失败仅默认项可提交。
 */
import { useEffect, useState } from "react";
import { chooseDirectory, listModels, newSessionInIterm, normalizeError } from "../api";
import { errorText } from "../format";
import type { ModelInfo } from "../types";
import { Ico, Modal } from "./ui";
import { SquareTerminal } from "lucide-react";
import type { ToastFn } from "./useOmpOp";

const LAST_DIR_KEY = "omp-resume:new-session-dir";

interface NewSessionDialogProps {
  /** 预填目录（组「+」/历史页 cwd）；null = 用上次目录或留空。 */
  initialCwd: string | null;
  onClose: () => void;
  onToast: ToastFn;
}

export function NewSessionDialog({ initialCwd, onClose, onToast }: NewSessionDialogProps) {
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    // 留空时回填上次目录（仅展示，提交时再读 localStorage）。
    if (initialCwd === null) {
      try {
        const last = localStorage.getItem(LAST_DIR_KEY);
        if (last) setCwd(last);
      } catch {
        // 无痕/禁用存储：留空即可。
      }
    }
    listModels()
      .then((list) => {
        if (alive) setModels(list);
      })
      .catch(() => {
        // 模型列表加载失败：仅默认项可提交。
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [initialCwd]);

  async function pickDir(): Promise<void> {
    try {
      const dir = await chooseDirectory();
      if (dir !== null) setCwd(dir);
    } catch (e: unknown) {
      onToast(errorText(normalizeError(e)), "error");
    }
  }

  async function submit(): Promise<void> {
    // 路径首尾空格可能是目录名的一部分（如 NAS 上的 "…dsh-superagent-prototype "），
    // 不能直接 trim：原样提交；仅全空白视为「留空」走上次目录。
    let target = cwd;
    if (target.trim() === "") {
      try {
        target = localStorage.getItem(LAST_DIR_KEY) ?? "";
      } catch {
        target = "";
      }
    }
    if (target === "") {
      onToast("请填写工作目录，或点「选择…」挑选", "error");
      return;
    }
    setBusy(true);
    try {
      await newSessionInIterm(target, model === "" ? null : model);
      try {
        localStorage.setItem(LAST_DIR_KEY, target);
      } catch {
        // 记不住也无妨。
      }
      onToast("已在 iTerm 新开会话", "info");
      onClose();
    } catch (e: unknown) {
      onToast(errorText(normalizeError(e)), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新建会话"
      sub={
        <>
          选择目录后，会在新的 iTerm2 标签页里启动 <code>omp</code>。
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-autofocus
            disabled={busy}
            onClick={() => void submit()}
          >
            <Ico icon={SquareTerminal} size={13} />
            {busy ? "启动中…" : "在 iTerm2 启动"}
          </button>
        </>
      }
    >
      <div className="fld">
        <label htmlFor="new-dir">工作目录</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id="new-dir"
            value={cwd}
            placeholder="~/dev/project"
            onChange={(e) => setCwd(e.target.value)}
          />
          <button type="button" className="btn btn-ghost" onClick={() => void pickDir()}>
            选择…
          </button>
        </div>
        <span className="help">留空则使用上次的目录。</span>
      </div>
      <div className="fld">
        <label htmlFor="new-model">模型</label>
        <select id="new-model" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">默认（不指定）</option>
          {(models ?? []).map((m) => (
            <option key={m.selector} value={m.selector}>
              {m.selector}
            </option>
          ))}
        </select>
        {models !== null && models.length === 0 ? (
          <span className="help">模型列表加载失败，仅可用默认模型提交。</span>
        ) : null}
      </div>
    </Modal>
  );
}
