/** localStorage JSON 读写小封装：key 与形状校验留在各调用模块。 */

/** 永不抛出；缺失/不可读/非法 JSON → undefined。 */
export function readJson(key: string, storage?: Storage): unknown {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(key);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 存储不可用时静默忽略。 */
export function writeJson(key: string, value: unknown, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage).setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用：忽略，界面状态仍然有效。
  }
}
