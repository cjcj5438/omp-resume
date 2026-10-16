/** 剪贴板：写入文本，成功返回 true；剪贴板不可用或被拒绝时返回 false，绝不抛出。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
