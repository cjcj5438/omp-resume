/**
 * 通用小组件：模态对话框（焦点陷阱）、懒渲染折叠块、会话徽章。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionSummary } from "../types";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer }: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const auto = boxRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    (auto ?? boxRef.current)?.focus();
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={boxRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key !== "Tab") return;
          const nodes = boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
          if (!nodes || nodes.length === 0) return;
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}

interface DisclosureProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}

/** 折叠块：未展开时不渲染内容（懒渲染）。 */
export function Disclosure({
  label,
  children,
  className,
  defaultOpen = false,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className ? `disclosure ${className}` : "disclosure"}>
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}

interface BadgeProps {
  tone: "accent" | "grey" | "fork" | "branch" | "danger";
  title?: string;
  children: ReactNode;
}

export function Badge({ tone, title, children }: BadgeProps) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** 会话行/详情共用徽章：使用中 / 占用未知 / fork / 分支数 / 格式不支持。 */
export function SessionBadges({ s }: { s: SessionSummary }) {
  return (
    <>
      {s.inUse ? (
        <Badge tone="accent">使用中</Badge>
      ) : !s.probeOk ? (
        <Badge tone="grey">占用未知</Badge>
      ) : null}
      {s.fork != null ? (
        <Badge tone="fork" title={s.fork.parentTitle ? `来自：${s.fork.parentTitle}` : "来源会话已不存在"}>
          fork
        </Badge>
      ) : null}
      {s.branchCount > 1 ? <Badge tone="branch">{s.branchCount} 个分支</Badge> : null}
      {!s.formatSupported ? <Badge tone="danger">格式不支持</Badge> : null}
    </>
  );
}
