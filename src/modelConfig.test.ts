/**
 * 模型配置值纯函数测试：`provider/model[:thinking]` 拆装与深比较。
 */
import { describe, expect, it } from "vitest";
import { composeSelectorValue, deepEqual, parseSelectorValue, rawValueText } from "./modelConfig";

describe("selector 值拆装", () => {
  it("拆分与组回 provider/model[:thinking]，未知值原样保留", () => {
    for (const value of [
      "5438/mimo-v2.6-pro",
      "@smol",
      "typesafe/jev-latest",
      "5438/deepseek-v4.1-flash:low",
      "5438-claude/claude-sonnet-5-5:xhigh",
      "factory-droid/gpt-6.1-sol:max",
    ]) {
      expect(composeSelectorValue(parseSelectorValue(value))).toBe(value);
    }
  });

  it("只有末段是简单 token 才算 thinking 后缀", () => {
    expect(parseSelectorValue("5438/mimo-v2.6-pro:high")).toEqual({
      selector: "5438/mimo-v2.6-pro",
      thinking: "high",
    });
    // 后缀里带斜杠/空白/空串 = 不是 thinking 后缀，selector 原样保留。
    for (const value of ["a/b:", "a/b:c/d", "a/b:c d", ":high", "a/b:c.d"]) {
      expect(parseSelectorValue(value)).toEqual({ selector: value, thinking: "" });
    }
    expect(composeSelectorValue({ selector: "@smol", thinking: "" })).toBe("@smol");
    expect(composeSelectorValue({ selector: "a/b", thinking: "low" })).toBe("a/b:low");
  });
});

describe("deepEqual", () => {
  it("对象按键集合比较、数组按顺序比较", () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: { b: ["x"] } }, { a: { b: ["x"] } })).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual("x", "x")).toBe(true);
    expect(deepEqual(5, "5")).toBe(false);
  });
});

describe("rawValueText", () => {
  it("字符串原样，其他值用紧凑 JSON 展示", () => {
    expect(rawValueText("a/b")).toBe("a/b");
    expect(rawValueText(5)).toBe("5");
    expect(rawValueText(["a", "b"])).toBe('["a","b"]');
  });
});
