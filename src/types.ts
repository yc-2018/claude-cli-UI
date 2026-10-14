export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ReorderPosition = "before" | "after";
/** 设置里的外部链接：地址写在主进程里，渲染层只点名要开哪个。 */
export type ProjectLinkTarget = "repository" | "issues";

export interface AppSettings {
  closeBehavior: "tray" | "quit";
  notifyOnCompletion: boolean;
  ignoredUpdateVersion?: string;
  /**
   * 「全部回答完成后执行」上次填过的命令。只记命令本身，不记是否已布置：
   * 重启后没有任何对话在跑，布置状态要是也存下来就会在启动瞬间直接关机。
   */
  completionTask?: ShellTask;
}

/** 用户自己写的本机命令：关机、睡眠这类收尾动作，交给 cmd 或 PowerShell 执行。 */
export interface ShellTask {
  shell: TerminalKind;
  command: string;
}

export interface RunShellTaskResult {
  started: boolean;
  error?: string;
}

/** 定时发送：到点把这句话发进指定对话，只配到分钟。 */
export interface ScheduledPrompt {
  id: string;
  projectId: string;
  conversationId: string;
  conversationTitle: string;
  prompt: string;
  /** 用户填的 HH:mm（本地时间），列表里原样显示。 */
  time: string;
  /** HH:mm 解析出的绝对触发时刻：过了今天这个点就算到明天。 */
  dueAt: number;
  createdAt: number;
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

export type TerminalKind = "cmd" | "powershell";

export interface ResumeSessionInTerminalRequest {
  kind: TerminalKind;
  workspace: string;
  sessionId: string;
  skipPermissions: boolean;
}

export interface ResumeSessionInTerminalResult {
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
  /**
   * 这一轮已经产生的输出 token：流式期间随着回复增长，收尾时用 CLI 报的整轮总数校准。
   * 界面上显示成 CLI 那样的「↑ 1.2k tokens」。
   */
  outputTokens?: number;
  createdAt: number;
  status?: "queued" | "running" | "done" | "error" | "stopped";
  activities?: Activity[];
  timeline?: ResponseTimelineItem[];
  activeActivityId?: string;
  error?: string;
  attachments?: Attachment[];
  /** CLI 正在重试这一轮的 API 请求：没有它界面只会一直停在「正在准备回答」。 */
  retry?: ApiRetryState;
  /**
   * 这一轮是引导进去的：提示已经写进正在运行的那个 Claude 进程，不是在界面里排队等下一次启动。
   * 两种等待的处置完全不同（引导的可能被并进当前回答），提示文案必须分开。
   */
  appended?: boolean;
}

export interface ApiRetryState {
  attempt: number;
  maxRetries?: number;
  delayMs?: number;
  status?: number;
  message?: string;
  at: number;
  /** API 连响应头都没回时 CLI 已经等掉的时长（wire 上的 no_response.waited_ms）。 */
  waitedMs?: number;
  /** 子代理的重试走的是 tool_progress.subagent_retry，文案要说清楚卡住的不是主对话。 */
  agentType?: string;
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
  /**
   * 这个占用量是按正文长度估算出来的，不是 CLI 报的权威读数（CLI 没给任何可用用量时才会这样），
   * 界面必须说清是估算值，否则用户会把估算当成真实占用去做压缩决策。
   */
  estimated?: boolean;
}

/** CLI 压缩生命周期里的阶段，来自 wire 上的 compact_progress 事件。 */
export type CompactionPhase = "pre_hooks" | "compacting" | "post_hooks" | "session_start";

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
  /** 压缩过程中 CLI 走到了哪一步：只有一条「已压缩」看不出它正卡在钩子还是正在总结。 */
  phase?: CompactionPhase;
  /** compact_start 带的 hint_text，说明这次压缩因何触发。 */
  hint?: string;
  /** 至今累计被压掉的 token（wire 上的 cumulative_dropped_tokens）。 */
  droppedTokens?: number;
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
  /** 用户通过发送框的附加目录按钮加入的目录，每次启动 CLI 时转成 --add-dir 参数。 */
  additionalDirectories?: string[];
  /** 本对话的 API 失败重试次数，转成 CLAUDE_CODE_MAX_RETRIES；不填就用 CLI 自己的 10 次。 */
  apiMaxRetries?: number;
  /**
   * 被回退掉的那些轮次的提示 uuid。CLI 的 --resume-drops-turn 只是把它们移出对话链，
   * 记录本身仍留在 session 文件里；重新导入历史时要靠这份名单把它们从界面上摘掉。
   */
  droppedPromptUuids?: string[];
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
  /** scratch 代表「临时对话」这个内建分组：它不是用户选的目录，不能改名、删除或置顶。 */
  kind?: "scratch";
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
  /** 从模型标识里识别出的上下文窗口：配成 1M 变体时界面上必须看得出来。 */
  contextWindow: number;
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
  additionalDirectories?: string[];
  permissionMode: PermissionMode;
  attachments?: Attachment[];
  /** 本轮的 API 重试次数上限，传给 CLI 的 CLAUDE_CODE_MAX_RETRIES。 */
  apiMaxRetries?: number;
  /**
   * 截断式恢复：只把 session 读到这条链上记录为止（对应 CLI 的 --resume-session-at），
   * 用来把停止后重新编辑的那一轮真正顶掉，而不是在原会话后面再堆一条。
   */
  resumeSessionAt?: string;
  /** 配合 resumeSessionAt 声明这次要丢掉的那一轮的提示 uuid（--resume-drops-turn）。 */
  resumeDropsTurn?: string;
}

/** 某一轮用户提示在 session 文件里的位置：回退时要同时交给 CLI 的两个 uuid。 */
export interface SessionRewindPoint {
  /** 要保留到的那条链上记录（被丢弃轮次的 parentUuid）。 */
  resumeSessionAt: string;
  /** 被丢弃的那一轮的提示 uuid。 */
  resumeDropsTurn: string;
  /** 这一轮的提示正文，供渲染层核对确实是它要改的那一条。 */
  prompt: string;
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

/** 主进程发现 Claude 自己改了 session 或配置文件后推过来的信号，只说类别，内容还得自己去读。 */
export interface ClaudeWatchEvent {
  kind: "sessions" | "settings";
  /** sessions 事件带 `~/.claude/projects` 下的目录名，用来对上是哪个项目。 */
  projectKey?: string;
}
