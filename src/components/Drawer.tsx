/**
 * 右侧抽屉：选中行的详情/操作放在独立面板里，避免长列表末尾的二次滚动。
 *
 * 两种形态：
 * - `inline`：作为父级 flex 行的右列参与布局（记忆库用），不遮挡左侧列表；
 * - 默认：贴窗口右边缘的浮层（非模态，左侧仍可点），用于没有双列容器的场景。
 *
 * Esc 关闭；页面里有模态对话框时不抢 Esc（让对话框先关自己）。
 */
import { useEffect, useRef, type ReactNode } from "react";
import "./Drawer.css";

export function Drawer(props: {
  title: ReactNode;
  label: string;
  onClose: () => void;
  inline?: boolean;
  children: ReactNode;
}): ReactNode {
  const { title, label, onClose, inline = false, children } = props;
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!inline) ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // 抽屉里的模态框（删除/移除确认）优先关闭自己。
      if (document.querySelector(".modal-overlay") !== null) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inline]);

  return (
    <div
      className={inline ? "drawer drawer-inline" : "drawer"}
      role="complementary"
      aria-label={label}
      tabIndex={inline ? undefined : -1}
      ref={ref}
    >
      <header className="drawer-head">
        <h2 className="drawer-title">{title}</h2>
        <button type="button" className="btn btn-small drawer-close" onClick={onClose} aria-label={`关闭${label}`}>
          关闭
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </div>
  );
}
