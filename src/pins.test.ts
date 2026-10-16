/** 置顶存储容错、切换与会话清理单测（纯函数 + 内存 Storage）。 */
import { describe, expect, it } from "vitest";
import {
  PINS_STORAGE_KEY,
  emptyPins,
  loadPins,
  removeSessionPins,
  savePins,
  togglePin,
} from "./pins";

function memoryStorage(initial?: string): Storage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(PINS_STORAGE_KEY, initial);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: () => null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("loadPins 容错", () => {
  it("没有记录时返回空置顶", () => {
    expect(loadPins(memoryStorage())).toEqual(emptyPins());
  });

  it("读取合法记录", () => {
    const st = memoryStorage(JSON.stringify({ projects: ["/a"], sessions: ["s1"] }));
    expect(loadPins(st)).toEqual({ projects: ["/a"], sessions: ["s1"] });
  });

  it("非法 JSON 返回空置顶且不抛出", () => {
    expect(loadPins(memoryStorage("{not json"))).toEqual(emptyPins());
  });

  it("结构错误（非对象、数组、字段类型错误）退化为空字段", () => {
    expect(loadPins(memoryStorage("null"))).toEqual(emptyPins());
    expect(loadPins(memoryStorage("42"))).toEqual(emptyPins());
    expect(loadPins(memoryStorage("[1,2]"))).toEqual(emptyPins());
    expect(loadPins(memoryStorage('{"projects":"/a","sessions":{}}'))).toEqual(emptyPins());
  });

  it("过滤非字符串条目并去重", () => {
    const st = memoryStorage(
      JSON.stringify({ projects: ["/a", 1, null, "/a", "/b"], sessions: [{}, "s1", "s1"] }),
    );
    expect(loadPins(st)).toEqual({ projects: ["/a", "/b"], sessions: ["s1"] });
  });

  it("存储读取抛错时返回空置顶", () => {
    const throwing = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(loadPins(throwing)).toEqual(emptyPins());
  });
});

describe("savePins", () => {
  it("写入后可被 loadPins 原样读回", () => {
    const st = memoryStorage();
    const pins = { projects: ["/a"], sessions: ["s1"] };
    savePins(pins, st);
    expect(loadPins(st)).toEqual(pins);
  });

  it("存储写入抛错时静默忽略", () => {
    const throwing = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(() => savePins(emptyPins(), throwing)).not.toThrow();
  });
});

describe("togglePin", () => {
  it("不存在则加入，存在则移除，并返回新对象", () => {
    const before = { projects: ["/a"], sessions: [] };
    const added = togglePin(before, "project", "/b");
    expect(added).toEqual({ projects: ["/a", "/b"], sessions: [] });
    expect(before).toEqual({ projects: ["/a"], sessions: [] });

    const removed = togglePin(added, "project", "/a");
    expect(removed).toEqual({ projects: ["/b"], sessions: [] });
    expect(added).toEqual({ projects: ["/a", "/b"], sessions: [] });
  });

  it("项目与会话互不干扰", () => {
    const pins = togglePin(emptyPins(), "session", "same-key");
    expect(pins).toEqual({ projects: [], sessions: ["same-key"] });
    expect(togglePin(pins, "project", "same-key").projects).toEqual(["same-key"]);
  });
});

describe("removeSessionPins", () => {
  it("移除指定会话 id，保留其余与项目置顶，且不修改入参", () => {
    const before = { projects: ["/a"], sessions: ["s1", "s2", "s3"] };
    const out = removeSessionPins(before, ["s1", "s3", "unknown"]);
    expect(out).toEqual({ projects: ["/a"], sessions: ["s2"] });
    expect(before.sessions).toEqual(["s1", "s2", "s3"]);
  });
});
