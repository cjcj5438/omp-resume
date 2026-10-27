/**
 * 模型模式（omp `modelPresets`）的模块级共享 store。
 *
 * 侧栏 ModePicker 与「管理 → 模型」草稿是两份独立状态，但写的是同一份 omp 配置：
 * 任一侧写成功后通过 `emitModelConfigChanged` 通知另一侧失效重载，避免两边
 * 各自持着过期基线、互相 `CONFLICT`。
 */
import { useSyncExternalStore } from "react";
import {
  deleteModelPreset,
  listModelPresets,
  saveModelPreset,
  switchModelPreset,
} from "./api";
import { normalizeError } from "./api";
import type { AppError } from "./types";
import type { ModelPresetsState } from "./types";

export type ModelConfigOrigin = "presets" | "draft";

export type PresetsView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; state: ModelPresetsState; busy: boolean };

type Listener = () => void;

let view: PresetsView = { status: "loading" };
let listeners = new Set<Listener>();
let inflight: Promise<void> | null = null;
let busy = false;
let subscribed = false;

const configListeners = new Set<(origin: ModelConfigOrigin) => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function setView(next: PresetsView): void {
  view = next;
  emit();
}

function errorMessage(e: unknown): string {
  const err = normalizeError(e);
  return err.message || err.code;
}

export function getPresetsView(): PresetsView {
  return view;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前 store 快照（`useSyncExternalStore` 用）。 */
export function usePresets(): PresetsView {
  if (!subscribed) {
    subscribed = true;
    void refreshPresets();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", () => {
        void refreshPresets();
      });
    }
  }
  return useSyncExternalStore(subscribe, getPresetsView, getPresetsView);
}

/** 重新拉取模式列表；并发调用复用同一个在途请求。 */
export function refreshPresets(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const state = await listModelPresets();
      const current = view.status === "ready" ? view.busy : busy;
      setView({ status: "ready", state, busy: current });
    } catch (e: unknown) {
      // 已有可用状态时保留（下次 focus/重试再拉），否则进入错误态。
      if (view.status !== "ready") {
        setView({ status: "error", message: errorMessage(e) });
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function setBusy(next: boolean): void {
  busy = next;
  if (view.status === "ready") setView({ ...view, busy: next });
}

/**
 * 执行一次模式写操作：`busy` 时直接返回（防重入）。
 * 成功存新状态并通知草稿侧；`CONFLICT` 先刷新再抛给调用方提示重试。
 */
export async function runPresetOp(
  op: () => Promise<ModelPresetsState>,
): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const state = await op();
    setView({ status: "ready", state, busy: false });
    emitModelConfigChanged("presets");
  } catch (e: unknown) {
    const err: AppError = normalizeError(e);
    if (err.code === "CONFLICT") {
      await refreshPresets();
    }
    throw err;
  } finally {
    busy = false;
    if (view.status === "ready" && view.busy) {
      setView({ ...view, busy: false });
    }
  }
}

/** 便捷封装：切换 / 保存 / 删除（都走 `runPresetOp`）。 */
export const presetOps = {
  switch: (name: string, expected: ModelPresetsState["current"]) =>
    runPresetOp(() => switchModelPreset({ name, expected })),
  save: (name: string, overwrite: boolean, expectedPresets: unknown) =>
    runPresetOp(() => saveModelPreset({ name, overwrite, expectedPresets })),
  remove: (name: string, expectedPresets: unknown) =>
    runPresetOp(() => deleteModelPreset({ name, expectedPresets })),
};

/** 订阅「另一侧改了模型配置」（模式弹层 ↔ 模型草稿）。 */
export function onModelConfigChanged(
  fn: (origin: ModelConfigOrigin) => void,
): () => void {
  configListeners.add(fn);
  return () => {
    configListeners.delete(fn);
  };
}

export function emitModelConfigChanged(origin: ModelConfigOrigin): void {
  for (const fn of [...configListeners]) fn(origin);
  // 草稿保存改写了角色 / agent 覆盖 → 模式列表的激活判定可能变化。
  if (origin === "draft") void refreshPresets();
}

/** 仅测试用：复位模块状态。 */
export function __resetPresetsStore(): void {
  view = { status: "loading" };
  listeners = new Set();
  inflight = null;
  busy = false;
  subscribed = false;
  configListeners.clear();
}
