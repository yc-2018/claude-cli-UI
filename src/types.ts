export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

export interface AppSettings {
  closeBehavior: "tray" | "quit";
  notifyOnCompletion: boolean;
}

export interface AppSelection {
  projectId: string | null;
  conversationId: string | null;
}

export type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "up-to-date" | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  portable: boolean;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  downloadAvailable?: boolean;
  error?: string;
  errorContext?: "check" | "download";
}

export interface UpdateActionResult {
  started: boolean;
  error?: string;
}

export interface Activity {
  id: string;
  name: string;
  summary: string;
}

export interface Attachment {
  id: string;
  storedName: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file";
}

export interface AttachmentUpload {
  name: string;
  mediaType: string;
  dataBase64: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  createdAt: number;
  status?: "running" | "done" | "error" | "stopped";
  activities?: Activity[];
  error?: string;
  attachments?: Attachment[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  gitBranch?: string;
  messages: ChatMessage[];
  selectedModel?: string;
  resolvedModel?: string;
  slashCommands?: string[];
  allowedTools?: string[];
  source?: "claude";
  historyLoaded?: boolean;
  permissionMode: PermissionMode;
}

export interface Project {
  id: string;
  name: string;
  customName?: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  conversations: Conversation[];
}

export interface ClaudeSessionSummary {
  sessionId: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  customTitle?: string;
  gitBranch?: string;
  resolvedModel?: string;
  permissionMode: PermissionMode;
}

export interface ClaudeSessionHistory extends ClaudeSessionSummary {
  messages: ChatMessage[];
}

export interface BranchClaudeSessionResult {
  branched: boolean;
  session?: ClaudeSessionHistory;
  error?: string;
}

export interface ModelOption {
  role: "Sonnet" | "Opus" | "Fable" | "Haiku";
  value: "sonnet" | "opus" | "fable" | "haiku";
  actualModel: string;
}

export interface ModelConfig {
  options: ModelOption[];
}

export interface RunRequest {
  runId: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  allowedTools?: string[];
  permissionMode: PermissionMode;
  attachments?: Attachment[];
}

export interface ToolPermissionRequest {
  toolName: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  summary: string;
}

export interface ClaudeEvent {
  runId: string;
  type: "message" | "raw" | "error" | "exit";
  data?: Record<string, unknown>;
  text?: string;
  message?: string;
  code?: number | null;
  stderr?: string;
}
