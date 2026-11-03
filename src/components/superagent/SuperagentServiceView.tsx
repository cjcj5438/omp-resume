/** Superagent 服务页：启用/停用、重启、状态、路径、日志。 */
import { useEffect, useState } from "react";
import { FolderSearch, Power, RefreshCw } from "lucide-react";
import {
  normalizeError,
  revealFile,
  superagentLogTail,
  superagentRestart,
  superagentSetEnabled,
  superagentStatus,
} from "../../api";
import type { AppError, SuperagentState, SuperagentStatus } from "../../types";
import { displayCwd, formatFullTime } from "../../format";
import { startChain } from "../../pollChain";
import { ErrorBanner, PageHeader, Panel, StatePill, Switch } from "../page";
import "./Superagent.css";

interface SuperagentServiceViewProps {
  onToast: (text: string, kind: "info" | "error") => void;
}

const POLL_MS = 3000;
const LOG_LINES = 200;

const PILL: Record<SuperagentState, { state: "running" | "idle" | "queued" | "failed"; word: string }> = {
  disabled: { state: "idle", word: "未启用" },
  starting: { state: "queued", word: "启动中" },
  running: { state: "running", word: "运行中" },
  stopping: { state: "queued", word: "停止中" },
  stopped: { state: "idle", word: "已停止" },
  crashed: { state: "failed", word: "异常退出" },
};

interface PathRow {
  key: string;
  label: string;
  value: string | null;
  /** reveal 走 `open -R`，只能选中文件；目录行不显示按钮。 */
  isFile: boolean;
}

export function SuperagentServiceView({ onToast }: SuperagentServiceViewProps) {
  const [status, setStatus] = useState<SuperagentStatus | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [logError, setLogError] = useState<AppError | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    return startChain(async () => {
      try {
        setStatus(await superagentStatus());
        setError(null);
      } catch (e) {
        setError(normalizeError(e));
      }
      return POLL_MS;
    });
  }, []);

  const loadLog = async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      setLog(await superagentLogTail(LOG_LINES));
    } catch (e) {
      setLogError(normalizeError(e));
    } finally {
      setLogLoading(false);
    }
  };

  useEffect(() => {
    void loadLog();
  }, []);

  const runOp = async (label: string, op: () => Promise<SuperagentStatus>) => {
    setBusy(true);
    try {
      setStatus(await op());
      setError(null);
      onToast(`${label}成功`, "info");
    } catch (e) {
      onToast(`${label}失败：${normalizeError(e).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (path: string) => {
    try {
      await revealFile(path);
    } catch (e) {
      onToast(`在 Finder 中显示失败：${normalizeError(e).message}`, "error");
    }
  };

  const pill = status !== null ? PILL[status.state] : null;
  const paths: PathRow[] = [
    { key: "stateDir", label: "状态目录", value: status?.stateDir ?? null, isFile: false },
    { key: "socketPath", label: "socket", value: status?.socketPath ?? null, isFile: true },
    { key: "logPath", label: "日志文件", value: status?.logPath ?? null, isFile: true },
    { key: "assetsDir", label: "资源目录", value: status?.assetsDir ?? null, isFile: false },
    { key: "ompBin", label: "omp 可执行文件", value: status?.ompBin ?? null, isFile: true },
  ];

  return (
    <div className="view">
      <PageHeader
        kicker="Superagent · 守护进程托管"
        title="服务"
        sub="守护进程由本应用以子进程托管：开、关、重启都在这里，状态每 3 秒刷新。"
        actions={
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || status === null || !status.enabled}
            title={status !== null && !status.enabled ? "未启用时不可重启" : undefined}
            onClick={() => void runOp("重启", () => superagentRestart())}
          >
            <RefreshCw size={14} aria-hidden="true" />
            重启
          </button>
        }
      />
      {error !== null ? <ErrorBanner error={error} onRetry={() => setError(null)} /> : null}
      <Panel title="状态" icon={Power}>
        {status === null ? (
          <div className="pane-note">读取中…</div>
        ) : (
          <>
            <dl className="detail-list">
              <div className="detail-row">
                <dt>运行状态</dt>
                <dd>
                  {pill !== null ? <StatePill state={pill.state}>{pill.word}</StatePill> : null}
                </dd>
              </div>
              <div className="detail-row">
                <dt>进程 pid</dt>
                <dd className="mono">{status.pid === null ? "—" : String(status.pid)}</dd>
              </div>
              <div className="detail-row">
                <dt>启动时间</dt>
                <dd>{status.startedAt === null ? "—" : formatFullTime(status.startedAt)}</dd>
              </div>
              <div className="detail-row">
                <dt>重启次数</dt>
                <dd className="mono">{status.restarts}</dd>
              </div>
              {status.lastError !== null ? (
                <div className="detail-row">
                  <dt>最近错误</dt>
                  <dd title={status.lastError}>{status.lastError}</dd>
                </div>
              ) : null}
            </dl>
            <Switch
              label="启用 Superagent"
              description={status.enabled ? "守护进程正在托管中；关闭后子进程会退出。" : "打开后本应用会拉起守护进程子进程。"}
              checked={status.enabled}
              disabled={busy}
              onChange={(next) => void runOp(next ? "启用" : "停用", () => superagentSetEnabled(next))}
            />
          </>
        )}
      </Panel>
      <Panel title="路径" icon={FolderSearch}>
        {status === null ? (
          <div className="pane-note">读取中…</div>
        ) : (
          <dl className="detail-list">
            {paths.map((row) => (
              <div className="detail-row" key={row.key}>
                <dt>{row.label}</dt>
                <dd>
                  <span className="sa-path-row">
                    <span className="mono" title={row.value ?? undefined}>
                      {row.value === null ? "—" : displayCwd(row.value)}
                    </span>
                    {row.isFile && row.value !== null ? (
                      <button
                        type="button"
                        className="btn btn-small btn-quiet"
                        onClick={() => {
                          if (row.value !== null) void reveal(row.value);
                        }}
                      >
                        在 Finder 中显示
                      </button>
                    ) : null}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>
      <Panel
        title="日志"
        meta={`末尾 ${LOG_LINES} 行`}
        actions={
          <button type="button" className="btn btn-small btn-ghost" disabled={logLoading} onClick={() => void loadLog()}>
            刷新
          </button>
        }
      >
        {logError !== null ? (
          <ErrorBanner error={logError} onRetry={() => void loadLog()} />
        ) : log === null ? (
          <div className="pane-note">读取中…</div>
        ) : log.length === 0 ? (
          <div className="pane-note">暂无日志</div>
        ) : (
          <pre className="sa-log">{log.join("\n")}</pre>
        )}
      </Panel>
    </div>
  );
}
