/**
 * 外观偏好：主题模式（跟随系统 / 浅色 / 深色）+ 强调色。纯界面状态，
 * 仅存 localStorage（沿用 pins.ts 的容错风格：缺失/损坏/未知值一律回落默认）。
 *
 * 实际主题由（mode, 系统偏好）纯函数解出；应用时写 documentElement 的
 * data-theme / data-accent，CSS 以 `:root[data-theme="…"]` 匹配。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readJson, writeJson } from "./storage";

export const APPEARANCE_STORAGE_KEY = "omp-resume:appearance";

export type ThemeMode = "system" | "light" | "dark";
export type AccentName = "blue" | "purple" | "green" | "orange" | "pink" | "grey";
/** 实际生效的主题（已解出跟随系统）。 */
export type ResolvedTheme = "light" | "dark";

export interface Appearance {
  mode: ThemeMode;
  accent: AccentName;
}

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];
export const ACCENTS: readonly AccentName[] = ["blue", "purple", "green", "orange", "pink", "grey"];

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export const ACCENT_LABEL: Record<AccentName, string> = {
  blue: "蓝色",
  purple: "紫色",
  green: "绿色",
  orange: "橙色",
  pink: "粉色",
  grey: "灰色",
};

export function defaultAppearance(): Appearance {
  return { mode: "system", accent: "blue" };
}

function isThemeMode(v: unknown): v is ThemeMode {
  return v === "system" || v === "light" || v === "dark";
}

function isAccent(v: unknown): v is AccentName {
  return (
    v === "blue" ||
    v === "purple" ||
    v === "green" ||
    v === "orange" ||
    v === "pink" ||
    v === "grey"
  );
}

function parseAppearance(data: unknown): Appearance {
  const fallback = defaultAppearance();
  if (typeof data !== "object" || data === null) return fallback;
  const obj = data as Record<string, unknown>;
  return {
    mode: isThemeMode(obj.mode) ? obj.mode : fallback.mode,
    accent: isAccent(obj.accent) ? obj.accent : fallback.accent,
  };
}

/** 读取外观偏好；任何异常都返回有效默认值。 */
export function loadAppearance(storage?: Storage): Appearance {
  return parseAppearance(readJson(APPEARANCE_STORAGE_KEY, storage));
}

/** 写入外观偏好；存储不可用时静默忽略（本次运行内仍然有效）。 */
export function saveAppearance(appearance: Appearance, storage?: Storage): void {
  writeJson(APPEARANCE_STORAGE_KEY, appearance, storage);
}

/** 由（模式, 系统是否深色）解出实际主题。跟随系统时直通系统偏好。 */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return systemDark ? "dark" : "light";
}

/** 把外观应用到根元素（默认 documentElement），返回实际主题。 */
export function applyAppearance(
  appearance: Appearance,
  systemDark: boolean,
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  const theme = resolveTheme(appearance.mode, systemDark);
  root.dataset.theme = theme;
  root.dataset.accent = appearance.accent;
  return theme;
}

/** 当前系统是否深色（matchMedia 不可用时按浅色处理）。 */
export function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    return false;
  }
}

/**
 * 监听系统外观变化。返回取消函数；matchMedia 不可用时返回空操作。
 * 回调参数为变化后的系统偏好（是否深色）。
 */
export function watchSystemTheme(onChange: (systemDark: boolean) => void): () => void {
  let mq: MediaQueryList | undefined;
  try {
    mq = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  } catch {
    mq = undefined;
  }
  if (mq == null) return () => {};
  const listener = (e: MediaQueryListEvent) => onChange(e.matches);
  // Safari < 14 只有 addListener；新旧都兼容。
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", listener);
  else mq.addListener(listener);
  return () => {
    if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", listener);
    else mq.removeListener(listener);
  };
}

/**
 * 同步 macOS 原生窗口标题栏主题：显式浅/深色时固定，null 表示跟随系统。
 * 非 Tauri 环境（纯浏览器 dev）或调用失败时静默忽略。
 */
export async function syncNativeTheme(mode: ThemeMode): Promise<void> {
  try {
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch {
    // 非 Tauri 环境或权限缺失：原生标题栏保持系统行为，不影响页面主题。
  }
}
