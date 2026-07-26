import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    window.claudeDesk.reportError(`${error.stack ?? error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="fatal-error">
        <TriangleAlert size={24} />
        <h1>界面遇到错误</h1>
        <p>任务记录仍保存在本机。重新载入后可以继续。</p>
        <button className="primary-button" onClick={() => location.reload()}>
          <RefreshCw size={16} />重新载入
        </button>
      </main>
    );
  }
}
