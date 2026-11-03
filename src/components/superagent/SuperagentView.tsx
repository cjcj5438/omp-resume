/** Superagent 管理面板：守护进程 running 时嵌入原面板，其余状态显示空态。 */
import { useEffect, useState } from "react";
import { Workflow } from "lucide-react";
import { SuperagentPanel } from "omp-superagent/panel";
import { normalizeError, superagentStatus } from "../../api";
import type { AppError, SuperagentState, SuperagentStatus } from "../../types";
import { errorText } from "../../format";
import { startChain } from "../../pollChain";
import type { Route } from "../../routes";
import { EmptyState } from "../ui";
import { PageHeader } from "../page";
import { invokeTransport } from "./transport";
import "./Superagent.css";

interface SuperagentViewProps {
  onOpenSession: (id: string) => void;
  onNavigate: (route: Route) => void;
}

const POLL_MS = 3000;

const STATE_TITLE: Record<Exclude<SuperagentState, "running">, string> = {
  disabled: "Superagent 未启用",
  starting: "正在启动…",
  stopping: "正在停止…",
  stopped: "已停止",
  crashed: "守护进程异常退出",
};

export function SuperagentView({ onOpenSession, onNavigate }: SuperagentViewProps) {
  const [status, setStatus] = useState<SuperagentStatus | null>(null);
  const [error, setError] = useState<AppError | null>(null);

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

  return (
    <div className="view">
      <PageHeader
        kicker="Superagent · 守护进程面板"
        title="管理面板"
        sub="来源、工单、执行与设置的统一管理界面，由 Superagent 守护进程提供。"
      />
      {error !== null && status === null ? (
        <EmptyState
          icon={Workflow}
          title="状态读取失败"
          action={
            <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>
              重试
            </button>
          }
        >
          {errorText(error)}
        </EmptyState>
      ) : status === null || status.state !== "running" ? (
        <EmptyState
          icon={Workflow}
          title={status === null || status.state === "running" ? "正在读取状态…" : STATE_TITLE[status.state]}
          action={
            status !== null ? (
              <button type="button" className="btn btn-ghost" onClick={() => onNavigate("superagent-service")}>
                前往服务页
              </button>
            ) : undefined
          }
        >
          {status?.lastError ?? "守护进程未运行时，管理面板不可用。"}
        </EmptyState>
      ) : (
        <div className="sa-host">
          <SuperagentPanel transport={invokeTransport} openSession={onOpenSession} lang="zh" />
        </div>
      )}
    </div>
  );
}
