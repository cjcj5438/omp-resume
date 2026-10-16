/** 外观偏好：主题解出、存储容错、根元素应用（纯逻辑，不测接线/文案）。 */
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  defaultAppearance,
  loadAppearance,
  resolveTheme,
  saveAppearance,
} from "./appearance";

function memoryStorage(initial?: string): Storage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(APPEARANCE_STORAGE_KEY, initial);
  return {
    getItem: (k: string) => (k === APPEARANCE_STORAGE_KEY ? (map.get(k) ?? null) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

describe("resolveTheme", () => {
  it("显式浅/深色不受系统偏好影响", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("跟随系统时直通系统偏好", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("loadAppearance 容错", () => {
  it("没有记录时返回默认（跟随系统 + 蓝色）", () => {
    expect(loadAppearance(memoryStorage())).toEqual({ mode: "system", accent: "blue" });
  });

  it("读取合法记录", () => {
    const s = memoryStorage(JSON.stringify({ mode: "dark", accent: "pink" }));
    expect(loadAppearance(s)).toEqual({ mode: "dark", accent: "pink" });
  });

  it("非法 JSON 返回默认且不抛出", () => {
    expect(loadAppearance(memoryStorage("{not json"))).toEqual(defaultAppearance());
  });

  it("未知枚举值逐字段回落默认", () => {
    const s = memoryStorage(JSON.stringify({ mode: "midnight", accent: "blue" }));
    expect(loadAppearance(s)).toEqual({ mode: "system", accent: "blue" });
    const s2 = memoryStorage(JSON.stringify({ mode: "dark", accent: "rainbow" }));
    expect(loadAppearance(s2)).toEqual({ mode: "dark", accent: "blue" });
  });

  it("非对象/字段缺失回落默认", () => {
    expect(loadAppearance(memoryStorage("[]"))).toEqual(defaultAppearance());
    expect(loadAppearance(memoryStorage("42"))).toEqual(defaultAppearance());
    expect(loadAppearance(memoryStorage("{}"))).toEqual(defaultAppearance());
    expect(loadAppearance(memoryStorage(JSON.stringify({ mode: "light" })))).toEqual({
      mode: "light",
      accent: "blue",
    });
  });

  it("存储读取抛错时返回默认", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(loadAppearance(throwing)).toEqual(defaultAppearance());
  });
});

describe("saveAppearance", () => {
  it("写入后可被 loadAppearance 原样读回", () => {
    const s = memoryStorage();
    saveAppearance({ mode: "light", accent: "green" }, s);
    expect(loadAppearance(s)).toEqual({ mode: "light", accent: "green" });
  });

  it("存储写入抛错时静默忽略", () => {
    const throwing = {
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(() => saveAppearance(defaultAppearance(), throwing)).not.toThrow();
  });
});

describe("applyAppearance", () => {
  it("写 data-theme/data-accent 并返回实际主题", () => {
    const root = document.createElement("div") as unknown as HTMLElement;
    expect(applyAppearance({ mode: "system", accent: "orange" }, true, root)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.accent).toBe("orange");
    expect(applyAppearance({ mode: "light", accent: "grey" }, true, root)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.accent).toBe("grey");
  });
});
