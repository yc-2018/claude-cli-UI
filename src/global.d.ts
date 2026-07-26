import type { ClaudeEvent, ClaudeSessionHistory, ClaudeSessionSummary, ModelConfig, RunRequest } from "./types";

declare module "*.css";

declare global {
  interface Window {
    claudeDesk: {
      selectWorkspace(): Promise<string | null>;
      openWorkspace(workspace: string): Promise<{ opened: boolean; error?: string }>;
      getClaudeInfo(): Promise<{ available: boolean; version?: string }>;
      getModels(workspace: string): Promise<ModelConfig>;
      getClaudeSessions(workspace: string): Promise<ClaudeSessionSummary[]>;
      getClaudeSession(workspace: string, sessionId: string): Promise<ClaudeSessionHistory | null>;
      reportError(message: string): void;
      startRun(request: RunRequest): Promise<{ started: boolean }>;
      stopRun(runId: string): Promise<boolean>;
      onEvent(callback: (event: ClaudeEvent) => void): () => void;
    };
  }
}

export {};
