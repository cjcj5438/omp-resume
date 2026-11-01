/**
 * 外观状态 hook：供标题栏主题切换与设置页共享。
 * 任何变化都即时应用 + 持久化 + 同步原生标题栏。
 */
import { useEffect, useState } from "react";
import {
  applyAppearance,
  loadAppearance,
  resolveTheme,
  saveAppearance,
  syncNativeTheme,
  systemPrefersDark,
  watchSystemTheme,
  type Appearance,
  type ResolvedTheme,
  type ThemeMode,
  type AccentName,
} from "./appearance";

export function useAppearance(): {
  appearance: Appearance;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
  setAccent: (a: AccentName) => void;
} {
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
    resolved: resolveTheme(appearance.mode, systemDark),
    setMode: (mode) => setAppearance((prev) => (prev.mode === mode ? prev : { ...prev, mode })),
    setAccent: (accent) =>
      setAppearance((prev) => (prev.accent === accent ? prev : { ...prev, accent })),
  };
}
