/** 时间 / 大小 / 路径展示、官方外链常量与打开：中文 UI 共用。 */
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = nowMs - t;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (Math.floor(min / 60) < 24) return `${Math.floor(min / 60)} 小时前`;
  const d = new Date(t);
  const now = new Date(nowMs);
  const yd = new Date(now);
  yd.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yd.getFullYear() &&
    d.getMonth() === yd.getMonth() &&
    d.getDate() === yd.getDate()
  )
    return "昨天";
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (d.getFullYear() === now.getFullYear()) return `${m}月${day}日`;
  return `${d.getFullYear()}年${m}月${day}日`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** 把开头的 /Users/<name> 替换为 ~，用于分组头与行展示。 */
export function displayCwd(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

/** 完整本地时间，供详情头展示。 */
export function formatFullTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

/** 树节点时间：今天显示 HH:mm，否则短日期。 */
export function formatTreeTime(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const now = new Date(nowMs);
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  return formatRelativeTime(iso, nowMs);
}

/** 错误横幅文本：UNKNOWN 显示通用文本 + 原始 message。 */
export function errorText(e: { code: string; message: string }): string {
  if (e.code === "UNKNOWN") return `未知错误：${e.message}`;
  return e.message;
}
/** omp 官方更新日志（文件顶部即最新版本；不要拼版本锚点）。 */
export const OMP_CHANGELOG_URL =
  "https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md";

/**
 * 在系统浏览器打开 omp 官方更新日志（侧栏版本行与更新对话框共用）。
 * 仅在非 Tauri 环境（浏览器 mock / 测试）回退到 window.open；
 * 打包应用里 window.open 可能落到应用内窗口，无意义且有风险。
 */
export async function openOmpChangelog(): Promise<void> {
  try {
    await openUrl(OMP_CHANGELOG_URL);
  } catch {
    if (!isTauri()) {
      window.open(OMP_CHANGELOG_URL, "_blank", "noopener");
    }
  }
}

// ---- 展示格式（用法/统计/bench 多处共用，口径锁死） ----

export const usageNumber = (value: number) => value.toLocaleString("zh-CN");
export const usageMoney = (value: number) => `$${value.toFixed(2)}`;

export function formatRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function formatTps(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

export function formatMs(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

/** USD 人话：≥$0.01 两位小数，更小显示 4 位（bench 单轮常不足 1 分钱）。 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** 最近列表时间：本地 "M月D日 HH:MM"。 */
export function formatClock(time: number): string {
  const d = new Date(time);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
