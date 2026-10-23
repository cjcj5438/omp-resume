import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

async function boot(): Promise<void> {
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("mock")
  ) {
    // 动态 import 是刻意的：静态导入会把 DEV 夹具打进生产包（任务要求用 build+grep 验证）。
    const { installMockBackend } = await import("./dev/mockBackend");
    await installMockBackend();
  }
  const root = document.getElementById("root");
  if (root === null) throw new Error("缺少 #root 容器");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

boot().catch((e: unknown) => {
  console.error(e);
  const root = document.getElementById("root");
  if (root !== null) {
    const message = e instanceof Error ? e.message : String(e);
    const outer = document.createElement("div");
    outer.className = "pane-note";
    outer.setAttribute("role", "alert");
    const banner = document.createElement("div");
    banner.className = "banner banner-error";
    const label = document.createElement("span");
    label.textContent = `启动失败：${message}`;
    banner.appendChild(label);
    outer.appendChild(banner);
    root.replaceChildren(outer);
  }
});
