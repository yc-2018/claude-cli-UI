import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

window.addEventListener("error", (event) => {
  window.claudeDesk.reportError(event.error?.stack ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  window.claudeDesk.reportError(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
});
