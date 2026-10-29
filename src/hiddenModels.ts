/**
 * 模型隐藏偏好：纯界面状态，仅存 localStorage，绝不改 omp 配置；
 * 隐藏只影响模型库与模型选择器的列表。
 *
 * 值为精确的 `ModelInfo.selector`（`provider/id`，不带 `:thinking`）数组。
 * 快照按原始字符串缓存：外部（测试的 `localStorage.clear()`、其他窗口）改动后，
 * 下次读取自动失效重建，不常驻过期内存。
 */
import { useSyncExternalStore } from "react";
import { writeJson } from "./storage";

export const HIDDEN_MODELS_KEY = "omp-resume:hidden-models:v1";

type Listener = () => void;

const listeners = new Set<Listener>();
const EMPTY: ReadonlySet<string> = new Set();
let cachedRaw: string | null | undefined;
let cached: ReadonlySet<string> = EMPTY;

function parse(raw: string | null): ReadonlySet<string> {
  if (raw == null) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return EMPTY;
    return new Set(value.filter((v): v is string => typeof v === "string"));
  } catch {
    return EMPTY;
  }
}

function getHidden(): ReadonlySet<string> {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage.getItem(HIDDEN_MODELS_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前已隐藏的模型 selector 集合。 */
export function useHiddenModels(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getHidden, getHidden);
}

/** 隐藏或取消隐藏一个模型（按精确 selector）。 */
export function setModelHidden(selector: string, hidden: boolean): void {
  const next = new Set(getHidden());
  if (hidden) next.add(selector);
  else next.delete(selector);
  writeJson(HIDDEN_MODELS_KEY, [...next]);
  for (const fn of listeners) fn();
}
