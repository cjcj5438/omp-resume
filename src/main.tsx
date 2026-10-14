import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

async function boot(): Promise<void> {
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("mock")
  ) {
    // 动态 import 是刻意的：静态导入会把 DEV 夹具打进生产包（任务要求用 build+grep 验证）。
    const { installMockBackend } = await import("./dev/mockBackend");
    await installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
