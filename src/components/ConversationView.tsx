/**
 * 对话预览（只读）：user 气泡、assistant Markdown、工具/命令折叠卡。
 * 3000+ 条目性能：内容 `content-visibility: auto`，折叠体未展开不渲染。
 */
import { memo, useEffect, useRef, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppError, Conversation, ConversationItem } from "../types";
import { errorText } from "../format";
import { Disclosure } from "./ui";

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

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0];
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function argsPreview(args: unknown): string {
  if (args === null || args === undefined) return "";
  const j = JSON.stringify(args);
  return j.length > 60 ? `${j.slice(0, 60)}…` : j;
}

const ItemView = memo(function ItemView({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="conv-item conv-user">
          <div className="bubble bubble-user">
            <pre className="plain-text">{item.text}</pre>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="conv-item conv-assistant">
          {item.blocks.map((b, i) => {
            if (b.kind === "text")
              return (
                <div className="assistant-text" key={i}>
                  <AssistantText text={b.text} />
                </div>
              );
            if (b.kind === "thinking")
              return (
                <Disclosure key={i} className="thin" label={<span className="muted">思考…</span>}>
                  <pre className="plain-text mono">{b.text}</pre>
                </Disclosure>
              );
            return (
              <Disclosure
                key={i}
                className="thin"
                label={
                  <span className="chip">
                    <span aria-hidden="true">🔧</span> {b.name}
                    <span className="chip-args mono">{argsPreview(b.args)}</span>
                  </span>
                }
              >
                <pre className="plain-text mono">
                  {b.args === null || b.args === undefined
                    ? "（无参数）"
                    : JSON.stringify(b.args, null, 2)}
                </pre>
              </Disclosure>
            );
          })}
        </div>
      );
    case "toolResult":
      return (
        <div className="conv-item conv-tool">
          <Disclosure
            className="thin"
            label={
              <span className={item.isError ? "chip chip-error" : "chip"}>
                <span aria-hidden="true">{item.isError ? "✗" : "✓"}</span> {item.toolName}
                <span className="chip-args">{firstLine(item.text)}</span>
                {item.truncated ? <span className="muted">（已截断）</span> : null}
              </span>
            }
          >
            <pre className="plain-text mono">{item.text}</pre>
          </Disclosure>
        </div>
      );
    case "bashExecution":
      return (
        <div className="conv-item conv-bash">
          <Disclosure
            className="thin"
            label={
              <span className="chip">
                <span className="mono" aria-hidden="true">
                  $
                </span>{" "}
                <span className="mono">{item.command}</span>
                <span
                  className={
                    item.exitCode !== null && item.exitCode !== 0
                      ? "chip-args badge badge-danger"
                      : "chip-args badge badge-grey"
                  }
                >
                  {item.cancelled ? "已取消" : `退出码 ${item.exitCode ?? "?"}`}
                </span>
                {item.truncated ? <span className="muted">（已截断）</span> : null}
              </span>
            }
          >
            <pre className="plain-text mono">{item.text}</pre>
          </Disclosure>
        </div>
      );
    case "compaction":
    case "branchSummary":
      return (
        <div className="conv-divider">
          <div className="conv-divider-title">
            {item.kind === "compaction" ? "已压缩上下文" : "分支摘要"}
          </div>
          <Disclosure
            className="thin"
            label={<span className="muted">摘要（点击展开）</span>}
          >
            <pre className="plain-text mono">{item.summary || "（无摘要）"}</pre>
          </Disclosure>
        </div>
      );
    default:
      return (
        <div className="conv-item conv-other">
          <Disclosure
            className="thin"
            label={
              <span className="muted">
                [{item.role}] {firstLine(item.text)}
              </span>
            }
          >
            <pre className="plain-text mono">{item.text}</pre>
          </Disclosure>
        </div>
      );
  }
});

interface ConversationViewProps {
  conversation: Conversation | null;
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  /** 首次加载后滚动到底部（active 路径续聊起点）。 */
  scrollToBottom?: boolean;
  emptyNote?: string;
}

export function ConversationView({
  conversation,
  loading,
  error,
  onRetry,
  scrollToBottom = false,
  emptyNote,
}: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollToBottom && conversation && !loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [scrollToBottom, conversation, loading]);

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
  return (
    <div className="conv-scroll" ref={scrollRef}>
      <div className="conv-col">
        {conversation.items.map((item, i) => (
          <div
            className="conv-wrap"
            key={i}
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 88px" }}
          >
            <ItemView item={item} />
          </div>
        ))}
      </div>
    </div>
  );
}
