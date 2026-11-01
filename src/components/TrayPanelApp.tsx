/**
 * 菜单栏面板窗口入口：轻量 App（自带外观 + 预览轮询 + 极简 toast），不挂主 App。
 * 快捷键：⌘N 新建会话（发 open_main_window{page:"new-session"}）、⌘1 主窗口、
 * ⌘, 设置（跳菜单栏页）、Esc 关闭面板。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import "../App.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import {
  getOmpVersion,
  listModelPresets,
  normalizeError,
  openMainWindow,
  quitApp,
  switchModelPreset,
  trayFocusSession,
  trayResumeRecent,
} from "../api";
import { errorText } from "../format";
import { useAppearance } from "../useAppearance";
import { useTrayPreview, useTraySettings } from "../traySettings";
import { TrayPanel, type TrayPanelActions } from "./TrayPanel";
import "./TrayPanelApp.css";

const MAX_TOASTS = 3;

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export function TrayPanelApp(): React.JSX.Element {
  // 面板窗口独立的外观实例（与主窗口共享 localStorage 键，天然同步偏好）。
  useAppearance();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [ompVersion, setOmpVersion] = useState<string | null>(null);
  const [switchingMode, setSwitchingMode] = useState<string | null>(null);
  const toastId = useRef(0);
  const pushToast = useCallback((text: string, kind: "info" | "error") => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((prev) => [...prev.slice(-MAX_TOASTS + 1), { id, text, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2800);
  }, []);
  const toast = useCallback(
    (text: string, kind: "info" | "error" = "info") => pushToast(text, kind),
    [pushToast],
  );

  const { settings } = useTraySettings(toast);
  const { preview, error: previewError } = useTrayPreview(settings);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    getOmpVersion()
      .then((v) => setOmpVersion(v.version))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (previewError !== null) pushToast(errorText(previewError), "error");
  }, [previewError, pushToast]);

  const closePanel = useCallback(() => {
    void getCurrentWindow().hide().catch(() => {});
  }, []);

  const actions: TrayPanelActions = {
    onFocusSession: (sessionId) => {
      void trayFocusSession(sessionId)
        .then(closePanel)
        .catch((e: unknown) => pushToast(errorText(normalizeError(e)), "error"));
    },
    onResumeRecent: (sessionId) => {
      void trayResumeRecent(sessionId)
        .then(closePanel)
        .catch((e: unknown) => pushToast(errorText(normalizeError(e)), "error"));
    },
    onNewSession: () => {
      // 面板内不做项目展开/目录选择：唤起主窗口的新建会话对话框。
      void openMainWindow("new-session")
        .then(closePanel)
        .catch((e: unknown) => pushToast(errorText(normalizeError(e)), "error"));
    },
    onOpenMain: (page) => {
      void openMainWindow(page)
        .then(closePanel)
        .catch((e: unknown) => pushToast(errorText(normalizeError(e)), "error"));
    },
    onOpenSettings: () => {
      void openMainWindow("tray")
        .then(closePanel)
        .catch((e: unknown) => pushToast(errorText(normalizeError(e)), "error"));
    },
    onSwitchMode: (name) => {
      if (switchingMode !== null) return;
      setSwitchingMode(name);
      void listModelPresets()
        .then((state) => switchModelPreset({ name, expected: state.current }))
        .then(() => pushToast(`已切换模式：${name}`, "info"))
        .catch((e: unknown) => pushToast(errorText(normalizeError(e)), "error"))
        .finally(() => setSwitchingMode(null));
    },
    onQuit: () => {
      void quitApp().catch((e: unknown) => pushToast(errorText(normalizeError(e)), "error"));
    },
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePanel();
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        actions.onNewSession();
      } else if (key === "1") {
        e.preventDefault();
        actions.onOpenMain();
      } else if (key === ",") {
        e.preventDefault();
        actions.onOpenSettings();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actions, closePanel]);

  return (
    <div className="tray-panel-app">
      {preview !== null && settings !== null ? (
        <TrayPanel
          preview={preview}
          settings={settings}
          mode="panel"
          actions={actions}
          appVersion={appVersion}
          ompVersion={ompVersion}
          switchingMode={switchingMode}
        />
      ) : (
        <div className="tray-panel-loading">正在加载…</div>
      )}
      {toasts.length > 0 ? (
        <div className="tray-panel-toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`tray-panel-toast is-${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
