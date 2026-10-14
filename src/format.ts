/** 时间 / 大小 / 路径展示：纯函数，中文 UI。 */

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
