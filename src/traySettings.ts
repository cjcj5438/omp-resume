/**
 * 菜单栏设置状态：事件订阅 + 设置读写 hook + 预览轮询 hook。
 * 设置写路径不做乐观更新：saving 期间控件禁用，失败 toast 后 reload 回真值。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getTrayPreview,
  getTraySettings,
  normalizeError,
  setTraySettings,
} from "./api";
import { startChain } from "./pollChain";
import { errorText } from "./format";
import type { ToastFn } from "./components/useOmpOp";
import type {
  AppError,
  TrayPreview,
  TraySettings,
  TraySettingsPatch,
} from "./types";

/** 设置变更事件（Rust 侧 tray.rs 同名字面量，payload 为完整 Settings）。 */
export const TRAY_SETTINGS_CHANGED_EVENT = "tray-settings-changed";
/** 「更多菜单栏设置…」请求（payload 空，主窗口收到后切到菜单栏页）。 */
export const OPEN_TRAY_SETTINGS_EVENT = "open-tray-settings";
/** 主窗口路由跳转（`open_main_window{page}` 发出；new-session 由新建会话对话框订阅）。 */
export const OPEN_MAIN_ROUTE_EVENT = "open-main-route";

/** `open-main-route` payload：route 跳转由 App 订阅，new-session 由 fe-sessions 订阅。 */
export type OpenMainRoutePayload = { route: string } | { action: "new-session" };

/** 预览轮询间隔（ms）：与原生托盘轮询器同频。 */
export const TRAY_PREVIEW_INTERVAL_MS = 3000;

/** 订阅设置变更；payload 为完整 `TraySettings`。返回取消订阅函数。 */
export function onTraySettingsChanged(cb: (settings: TraySettings) => void): Promise<() => void> {
  return listen<TraySettings>(TRAY_SETTINGS_CHANGED_EVENT, (e) => cb(e.payload));
}

/** 订阅「打开菜单栏页」请求；返回取消订阅函数。 */
export function onOpenTraySettingsRequest(cb: () => void): Promise<() => void> {
  return listen(OPEN_TRAY_SETTINGS_EVENT, () => cb());
}

/** 订阅主窗口路由跳转；payload 为 `OpenMainRoutePayload`。返回取消订阅函数。 */
export function onOpenMainRouteRequest(cb: (payload: OpenMainRoutePayload) => void): Promise<() => void> {
  return listen<OpenMainRoutePayload>(OPEN_MAIN_ROUTE_EVENT, (e) => cb(e.payload));
}

export interface TraySettingsData {
  settings: TraySettings | null;
  error: AppError | null;
  saving: boolean;
  reload: () => void;
  update: (patch: TraySettingsPatch) => Promise<void>;
}

/**
 * 菜单栏设置：挂载拉取 + 事件订阅同步外部修改（原生菜单勾选）。
 * `update` 不做乐观更新：saving=true → 成功用返回值 set → 失败 toast 后 reload。
 */
export function useTraySettings(onToast: ToastFn): TraySettingsData {
  const [settings, setSettings] = useState<TraySettings | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void getTraySettings()
      .then((s) => {
        if (!cancelled && alive.current) {
          setSettings(s);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled && alive.current) setError(normalizeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // 外部修改（原生菜单勾选）：事件 payload 直接 set，无需重拉。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onTraySettingsChanged((s) => {
      if (alive.current) {
        setSettings(s);
        setError(null);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      // 浏览器 mock 环境没有事件投递：静默，设置读写不受影响。
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => () => {
    alive.current = false;
  }, []);

  const update = useCallback(
    async (patch: TraySettingsPatch) => {
      setSaving(true);
      try {
        const next = await setTraySettings(patch);
        if (alive.current) {
          setSettings(next);
          setError(null);
        }
      } catch (e: unknown) {
        if (alive.current) {
          onToast(errorText(normalizeError(e)), "error");
          reload();
        }
      } finally {
        if (alive.current) setSaving(false);
      }
    },
    [onToast, reload],
  );

  return { settings, error, saving, reload, update };
}

/**
 * 预览轮询：链式 `startChain`，连续 2 次失败才置 error（同 `useStagePoll`）。
 * `version` 变化（设置更新后）立即重拉。
 */
export function useTrayPreview(version: unknown): {
  preview: TrayPreview | null;
  error: AppError | null;
} {
  const [preview, setPreview] = useState<TrayPreview | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    failures.current = 0;
    setPreview(null);
    setError(null);
    let alive = true;

    const stop = startChain(async () => {
      try {
        const data = await getTrayPreview();
        if (!alive) return TRAY_PREVIEW_INTERVAL_MS;
        failures.current = 0;
        setPreview(data);
        setError(null);
      } catch (e: unknown) {
        if (alive) {
          failures.current += 1;
          if (failures.current >= 2) setError(normalizeError(e));
        }
      }
      return TRAY_PREVIEW_INTERVAL_MS;
    });

    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return { preview, error };
}
