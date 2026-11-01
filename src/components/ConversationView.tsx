/**
 * 对话审阅（只读）：设计稿 §9（`views-core.js:426-479`）的 msg/tool-card/think/divider-note 结构。
 * B4/B5/B6 字段（id/timestamp/durationMs/diff/pending/usage）齐备即渲染；timestamp null 显示 —。
 * markdown 渲染与链接安全策略保持现状；3000+ 条目性能：视口外 `content-visibility: auto`。
 */
import { memo, useEffect, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppError, AssistantBlock, Conversation, ConversationItem } from "../types";
import { errorText, formatMs, formatUsd } from "../format";
import { Ico } from "./ui";
import { Cpu, Sparkles, Terminal } from "lucide-react";

/** 链接不跳转 webview：拦截点击，URL 放 title。 */
function MdLink({ href, children, title }: ComponentProps<"a">) {
  return (
    <a
      className="md-link"
      href={href}
      title={href ?? title}
      onClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  );
}

function AssistantText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>
      {text}
    </Markdown>
  );
}

/** D2 右侧时间：null 显示 —；今天 HH:MM，否则 M月d日 HH:MM；非法 ISO 透传原串。 */
function timeText(timestamp: string | null, nowMs = Date.now()): string {
  if (timestamp === null) return "—";
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return timestamp;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const now = new Date(nowMs);
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `${hh}:${mm}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** B5 diff 统计：omp 行号格式 `+230|新增行` 计新增、`-数字|` 计删除，输出 `+38 −11`。 */
function diffStat(diff: string): string | null {
  // omp 行号渲染：` 228|上下文` / `+230|新增行`（加号在行首空格之后、行号之前）。
  // 删除行样本尚未出现，按 `-数字|` 预留计数；无 +/- 则 null（不显示 foot）。
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    const m = /^([+-])\d+\|/.exec(line.trimStart());
    if (m !== null) {
      if (m[1] === "+") add += 1;
      else del += 1;
    }
  }
  if (add === 0 && del === 0) return null;
  return `+${add} −${del}`;
}

/** 大数字紧凑显示：usage 行 312400 → 312.4k（与设计稿 tokens 口径一致）。 */
function compactCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(value);
}

function argsPreview(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    // 设计稿 tool-arg 放"参数摘要"：优先常见目标键，否则首个非空字符串值。
    for (const key of ["path", "file", "target", "command", "cmd", "pattern", "url"]) {
      if (typeof record[key] === "string" && record[key] !== "") return record[key] as string;
    }
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value !== "") return value;
    }
  }
  const j = JSON.stringify(args);
  return j.length > 60 ? `${j.slice(0, 60)}…` : j;
}

/** D2 消息头：role 大写 + node-id chip + 分支点徽章（可选）+ 右侧 time（timestamp null 显示 —）。 */
function MsgHead({ role, roleClass, nodeId, timestamp, branch = false }: { role: string; roleClass?: string; nodeId: string; timestamp: string | null; branch?: boolean }) {
  return (
    <div className="msg-head">
      <span className={roleClass ? `role ${roleClass}` : "role"}>{role}</span>
      <span className="node-id">{nodeId}</span>
      {branch ? <span className="badge badge-warn">分支点</span> : null}
      <span className="msg-time">{timeText(timestamp)}</span>
    </div>
  );
}

/** D5 思考折叠：设计稿 details.think「思考过程 · 已折叠」+ 斜体正文。 */
function ThinkBlock({ text }: { text: string }) {
  return (
    <details className="think">
      <summary>
        <Ico icon={Sparkles} size={12} />
        思考过程 · 已折叠
      </summary>
      <p>{text}</p>
    </details>
  );
}

type ToolResultItem = Extract<ConversationItem, { kind: "toolResult" }>;
type ToolCallBlock = Extract<AssistantBlock, { kind: "toolCall" }>;

/** D4 工具调用卡：图标 / mono 工具名 / 参数摘要 / 状态点 + 时长 / 输出 pre / diff foot。 */
function ToolCard({
  icon,
  name,
  arg,
  isError,
  pending = false,
  duration,
  output,
  truncated,
  diff,
}: {
  icon: "tool" | "bash";
  name: string;
  arg: string;
  isError: boolean;
  pending?: boolean;
  duration: string | null;
  output: string;
  truncated: boolean;
  diff?: ReactNode;
}) {
  const status = pending ? "运行中" : isError ? "失败" : "完成";
  const statusClass = pending ? "tool-status run" : isError ? "tool-status err" : "tool-status";
  const dotClass = pending ? "dot live" : isError ? "dot bad" : "dot ok";
  return (
    <div className="tool-card">
      <div className="tool-head">
        <span className="tool-ico">
          <Ico icon={icon === "bash" ? Terminal : Cpu} size={12} />
        </span>
        <span className="tool-name">{name}</span>
        {arg !== "" ? <span className="tool-arg">{arg}</span> : null}
        <span className={statusClass}>
          <span className={dotClass} aria-hidden="true" />
          {duration !== null ? `${status} · ${duration}` : status}
        </span>
      </div>
      {output !== "" ? (
        <div className="tool-body">
          <pre>{output}</pre>
        </div>
      ) : null}
      {truncated ? (
        <div className="tool-foot">
          <span className="mono">已截断</span>
          <span>输出过长，仅保留前 8KB</span>
        </div>
      ) : null}
      {diff}
    </div>
  );
}

/** 一次调用一张卡：toolCall 参数摘要 + 配对 toolResult 的状态/时长/输出/diff。 */
function PairedToolCard({ call, result }: { call: ToolCallBlock; result: ToolResultItem | null }) {
  const isError = result?.isError ?? false;
  const pending = result === null && call.pending;
  // 无 result 且非 pending：call 与 result 走散（被筛掉/截断/压缩），显示「无结果」而非假完成。
  const missing = result === null && !call.pending;
  const status = missing ? "无结果" : pending ? "运行中" : isError ? "失败" : "完成";
  const statusClass = missing ? "tool-status mute" : pending ? "tool-status run" : isError ? "tool-status err" : "tool-status";
  const dotClass = missing ? "dot" : pending ? "dot live" : isError ? "dot bad" : "dot ok";
  const duration = result?.durationMs === null || result?.durationMs === undefined ? null : formatMs(result.durationMs);
  const stat = result?.diff === null || result?.diff === undefined ? null : diffStat(result.diff);
  const paramsText = call.args === null || call.args === undefined ? null : JSON.stringify(call.args, null, 2);
  return (
    <div className="tool-card" data-call-id={call.id} data-result-id={result?.id ?? null}>
      <div className="tool-head">
        <span className="tool-ico">
          <Ico icon={Cpu} size={12} />
        </span>
        <span className="tool-name">{call.name}</span>
        {argsPreview(call.args) !== "" ? <span className="tool-arg">{argsPreview(call.args)}</span> : null}
        <span className={statusClass}>
          <span className={dotClass} aria-hidden="true" />
          {duration !== null ? `${status} · ${duration}` : status}
        </span>
      </div>
      {result !== null && result.text !== "" ? (
        <div className="tool-body">
          <pre>{result.text}</pre>
        </div>
      ) : null}
      {paramsText !== null ? (
        <details className="tool-params">
          <summary>参数</summary>
          <pre>{paramsText}</pre>
        </details>
      ) : null}
      {result?.truncated === true ? (
        <div className="tool-foot">
          <span className="mono">已截断</span>
          <span>输出过长，仅保留前 8KB</span>
        </div>
      ) : null}
      {stat !== null ? (
        <div className="tool-foot">
          <span className="mono">{stat}</span>
          <span>diff</span>
        </div>
      ) : null}
    </div>
  );
}

/** 孤儿 toolResult（找不到对应 call）：头部只用 toolName，不显示内部 call id。 */
function OrphanToolCard({ item }: { item: ToolResultItem }) {
  const duration = item.durationMs === null ? null : formatMs(item.durationMs);
  const stat = item.diff === null ? null : diffStat(item.diff);
  return (
    <ToolCard
      icon="tool"
      name={item.toolName}
      arg=""
      isError={item.isError}
      duration={duration}
      output={item.text}
      truncated={item.truncated}
      diff={
        stat !== null ? (
          <div className="tool-foot">
            <span className="mono">{stat}</span>
            <span>diff</span>
          </div>
        ) : undefined
      }
    />
  );
}

/** D6 用量记录行：purpose 标签 + 模型/输入/输出/缓存/成本/时间（零值项由 filter 丢弃）。 */
function UsageLine({ item }: { item: Extract<ConversationItem, { kind: "usage" }> }) {
  const modelLabel = item.model !== "" ? item.model : item.provider;
  return (
    <div className="msg">
      <MsgHead role="用量记录" nodeId={item.id} timestamp={item.timestamp} />
      <div className="usage-line">
        <span>用量记录</span>
        {item.purpose !== "" ? <span className="usage-purpose">{item.purpose}</span> : null}
        {modelLabel !== "" ? (
          <span>
            <b>{modelLabel}</b>
          </span>
        ) : null}
        <span>
          输入 <b>{compactCount(item.input)}</b>
        </span>
        <span>
          输出 <b>{compactCount(item.output)}</b>
        </span>
        <span>
          缓存 <b>{compactCount(item.cacheRead + item.cacheWrite)}</b>
        </span>
        <span>
          <b>{formatUsd(item.cost)}</b>
        </span>
        <span style={{ marginLeft: "auto" }}>{timeText(item.timestamp)}</span>
      </div>
    </div>
  );
}

function AssistantBlocks({ blocks, results }: { blocks: AssistantBlock[]; results: Map<string, ToolResultItem> }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "text")
          return (
            <div className="assistant-text" key={i}>
              <AssistantText text={b.text} />
            </div>
          );
        if (b.kind === "thinking") return <ThinkBlock key={i} text={b.text} />;
        return <PairedToolCard key={i} call={b} result={results.get(b.id) ?? null} />;
      })}
    </>
  );
}

const ItemView = memo(function ItemView({ item, results, branchPointId }: { item: ConversationItem; results: Map<string, ToolResultItem>; branchPointId: string | null }) {
  switch (item.kind) {
    case "usage":
      return <UsageLine item={item} />;
    case "user":
      return (
        <div className="msg user" data-node-id={item.id}>
          <MsgHead role="用户" roleClass="user" nodeId={item.id} timestamp={item.timestamp} branch={branchPointId === item.id} />
          <div className="msg-body">
            <p>{item.text}</p>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="msg assistant" data-node-id={item.id}>
          <MsgHead role="助手" roleClass="assistant" nodeId={item.id} timestamp={item.timestamp} />
          <div className="msg-body">
            <AssistantBlocks blocks={item.blocks} results={results} />
          </div>
        </div>
      );
    case "toolResult":
      // 到这里的都是孤儿 result（被消费的已在渲染前滤掉）：单独成卡，不显示 call id。
      return (
        <div className="msg" data-node-id={item.id}>
          <MsgHead role="工具调用" nodeId={item.id} timestamp={item.timestamp} />
          <OrphanToolCard item={item} />
        </div>
      );
    case "bashExecution": {
      const failed = item.exitCode !== null && item.exitCode !== 0;
      return (
        <div className="msg" data-node-id={item.id}>
          <MsgHead role="工具调用" nodeId={item.id} timestamp={item.timestamp} />
          <ToolCard
            icon="bash"
            name="bash"
            arg={item.command}
            isError={failed}
            duration={null}
            output={item.text}
            truncated={item.truncated}
            diff={
              <div className="tool-foot">
                <span className="mono">{item.cancelled ? "已取消" : `退出码 ${item.exitCode ?? "?"}`}</span>
                <span>bash</span>
              </div>
            }
          />
        </div>
      );
    }
    case "compaction":
    case "branchSummary":
      return (
        <>
          <div className="divider-note" data-node-id={item.id}>
            {item.kind === "compaction" ? "已压缩上下文" : "分支摘要"}
          </div>
          {item.summary !== "" ? (
            <div className="msg">
              <div className="msg-body">
                <p className="muted">{item.summary}</p>
              </div>
            </div>
          ) : null}
        </>
      );
    case "other":
      return (
        <div className="msg" data-node-id={item.id}>
          <MsgHead role={item.role} nodeId={item.id} timestamp={item.timestamp} />
          <div className="msg-body">
            <p>
              [{item.role}] {item.text}
            </p>
          </div>
        </div>
      );
  }
});

interface ConversationViewProps {
  conversation: Conversation | null;
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  /** 首次加载后滚动到底部（active 路径续聊起点）。与 activeNodeId 互斥：定位优先。 */
  scrollToBottom?: boolean;
  emptyNote?: string;
  /** 树「在对话中定位」目标条目 id：滚动到该条目 + 高亮；找不到/被筛掉则静默 no-op。 */
  activeNodeId?: string | null;
}

export function ConversationView({
  conversation,
  loading,
  error,
  onRetry,
  scrollToBottom = false,
  emptyNote,
  activeNodeId = null,
}: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 配对：toolResult.toolCallId → result；consumed = 被 assistant toolCall 引用的 call id。
  // 只在渲染层配对（不改 filter 产出）：同一次 items 扫描建两张表，O(n)。
  const { results, consumed } = useMemo(() => {
    const results = new Map<string, ToolResultItem>();
    const calls = new Set<string>();
    if (conversation !== null) {
      for (const item of conversation.items) {
        if (item.kind === "toolResult") {
          if (!results.has(item.toolCallId)) results.set(item.toolCallId, item);
        } else if (item.kind === "assistant") {
          for (const b of item.blocks) {
            if (b.kind === "toolCall") calls.add(b.id);
          }
        }
      }
    }
    const consumed = new Set<string>();
    for (const id of calls) {
      if (results.has(id)) consumed.add(id);
    }
    return { results, consumed };
  }, [conversation]);
  useEffect(() => {
    const el = scrollRef.current;
    if (scrollToBottom === false || activeNodeId !== null || !conversation || loading || !el) return;
    // 对话由外层 .main-pane 纵滚：滚外层到底。
    const pane = el.closest(".main-pane");
    if (pane === null) return;
    let cancelled = false;
    let raf = 0;
    let frames = 0;
    const settle = () => {
      if (cancelled) return;
      // content-visibility 的估算高度会在渲染后修正，逐帧重滚到真正的底部。
      pane.scrollTop = pane.scrollHeight;
      frames += 1;
      if (frames < 10) raf = requestAnimationFrame(settle);
    };
    settle();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [scrollToBottom, activeNodeId, conversation, loading]);
  // activeNodeId 定位：优先条目 data-node-id；被配对消费的 toolResult id 则回退到
  // 合成卡的 data-result-id（滚动到那张卡）。找不到/被筛掉则静默 no-op。
  useEffect(() => {
    const el = scrollRef.current;
    if (activeNodeId === null || !conversation || loading || !el) return;
    const sel = `[data-node-id="${CSS.escape(activeNodeId)}"]`;
    const fallback = `[data-result-id="${CSS.escape(activeNodeId)}"]`;
    const target = el.querySelector(sel) ?? el.querySelector(fallback);
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("is-located");
    const t = window.setTimeout(() => target.classList.remove("is-located"), 2400);
    return () => {
      window.clearTimeout(t);
      target.classList.remove("is-located");
    };
  }, [activeNodeId, conversation, loading]);

  if (error) {
    return (
      <div className="banner banner-error" role="alert">
        <span>{errorText(error)}</span>
        <button type="button" className="btn btn-small" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (loading && !conversation) return <div className="pane-note">加载中…</div>;
  if (!conversation) return null;
  if (conversation.items.length === 0)
    return <div className="pane-note">{emptyNote ?? "暂无内容"}</div>;
  // 被配对消费的 toolResult 在渲染前滤掉：不留空 .conv-cell（否则 88px 占位虚高滚动高度）。
  const visible = conversation.items.filter(
    (item) => item.kind !== "toolResult" || !consumed.has(item.toolCallId),
  );
  return (
    <div className="conv-scroll" ref={scrollRef}>
      <div className="conv-col">
        {visible.map((item) => (
          <div
            key={item.id}
            className="conv-cell"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 88px" }}
          >
            <ItemView item={item} results={results} branchPointId={conversation.branchPointId} />
          </div>
        ))}
      </div>
    </div>
  );
}
