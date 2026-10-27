/**
 * 通用小组件：模态对话框（焦点陷阱）、懒渲染折叠块、会话徽章。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { SessionSummary } from "../types";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  /** 宽版（表格类内容用，如备份列表）；默认 520px 窄版。 */
  wide?: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, wide = false }: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const auto = boxRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    (auto ?? boxRef.current)?.focus();
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={wide ? "modal modal-wide" : "modal"}
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
}

/** 折叠块：未展开时不渲染内容（懒渲染）。 */
export function Disclosure({
  label,
  children,
  className,
}: DisclosureProps) {
  const [open, setOpen] = useState(false);
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
        <Badge tone="accent">使用中{s.occupant?.app ? ` · ${s.occupant.app}` : ""}</Badge>
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
      {!s.cwdExists ? (
        <Badge tone="danger" title="记录的项目目录不存在">
          目录不存在
        </Badge>
      ) : null}
    </>
  );
}

/**
 * 全应用唯一的图标封装：统一 family（lucide）、统一描边、默认对辅助技术隐藏。
 * 纯图标按钮必须自己带 `aria-label`（图标本身恒为装饰）。
 */
export function Ico({ icon: Icon, size = 14 }: { icon: LucideIcon; size?: number }) {
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

/** 空状态：圆形图标 + 标题 + 一句说明 + 可选动作。 */
export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        <Ico icon={Icon} size={26} />
      </span>
      <div className="empty-state-title">{title}</div>
      {children !== undefined ? <p className="empty-state-desc">{children}</p> : null}
      {action}
    </div>
  );
}
