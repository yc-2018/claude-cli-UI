import type { AppendRunRequest, AppSelection, AppSettings, AppUpdateState, Attachment, AttachmentUpload, BranchClaudeSessionResult, ClaudeEvent, ClaudeSessionHistory, ClaudeSessionSummary, ControlResponseRequest, ModelConfig, OpenAttachmentResult, PermissionMode, PermissionNotificationRequest, Project, RunRequest, UpdateActionResult } from "./types";

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
      branchClaudeSession(workspace: string, sessionId: string, userTurn: number, title: string): Promise<BranchClaudeSessionResult>;
      deleteClaudeSession(workspace: string, sessionId: string): Promise<{ deleted: boolean; error?: string }>;
      normalizeClaudeSession(workspace: string, sessionId: string): Promise<boolean>;
      stageAttachments(attachments: AttachmentUpload[]): Promise<Attachment[]>;
      deleteAttachment(storedName: string): Promise<boolean>;
      openAttachment(storedName: string): Promise<OpenAttachmentResult>;
      getProjectStore(): Promise<unknown[] | null>;
      discoverProjects(): Promise<string[]>;
      saveProjectStore(projects: Project[]): void;
      getAppSelection(): Promise<AppSelection | null>;
      saveAppSelection(selection: AppSelection): void;
      getAppVersion(): Promise<string>;
      getUpdateState(): Promise<AppUpdateState>;
      checkAppUpdate(): Promise<AppUpdateState>;
      downloadAppUpdate(): Promise<AppUpdateState>;
      installAppUpdate(): Promise<UpdateActionResult>;
      openUpdateRelease(): Promise<boolean>;
      getAppSettings(): Promise<AppSettings>;
      setAppSettings(settings: AppSettings): Promise<AppSettings>;
      focusWindow(): Promise<boolean>;
      notifyCompletion(conversationId: string, title: string): Promise<boolean>;
      notifyPermission(request: PermissionNotificationRequest): Promise<boolean>;
      reportError(message: string): void;
      startRun(request: RunRequest): Promise<{ started: boolean }>;
      appendRun(request: AppendRunRequest): Promise<{ appended: boolean }>;
      respondControl(request: ControlResponseRequest): Promise<{ responded: boolean }>;
      setPermissionMode(request: { runId: string; permissionMode: PermissionMode }): Promise<{ changed: boolean }>;
      stopRun(runId: string): Promise<boolean>;
      onEvent(callback: (event: ClaudeEvent) => void): () => void;
      onNavigateToConversation(callback: (conversationId: string) => void): () => void;
      onUpdateState(callback: (state: AppUpdateState) => void): () => void;
    };
  }
}

export {};
