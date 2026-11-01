/**
 * 全局命令面板：页面 + 动作 + 会话。外层复用 DialogFrame（焦点陷阱/ESC/遮罩），
 * ↑/↓ 循环高亮，Enter 执行，鼠标移入设为高亮。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Globe, Search, Zap } from "lucide-react";
import type { MetaSnapshot, SessionSummary } from "../../types";
import { paletteItems, type PaletteItem } from "../../palette";
import { DialogFrame, Ico } from "../ui";
import { SearchInput } from "../page";
import type { Route } from "../../routes";

interface CommandPaletteProps {
  sessions: SessionSummary[];
  meta: MetaSnapshot | null;
  onNavigate: (r: Route) => void;
  onOpenSession: (path: string) => void;
  onNewSession: () => void;
  onRescan: () => void;
  onToggleTheme: () => void;
  onCheckApp: () => void;
  onCheckOmp: () => void;
  onClose: () => void;
}

function kindIcon(item: PaletteItem) {
  if (item.kind === "page") return Globe;
  if (item.kind === "action") return Zap;
  return FileText;
}

function kindLabel(item: PaletteItem): string {
  if (item.kind === "page") return "页面";
  if (item.kind === "action") return "动作";
  return "会话";
}

export function CommandPalette({
  sessions,
  meta,
  onNavigate,
  onOpenSession,
  onNewSession,
  onRescan,
  onToggleTheme,
  onCheckApp,
  onCheckOmp,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => paletteItems(query, sessions, meta), [query, sessions, meta]);
  // document 监听读最新值：ref 桥接，避免每 render 重绑。
  const stateRef = useRef({ items, highlight });
  stateRef.current = { items, highlight };
  const run = (item: PaletteItem): void => {
    if (item.kind === "page") onNavigate(item.route);
    else if (item.kind === "session") onOpenSession(item.path);
    else if (item.id === "new-session") onNewSession();
    else if (item.id === "rescan") onRescan();
    else if (item.id === "toggle-theme") onToggleTheme();
    else if (item.id === "check-app") onCheckApp();
    else onCheckOmp();
    onClose();
  };
  const runRef = useRef(run);
  runRef.current = run;

  // 结果变化时高亮回到首项，避免越界。
  useEffect(() => {
    setHighlight(0);
  }, [items.length]);

  // ↑/↓/Enter：焦点在输入框（与列表是兄弟），只能走 document 级监听。
  // Esc 归 DialogFrame 管，这里不碰。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      if (e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      const { items: cur, highlight: h } = stateRef.current;
      if (e.key === "ArrowDown") {
        setHighlight(cur.length === 0 ? 0 : (h + 1) % cur.length);
      } else if (e.key === "ArrowUp") {
        setHighlight(cur.length === 0 ? 0 : (h - 1 + cur.length) % cur.length);
      } else {
        const item = cur[h];
        if (item !== undefined) runRef.current(item);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 高亮项滚入可见。
  useEffect(() => {
    listRef.current
      ?.querySelector("[aria-selected=\"true\"]")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);

  return (
    <DialogFrame label="全局搜索" className="palette-box" overlayClass="palette-overlay" onClose={onClose}>
      <div className="palette-input">
        <span className="palette-ico" aria-hidden="true">
          <Ico icon={Search} size={16} />
        </span>
        <SearchInput
          label="搜索页面、会话或动作"
          placeholder="搜索页面、会话或动作"
          value={query}
          onChange={setQuery}
          autoFocus
        />
      </div>
      <div className="palette-list" role="listbox" aria-label="搜索结果" ref={listRef}>
        {items.length === 0 ? (
          <div className="palette-empty">没有匹配的页面、会话或动作</div>
        ) : (
          items.map((item, i) => {
            const key =
              item.kind === "page"
                ? "page:" + item.route
                : item.kind === "action"
                  ? "action:" + item.id
                  : "session:" + item.path;
            const sub = item.kind === "session" ? item.sub : item.kind === "page" ? item.group : null;
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={i === highlight ? "palette-item is-on" : "palette-item"}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => run(item)}
              >
                <Ico icon={kindIcon(item)} size={14} />
                <span className="truncate">{item.label}</span>
                {sub !== null ? <span className="p-sub truncate">{sub}</span> : null}
                <span className="p-kind">{kindLabel(item)}</span>
              </button>
            );
          })
        )}
      </div>
    </DialogFrame>
  );
}
