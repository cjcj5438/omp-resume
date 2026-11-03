/** Superagent 会话页：左列主会话 + worker 会话，右列只读对话。 */
import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { getConversation, normalizeError, superagentRequest } from "../../api";
import type { AppError, Conversation, SuperagentSessionItem } from "../../types";
import { startChain } from "../../pollChain";
import { ConversationView } from "../ConversationView";
import { ErrorBanner, PageHeader, Panel, StatePill } from "../page";
import { Badge, EmptyState } from "../ui";
import "./Superagent.css";

interface SuperagentSessionsViewProps {
  /** 管理面板「打开会话」请求：seq 区分每次点击（同 id 重复点也要切过去）。 */
  target: { id: string; seq: number } | null;
}

const POLL_MS = 5000;

type PillState = "running" | "idle" | "queued" | "done";

const PILL: Record<SuperagentSessionItem["state"], { state: PillState; word: string }> = {
  running: { state: "running", word: "运行中" },
  settling: { state: "running", word: "收尾中" },
  starting: { state: "queued", word: "启动中" },
  idle: { state: "idle", word: "空闲" },
  absent: { state: "done", word: "未运行" },
};

/** 守护进程响应的单行校验：形状不对的行直接丢掉，不让整页崩掉。 */
function isSessionItem(v: unknown): v is SuperagentSessionItem {
  if (typeof v !== "object" || v === null) return false;
  if (!("id" in v && "role" in v && "ticketId" in v && "title" in v && "sessionFile" in v && "state" in v)) {
    return false;
  }
  const { id, role, ticketId, title, sessionFile, state } = v;
  return (
    typeof id === "string" &&
    (role === "orchestrator" || role === "worker") &&
    (ticketId === null || typeof ticketId === "string") &&
    typeof title === "string" &&
    (sessionFile === null || typeof sessionFile === "string") &&
    (state === "absent" || state === "starting" || state === "running" || state === "settling" || state === "idle")
  );
}

function parseSessions(body: string): SuperagentSessionItem[] {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || !("items" in parsed)) return [];
  const items = parsed.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isSessionItem);
}
export function SuperagentSessionsView({ target }: SuperagentSessionsViewProps) {
  const [items, setItems] = useState<SuperagentSessionItem[]>([]);
  const [listError, setListError] = useState<AppError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [convLoading, setConvLoading] = useState(false);
  const [convError, setConvError] = useState<AppError | null>(null);

  useEffect(() => {
    return startChain(async () => {
      try {
        const r = await superagentRequest("GET", "sessions");
        if (r.status < 200 || r.status >= 300) throw new Error(`守护进程返回 ${r.status}`);
        setItems(parseSessions(r.body));
        setListError(null);
      } catch (e) {
        setListError(normalizeError(e));
      }
      return POLL_MS;
    });
  }, []);

  // 外部跳转：每次 seq 变化都选中目标（即使 id 与当前相同）。
  useEffect(() => {
    if (target !== null) setSelectedId(target.id);
  }, [target]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  // 默认选中第一行（主会话排第一）；选中项消失时回落。
  const effective = selected ?? items[0] ?? null;

  useEffect(() => {
    const file = effective?.sessionFile ?? null;
    if (file === null) {
      setConversation(null);
      setConvError(null);
      setConvLoading(false);
      return;
    }
    let alive = true;
    setConvLoading(true);
    setConvError(null);
    getConversation({ path: file })
      .then((c) => {
        if (alive) {
          setConversation(c);
          setConvLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setConvError(normalizeError(e));
          setConvLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [effective?.sessionFile]);

  const retryConv = () => {
    const file = effective?.sessionFile ?? null;
    if (file === null) return;
    setConvLoading(true);
    setConvError(null);
    getConversation({ path: file })
      .then((c) => {
        setConversation(c);
        setConvLoading(false);
      })
      .catch((e: unknown) => {
        setConvError(normalizeError(e));
        setConvLoading(false);
      });
  };

  return (
    <div className="view">
      <PageHeader
        kicker="Superagent · 只读"
        title="会话"
        sub="主会话与各 worker 会话的对话记录，由守护进程按需拉起，这里只读展示。"
      />
      {listError !== null ? (
        <ErrorBanner error={listError} onRetry={() => setListError(null)} />
      ) : null}
      <div className="sa-split">
        <Panel title="会话列表" icon={ScrollText} meta={`${items.length} 个`}>
          {items.length === 0 ? (
            <div className="pane-note">暂无会话</div>
          ) : (
            <ul className="sa-list">
              {items.map((item) => {
                const pill = PILL[item.state];
                const isSelected = effective?.id === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={isSelected ? "sa-row is-selected" : "sa-row"}
                      aria-pressed={isSelected}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="sa-row-main">
                        <span className="sa-row-title" title={item.title}>
                          {item.title}
                        </span>
                        <span className="sa-row-sub">
                          <span className="mono">{item.id}</span>
                          {item.ticketId !== null ? <span>工单 {item.ticketId}</span> : null}
                        </span>
                      </span>
                      <span className="sa-row-side">
                        <Badge tone={item.role === "orchestrator" ? "accent" : "grey"}>
                          {item.role === "orchestrator" ? "主会话" : "worker"}
                        </Badge>
                        <StatePill state={pill.state}>{pill.word}</StatePill>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel
          title={effective === null ? "对话" : effective.title}
          meta={effective === null ? undefined : effective.id}
        >
          {effective === null ? (
            <EmptyState icon={ScrollText} title="还没有会话">
              启用 Superagent 后，主会话会出现在这里。
            </EmptyState>
          ) : effective.sessionFile === null ? (
            <EmptyState icon={ScrollText} title="该会话还没有记录">
              该会话尚未产生对话文件，稍后再看。
            </EmptyState>
          ) : convError !== null ? (
            <ErrorBanner error={convError} onRetry={retryConv} />
          ) : (
            <ConversationView
              conversation={conversation}
              loading={convLoading}
              error={null}
              onRetry={retryConv}
              scrollToBottom
              emptyNote="该会话还没有记录"
            />
          )}
        </Panel>
      </div>
    </div>
  );
}
