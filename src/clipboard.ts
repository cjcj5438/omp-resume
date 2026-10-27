/** 剪贴板：写入文本，成功返回 true；剪贴板不可用或被拒绝时返回 false，绝不抛出。 */
import { copyTextToClipboard } from "./api";

/**
 * 原生兜底：WebView 的 `navigator.clipboard` 需要「用户激活」，而菜单动作里只要有
 * await（例如先取续聊命令）就会丢掉激活态并抛 NotAllowedError。
 * `copy_text` 直接写系统剪贴板，与焦点/激活无关。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 文档未聚焦等：落原生兜底。
  }
  try {
    await copyTextToClipboard(text);
    return true;
  } catch {
    return false;
  }
}
