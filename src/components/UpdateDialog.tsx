/** 发现新版本：展示版本号/日期/说明，下载安装，成功后重启。 */
import { useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Modal } from "./ui";
import { relaunchApp } from "../update";

interface UpdateDialogProps {
  update: Update;
  onClose: () => void;
}

type Phase = "ready" | "downloading" | "done" | "error";

function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateDialog({ update, onClose }: UpdateDialogProps) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState("");
  // relaunch 失败时留在对话框内提示，用户可手动重启。
  const [restartError, setRestartError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const date = formatDate(update.date);
  const progressText =
    total != null
      ? `下载中…${formatSize(downloaded)} / ${formatSize(total)}`
      : downloaded > 0
        ? `下载中…已下载 ${formatSize(downloaded)}`
        : "下载中…";

  const footer = (() => {
    if (phase === "done") {
      return (
        <>
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            稍后重启
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              void relaunchApp().then((err) => {
                setRestarting(false);
                if (err) setRestartError(err);
              });
            }}
          >
            {restarting ? "重启中…" : "立即重启"}
          </button>
        </>
      );
    }
    if (phase === "error") {
      return (
        <button type="button" className="btn" data-autofocus onClick={onClose}>
          关闭
        </button>
      );
    }
    const busy = phase === "downloading";
    return (
      <>
        <button type="button" className="btn" data-autofocus disabled={busy} onClick={onClose}>
          稍后
        </button>
        <button
          type="button"
          className="btn btn-accent"
          disabled={busy}
          onClick={() => {
            setPhase("downloading");
            void update
              .downloadAndInstall((e) => {
                if (e.event === "Started" && e.data.contentLength != null) {
                  setTotal(e.data.contentLength);
                } else if (e.event === "Progress") {
                  setDownloaded((n) => n + e.data.chunkLength);
                }
              })
              .then(() => setPhase("done"))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "下载安装失败，请稍后重试");
                setPhase("error");
              });
          }}
        >
          {busy ? progressText : "下载并安装"}
        </button>
      </>
    );
  })();

  return (
    <Modal title={`发现新版本 ${update.version}`} onClose={onClose} footer={footer}>
      <p>
        当前版本 {update.currentVersion}，可更新到 {update.version}
        {date ? `（发布于 ${date}）` : null}。
      </p>
      {update.body ? <p className="update-notes">{update.body}</p> : null}
      {phase === "error" ? <p className="banner banner-error">{error}</p> : null}
      {phase === "done" ? (
        <p>安装完成，重启后生效{restartError ? `。${restartError}，请手动重启应用` : "。"}</p>
      ) : null}
    </Modal>
  );
}
