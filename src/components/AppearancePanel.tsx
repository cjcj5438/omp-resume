/**
 * 外观设置：主题模式（跟随系统 / 浅色 / 深色）+ 强调色（6 预设）。
 * 挂在侧栏底部状态区；选择即时生效并持久化，无保存按钮。
 */
import { useEffect, useRef, useState } from "react";
import {
  ACCENTS,
  ACCENT_LABEL,
  THEME_MODES,
  THEME_MODE_LABEL,
  applyAppearance,
  loadAppearance,
  saveAppearance,
  syncNativeTheme,
  systemPrefersDark,
  watchSystemTheme,
  type AccentName,
  type Appearance,
  type ThemeMode,
} from "../appearance";

/** 各强调色的示意色块（固定值：预设身份色，不随主题变）。 */
const ACCENT_SWATCH: Record<AccentName, string> = {
  blue: "#0a5fd0",
  purple: "#7c3aed",
  green: "#1a7f37",
  orange: "#b25a00",
  pink: "#c2337f",
  grey: "#5f6368",
};

function useAppearanceState(): { appearance: Appearance; setMode: (m: ThemeMode) => void; setAccent: (a: AccentName) => void } {
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  // 跟随系统时实时响应系统外观变化。
  useEffect(() => watchSystemTheme(setSystemDark), []);

  // 任何变化都即时应用 + 持久化 + 同步原生标题栏。
  useEffect(() => {
    applyAppearance(appearance, systemDark);
    saveAppearance(appearance);
    void syncNativeTheme(appearance.mode);
  }, [appearance, systemDark]);

  return {
    appearance,
    setMode: (mode) => setAppearance((prev) => (prev.mode === mode ? prev : { ...prev, mode })),
    setAccent: (accent) =>
      setAppearance((prev) => (prev.accent === accent ? prev : { ...prev, accent })),
  };
}

export function AppearancePanel() {
  const { appearance, setMode, setAccent } = useAppearanceState();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 点击外部关闭；Escape 关闭并把焦点还给按钮。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current != null && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  return (
    <div className="appearance-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-small icon-btn icon-btn-quiet"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="外观"
        title="切换主题与强调色"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {open ? (
        <div className="appearance-pop" role="dialog" aria-label="外观设置">
          <div>
            <div className="appearance-label" id="appearance-mode-label">
              主题模式
            </div>
            <div className="appearance-seg" role="group" aria-labelledby="appearance-mode-label">
              {THEME_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className="btn btn-small"
                  aria-pressed={appearance.mode === m}
                  onClick={() => setMode(m)}
                >
                  {THEME_MODE_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="appearance-label" id="appearance-accent-label">
              强调色
            </div>
            <div className="appearance-swatches" role="group" aria-labelledby="appearance-accent-label">
              {ACCENTS.map((a) => {
                const selected = appearance.accent === a;
                return (
                  <button
                    key={a}
                    type="button"
                    className="accent-swatch"
                    style={{ background: ACCENT_SWATCH[a] }}
                    aria-pressed={selected}
                    aria-label={`强调色：${ACCENT_LABEL[a]}`}
                    title={ACCENT_LABEL[a]}
                    onClick={() => setAccent(a)}
                  >
                    {selected ? <span aria-hidden="true">✓</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
