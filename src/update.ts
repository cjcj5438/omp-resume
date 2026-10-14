/**
 * 应用内自动更新：启动时静默检查一次，失败一律静默忽略（不打扰列表加载）。
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

/**
 * 检查更新。开发模式不联网；任何失败（离线、无 IPC、响应异常）都返回 null，
 * 调用方只需 `if (u) setUpdate(u)`，无需处理错误。
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (import.meta.env.DEV) return null;
  try {
    return await check();
  } catch {
    return null;
  }
}

/**
 * 安装完成后重启应用（macOS/Linux 必须 relaunch 新版本才生效）。
 * 成功返回 null；失败返回错误文本，由调用方展示并提示手动重启。
 */
export async function relaunchApp(): Promise<string | null> {
  try {
    await relaunch();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "重启失败，请手动重启应用";
  }
}
