/**
 * 应用偏好：侧栏折叠、启动时检查更新。纯界面状态，存 localStorage。
 * 写法照抄 appearance.ts 的 load/save/parse 模式。
 */
import { readJson, writeJson } from "./storage";

export const APP_PREFS_STORAGE_KEY = "omp-resume:app-prefs:v1";

export interface AppPrefs {
  sidebarCollapsed: boolean;
  checkUpdateOnLaunch: boolean;
}

export function defaultAppPrefs(): AppPrefs {
  return { sidebarCollapsed: false, checkUpdateOnLaunch: true };
}

function parseAppPrefs(data: unknown): AppPrefs {
  const fallback = defaultAppPrefs();
  if (data === null || typeof data !== "object") return fallback;
  const o = data as Record<string, unknown>;
  return {
    sidebarCollapsed: typeof o.sidebarCollapsed === "boolean" ? o.sidebarCollapsed : fallback.sidebarCollapsed,
    checkUpdateOnLaunch:
      typeof o.checkUpdateOnLaunch === "boolean" ? o.checkUpdateOnLaunch : fallback.checkUpdateOnLaunch,
  };
}

/** 读取应用偏好；任何异常都返回有效默认值。 */
export function loadAppPrefs(storage?: Storage): AppPrefs {
  return parseAppPrefs(readJson(APP_PREFS_STORAGE_KEY, storage));
}

/** 写入应用偏好；存储不可用时静默忽略（本次运行内仍然有效）。 */
export function saveAppPrefs(prefs: AppPrefs, storage?: Storage): void {
  writeJson(APP_PREFS_STORAGE_KEY, prefs, storage);
}
