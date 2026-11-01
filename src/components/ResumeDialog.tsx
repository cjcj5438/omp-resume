/** 单个恢复确认框（G8 设计稿 selectDialog）：打开即用 check_session 最新探测决定变体。
 * - idle：在 iTerm2 打开标签页（open_in_iterm）。
 * - inUse（决策4）：warn 说明占用者；iTerm2 占用→「切到正在运行的标签页」（focus_iterm_tab），否则只有「知道了」；绝不调 open_in_iterm。
 * - 探测中按钮禁用；探测失败（!probeOk）warn 且不给「打开标签页」。
 * - v2 叠加格式 warn 行（非阻塞，G9）。
 */
import { useEffect, useState } from "react";
import type { Occupant, SessionSummary } from "../types";
import { checkSession, focusItermTab, normalizeError, openInIterm } from "../api";
import { displayCwd, errorText } from "../format";
import { Ico, Modal } from "./ui";
import { SquareTerminal } from "lucide-react";
import type { ToastFn } from "./useOmpOp";

interface ResumeDialogProps {
  session: SessionSummary;
  onClose: () => void;
  onOpened: () => void;
  onToast: ToastFn;
}

type Probe = { state: "loading" } | { state: "ready"; inUse: boolean; probeOk: boolean } | { state: "failed"; message: string };

function occupantText(o: Occupant | null): string {
  if (o?.app == null) return "另一个 omp 进程";
  const ver = o.appVersion != null ? ` ${o.appVersion}` : "";
  return `${o.app}${ver} · PID ${o.pid}`;
}

export function ResumeDialog({ session, onClose, onOpened, onToast }: ResumeDialogProps) {
  const [probe, setProbe] = useState<Probe>({ state: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    checkSession({ path: session.path })
      .then((r) => {
        if (alive) setProbe({ state: "ready", inUse: r.inUse, probeOk: r.probeOk });
      })
      .catch((e: unknown) => {
        if (alive) setProbe({ state: "failed", message: errorText(normalizeError(e)) });
      });
    return () => {
      alive = false;
    };
  }, [session.path]);

  const inUse = probe.state === "ready" && probe.inUse;
  const probeOk = probe.state === "ready" ? probe.probeOk : probe.state === "loading" ? true : false;
  const loading = probe.state === "loading" || busy;
  const itermOccupant = session.occupant?.app === "iTerm2";

  async function doOpen(): Promise<void> {
    setBusy(true);
    try {
      await openInIterm({ path: session.path });
      onToast(`已打开 iTerm2 标签页 · ${session.title}`, "info");
      onOpened();
      onClose();
    } catch (e: unknown) {
      onToast(errorText(normalizeError(e)), "error");
    } finally {
      setBusy(false);
    }
  }

  async function doFocus(): Promise<void> {
    setBusy(true);
    try {
      await focusItermTab(session.path);
      onClose();
    } catch (e: unknown) {
      onToast(errorText(normalizeError(e)), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="在 iTerm2 中恢复会话"
      sub={
        <>
          将在新的 iTerm2 标签页中执行真实的 <code>omp --resume</code>。完成后不再向标签页输入任何按键。
        </>
      }
      onClose={onClose}
      footer={
        inUse ? (
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
              取消
            </button>
            {itermOccupant ? (
              <button
                type="button"
                className="btn btn-primary"
                data-autofocus
                disabled={busy}
                onClick={() => void doFocus()}
              >
                切到正在运行的标签页
              </button>
            ) : (
              <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
                知道了
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-autofocus
              disabled={loading || !probeOk}
              title={!probeOk ? "占用探测失败，无法确认安全" : undefined}
              onClick={() => void doOpen()}
            >
              <Ico icon={SquareTerminal} size={13} />
              打开标签页
            </button>
          </>
        )
      }
    >
      <div className="dlg-kv">
        <div>
          <span>会话</span>
          <span>{session.title}</span>
        </div>
        <div>
          <span>路径</span>
          <span>{displayCwd(session.cwd)}</span>
        </div>
        <div>
          <span>模型</span>
          <span>{session.model ?? "—"}</span>
        </div>
        <div>
          <span>状态</span>
          <span>
            {probe.state === "loading" ? "探测中…" : inUse ? "当前被 omp 占用" : "空闲"}
          </span>
        </div>
      </div>
      {!session.formatSupported ? (
        <div className="inline-note warn" role="note">
          <span>
            该会话格式（版本 {session.version ?? "?"}）较旧，恢复后如遇问题请改用只读审阅。
          </span>
        </div>
      ) : null}
      {inUse ? (
        <div className="inline-note warn" role="note">
          <span>
            该会话正被{occupantText(session.occupant)}持有。为保护正在运行的会话，不会再开一个
            omp 进程。
            {itermOccupant ? "可直接切到正在运行的标签页。" : ""}
          </span>
        </div>
      ) : null}
      {probe.state === "failed" || (probe.state === "ready" && !probe.probeOk) ? (
        <div className="inline-note warn" role="note">
          <span>
            占用探测失败
            {probe.state === "failed" ? `：${probe.message}` : ""}，无法确认安全，已禁用打开。
          </span>
        </div>
      ) : null}
    </Modal>
  );
}
