import { Component, type ReactNode } from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/** 顶层崩溃兜底：子树渲染抛错时显示重载横幅而不是白屏。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(e: unknown): ErrorBoundaryState {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }

  componentDidCatch(error: Error): void {
    console.error(error);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="pane-note" role="alert">
        <div className="banner banner-error"><span>页面出错：{error.message || "未知错误"}</span></div>
        <p><button type="button" className="btn btn-accent" onClick={() => location.reload()}>重新加载</button></p>
      </div>
    );
  }
}
