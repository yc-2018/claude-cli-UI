export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

export interface Activity {
  id: string;
  name: string;
  summary: string;
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
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
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
  hiddenSessionIds?: string[];
}

export interface ClaudeSessionSummary {
  sessionId: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  resolvedModel?: string;
  permissionMode: PermissionMode;
}

export interface ClaudeSessionHistory extends ClaudeSessionSummary {
  messages: ChatMessage[];
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
  model?: string;
  allowedTools?: string[];
  permissionMode: PermissionMode;
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
