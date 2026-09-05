export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ReorderPosition = "before" | "after";

export interface AppSettings {
  closeBehavior: "tray" | "quit";
  notifyOnCompletion: boolean;
  ignoredUpdateVersion?: string;
}

export interface AppSelection {
  projectId: string | null;
  conversationId: string | null;
}

export interface PermissionNotificationRequest {
  requestId: string;
  conversationId: string;
  title: string;
  tools: string[];
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
  detail?: ActivityDetail;
}

export interface ActivityDiffLine {
  type: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: UserQuestionOption[];
}

export interface ActivityDetail {
  path?: string;
  command?: string;
  oldText?: string;
  newText?: string;
  output?: string;
  diff?: ActivityDiffLine[];
  questions?: UserQuestion[];
}

export type ResponseTimelineItem = {
  id: string;
  type: "text";
  content: string;
} | {
  id: string;
  type: "activity";
  activity: Activity;
};

export interface Attachment {
  id: string;
  storedName: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file";
}

export interface ComposerDraft {
  prompt: string;
  attachments: Attachment[];
}

export interface QueuedPrompt extends ComposerDraft {
  id: string;
}

export interface AttachmentUpload {
  name: string;
  mediaType: string;
  dataBase64: string;
}

export interface OpenAttachmentResult {
  opened: boolean;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  responseStartedAt?: number;
  responseDurationMs?: number;
  /** 这一轮回答结束的时刻：耗时只说明跑了多久，回看长任务还需要知道它是几点结束的。 */
  responseCompletedAt?: number;
  createdAt: number;
  status?: "queued" | "running" | "done" | "error" | "stopped";
  activities?: Activity[];
  timeline?: ResponseTimelineItem[];
  activeActivityId?: string;
  error?: string;
  attachments?: Attachment[];
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface ContextUsage {
  usedTokens?: number;
  contextWindow?: number;
  usedPercentage?: number;
  remainingPercentage?: number;
}

export interface ContextCompaction {
  id: string;
  trigger: "auto" | "manual" | "unknown";
  status: "running" | "done" | "error";
  startedAt?: number;
  completedAt?: number;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  /** 压缩发生时对话里的最后一条消息，用于把提示卡片渲染在正确的位置。 */
  anchorMessageId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  gitBranch?: string;
  messages: ChatMessage[];
  selectedModel?: string;
  thinkingEffort?: ThinkingEffort;
  resolvedModel?: string;
  slashCommands?: SlashCommand[];
  contextUsage?: ContextUsage;
  contextCompactions?: ContextCompaction[];
  allowedTools?: string[];
  source?: "claude";
  historyLoaded?: boolean;
  permissionMode: PermissionMode;
}

export interface Project {
  id: string;
  name: string;
  customName?: string;
  pinned?: boolean;
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
  contextUsage?: ContextUsage;
  contextCompactions?: ContextCompaction[];
}

export interface ClaudeSessionHistory extends ClaudeSessionSummary {
  messages: ChatMessage[];
  contextUsage?: ContextUsage;
  contextCompactions?: ContextCompaction[];
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
  conversationId: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  allowedTools?: string[];
  permissionMode: PermissionMode;
  attachments?: Attachment[];
}

export interface StartRunResult {
  started: boolean;
  /** 该对话已经有一个正在运行的 Claude 进程，调用方需要改为排队。 */
  busy?: boolean;
  runId?: string;
}

export interface ActiveRunStatus {
  runId: string;
  conversationId: string;
  currentTurnRunId: string;
  turnRunIds: string[];
  startedAt: number;
  stopping: boolean;
}

export interface AppendRunRequest {
  runId: string;
  turnRunId: string;
  prompt: string;
  attachments?: Attachment[];
}

export interface ControlResponseRequest {
  runId: string;
  requestId: string;
  behavior: "allow" | "deny" | "completed" | "cancelled";
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Record<string, unknown>[];
  result?: unknown;
  message?: string;
}


export interface ToolPermissionRequest {
  requestId?: string;
  toolName: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  summary: string;
}

export interface ClaudeEvent {
  runId: string;
  type: "message" | "control_request" | "raw" | "error" | "exit";
  data?: Record<string, unknown>;
  text?: string;
  message?: string;
  code?: number | null;
  stderr?: string;
}
