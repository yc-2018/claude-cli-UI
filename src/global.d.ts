import type { Attachment, AttachmentUpload, ClaudeEvent, ClaudeSessionHistory, ClaudeSessionSummary, ModelConfig, Project, RunRequest } from "./types";

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
      getClaudeSessionHistories(workspace: string): Promise<ClaudeSessionHistory[]>;
      renameClaudeSession(workspace: string, sessionId: string, title: string): Promise<{ renamed: boolean; error?: string }>;
      deleteClaudeSession(workspace: string, sessionId: string): Promise<{ deleted: boolean; error?: string }>;
      normalizeClaudeSession(workspace: string, sessionId: string): Promise<boolean>;
      stageAttachments(attachments: AttachmentUpload[]): Promise<Attachment[]>;
      deleteAttachment(storedName: string): Promise<boolean>;
      getProjectStore(): Promise<unknown[] | null>;
      discoverProjects(): Promise<string[]>;
      saveProjectStore(projects: Project[]): void;
      reportError(message: string): void;
      startRun(request: RunRequest): Promise<{ started: boolean }>;
      stopRun(runId: string): Promise<boolean>;
      onEvent(callback: (event: ClaudeEvent) => void): () => void;
    };
  }
}

export {};
