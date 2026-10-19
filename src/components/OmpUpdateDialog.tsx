/** omp CLI 更新：展示检查结果、实时日志，仅以版本变化判定已更新。 */
import { useRef, useState } from "react";
import { normalizeError, runOmpUpdate } from "../api";
import { errorText, openOmpChangelog } from "../format";
import type { OmpUpdateCheck, OmpUpdateResult } from "../types";
import { Modal } from "./ui";

interface OmpUpdateDialogProps {
  check: OmpUpdateCheck;
  onClose: () => void;
  onUpdated: (after: string | null) => void;
}

type Phase = "ready" | "running" | "done" | "error";

export function OmpUpdateDialog({ check, onClose, onUpdated }: OmpUpdateDialogProps) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<OmpUpdateResult | null>(null);
  const [error, setError] = useState("");
  const running = phase === "running";
  // 同步守卫：disabled 是 state 派生，同一帧内的第二次点击需同步拦截。
  const runningRef = useRef(false);

  async function update() {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("running");
    try {
      const updated = await runOmpUpdate((line) => setLines((previous) => [...previous, line]));
      setResult(updated);
      setPhase("done");
      if (updated.changed) onUpdated(updated.after);
    } catch (e: unknown) {
      setError(errorText(normalizeError(e)));
      setPhase("error");
    } finally {
      runningRef.current = false;
    }
  }

  return (
    <Modal
      title="omp 版本更新"
      onClose={() => { if (!running) onClose(); }}
      footer={
        <>
          <button type="button" className="btn" data-autofocus disabled={running} onClick={onClose}>
            关闭
          </button>
          {check.latest && (phase === "ready" || running) ? (
            <button type="button" className="btn btn-accent" disabled={running} onClick={() => void update()}>
              {running ? <span className="spinner" aria-hidden="true" /> : null}
              {running ? "更新中…" : "更新 omp"}
            </button>
          ) : null}
        </>
      }
    >
      <p>
        当前 omp {check.current ?? "未知"}
        <button
          type="button"
          className="changelog-link"
          title="在浏览器打开 omp 官方更新日志"
          onClick={() => void openOmpChangelog()}
        >
          查看更新日志
        </button>
      </p>
      {phase === "ready" ? (
        check.latest ? <p>可更新到 {check.latest}</p> : check.upToDate ? <p>已是最新版本</p> : (
          <>
            <p className="banner">未识别的输出，可能由包管理器托管；请在其管理器中更新</p>
            <div className="update-notes"><pre className="plain-text mono">{check.raw}</pre></div>
          </>
        )
      ) : null}
      {running || phase === "error" ? (
        <div className="update-notes"><pre className="plain-text mono" aria-label="omp 更新日志">{lines.join("\n")}</pre></div>
      ) : null}
      {phase === "error" ? <p className="banner banner-error" role="alert">{error}</p> : null}
      {phase === "done" && result ? (
        result.changed ? (
          <p>已更新到 {result.after}。已打开的 omp 会话需重启后才使用新版本。</p>
        ) : (
          <>
            <p>版本未变化</p>
            <div className="update-notes"><pre className="plain-text mono">{result.output}</pre></div>
          </>
        )
      ) : null}
    </Modal>
  );
}
