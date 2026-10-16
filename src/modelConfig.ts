/**
 * 模型配置值的纯函数：`provider/model[:thinking]` 拆装与 JSON 深比较。
 * 值格式是 CONTRACT §4.37 的持久约定（modelRoles / agentModelOverrides /
 * 回退链条目通用）；未知 selector（别名 `@smol`、已下线模型）原样保留。
 */

export interface SelectorValue {
  selector: string;
  /** 空字符串表示「默认」（不带 `:thinking` 后缀）。 */
  thinking: string;
}

/** 拆分 `provider/model[:thinking]`：仅当末段形如简单 token 才当作 thinking 后缀。 */
export function parseSelectorValue(value: string): SelectorValue {
  const at = value.lastIndexOf(":");
  if (at <= 0) return { selector: value, thinking: "" };
  const tail = value.slice(at + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(tail)) return { selector: value, thinking: "" };
  return { selector: value.slice(0, at), thinking: tail };
}

/** 组回 `provider/model[:thinking]`；未设置 thinking 时不带后缀。 */
export function composeSelectorValue(value: SelectorValue): string {
  return value.thinking ? `${value.selector}:${value.thinking}` : value.selector;
}

/** JSON 值深比较：对象按键集合比较（顺序无关），数组按顺序比较。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every((key) =>
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return false;
}

/** 值不是字符串时的展示文本（原样保留、不参与改写）。 */
export function rawValueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
