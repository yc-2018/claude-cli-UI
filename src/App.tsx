import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Check, CheckCircle2, Copy, Folder, FolderOpen, Minimize2, Plus, TerminalSquare, X } from "lucide-react";
import Composer from "./Composer";
import ConversationView from "./ConversationView";
import DeleteConfirmDialog from "./DeleteConfirmDialog";
import PermissionDialog from "./PermissionDialog";
import UserQuestionDialog from "./UserQuestionDialog";
import Sidebar from "./Sidebar";
import UpdateDialog from "./UpdateDialog";
import { hasLegacyProjectsToMigrate, loadProjects, makeId, parseProjects, pathName, saveProjects, shorten } from "./storage";
import type {
  Activity,
  ActivityDetail,
  ActivityDiffLine,
  AppSelection,
  AppSettings,
  AppUpdateState,
  Attachment,
  ChatMessage,
  ClaudeEvent,
  ClaudeSessionHistory,
  ClaudeSessionSummary,
  ComposerDraft,
  Conversation,
  ContextCompaction,
  ContextUsage,
  ModelConfig,
  PermissionMode,
  PermissionNotificationRequest,
  Project,
  QueuedPrompt,
  ReorderPosition,
  RunRequest,
  ToolPermissionRequest,
  UserQuestion,
} from "./types";
import { describeSlashCommand, normalizeSlashCommands } from "./commands";

interface RunMeta {
  conversationId: string;
  processRunId: string;
  responseId: string;
  userMessageId?: string;
  appendToResponse: boolean;
  completed: boolean;
  successful: boolean;
  receivedText: boolean;
  receivedThinking: boolean;
  pendingText: string;
  pendingThinking: string;
  activeTextBlockId?: string;
  flushTimer?: number;
}

interface PendingPermission {
  conversationId: string;
  responseId: string;
  sessionId?: string;
  requests: ToolPermissionRequest[];
  runId?: string;
  requestId?: string;
  input?: Record<string, unknown>;
  permissionSuggestions?: Record<string, unknown>[];
  direct?: boolean;
}

interface PendingUserQuestion {
  conversationId: string;
  runId: string;
  requestId: string;
  input: Record<string, unknown>;
  questions: UserQuestion[];
}

interface CliCommandNotice {
  conversationId: string;
  command: string;
  copied: boolean;
}

function finishResponse(message: ChatMessage, now = Date.now()): Pick<ChatMessage, "responseDurationMs"> {
  if (!message.responseStartedAt) return {};
  return { responseDurationMs: Math.max(0, now - message.responseStartedAt) };
}

function appendResponseContent(current: string | undefined, addition: string) {
  if (!addition) return current ?? "";
  if (!current) return addition;
  return `${current}\n\n${addition}`;
}

function createCliResumeCommand(workspace: string, sessionId: string) {
  return `cd /d "${workspace}" && claude --resume "${sessionId}"`;
}

type PendingDeletion = {
  kind: "conversation";
  projectId: string;
  conversationId: string;
  title: string;
  hasSession: boolean;
} | {
  kind: "project";
  projectId: string;
  title: string;
};

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const SIDEBAR_WIDTH_STORAGE_KEY = "claude-desk.sidebar-width.v1";
const DEFAULT_APP_SETTINGS: AppSettings = { closeBehavior: "tray", notifyOnCompletion: true };
const DEFAULT_UPDATE_STATE: AppUpdateState = { phase: "idle", currentVersion: "", portable: false };
const EMPTY_COMPOSER_DRAFT: ComposerDraft = { prompt: "", attachments: [] };

function insertUnpinnedFirst<T extends { pinned?: boolean }>(items: T[], additions: T | T[]) {
  const newItems = Array.isArray(additions) ? additions : [additions];
  const firstUnpinnedIndex = items.findIndex((item) => !item.pinned);
  const insertionIndex = firstUnpinnedIndex === -1 ? items.length : firstUnpinnedIndex;
  return [
    ...items.slice(0, insertionIndex),
    ...newItems,
    ...items.slice(insertionIndex),
  ];
}

function reorderListItem<T extends { id: string; pinned?: boolean }>(
  items: T[],
  sourceId: string,
  targetId: string,
  position: ReorderPosition,
) {
  if (sourceId === targetId) return items;
  const source = items.find((item) => item.id === sourceId);
  const target = items.find((item) => item.id === targetId);
  if (!source || !target) return items;
  const remaining = items.filter((item) => item.id !== sourceId);
  const targetIndex = remaining.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) return items;
  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  const moved = Boolean(source.pinned) === Boolean(target.pinned)
    ? source
    : { ...source, pinned: target.pinned ? true : undefined };
  return [
    ...remaining.slice(0, insertionIndex),
    moved,
    ...remaining.slice(insertionIndex),
  ];
}

function toggleListItemPinned<T extends { id: string; pinned?: boolean }>(items: T[], id: string) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return items;
  const pinned = !item.pinned;
  const changed = { ...item, pinned: pinned ? true : undefined };
  const remaining = items.filter((candidate) => candidate.id !== id);
  if (pinned) return [changed, ...remaining];
  const firstUnpinnedIndex = remaining.findIndex((candidate) => !candidate.pinned);
  const insertionIndex = firstUnpinnedIndex === -1 ? remaining.length : firstUnpinnedIndex;
  return [
    ...remaining.slice(0, insertionIndex),
    changed,
    ...remaining.slice(insertionIndex),
  ];
}

function resolveSelection(projects: Project[], saved: AppSelection | null): AppSelection {
  const savedProject = saved?.projectId ? projects.find((project) => project.id === saved.projectId) : undefined;
  if (savedProject) {
    const savedConversation = saved?.conversationId
      ? savedProject.conversations.find((conversation) => conversation.id === saved.conversationId)
      : undefined;
    return { projectId: savedProject.id, conversationId: savedConversation?.id ?? null };
  }
  const firstProject = projects[0];
  return {
    projectId: firstProject?.id ?? null,
    conversationId: firstProject?.conversations[0]?.id ?? null,
  };
}

function maxSidebarWidth() {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 420));
}

function clampSidebarWidth(width: number) {
  return Math.min(maxSidebarWidth(), Math.max(MIN_SIDEBAR_WIDTH, width));
}

function loadSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return clampSidebarWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SIDEBAR_WIDTH);
}

function getTextDelta(data: Record<string, unknown>) {
  if (data.type !== "stream_event" || !data.event || typeof data.event !== "object") return "";
  const streamEvent = data.event as Record<string, unknown>;
  if (streamEvent.type !== "content_block_delta" || !streamEvent.delta || typeof streamEvent.delta !== "object") return "";
  const delta = streamEvent.delta as Record<string, unknown>;
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function getThinkingDelta(data: Record<string, unknown>) {
  if (data.type !== "stream_event" || !data.event || typeof data.event !== "object") return "";
  const streamEvent = data.event as Record<string, unknown>;
  if (streamEvent.type !== "content_block_delta" || !streamEvent.delta || typeof streamEvent.delta !== "object") return "";
  const delta = streamEvent.delta as Record<string, unknown>;
  return delta.type === "thinking_delta" && typeof delta.thinking === "string" ? delta.thinking : "";
}

function getStreamBlockStart(data: Record<string, unknown>) {
  if (data.type !== "stream_event" || !data.event || typeof data.event !== "object") return null;
  const streamEvent = data.event as Record<string, unknown>;
  if (streamEvent.type !== "content_block_start" || !streamEvent.content_block || typeof streamEvent.content_block !== "object") return null;
  return streamEvent.content_block as Record<string, unknown>;
}

function summarizeToolInput(input: unknown) {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  const preferred = value.command ?? value.file_path ?? value.path ?? value.pattern ?? value.query ?? value.description;
  return typeof preferred === "string" ? shorten(preferred, 90) : "";
}

const MAX_ACTIVITY_DETAIL_LENGTH = 200_000;

function activityDetailText(value: unknown) {
  return typeof value === "string" ? value.slice(0, MAX_ACTIVITY_DETAIL_LENGTH) : undefined;
}

function getUserQuestions(input: unknown): UserQuestion[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rawQuestions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions)) return undefined;
  const questions = rawQuestions.slice(0, 10).flatMap((rawQuestion): UserQuestion[] => {
    if (!rawQuestion || typeof rawQuestion !== "object") return [];
    const question = rawQuestion as Record<string, unknown>;
    if (typeof question.question !== "string" || !question.question.trim()) return [];
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 20).flatMap((rawOption) => {
        if (!rawOption || typeof rawOption !== "object") return [];
        const option = rawOption as Record<string, unknown>;
        if (typeof option.label !== "string" || !option.label.trim()) return [];
        return [{
          label: option.label.slice(0, 500),
          description: activityDetailText(option.description),
          preview: activityDetailText(option.preview),
        }];
      })
      : [];
    return [{
      question: question.question.slice(0, 2_000),
      header: activityDetailText(question.header),
      multiSelect: question.multiSelect === true,
      options,
    }];
  });
  return questions.length > 0 ? questions : undefined;
}

function getActivityDetail(name: string, input: unknown): ActivityDetail | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const path = activityDetailText(value.file_path ?? value.path);
  const command = activityDetailText(value.command);
  const oldText = activityDetailText(value.old_string ?? value.oldText);
  let newText = activityDetailText(value.new_string ?? value.newText);
  const questions = /askuserquestion/i.test(name) ? getUserQuestions(input) : undefined;
  if (newText === undefined && /write|create/i.test(name)) newText = activityDetailText(value.content);
  if (!path && !command && oldText === undefined && newText === undefined && !questions) return undefined;
  return { path, command, oldText, newText, questions };
}

function toolResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, MAX_ACTIVITY_DETAIL_LENGTH);
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
  return text ? text.slice(0, MAX_ACTIVITY_DETAIL_LENGTH) : undefined;
}

function structuredDiffLines(value: unknown): ActivityDiffLine[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.structuredPatch)) return undefined;
  const diff: ActivityDiffLine[] = [];
  for (const rawHunk of result.structuredPatch.slice(0, 100)) {
    if (!rawHunk || typeof rawHunk !== "object") continue;
    const hunk = rawHunk as Record<string, unknown>;
    if (!Array.isArray(hunk.lines)) continue;
    let oldLine = typeof hunk.oldStart === "number" ? hunk.oldStart : 1;
    let newLine = typeof hunk.newStart === "number" ? hunk.newStart : 1;
    for (const rawLine of hunk.lines) {
      if (typeof rawLine !== "string" || rawLine.startsWith("\\ No newline")) continue;
      const marker = rawLine[0];
      const text = marker === "+" || marker === "-" || marker === " " ? rawLine.slice(1) : rawLine;
      if (marker === "+") {
        diff.push({ type: "add", text, newLine });
        newLine += 1;
      } else if (marker === "-") {
        diff.push({ type: "remove", text, oldLine });
        oldLine += 1;
      } else {
        diff.push({ type: "context", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
      if (diff.length >= 4_000) return diff;
    }
  }
  return diff.length > 0 ? diff : undefined;
}

interface ActivityResult {
  id: string;
  output?: string;
  path?: string;
  diff?: ActivityDiffLine[];
}

function getActivityResults(data: Record<string, unknown>): ActivityResult[] {
  if (data.type !== "user" || !data.message || typeof data.message !== "object") return [];
  const content = (data.message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const rawResult = data.tool_use_result ?? data.toolUseResult;
  const resultObject = rawResult && typeof rawResult === "object" ? rawResult as Record<string, unknown> : undefined;
  const diff = structuredDiffLines(rawResult);
  const path = activityDetailText(resultObject?.filePath ?? resultObject?.file_path);
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    if (item.type !== "tool_result" || typeof item.tool_use_id !== "string") return [];
    const output = toolResultText(item.content)
      ?? activityDetailText(resultObject?.stdout)
      ?? activityDetailText(resultObject?.stderr);
    return [{ id: item.tool_use_id, output, path, diff }];
  });
}

function makeClaudeSessionName(prompt: string) {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  const firstTenCharacters = Array.from(normalized).slice(0, 10).join("");
  return firstTenCharacters.replace(/[&|<>^%"!()]/g, "").trim() || undefined;
}

function getPermissionRequests(data: Record<string, unknown>): ToolPermissionRequest[] {
  if (data.type !== "result" || !Array.isArray(data.permission_denials)) return [];
  return data.permission_denials.flatMap((denial) => {
    if (!denial || typeof denial !== "object") return [];
    const value = denial as Record<string, unknown>;
    const toolName = typeof value.tool_name === "string"
      ? value.tool_name
      : (typeof value.name === "string" ? value.name : "");
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return [];
    const toolInput = value.tool_input && typeof value.tool_input === "object" && !Array.isArray(value.tool_input)
      ? value.tool_input as Record<string, unknown>
      : undefined;
    let summary = summarizeToolInput(toolInput);
    if (!summary && toolInput) {
      try {
        summary = shorten(JSON.stringify(toolInput), 120);
      } catch {
        summary = "";
      }
    }
    return [{
      toolName,
      toolUseId: typeof value.tool_use_id === "string" ? value.tool_use_id : undefined,
      toolInput,
      summary,
    }];
  });
}

function getControlRequest(data: Record<string, unknown>) {
  if (data.type !== "control_request" || typeof data.request_id !== "string" || !data.request || typeof data.request !== "object") return null;
  const request = data.request as Record<string, unknown>;
  if (request.subtype !== "can_use_tool" || typeof request.tool_name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(request.tool_name)) return null;
  const input = request.input && typeof request.input === "object" && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {};
  return {
    requestId: data.request_id,
    toolName: request.tool_name,
    toolUseId: typeof request.tool_use_id === "string" ? request.tool_use_id : undefined,
    input,
    requiresUserInteraction: request.requires_user_interaction === true,
    permissionSuggestions: Array.isArray(request.permission_suggestions)
      ? request.permission_suggestions.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).slice(0, 20)
      : undefined,
  };
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function percentageValue(value: unknown) {
  const percentage = numberValue(value);
  return percentage === undefined ? undefined : Math.min(100, percentage);
}

function contextUsageSource(data: Record<string, unknown>) {
  const directSources = [data.context_window, data.contextWindow, data.current_usage, data.currentUsage, data.context_usage, data.contextUsage];
  for (const value of directSources) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  const usage = data.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const usageObject = usage as Record<string, unknown>;
  const nestedSources = [usageObject.context_window, usageObject.contextWindow, usageObject.current_usage, usageObject.currentUsage];
  return nestedSources.find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
}

function getContextUsage(data: Record<string, unknown>): ContextUsage | undefined {
  const source = contextUsageSource(data);
  if (!source) return undefined;
  const usedTokens = numberValue(source.used_tokens ?? source.usedTokens ?? source.current_tokens ?? source.currentTokens ?? source.context_tokens ?? source.contextTokens);
  const contextWindow = numberValue(source.context_window ?? source.contextWindow ?? source.context_window_size ?? source.contextWindowSize ?? source.max_tokens);
  const usedPercentage = percentageValue(source.used_percentage ?? source.usedPercentage);
  const remainingPercentage = percentageValue(source.remaining_percentage ?? source.remainingPercentage);
  if (usedTokens === undefined && contextWindow === undefined && usedPercentage === undefined && remainingPercentage === undefined) return undefined;
  return { usedTokens, contextWindow, usedPercentage, remainingPercentage };
}

function getCompactBoundary(data: Record<string, unknown>): ContextCompaction | undefined {
  if (data.type !== "system" || data.subtype !== "compact_boundary") return undefined;
  const metadata = data.compactMetadata && typeof data.compactMetadata === "object"
    ? data.compactMetadata as Record<string, unknown>
    : {};
  const trigger = metadata.trigger === "auto" || metadata.trigger === "manual" ? metadata.trigger : "unknown";
  return {
    id: typeof data.uuid === "string" ? data.uuid : makeId(),
    trigger,
    status: "done",
    completedAt: Date.now(),
    preTokens: numberValue(metadata.preTokens),
    postTokens: numberValue(metadata.postTokens),
    durationMs: numberValue(metadata.durationMs),
  };
}

function getCompactSummary(data: Record<string, unknown>) {
  if (data.isCompactSummary !== true || !data.message || typeof data.message !== "object") return undefined;
  const content = (data.message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n").trim();
  return text || undefined;
}

function getCompactionState(data: Record<string, unknown>): "running" | "done" | "error" | undefined {
  const subtype = typeof data.subtype === "string" ? data.subtype.toLowerCase() : "";
  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  if (subtype.includes("compact") || status.includes("compact")) {
    if (subtype.includes("error") || status.includes("error") || data.is_error === true) return "error";
    if (subtype.includes("boundary") || subtype.includes("complete") || status.includes("complete") || status.includes("done")) return "done";
    return "running";
  }
  return undefined;
}

function getAssistantContent(data: Record<string, unknown>): Record<string, unknown>[] {
  if (data.type !== "assistant" || !data.message || typeof data.message !== "object") return [];
  const content = (data.message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"));
}

function appendTimelineText(message: ChatMessage, id: string, text: string): ChatMessage {
  if (!text) return message;
  const timeline = message.timeline ?? [];
  const existingIndex = timeline.findIndex((item) => item.type === "text" && item.id === id);
  if (existingIndex >= 0) {
    return {
      ...message,
      content: message.content + text,
      timeline: timeline.map((item, index) => index === existingIndex && item.type === "text"
        ? { ...item, content: item.content + text }
        : item),
    };
  }
  return {
    ...message,
    content: appendResponseContent(message.content, text),
    timeline: [...timeline, { id, type: "text", content: text }],
  };
}

function upsertTimelineActivity(message: ChatMessage, activity: Activity): ChatMessage {
  const activities = message.activities ?? [];
  const existingActivity = activities.find((item) => item.id === activity.id);
  const nextActivity = existingActivity
    ? {
      ...existingActivity,
      ...activity,
      detail: existingActivity.detail || activity.detail
        ? { ...existingActivity.detail, ...activity.detail }
        : undefined,
    }
    : activity;
  const timeline = message.timeline ?? [];
  const existingTimelineIndex = timeline.findIndex((item) => item.type === "activity" && item.activity.id === activity.id);
  return {
    ...message,
    activities: existingActivity
      ? activities.map((item) => item.id === activity.id ? nextActivity : item)
      : [...activities, nextActivity],
    timeline: existingTimelineIndex >= 0
      ? timeline.map((item, index) => index === existingTimelineIndex && item.type === "activity"
        ? { ...item, activity: nextActivity }
        : item)
      : [...timeline, { id: `activity-${activity.id}`, type: "activity", activity: nextActivity }],
  };
}

function applyActivityResult(message: ChatMessage, result: ActivityResult): ChatMessage {
  const activity = (message.activities ?? []).find((item) => item.id === result.id);
  if (!activity) return message;
  return {
    ...upsertTimelineActivity(message, {
      ...activity,
      detail: {
        ...activity.detail,
        path: result.path ?? activity.detail?.path,
        output: result.output ?? activity.detail?.output,
        diff: result.diff ?? activity.detail?.diff,
      },
    }),
    activeActivityId: message.activeActivityId === result.id ? undefined : message.activeActivityId,
  };
}

function createConversation(): Conversation {
  const now = Date.now();
  return {
    id: makeId(),
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
    slashCommands: [],
    permissionMode: "acceptEdits",
  };
}

function getModelArgument(conversation: Conversation, config: ModelConfig) {
  const selected = conversation.selectedModel;
  if (selected && config.options.some((option) => option.value === selected)) return selected;
  if (selected) {
    const mapped = config.options.find((option) => option.actualModel === selected);
    if (mapped) return mapped.value;
  }
  return config.options[0]?.value ?? selected;
}

function importedConversation(summary: ClaudeSessionSummary): Conversation {
  return {
    id: `claude-${summary.sessionId}`,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    sessionId: summary.sessionId,
    gitBranch: summary.gitBranch,
    messages: [],
    resolvedModel: summary.resolvedModel,
    slashCommands: [],
    contextUsage: summary.contextUsage,
    contextCompactions: summary.contextCompactions,
    permissionMode: summary.permissionMode,
    source: "claude",
    historyLoaded: false,
  };
}

function nextBranchTitle(title: string, conversations: Conversation[]) {
  const base = title.replace(/ \(\d+\)$/, "").trim() || "新对话";
  const existingTitles = new Set(conversations.map((conversation) => conversation.title));
  for (let number = 2; number < 10_000; number += 1) {
    const suffix = ` (${number})`;
    const candidate = `${Array.from(base).slice(0, 100 - suffix.length).join("")}${suffix}`;
    if (!existingTitles.has(candidate)) return candidate;
  }
  return `${Array.from(base).slice(0, 93).join("")} (${Date.now().toString().slice(-4)})`;
}

function EmptyView({ onNewProject }: { onNewProject(): void }) {
  return (
    <div className="empty-view">
      <div className="empty-icon"><TerminalSquare size={25} /></div>
      <h1>选择项目目录</h1>
      <button className="primary-button" onClick={onNewProject}><FolderOpen size={16} />新建项目</button>
    </div>
  );
}

function ProjectEmptyView({ project, onNewConversation }: { project: Project; onNewConversation(): void }) {
  return (
    <div className="empty-view project-empty-view">
      <div className="empty-icon"><Folder size={25} /></div>
      <h1>{project.customName ?? project.name}</h1>
      <p>当前没有打开的对话</p>
      <button className="primary-button" onClick={onNewConversation}><Plus size={16} />新建对话</button>
    </div>
  );
}

function formatTokenCount(value?: number) {
  if (value === undefined) return "未知";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function ContextStatus({ conversation, onCompact, disabled }: { conversation: Conversation; onCompact(): void; disabled: boolean }) {
  const usage = conversation.contextUsage;
  const latest = conversation.contextCompactions?.at(-1);
  const percentage = usage?.usedPercentage ?? (usage?.usedTokens !== undefined && usage.contextWindow
    ? (usage.usedTokens / usage.contextWindow) * 100
    : undefined);
  const usageText = percentage !== undefined
    ? `上下文 ${Math.round(percentage)}%`
    : usage?.usedTokens !== undefined
      ? `上下文 ${formatTokenCount(usage.usedTokens)}${usage.contextWindow ? `/${formatTokenCount(usage.contextWindow)}` : ""}`
      : "上下文用量未知";
  const compactText = latest?.status === "running"
    ? "正在压缩上下文…"
    : latest?.status === "error"
      ? "上下文压缩失败"
      : latest?.summary
        ? "已完成上下文压缩"
        : undefined;
  return (
    <div className="context-status" title={latest?.summary ?? usageText}>
      <span className="context-status-text">{compactText ?? usageText}</span>
      {latest?.status === "done" && latest.preTokens !== undefined && latest.postTokens !== undefined
        ? <small>{formatTokenCount(latest.preTokens)} → {formatTokenCount(latest.postTokens)}</small>
        : null}
      <button type="button" className="context-compact-button" onClick={onCompact} disabled={disabled || latest?.status === "running"} title="压缩上下文" aria-label="压缩上下文">
        <Minimize2 size={13} />
        <span>压缩</span>
      </button>
    </div>
  );
}

export default function App() {
  const [initialProjects] = useState<Project[]>(loadProjects);
  const [preferLegacyProjects] = useState(hasLegacyProjectsToMigrate);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [storageReady, setStorageReady] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [activeRuns, setActiveRuns] = useState<Record<string, string>>({});
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [appSettingsLoaded, setAppSettingsLoaded] = useState(false);
  const [completionNotice, setCompletionNotice] = useState<{ conversationId: string; title: string } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [updateState, setUpdateState] = useState<AppUpdateState>(DEFAULT_UPDATE_STATE);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [updateActionError, setUpdateActionError] = useState("");
  const [cliInfo, setCliInfo] = useState<{ available: boolean; version?: string } | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({ options: [] });
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([]);
  const [questionQueue, setQuestionQueue] = useState<PendingUserQuestion[]>([]);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [cliCommandNotice, setCliCommandNotice] = useState<CliCommandNotice | null>(null);
  const [branchingConversationId, setBranchingConversationId] = useState<string | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraft>>({});
  const [promptQueues, setPromptQueues] = useState<Record<string, QueuedPrompt[]>>({});
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState("");
  const projectsRef = useRef(projects);
  const activeConversationIdRef = useRef(activeConversationId);
  const appSettingsRef = useRef(appSettings);
  const runMeta = useRef(new Map<string, RunMeta>());
  const processRunIds = useRef(new Map<string, string>());
  const scannedProjects = useRef(new Set<string>());
  const loadingHistories = useRef(new Set<string>());
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const branchingConversation = useRef(false);
  const previousUpdatePhase = useRef(updateState.phase);
  const notifiedPermissionIds = useRef(new Set<string>());
  const cliCommandNoticeTimer = useRef<number | undefined>(undefined);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const activeConversation = useMemo(
    () => activeProject?.conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeProject, activeConversationId],
  );
  const activeRunId = activeConversationId ? activeRuns[activeConversationId] : undefined;
  const activeResponseRunning = Boolean(activeConversation?.messages.some((message) => message.role === "assistant" && message.status === "running"));
  const activeProcessRunning = Boolean(activeRunId) || activeResponseRunning;
  const pendingPermission = permissionQueue[0];
  const pendingQuestion = questionQueue[0];

  useEffect(() => {
    let canceled = false;
    void Promise.all([
      window.claudeDesk.getProjectStore(),
      window.claudeDesk.getAppSelection().catch(() => null),
    ]).then(async ([stored, savedSelection]) => {
      if (canceled) return;
      const storedProjects = parseProjects(stored);
      let loaded = preferLegacyProjects || stored === null || (storedProjects.length === 0 && initialProjects.length > 0)
        ? initialProjects
        : storedProjects;
      if (loaded.length === 0 && stored === null && !preferLegacyProjects) {
        const workspaces = await window.claudeDesk.discoverProjects().catch(() => []);
        loaded = workspaces.map((workspace) => {
          const conversation = createConversation();
          return {
            id: makeId(),
            name: pathName(workspace),
            workspace,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            conversations: [conversation],
          };
        });
      }
      if (canceled) return;
      const selection = resolveSelection(loaded, savedSelection);
      setProjects(loaded);
      setSelectedProjectId(selection.projectId);
      setActiveConversationId(selection.conversationId);
      setStorageReady(true);
      if (stored === null) window.claudeDesk.saveProjectStore(loaded);
    }).catch(() => {
      if (!canceled) setStorageReady(true);
    });
    return () => { canceled = true; };
  }, [initialProjects, preferLegacyProjects]);

  useEffect(() => {
    if (!storageReady) return;
    window.claudeDesk.saveAppSelection({ projectId: selectedProjectId, conversationId: activeConversationId });
  }, [activeConversationId, selectedProjectId, storageReady]);

  useEffect(() => {
    projectsRef.current = projects;
    if (!storageReady) return;
    const timer = window.setTimeout(() => {
      try {
        saveProjects(projects);
        window.claudeDesk.saveProjectStore(projects);
      } catch (error) {
        console.error("保存项目失败", error);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [projects, storageReady]);

  useEffect(() => {
    const persistNow = () => {
      try {
        saveProjects(projectsRef.current);
        window.claudeDesk.saveProjectStore(projectsRef.current);
      } catch (error) {
        console.error("保存项目失败", error);
      }
    };
    window.addEventListener("beforeunload", persistNow);
    return () => window.removeEventListener("beforeunload", persistNow);
  }, []);

  useEffect(() => {
    void window.claudeDesk.getClaudeInfo().then(setCliInfo).catch(() => setCliInfo({ available: false }));
    void window.claudeDesk.getAppVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

  useEffect(() => {
    let canceled = false;
    void window.claudeDesk.getUpdateState()
      .then((state) => {
        if (!canceled) setUpdateState(state);
      })
      .catch(() => undefined);
    const removeListener = window.claudeDesk.onUpdateState((state) => {
      if (!canceled) setUpdateState(state);
    });
    return () => {
      canceled = true;
      removeListener();
    };
  }, []);

  useEffect(() => {
    if (updateState.phase === "ready" && previousUpdatePhase.current !== "ready") {
      setDismissedUpdateVersion(null);
      setUpdateActionError("");
    }
    previousUpdatePhase.current = updateState.phase;
  }, [updateState.phase]);

  useEffect(() => {
    let canceled = false;
    void window.claudeDesk.getAppSettings()
      .then((settings) => {
        if (canceled) return;
        appSettingsRef.current = settings;
        setAppSettings(settings);
        setDismissedUpdateVersion(settings.ignoredUpdateVersion ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!canceled) setAppSettingsLoaded(true);
      });
    return () => { canceled = true; };
  }, []);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  useEffect(() => window.claudeDesk.onNavigateToConversation((conversationId) => {
    const project = projectsRef.current.find((item) => item.conversations.some((conversation) => conversation.id === conversationId));
    if (!project) return;
    setSelectedProjectId(project.id);
    setActiveConversationId(conversationId);
    setCompletionNotice(null);
  }), []);

  useEffect(() => {
    if (!completionNotice) return;
    const timer = window.setTimeout(() => setCompletionNotice((current) => (
      current?.conversationId === completionNotice.conversationId ? null : current
    )), 8_000);
    return () => window.clearTimeout(timer);
  }, [completionNotice]);

  useEffect(() => () => window.clearTimeout(cliCommandNoticeTimer.current), []);

  useEffect(() => {
    if (!pendingPermission) return;
    let notificationTimer: number | undefined;
    const notifyIfBackground = () => {
      if (
        notifiedPermissionIds.current.has(pendingPermission.responseId) ||
        (document.visibilityState === "visible" && document.hasFocus())
      ) return;
      window.clearTimeout(notificationTimer);
      notificationTimer = window.setTimeout(() => {
        if (
          notifiedPermissionIds.current.has(pendingPermission.responseId) ||
          (document.visibilityState === "visible" && document.hasFocus())
        ) return;
        const conversation = projectsRef.current
          .flatMap((project) => project.conversations)
          .find((item) => item.id === pendingPermission.conversationId);
        if (!conversation) return;
        const request: PermissionNotificationRequest = {
          requestId: pendingPermission.responseId,
          conversationId: pendingPermission.conversationId,
          title: conversation.title,
          tools: [...new Set(pendingPermission.requests.map((item) => item.toolName))],
        };
        notifiedPermissionIds.current.add(pendingPermission.responseId);
        void window.claudeDesk.notifyPermission(request).catch(() => false);
      }, 100);
    };
    notifyIfBackground();
    window.addEventListener("blur", notifyIfBackground);
    document.addEventListener("visibilitychange", notifyIfBackground);
    return () => {
      window.clearTimeout(notificationTimer);
      window.removeEventListener("blur", notifyIfBackground);
      document.removeEventListener("visibilitychange", notifyIfBackground);
    };
  }, [pendingPermission]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const resize = () => setSidebarWidth((current) => clampSidebarWidth(current));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const syncProjectSessions = useCallback(async (projectId: string, reloadMessages: boolean) => {
    const project = projectsRef.current.find((item) => item.id === projectId);
    if (!project) return;

    const localSessionIds = project.conversations.flatMap((conversation) => (
      conversation.source !== "claude" && conversation.sessionId ? [conversation.sessionId] : []
    ));
    await Promise.all(localSessionIds.map((sessionId) => (
      window.claudeDesk.normalizeClaudeSession(project.workspace, sessionId).catch(() => false)
    )));

    const sessions = await window.claudeDesk.getClaudeSessions(project.workspace);
    const sessionById = new Map(sessions.map((session) => [session.sessionId, session] as const));
    const histories = new Map<string, ClaudeSessionHistory>();
    if (reloadMessages) {
      const runningConversationIds = new Set([...runMeta.current.values()].map((meta) => meta.conversationId));
      const runningSessionIds = new Set(project.conversations.flatMap((conversation) => (
        conversation.sessionId && runningConversationIds.has(conversation.id) ? [conversation.sessionId] : []
      )));
      const loadedHistories = await window.claudeDesk.getClaudeSessionHistories(project.workspace);
      for (const history of loadedHistories) {
        if (!runningSessionIds.has(history.sessionId)) histories.set(history.sessionId, history);
      }
    }

    setProjects((current) => current.map((item) => {
      if (item.id !== projectId) return item;
      const refreshed = item.conversations.map((conversation) => {
        const session = conversation.sessionId ? sessionById.get(conversation.sessionId) : undefined;
        const history = conversation.sessionId ? histories.get(conversation.sessionId) : undefined;
        if (!session) return conversation;
        return {
          ...conversation,
          title: session.customTitle ?? conversation.title,
          messages: history?.messages ?? conversation.messages,
          updatedAt: Math.max(conversation.updatedAt, session.updatedAt),
          gitBranch: session.gitBranch ?? conversation.gitBranch,
          resolvedModel: session.resolvedModel ?? conversation.resolvedModel,
          permissionMode: history?.permissionMode ?? conversation.permissionMode,
          historyLoaded: conversation.source === "claude" && history ? true : conversation.historyLoaded,
        };
      });
      const knownSessionIds = new Set(refreshed.flatMap((conversation) => conversation.sessionId ? [conversation.sessionId] : []));
      const additions = sessions
        .filter((session) => !knownSessionIds.has(session.sessionId))
        .map(importedConversation);
      return {
        ...item,
        updatedAt: sessions.length > 0
          ? Math.max(item.updatedAt, ...sessions.map((session) => session.updatedAt))
          : item.updatedAt,
        conversations: insertUnpinnedFirst(
          refreshed,
          additions.sort((a, b) => b.updatedAt - a.updatedAt),
        ),
      };
    }));
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    for (const project of projects) {
      if (scannedProjects.current.has(project.id)) continue;
      scannedProjects.current.add(project.id);
      void syncProjectSessions(project.id, false).catch(() => {
        // A missing or unreadable Claude history directory simply has no sessions to merge.
      });
    }
  }, [projects, storageReady, syncProjectSessions]);

  useEffect(() => {
    if (!activeProject) {
      setModelConfig({ options: [] });
      return;
    }
    let canceled = false;
    void window.claudeDesk.getModels(activeProject.workspace)
      .then((config) => { if (!canceled) setModelConfig(config); })
      .catch(() => { if (!canceled) setModelConfig({ options: [] }); });
    return () => { canceled = true; };
  }, [activeProject?.id, activeProject?.workspace]);

  const updateConversation = useCallback((conversationId: string, updater: (value: Conversation) => Conversation) => {
    setProjects((current) => current.map((project) => {
      if (!project.conversations.some((item) => item.id === conversationId)) return project;
      return {
        ...project,
        updatedAt: Date.now(),
        conversations: project.conversations.map((item) => item.id === conversationId ? updater(item) : item),
      };
    }));
  }, []);

  const updateResponse = useCallback((meta: RunMeta, updater: (message: ChatMessage) => ChatMessage) => {
    updateConversation(meta.conversationId, (conversation) => ({
      ...conversation,
      updatedAt: Date.now(),
      messages: conversation.messages.map((message) => message.id === meta.responseId ? updater(message) : message),
    }));
  }, [updateConversation]);

  const notifyConversationCompleted = useCallback((conversationId: string) => {
    if (!appSettingsRef.current.notifyOnCompletion) return;
    const conversation = projectsRef.current
      .flatMap((project) => project.conversations)
      .find((item) => item.id === conversationId);
    if (!conversation) return;
    if (document.visibilityState === "visible" && document.hasFocus()) {
      if (activeConversationIdRef.current !== conversationId) {
        setCompletionNotice({ conversationId, title: conversation.title });
      }
      return;
    }
    void window.claudeDesk.notifyCompletion(conversationId, conversation.title).catch(() => false);
  }, []);

  const changeAppSettings = (settings: AppSettings, onFailure?: (previous: AppSettings) => void) => {
    const previous = appSettingsRef.current;
    appSettingsRef.current = settings;
    setAppSettings(settings);
    void window.claudeDesk.setAppSettings(settings)
      .then((saved) => {
        appSettingsRef.current = saved;
        setAppSettings(saved);
      })
      .catch(() => {
        appSettingsRef.current = previous;
        setAppSettings(previous);
        onFailure?.(previous);
        window.alert("无法保存设置");
      });
  };

  const ignoreUpdateVersion = () => {
    const version = updateState.latestVersion;
    if (!version) return;
    setDismissedUpdateVersion(version);
    setUpdateActionError("");
    changeAppSettings(
      { ...appSettingsRef.current, ignoredUpdateVersion: version },
      (previous) => setDismissedUpdateVersion(previous.ignoredUpdateVersion ?? null),
    );
  };

  const checkForUpdates = () => {
    setUpdateActionError("");
    if (
      updateState.phase === "available" ||
      updateState.phase === "downloading" ||
      updateState.phase === "ready" ||
      (updateState.phase === "error" && updateState.errorContext === "download")
    ) {
      setDismissedUpdateVersion(null);
      return;
    }
    void window.claudeDesk.checkAppUpdate()
      .then((state) => {
        setUpdateState(state);
        if (state.phase === "available") setDismissedUpdateVersion(null);
      })
      .catch((error) => {
        setUpdateState((current) => ({
          ...current,
          phase: "error",
          error: error instanceof Error ? error.message : "检查更新失败",
          errorContext: "check",
        }));
      });
  };

  const downloadUpdate = () => {
    setUpdateActionError("");
    void window.claudeDesk.downloadAppUpdate()
      .then(setUpdateState)
      .catch((error) => setUpdateActionError(error instanceof Error ? error.message : "下载更新失败"));
  };

  const installUpdate = () => {
    setUpdateActionError("");
    void window.claudeDesk.installAppUpdate()
      .then((result) => {
        if (result.started) setDismissedUpdateVersion(updateState.latestVersion ?? null);
        else setUpdateActionError(result.error ?? "无法启动更新");
      })
      .catch((error) => setUpdateActionError(error instanceof Error ? error.message : "无法启动更新"));
  };

  const openUpdateRelease = () => {
    void window.claudeDesk.openUpdateRelease().catch((error) => {
      setUpdateActionError(error instanceof Error ? error.message : "无法打开发布页面");
    });
  };

  useEffect(() => {
    if (
      !activeProject ||
      !activeConversation ||
      activeConversation.source !== "claude" ||
      activeConversation.historyLoaded ||
      !activeConversation.sessionId ||
      loadingHistories.current.has(activeConversation.id)
    ) return;
    loadingHistories.current.add(activeConversation.id);
    const conversationId = activeConversation.id;
    void window.claudeDesk.getClaudeSession(activeProject.workspace, activeConversation.sessionId)
      .then((history) => {
        updateConversation(conversationId, (conversation) => history
          ? {
            ...conversation,
            messages: history.messages,
            resolvedModel: history.resolvedModel ?? conversation.resolvedModel,
            permissionMode: history.permissionMode,
            contextUsage: history.contextUsage,
            contextCompactions: history.contextCompactions ?? conversation.contextCompactions,
            updatedAt: Math.max(conversation.updatedAt, history.updatedAt),
            historyLoaded: true,
          }
          : {
            ...conversation,
            historyLoaded: true,
            messages: [{
              id: makeId(),
              role: "assistant",
              content: "",
              createdAt: Date.now(),
              status: "error",
              error: "无法读取这条 Claude CLI 历史记录。",
            }],
          });
      })
      .catch((error) => {
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          historyLoaded: true,
          messages: [{
            id: makeId(),
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            status: "error",
            error: error instanceof Error ? error.message : "无法读取这条 Claude CLI 历史记录。",
          }],
        }));
      })
      .finally(() => loadingHistories.current.delete(conversationId));
  }, [activeConversation, activeProject, updateConversation]);

  const flushPendingText = useCallback((meta: RunMeta) => {
    if (meta.flushTimer !== undefined) {
      window.clearTimeout(meta.flushTimer);
      meta.flushTimer = undefined;
    }
    if (!meta.pendingText && !meta.pendingThinking) return;
    const text = meta.pendingText;
    const thinking = meta.pendingThinking;
    meta.pendingText = "";
    meta.pendingThinking = "";
    const textBlockId = text ? meta.activeTextBlockId ?? (meta.activeTextBlockId = makeId()) : undefined;
    updateResponse(meta, (message) => {
      const withText = text && textBlockId
        ? appendTimelineText(message, textBlockId, text)
        : message;
      return {
        ...withText,
        thinking: `${withText.thinking ?? ""}${thinking}` || undefined,
      };
    });
  }, [updateResponse]);

  useEffect(() => window.claudeDesk.onEvent((event: ClaudeEvent) => {
    const meta = runMeta.current.get(event.runId);
    if (!meta) {
      if (event.type === "exit") {
        for (const [conversationId, processRunId] of processRunIds.current) {
          if (processRunId !== event.runId) continue;
          processRunIds.current.delete(conversationId);
          setActiveRuns((current) => {
            const next = { ...current };
            delete next[conversationId];
            return next;
          });
        }
      }
      return;
    }

    if (event.type === "control_request" && event.data) {
      const control = getControlRequest(event.data);
      if (control) {
        const questions = getUserQuestions(control.input);
        if (control.toolName === "AskUserQuestion" && questions) {
          setQuestionQueue((current) => current.some((item) => item.requestId === control.requestId)
            ? current
            : [...current, {
              conversationId: meta.conversationId,
              runId: event.runId,
              requestId: control.requestId,
              input: control.input,
              questions,
            }]);
        } else {
          const toolInput = control.input;
          let summary = summarizeToolInput(toolInput);
          if (!summary) {
            try { summary = shorten(JSON.stringify(toolInput), 120); } catch { summary = ""; }
          }
          setPermissionQueue((current) => current.some((item) => item.requestId === control.requestId)
            ? current
            : [...current, {
              conversationId: meta.conversationId,
              responseId: control.requestId,
              requests: [{ requestId: control.requestId, toolName: control.toolName, toolUseId: control.toolUseId, toolInput, summary }],
              runId: event.runId,
              requestId: control.requestId,
              input: toolInput,
              permissionSuggestions: control.permissionSuggestions,
              direct: true,
            }]);
        }
      }
      return;
    }

    if (event.type === "message" && event.data) {
      const data = event.data;
      if (data.type === "system" && typeof data.session_id === "string") {
        const descriptions = data.slash_command_descriptions && typeof data.slash_command_descriptions === "object"
          ? data.slash_command_descriptions as Record<string, unknown>
          : {};
        const slashCommands = Array.isArray(data.slash_commands)
          ? normalizeSlashCommands(data.slash_commands.map((command) => {
            const name = typeof command === "string" ? `/${command.replace(/^\//, "")}` : "";
            const description = typeof descriptions[name.toLowerCase()] === "string"
              ? descriptions[name.toLowerCase()] as string
              : describeSlashCommand(name);
            return { name, description };
          }))
          : undefined;
        updateConversation(meta.conversationId, (conversation) => ({
          ...conversation,
          sessionId: data.session_id as string,
          gitBranch: typeof data.git_branch === "string" ? data.git_branch : conversation.gitBranch,
          resolvedModel: typeof data.model === "string" ? data.model : conversation.resolvedModel,
          slashCommands: slashCommands ?? conversation.slashCommands,
        }));
      }

      const contextUsage = getContextUsage(data);
      if (contextUsage) {
        updateConversation(meta.conversationId, (conversation) => ({
          ...conversation,
          contextUsage: { ...conversation.contextUsage, ...contextUsage },
        }));
      }
      const compactBoundary = getCompactBoundary(data);
      const compactSummary = getCompactSummary(data);
      if (compactBoundary) {
        updateConversation(meta.conversationId, (conversation) => ({
          ...conversation,
          contextUsage: {
            ...conversation.contextUsage,
            usedTokens: compactBoundary.postTokens ?? conversation.contextUsage?.usedTokens,
          },
          contextCompactions: [...(conversation.contextCompactions ?? []).filter((item) => item.status !== "running"), compactBoundary].slice(-20),
        }));
      } else if (compactSummary) {
        updateConversation(meta.conversationId, (conversation) => {
          const compactions = conversation.contextCompactions ?? [];
          const index = compactions.findIndex((item) => item.status === "done" && !item.summary);
          if (index < 0) return conversation;
          return {
            ...conversation,
            contextCompactions: compactions.map((item, itemIndex) => itemIndex === index ? { ...item, summary: compactSummary } : item),
          };
        });
      } else {
        const compactState = getCompactionState(data);
        if (compactState) {
          updateConversation(meta.conversationId, (conversation) => {
            const compactions = conversation.contextCompactions ?? [];
            const runningIndex = compactions.findIndex((item) => item.status === "running");
            if (compactState === "running" && runningIndex < 0) {
              const runningCompaction: ContextCompaction = { id: makeId(), trigger: "unknown", status: "running", startedAt: Date.now() };
              return {
                ...conversation,
                contextCompactions: [...compactions, runningCompaction].slice(-20),
              };
            }
            if (runningIndex < 0) return conversation;
            return {
              ...conversation,
              contextCompactions: compactions.map((item, index) => index === runningIndex
                ? { ...item, status: compactState, completedAt: compactState === "running" ? undefined : Date.now(), error: compactState === "error" ? "上下文压缩失败" : undefined }
                : item),
            };
          });
        }
      }

      const blockStart = getStreamBlockStart(data);
      if (blockStart?.type === "text" || blockStart?.type === "thinking") {
        flushPendingText(meta);
        if (blockStart.type === "text") meta.activeTextBlockId = makeId();
        updateResponse(meta, (message) => ({ ...message, activeActivityId: undefined }));
      }
      if (blockStart?.type === "tool_use" && typeof blockStart.name === "string") {
        flushPendingText(meta);
        const detail = getActivityDetail(blockStart.name, blockStart.input);
        const activity: Activity = {
          id: typeof blockStart.id === "string" ? blockStart.id : makeId(),
          name: blockStart.name,
          summary: summarizeToolInput(blockStart.input),
          ...(detail ? { detail } : {}),
        };
        updateResponse(meta, (message) => ({ ...upsertTimelineActivity(message, activity), activeActivityId: activity.id }));
        meta.activeTextBlockId = undefined;
      }

      const delta = getTextDelta(data);
      if (delta) {
        if (!meta.receivedText) updateResponse(meta, (message) => ({ ...message, activeActivityId: undefined }));
        if (!meta.activeTextBlockId) meta.activeTextBlockId = makeId();
        meta.receivedText = true;
        meta.pendingText += delta;
        if (meta.flushTimer === undefined) meta.flushTimer = window.setTimeout(() => flushPendingText(meta), 50);
      }

      const thinkingDelta = getThinkingDelta(data);
      if (thinkingDelta) {
        if (!meta.receivedThinking) updateResponse(meta, (message) => ({ ...message, activeActivityId: undefined }));
        if (meta.appendToResponse && !meta.receivedThinking) meta.pendingThinking += "\n\n";
        meta.receivedThinking = true;
        meta.pendingThinking += thinkingDelta;
        if (meta.flushTimer === undefined) meta.flushTimer = window.setTimeout(() => flushPendingText(meta), 50);
      }

      if (data.type === "assistant") {
        flushPendingText(meta);
        const receivedText = meta.receivedText;
        const receivedThinking = meta.receivedThinking;
        updateResponse(meta, (message) => {
          let next = message;
          for (const block of getAssistantContent(data)) {
            if (block.type === "text" && typeof block.text === "string") {
              next = { ...next, activeActivityId: undefined };
              if (!receivedText) next = appendTimelineText(next, makeId(), block.text);
            }
            if (block.type === "thinking" && typeof block.thinking === "string") {
              next = { ...next, activeActivityId: undefined };
              if (!receivedThinking) next = { ...next, thinking: appendResponseContent(next.thinking, block.thinking) };
            }
            if (block.type === "tool_use" && typeof block.name === "string") {
              const activityId = typeof block.id === "string" ? block.id : makeId();
              const detail = getActivityDetail(block.name, block.input);
              next = upsertTimelineActivity(next, {
                id: activityId,
                name: block.name,
                summary: summarizeToolInput(block.input),
                ...(detail ? { detail } : {}),
              });
              next = { ...next, activeActivityId: activityId };
            }
          }
          return next;
        });
        meta.receivedText = false;
        meta.receivedThinking = false;
        meta.activeTextBlockId = undefined;
      }

      const activityResults = getActivityResults(data);
      if (activityResults.length > 0) {
        updateResponse(meta, (message) => activityResults.reduce(applyActivityResult, message));
      }

      if (data.type === "result") {
        flushPendingText(meta);
        meta.completed = true;
        const nextMeta = [...runMeta.current.values()].find((item) => item !== meta && item.conversationId === meta.conversationId && !item.completed);
        const hasPendingTurn = Boolean(nextMeta);
        const permissionRequests = getPermissionRequests(data);
        const isError = data.is_error === true;
        meta.successful = !isError && permissionRequests.length === 0;
        const resultText = typeof data.result === "string" ? data.result : "";
        const resultBlockId = makeId();
        updateResponse(meta, (message) => ({
          ...(message.content || !resultText ? message : appendTimelineText(message, resultBlockId, resultText)),
          activeActivityId: undefined,
          status: permissionRequests.length > 0 ? "stopped" : (isError ? "error" : (hasPendingTurn ? "running" : "done")),
          error: isError ? resultText || "Claude 未能完成这次任务" : undefined,
          ...(!hasPendingTurn || isError || permissionRequests.length > 0 ? finishResponse(message) : {}),
        }));
        if (permissionRequests.length > 0) {
          setPermissionQueue((current) => current.some((item) => item.responseId === meta.responseId)
            ? current
            : [...current, {
              conversationId: meta.conversationId,
              responseId: meta.responseId,
              sessionId: typeof data.session_id === "string" ? data.session_id : undefined,
              requests: permissionRequests,
            }]);
        }
        runMeta.current.delete(event.runId);
        if (!hasPendingTurn) {
          if (processRunIds.current.get(meta.conversationId) === meta.processRunId) processRunIds.current.delete(meta.conversationId);
          setActiveRuns((current) => {
            const next = { ...current };
            if (next[meta.conversationId] === meta.processRunId) delete next[meta.conversationId];
            return next;
          });
        }
        if (meta.successful && !hasPendingTurn) notifyConversationCompleted(meta.conversationId);
      }
    }

    if (event.type === "raw" && event.text) {
      if (!meta.activeTextBlockId) meta.activeTextBlockId = makeId();
      meta.pendingText += event.text + "\n";
      if (meta.flushTimer === undefined) meta.flushTimer = window.setTimeout(() => flushPendingText(meta), 50);
    }
    if (event.type === "error") {
      setQuestionQueue((current) => current.filter((item) => item.runId !== event.runId));
      setPermissionQueue((current) => current.filter((item) => item.runId !== event.runId));
      flushPendingText(meta);
      meta.completed = true;
      meta.successful = false;
      updateResponse(meta, (message) => ({ ...message, status: "error", activeActivityId: undefined, error: event.message ?? "无法启动 Claude CLI", ...finishResponse(message) }));
      if (processRunIds.current.get(meta.conversationId) === meta.processRunId) processRunIds.current.delete(meta.conversationId);
      setActiveRuns((current) => {
        const next = { ...current };
        if (next[meta.conversationId] === meta.processRunId) delete next[meta.conversationId];
        return next;
      });
    }
    if (event.type === "exit") {
      setQuestionQueue((current) => current.filter((item) => item.runId !== event.runId));
      setPermissionQueue((current) => current.filter((item) => item.runId !== event.runId));
      flushPendingText(meta);
      if (!meta.completed) {
        const detail = event.stderr || (event.code === 0 ? "Claude 已结束，但没有返回结果" : `Claude CLI 退出，代码 ${event.code ?? "未知"}`);
        updateResponse(meta, (message) => ({ ...message, status: "error", activeActivityId: undefined, error: detail, ...finishResponse(message) }));
      }
      setActiveRuns((current) => {
        const next = { ...current };
        if (next[meta.conversationId] === meta.processRunId) delete next[meta.conversationId];
        return next;
      });
      if (meta.successful) notifyConversationCompleted(meta.conversationId);
      runMeta.current.delete(event.runId);
      if (processRunIds.current.get(meta.conversationId) === meta.processRunId) processRunIds.current.delete(meta.conversationId);
    }
  }), [flushPendingText, notifyConversationCompleted, updateConversation, updateResponse]);

  const addConversation = (projectId: string) => {
    const conversation = createConversation();
    setProjects((current) => current.map((project) => project.id === projectId
      ? { ...project, updatedAt: Date.now(), conversations: insertUnpinnedFirst(project.conversations, conversation) }
      : project));
    setSelectedProjectId(projectId);
    setActiveConversationId(conversation.id);
    setComposerFocusRequest((request) => request + 1);
  };

  const selectConversation = (conversationId: string) => {
    const project = projects.find((item) => item.conversations.some((conversation) => conversation.id === conversationId));
    if (!project) return;
    setSelectedProjectId(project.id);
    setActiveConversationId(conversationId);
    setComposerFocusRequest((request) => request + 1);
  };

  const addProject = async () => {
    const workspace = await window.claudeDesk.selectWorkspace();
    if (!workspace) return;
    const key = workspace.replace(/[\\/]+$/, "").toLocaleLowerCase();
    const existing = projects.find((project) => project.workspace.replace(/[\\/]+$/, "").toLocaleLowerCase() === key);
    if (existing) {
      addConversation(existing.id);
      return;
    }
    const conversation = createConversation();
    const now = Date.now();
    const project: Project = {
      id: makeId(),
      name: pathName(workspace),
      workspace,
      createdAt: now,
      updatedAt: now,
      conversations: [conversation],
    };
    setProjects((current) => insertUnpinnedFirst(current, project));
    setSelectedProjectId(project.id);
    setActiveConversationId(conversation.id);
    setComposerFocusRequest((request) => request + 1);
  };

  const openProject = async (workspace: string) => {
    try {
      const result = await window.claudeDesk.openWorkspace(workspace);
      if (!result.opened) window.alert(result.error ?? "无法打开项目目录");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "无法打开项目目录");
    }
  };

  const refreshProject = async (projectId: string) => {
    try {
      await syncProjectSessions(projectId, true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "刷新 Claude CLI 会话失败");
    }
  };

  const deleteConversation = (projectId: string, conversationId: string) => {
    if (activeRuns[conversationId]) return;
    const project = projects.find((item) => item.id === projectId);
    const deleted = project?.conversations.find((conversation) => conversation.id === conversationId);
    if (!project || !deleted) return;
    setDeletionError("");
    setPendingDeletion({
      kind: "conversation",
      projectId,
      conversationId,
      title: deleted.title,
      hasSession: Boolean(deleted.sessionId),
    });
  };

  const deleteProject = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || project.conversations.some((item) => activeRuns[item.id])) return;
    setDeletionError("");
    setPendingDeletion({ kind: "project", projectId, title: project.customName ?? project.name });
  };

  const cancelDeletion = useCallback(() => {
    if (deletionBusy) return;
    setPendingDeletion(null);
    setDeletionError("");
    setComposerFocusRequest((request) => request + 1);
  }, [deletionBusy]);

  const confirmDeletion = async () => {
    const deletion = pendingDeletion;
    if (!deletion || deletionBusy) return;
    setDeletionBusy(true);
    setDeletionError("");
    try {
      if (deletion.kind === "conversation") {
        const project = projects.find((item) => item.id === deletion.projectId);
        const deleted = project?.conversations.find((conversation) => conversation.id === deletion.conversationId);
        if (!project || !deleted) {
          setPendingDeletion(null);
          return;
        }
        if (deleted.sessionId) {
          const result = await window.claudeDesk.deleteClaudeSession(project.workspace, deleted.sessionId);
          if (!result.deleted) throw new Error(result.error ?? "无法删除 Claude CLI 会话");
        }
        setProjects((current) => current.map((item) => item.id === deletion.projectId
          ? {
            ...item,
            conversations: item.conversations.filter((conversation) => conversation.id !== deletion.conversationId),
          }
          : item));
        setPermissionQueue((current) => current.filter((item) => item.conversationId !== deletion.conversationId));
        setPromptQueues((current) => {
          if (!current[deletion.conversationId]) return current;
          const next = { ...current };
          delete next[deletion.conversationId];
          return next;
        });
        if (activeConversationId === deletion.conversationId) {
          setSelectedProjectId(deletion.projectId);
          setActiveConversationId(null);
        }
      } else {
        const project = projects.find((item) => item.id === deletion.projectId);
        if (!project) {
          setPendingDeletion(null);
          return;
        }
        const remaining = projects.filter((item) => item.id !== deletion.projectId);
        setProjects(remaining);
        const removedConversationIds = new Set(project.conversations.map((conversation) => conversation.id));
        setPromptQueues((current) => Object.fromEntries(
          Object.entries(current).filter(([conversationId]) => !removedConversationIds.has(conversationId)),
        ));
        if (selectedProjectId === deletion.projectId) {
          const fallback = resolveSelection(remaining, null);
          setSelectedProjectId(fallback.projectId);
          setActiveConversationId(fallback.conversationId);
        }
      }
      setPendingDeletion(null);
      await window.claudeDesk.focusWindow().catch(() => false);
      setComposerFocusRequest((request) => request + 1);
    } catch (error) {
      setDeletionError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeletionBusy(false);
    }
  };

  const renameProject = (projectId: string, name: string) => {
    const trimmed = name.trim();
    setProjects((current) => current.map((project) => project.id === projectId
      ? {
        ...project,
        customName: trimmed && trimmed !== project.name ? trimmed : undefined,
        updatedAt: Date.now(),
      }
      : project));
  };

  const renameConversation = async (conversationId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 100 || [...runMeta.current.values()].some((meta) => meta.conversationId === conversationId && !meta.completed)) return;
    const project = projects.find((item) => item.conversations.some((conversation) => conversation.id === conversationId));
    const conversation = project?.conversations.find((item) => item.id === conversationId);
    if (!project || !conversation) return;
    if (conversation.sessionId) {
      try {
        const result = await window.claudeDesk.renameClaudeSession(project.workspace, conversation.sessionId, trimmed);
        if (!result.renamed) {
          window.alert(result.error ?? "无法同步 Claude CLI 会话名称");
          return;
        }
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "无法同步 Claude CLI 会话名称");
        return;
      }
    }
    updateConversation(conversationId, (conversation) => ({ ...conversation, title: trimmed, updatedAt: Date.now() }));
  };

  const reorderProject = (sourceId: string, targetId: string, position: ReorderPosition) => {
    setProjects((current) => reorderListItem(current, sourceId, targetId, position));
  };

  const reorderConversation = (
    projectId: string,
    sourceId: string,
    targetId: string,
    position: ReorderPosition,
  ) => {
    setProjects((current) => current.map((project) => project.id === projectId
      ? { ...project, conversations: reorderListItem(project.conversations, sourceId, targetId, position) }
      : project));
  };

  const toggleProjectPinned = (projectId: string) => {
    setProjects((current) => toggleListItemPinned(current, projectId));
  };

  const toggleConversationPinned = (projectId: string, conversationId: string) => {
    setProjects((current) => current.map((project) => project.id === projectId
      ? { ...project, conversations: toggleListItemPinned(project.conversations, conversationId) }
      : project));
  };

  const branchConversation = async (userTurn: number) => {
    if (
      !activeProject ||
      !activeConversation?.sessionId ||
      activeResponseRunning ||
      branchingConversation.current ||
      (activeConversation.source === "claude" && !activeConversation.historyLoaded)
    ) return;
    const sourceConversation = activeConversation;
    const sourceProject = activeProject;
    const sourceSessionId = activeConversation.sessionId;
    const title = nextBranchTitle(sourceConversation.title, sourceProject.conversations);
    branchingConversation.current = true;
    setBranchingConversationId(sourceConversation.id);
    try {
      const result = await window.claudeDesk.branchClaudeSession(
        sourceProject.workspace,
        sourceSessionId,
        userTurn,
        title,
      );
      if (!result.branched || !result.session) {
        window.alert(result.error ?? "无法创建 Claude CLI 会话分支");
        return;
      }
      const session = result.session;
      const branch: Conversation = {
        id: `claude-${session.sessionId}`,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        sessionId: session.sessionId,
        gitBranch: session.gitBranch,
        messages: session.messages,
        selectedModel: sourceConversation.selectedModel,
        resolvedModel: session.resolvedModel ?? sourceConversation.resolvedModel,
        slashCommands: sourceConversation.slashCommands,
        allowedTools: sourceConversation.allowedTools,
        permissionMode: session.permissionMode,
        source: "claude",
        historyLoaded: true,
      };
      setProjects((current) => current.map((project) => project.id === sourceProject.id
        ? { ...project, updatedAt: Date.now(), conversations: insertUnpinnedFirst(project.conversations, branch) }
        : project));
      setSelectedProjectId(sourceProject.id);
      setActiveConversationId(branch.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "无法创建 Claude CLI 会话分支");
    } finally {
      branchingConversation.current = false;
      setBranchingConversationId(null);
    }
  };

  const startPrompt = useCallback(async (conversationId: string, prompt: string, attachments: Attachment[]) => {
    const project = projectsRef.current.find((item) => item.conversations.some((conversation) => conversation.id === conversationId));
    const conversation = project?.conversations.find((item) => item.id === conversationId);
    if (
      !project ||
      !conversation ||
      [...runMeta.current.values()].some((meta) => meta.conversationId === conversationId) ||
      (conversation.source === "claude" && !conversation.historyLoaded)
    ) return false;
    const runId = makeId();
    const responseId = makeId();
    const now = Date.now();
    const userMessage: ChatMessage = { id: makeId(), role: "user", content: prompt, attachments, createdAt: now };
    const response: ChatMessage = {
      id: responseId,
      role: "assistant",
      content: "",
      createdAt: now,
      responseStartedAt: now,
      status: "running",
      activities: [],
      timeline: [],
    };
    const firstPrompt = conversation.messages.length === 0;

    updateConversation(conversationId, (current) => ({
      ...current,
      title: firstPrompt && current.title === "新对话" ? shorten(prompt || attachments[0]?.name || "附件", 28) : current.title,
      updatedAt: now,
      messages: [...current.messages, userMessage, response],
    }));
    runMeta.current.set(runId, {
      conversationId,
      processRunId: runId,
      responseId,
      appendToResponse: false,
      completed: false,
      successful: false,
      receivedText: false,
      receivedThinking: false,
      pendingText: "",
      pendingThinking: "",
    });
    setActiveRuns((current) => ({ ...current, [conversationId]: runId }));
    processRunIds.current.set(conversationId, runId);

    const request: RunRequest = {
      runId,
      prompt,
      cwd: project.workspace,
      sessionId: conversation.sessionId,
      sessionName: conversation.sessionId
        ? undefined
        : (conversation.title !== "新对话"
          ? conversation.title.slice(0, 100)
          : makeClaudeSessionName((conversation.messages.find((message) => message.role === "user")?.content ?? prompt) || attachments[0]?.name || "附件")),
      model: getModelArgument(conversation, modelConfig),
      allowedTools: conversation.allowedTools,
      permissionMode: conversation.permissionMode,
      attachments,
    };
    try {
      await window.claudeDesk.startRun(request);
    } catch (error) {
      const meta = runMeta.current.get(runId);
      if (meta) updateResponse(meta, (message) => ({ ...message, status: "error", error: error instanceof Error ? error.message : "启动失败", ...finishResponse(message) }));
      setActiveRuns((current) => {
        const next = { ...current };
        if (next[conversationId] === runId) delete next[conversationId];
        return next;
      });
      runMeta.current.delete(runId);
      processRunIds.current.delete(conversationId);
      return false;
    }
    return true;
  }, [modelConfig, updateConversation, updateResponse]);

  const appendPrompt = useCallback(async (conversationId: string, prompt: string, attachments: Attachment[]) => {
    const runId = processRunIds.current.get(conversationId);
    if (!runId) return false;
    const turnRunId = makeId();
    const activeMeta = [...runMeta.current.values()].find((meta) => meta.conversationId === conversationId && !meta.completed);
    if (!activeMeta) return false;
    const userMessageId = makeId();
    const now = Date.now();
    updateConversation(conversationId, (conversation) => {
      const responseIndex = conversation.messages.findIndex((message) => message.id === activeMeta.responseId);
      const userMessage: ChatMessage = { id: userMessageId, role: "user", content: prompt, attachments, createdAt: now };
      if (responseIndex < 0) return { ...conversation, updatedAt: now, messages: [...conversation.messages, userMessage] };
      const response = conversation.messages[responseIndex];
      return {
        ...conversation,
        updatedAt: now,
        messages: [
          ...conversation.messages.slice(0, responseIndex),
          userMessage,
          response,
          ...conversation.messages.slice(responseIndex + 1),
        ],
      };
    });
    runMeta.current.set(turnRunId, {
      conversationId,
      processRunId: runId,
      responseId: activeMeta.responseId,
      userMessageId,
      appendToResponse: true,
      completed: false,
      successful: false,
      receivedText: false,
      receivedThinking: false,
      pendingText: "",
      pendingThinking: "",
    });
    setActiveRuns((current) => ({ ...current, [conversationId]: runId }));
    try {
      const result = await window.claudeDesk.appendRun({ runId, turnRunId, prompt, attachments });
      if (result.appended) return true;
    } catch {
      // The caller restores the message as a queued prompt below.
    }
    runMeta.current.delete(turnRunId);
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.filter((message) => message.id !== userMessageId),
    }));
    if (activeMeta.completed && ![...runMeta.current.values()].some((meta) => meta.conversationId === conversationId && !meta.completed)) {
      updateResponse(activeMeta, (message) => ({
        ...message,
        status: activeMeta.successful ? "done" : message.status,
        ...(activeMeta.successful ? finishResponse(message) : {}),
      }));
      setActiveRuns((current) => {
        const next = { ...current };
        if (next[conversationId] === runId) delete next[conversationId];
        return next;
      });
      processRunIds.current.delete(conversationId);
      if (activeMeta.successful) notifyConversationCompleted(conversationId);
    }
    return false;
  }, [notifyConversationCompleted, updateConversation, updateResponse]);

  const sendPrompt = (prompt: string, attachments: Attachment[]) => {
    if (!activeConversation || (activeConversation.source === "claude" && !activeConversation.historyLoaded)) return;
    const busy = [...runMeta.current.values()].some((meta) => meta.conversationId === activeConversation.id)
      || permissionQueue.some((permission) => permission.conversationId === activeConversation.id)
      || questionQueue.some((question) => question.conversationId === activeConversation.id);
    if (!busy) {
      void startPrompt(activeConversation.id, prompt, attachments);
      return;
    }
    queuePrompt(prompt, attachments);
  };

  const queuePrompt = (prompt: string, attachments: Attachment[]) => {
    if (!activeConversation) return;
    const queuedPrompt: QueuedPrompt = { id: makeId(), prompt, attachments };
    setPromptQueues((current) => ({ ...current, [activeConversation.id]: [...(current[activeConversation.id] ?? []), queuedPrompt] }));
  };

  const guideQueuedPrompt = (promptId: string) => {
    if (!activeConversation) return;
    const conversationId = activeConversation.id;
    const queuedPrompt = promptQueues[conversationId]?.find((item) => item.id === promptId);
    if (!queuedPrompt) return;
    setPromptQueues((current) => {
      const remaining = (current[conversationId] ?? []).filter((item) => item.id !== promptId);
      if (remaining.length === 0) {
        const next = { ...current };
        delete next[conversationId];
        return next;
      }
      return { ...current, [conversationId]: remaining };
    });
    void appendPrompt(conversationId, queuedPrompt.prompt, queuedPrompt.attachments).then((appended) => {
      if (appended) return;
      setPromptQueues((current) => ({ ...current, [conversationId]: [queuedPrompt, ...(current[conversationId] ?? [])] }));
    });
  };

  useEffect(() => {
    for (const [conversationId, queue] of Object.entries(promptQueues)) {
      if (
        queue.length === 0 ||
        activeRuns[conversationId] ||
        permissionQueue.some((permission) => permission.conversationId === conversationId) ||
        questionQueue.some((question) => question.conversationId === conversationId) ||
        [...runMeta.current.values()].some((meta) => meta.conversationId === conversationId)
      ) continue;
      const [nextPrompt, ...remaining] = queue;
      setPromptQueues((current) => {
        const latest = current[conversationId] ?? [];
        if (latest[0]?.id !== nextPrompt.id) return current;
        if (latest.length === 1) {
          const next = { ...current };
          delete next[conversationId];
          return next;
        }
        return { ...current, [conversationId]: remaining };
      });
      void startPrompt(conversationId, nextPrompt.prompt, nextPrompt.attachments);
    }
  }, [activeRuns, permissionQueue, promptQueues, questionQueue, startPrompt]);

  const reorderPromptQueue = (sourceId: string, targetId: string, position: ReorderPosition) => {
    if (!activeConversation) return;
    setPromptQueues((current) => ({
      ...current,
      [activeConversation.id]: reorderListItem(current[activeConversation.id] ?? [], sourceId, targetId, position),
    }));
  };

  const deleteQueuedPrompt = (promptId: string) => {
    if (!activeConversation) return;
    const conversationId = activeConversation.id;
    const removed = promptQueues[conversationId]?.find((prompt) => prompt.id === promptId);
    setPromptQueues((current) => {
      const remaining = (current[conversationId] ?? []).filter((prompt) => prompt.id !== promptId);
      if (remaining.length === 0) {
        const next = { ...current };
        delete next[conversationId];
        return next;
      }
      return { ...current, [conversationId]: remaining };
    });
    for (const attachment of removed?.attachments ?? []) void window.claudeDesk.deleteAttachment(attachment.storedName);
  };

  const editQueuedPrompt = (promptId: string) => {
    if (!activeConversation) return;
    const conversationId = activeConversation.id;
    const queue = promptQueues[conversationId] ?? [];
    const index = queue.findIndex((prompt) => prompt.id === promptId);
    if (index < 0) return;
    const queuedPrompt = queue[index];
    const currentDraft = composerDrafts[conversationId] ?? EMPTY_COMPOSER_DRAFT;
    const hasCurrentDraft = Boolean(currentDraft.prompt.trim() || currentDraft.attachments.length > 0);
    const replacement = hasCurrentDraft ? { id: makeId(), ...currentDraft } : null;
    const nextQueue = [...queue];
    if (replacement) nextQueue[index] = replacement;
    else nextQueue.splice(index, 1);
    setPromptQueues((current) => {
      if (nextQueue.length === 0) {
        const next = { ...current };
        delete next[conversationId];
        return next;
      }
      return { ...current, [conversationId]: nextQueue };
    });
    setComposerDrafts((current) => ({
      ...current,
      [conversationId]: { prompt: queuedPrompt.prompt, attachments: queuedPrompt.attachments },
    }));
    setComposerFocusRequest((request) => request + 1);
  };

  const editAndResend = async (messageId: string, content: string) => {
    if (!activeProject || !activeConversation || activeResponseRunning || (activeConversation.source === "claude" && !activeConversation.historyLoaded)) return;
    const index = activeConversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const target = activeConversation.messages[index];
    if (target.role !== "user") return;
    const isLastUserMessage = activeConversation.messages.slice(index + 1).every((message) => message.role !== "user");
    if (!isLastUserMessage) return;
    const attachments = target.attachments ?? [];
    setPermissionQueue((current) => current.filter((item) => item.conversationId !== activeConversation.id));
    setQuestionQueue((current) => current.filter((item) => item.conversationId !== activeConversation.id));
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      updatedAt: Date.now(),
      messages: conversation.messages.slice(0, index),
    }));
    processRunIds.current.delete(activeConversation.id);
    await startPrompt(activeConversation.id, content, attachments);
  };

  const resolvePermission = async (decision: "deny" | "once" | "conversation") => {
    if (!pendingPermission) return;
    if (!pendingPermission.direct && [...runMeta.current.values()].some((meta) => meta.conversationId === pendingPermission.conversationId && !meta.completed)) return;
    if (pendingPermission.direct && pendingPermission.runId && pendingPermission.requestId) {
      const project = projectsRef.current.find((item) => item.conversations.some((conversation) => conversation.id === pendingPermission.conversationId));
      const conversation = project?.conversations.find((item) => item.id === pendingPermission.conversationId);
      const names = [...new Set(pendingPermission.requests.map((request) => request.toolName))];
      if (decision === "conversation" && conversation) {
        const allowedTools = [...new Set([...(conversation.allowedTools ?? []), ...names])];
        const suggestedMode = pendingPermission.permissionSuggestions?.find((suggestion) => suggestion.type === "setMode" && suggestion.mode === "acceptEdits");
        updateConversation(conversation.id, (current) => ({
          ...current,
          allowedTools,
          ...(suggestedMode ? { permissionMode: "acceptEdits" as const } : {}),
          updatedAt: Date.now(),
        }));
      }
      const response = decision === "deny"
        ? { runId: pendingPermission.runId, requestId: pendingPermission.requestId, behavior: "deny" as const, message: `用户拒绝使用 ${names.join("、")}` }
        : {
          runId: pendingPermission.runId,
          requestId: pendingPermission.requestId,
          behavior: "allow" as const,
          updatedInput: pendingPermission.input,
          ...(decision === "conversation" && pendingPermission.permissionSuggestions?.length
            ? { updatedPermissions: pendingPermission.permissionSuggestions }
            : {}),
        };
      try {
        const result = await window.claudeDesk.respondControl(response);
        if (!result.responded) throw new Error("Claude CLI 没有接受这次授权");
        setPermissionQueue((current) => current.filter((item) => item.requestId !== pendingPermission.requestId));
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "无法回复 Claude 的权限请求");
      }
      return;
    }
    setPermissionQueue((current) => current.filter((item) => item.responseId !== pendingPermission.responseId));

    const names = [...new Set(pendingPermission.requests.map((request) => request.toolName))];
    if (decision === "deny") {
      const meta: RunMeta = {
        conversationId: pendingPermission.conversationId,
        processRunId: "",
        responseId: pendingPermission.responseId,
        appendToResponse: false,
        completed: true,
        successful: false,
        receivedText: false,
        receivedThinking: false,
        pendingText: "",
        pendingThinking: "",
      };
      updateResponse(meta, (message) => ({
        ...message,
        status: "stopped",
        error: `你已拒绝 Claude 使用 ${names.join("、")}，本次操作未继续。`,
      }));
      return;
    }

    const project = projectsRef.current.find((item) => item.conversations.some((conversation) => conversation.id === pendingPermission.conversationId));
    const conversation = project?.conversations.find((item) => item.id === pendingPermission.conversationId);
    if (!project || !conversation) return;

    const allowedTools = [...new Set([...(conversation.allowedTools ?? []), ...names])];
    if (decision === "conversation") {
      updateConversation(conversation.id, (current) => ({ ...current, allowedTools, updatedAt: Date.now() }));
    }

    const runId = makeId();
    const meta: RunMeta = {
      conversationId: conversation.id,
      processRunId: runId,
      responseId: pendingPermission.responseId,
      appendToResponse: true,
      completed: false,
      successful: false,
      receivedText: false,
      receivedThinking: false,
      pendingText: "",
      pendingThinking: "",
    };
    updateResponse(meta, (message) => ({
      ...message,
      responseStartedAt: message.responseStartedAt ?? Date.now(),
      responseDurationMs: undefined,
      status: "running",
      error: undefined,
    }));
    runMeta.current.set(runId, meta);
    setActiveRuns((current) => ({ ...current, [conversation.id]: runId }));

    const request: RunRequest = {
      runId,
      prompt: `用户已授权你使用 ${names.join("、")}。请继续完成刚才因权限不足而中断的请求，不要再次要求用户授权。`,
      cwd: project.workspace,
      sessionId: pendingPermission.sessionId ?? conversation.sessionId,
      model: getModelArgument(conversation, modelConfig),
      allowedTools,
      permissionMode: conversation.permissionMode,
    };
    try {
      await window.claudeDesk.startRun(request);
    } catch (error) {
      updateResponse(meta, (message) => ({
        ...message,
        status: "error",
        error: error instanceof Error ? error.message : "授权后继续运行失败",
      }));
      setActiveRuns((current) => {
        const next = { ...current };
        if (next[conversation.id] === runId) delete next[conversation.id];
        return next;
      });
      runMeta.current.delete(runId);
    }
  };

  const resolveQuestion = async (answers: Record<string, string>) => {
    if (!pendingQuestion || questionSubmitting) return;
    setQuestionSubmitting(true);
    try {
      const result = await window.claudeDesk.respondControl({
        runId: pendingQuestion.runId,
        requestId: pendingQuestion.requestId,
        behavior: "allow",
        updatedInput: { ...pendingQuestion.input, answers },
      });
      if (!result.responded) throw new Error("Claude CLI 没有接受这次回答");
      setQuestionQueue((current) => current.filter((item) => item.requestId !== pendingQuestion.requestId));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "无法提交回答");
    } finally {
      setQuestionSubmitting(false);
    }
  };

  const cancelQuestion = async () => {
    if (!pendingQuestion || questionSubmitting) return;
    setQuestionSubmitting(true);
    try {
      const result = await window.claudeDesk.respondControl({
        runId: pendingQuestion.runId,
        requestId: pendingQuestion.requestId,
        behavior: "cancelled",
      });
      if (!result.responded) throw new Error("Claude CLI 没有接受取消操作");
      setQuestionQueue((current) => current.filter((item) => item.requestId !== pendingQuestion.requestId));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "无法取消问题");
    } finally {
      setQuestionSubmitting(false);
    }
  };

  const stopRun = async () => {
    if (!activeConversation) return;
    const processRunId = processRunIds.current.get(activeConversation.id) ?? activeRunId;
    if (!processRunId) return;
    const metas = [...runMeta.current.values()].filter((item) => item.conversationId === activeConversation.id && !item.completed);
    if (metas.length > 0) {
      for (const meta of metas) meta.completed = true;
      updateResponse(metas[0], (message) => ({ ...message, status: "stopped", ...finishResponse(message) }));
    }
    try {
      const stopped = await window.claudeDesk.stopRun(processRunId);
      if (!stopped && metas.length > 0) {
        for (const meta of metas) meta.completed = false;
        updateResponse(metas[0], (message) => ({ ...message, status: "running", responseDurationMs: undefined, error: "暂时无法停止 Claude CLI。" }));
      }
    } catch (error) {
      if (metas.length > 0) {
        for (const meta of metas) meta.completed = false;
        updateResponse(metas[0], (message) => ({ ...message, status: "running", responseDurationMs: undefined, error: error instanceof Error ? error.message : "停止失败" }));
      }
    }
  };

  const runLocalCommand = (command: string) => {
    if (!activeProject || !activeConversation) return false;
    const name = command.split(/\s+/, 1)[0].toLowerCase();
    if (name === "/project") {
      void addProject();
      return true;
    }
    if (name === "/new") {
      addConversation(activeProject.id);
      return true;
    }
    if (name === "/clear") {
      setPermissionQueue((current) => current.filter((item) => item.conversationId !== activeConversation.id));
      setQuestionQueue((current) => current.filter((item) => item.conversationId !== activeConversation.id));
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        title: "新对话",
        sessionId: undefined,
        gitBranch: undefined,
        resolvedModel: undefined,
        allowedTools: [],
        source: undefined,
        historyLoaded: undefined,
        messages: [],
        updatedAt: Date.now(),
      }));
      return true;
    }
    if (name === "/plan" || name === "/edit") {
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        permissionMode: name === "/plan" ? "plan" : "acceptEdits",
        updatedAt: Date.now(),
      }));
      return true;
    }
    return false;
  };

  const changePermissionMode = (permissionMode: PermissionMode) => {
    if (!activeConversation) return;
    updateConversation(activeConversation.id, (conversation) => ({ ...conversation, permissionMode, updatedAt: Date.now() }));
    const runId = processRunIds.current.get(activeConversation.id) ?? activeRuns[activeConversation.id];
    if (runId) void window.claudeDesk.setPermissionMode({ runId, permissionMode }).catch(() => undefined);
  };

  const compactContext = () => {
    if (!activeConversation) return;
    sendPrompt("/compact", []);
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    sidebarResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-sidebar");
  };

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = sidebarResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setSidebarWidth(clampSidebarWidth(resize.startWidth + event.clientX - resize.startX));
  };

  const stopSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResize.current?.pointerId !== event.pointerId) return;
    sidebarResize.current = null;
    document.body.classList.remove("resizing-sidebar");
  };

  const copyCliResumeCommand = async (command: string, conversationId: string) => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      // Keep the command visible so it can still be selected manually.
    }
    setCliCommandNotice({ conversationId, command, copied });
    window.clearTimeout(cliCommandNoticeTimer.current);
    cliCommandNoticeTimer.current = window.setTimeout(() => setCliCommandNotice(null), 8_000);
  };

  const showCliResumeCommand = () => {
    if (!activeConversation?.sessionId || !activeProject) return;
    const command = createCliResumeCommand(activeProject.workspace, activeConversation.sessionId);
    setCliCommandNotice({ conversationId: activeConversation.id, command, copied: false });
    window.clearTimeout(cliCommandNoticeTimer.current);
    cliCommandNoticeTimer.current = window.setTimeout(() => setCliCommandNotice(null), 8_000);
  };

  if (!storageReady) {
    return (
      <div className="app-shell">
        <main className="main-panel">
          <div className="conversation-intro history-loading">
            <span className="spinner" />
            <h1>正在载入项目</h1>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <div className="title-drag-region" />
      <Sidebar
        projects={projects}
        activeProjectId={selectedProjectId}
        activeConversationId={activeConversationId}
        appVersion={appVersion}
        collapsed={sidebarCollapsed}
        cliInfo={cliInfo}
        runningConversationIds={new Set(Object.keys(activeRuns))}
        appSettings={appSettings}
        updateState={updateState}
        onSelectConversation={selectConversation}
        onNewProject={addProject}
        onNewConversation={addConversation}
        onRefreshProject={refreshProject}
        onOpenProject={(workspace) => { void openProject(workspace); }}
        onDeleteConversation={deleteConversation}
        onDeleteProject={deleteProject}
        onRenameConversation={renameConversation}
        onRenameProject={renameProject}
        onReorderConversation={reorderConversation}
        onReorderProject={reorderProject}
        onToggleConversationPinned={toggleConversationPinned}
        onToggleProjectPinned={toggleProjectPinned}
        onSettingsChange={changeAppSettings}
        onCheckForUpdates={checkForUpdates}
        onToggle={() => setSidebarCollapsed((value) => !value)}
      />
      {!sidebarCollapsed ? (
        <div
          aria-label="调整侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemax={maxSidebarWidth()}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className="sidebar-resizer"
          role="separator"
          tabIndex={0}
          title="拖动调整侧边栏宽度，双击恢复默认宽度"
          onDoubleClick={() => setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH))}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setSidebarWidth((current) => clampSidebarWidth(current + (event.key === "ArrowLeft" ? -16 : 16)));
          }}
          onLostPointerCapture={stopSidebarResize}
          onPointerCancel={stopSidebarResize}
          onPointerDown={startSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={stopSidebarResize}
        />
      ) : null}
      <main className="main-panel">
        {activeProject && activeConversation ? (
          <>
            <header className="task-header">
              <div className="task-heading">
                {activeConversation.sessionId ? (
                  <button
                    className="task-title-command"
                    onClick={showCliResumeCommand}
                    title="复制 CMD 恢复命令"
                    type="button"
                  >
                    <h2>{activeConversation.title}</h2>
                    <TerminalSquare className="title-command-icon" size={13} />
                  </button>
                ) : <h2>{activeConversation.title}</h2>}
                <button className="workspace-chip" onClick={() => { void openProject(activeProject.workspace); }} title="在文件管理器中打开项目">
                  <Folder size={13} />
                  <strong>{activeProject.customName ?? activeProject.name}</strong>
                  {activeProject.customName ? <small>{activeProject.name}</small> : null}
                </button>
              </div>
              {cliCommandNotice?.conversationId === activeConversation.id ? (
                <div className="cli-command-popover" role="status">
                  <TerminalSquare size={14} />
                  <code>{cliCommandNotice.command}</code>
                  <button
                    aria-label={cliCommandNotice.copied ? "CMD 命令已复制" : "复制 CMD 命令"}
                    onClick={() => {
                      if (cliCommandNotice.copied) setCliCommandNotice(null);
                      else void copyCliResumeCommand(cliCommandNotice.command, activeConversation.id);
                    }}
                    title={cliCommandNotice.copied ? "已复制" : "复制"}
                    type="button"
                  >
                    {cliCommandNotice.copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    aria-label="关闭 CMD 命令"
                    onClick={() => setCliCommandNotice(null)}
                    title="关闭"
                    type="button"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : null}
              <ContextStatus
                conversation={activeConversation}
                disabled={activeProcessRunning || !activeConversation.sessionId}
                onCompact={compactContext}
              />
            </header>
            <ConversationView
              key={`conversation-${activeConversation.id}`}
              messages={activeConversation.messages}
              contextCompactions={activeConversation.contextCompactions ?? []}
              loadingHistory={activeConversation.source === "claude" && !activeConversation.historyLoaded}
              onBranch={activeConversation.sessionId ? branchConversation : undefined}
              branchDisabled={activeProcessRunning || branchingConversationId === activeConversation.id}
              onEditResend={editAndResend}
              editDisabled={activeProcessRunning}
            />
            <Composer
              key={`composer-${activeConversation.id}`}
              conversation={activeConversation}
              draft={composerDrafts[activeConversation.id] ?? EMPTY_COMPOSER_DRAFT}
              modelConfig={modelConfig}
              running={activeProcessRunning}
              queuedPrompts={promptQueues[activeConversation.id] ?? []}
              loadingHistory={activeConversation.source === "claude" && !activeConversation.historyLoaded}
              focusRequest={composerFocusRequest}
              onSend={sendPrompt}
              onQueue={queuePrompt}
              onGuideQueuedPrompt={guideQueuedPrompt}
              onStop={stopRun}
              onDeleteQueuedPrompt={deleteQueuedPrompt}
              onEditQueuedPrompt={editQueuedPrompt}
              onReorderQueuedPrompt={reorderPromptQueue}
              onDraftChange={(update) => {
                setComposerDrafts((current) => {
                  const nextDraft = update(current[activeConversation.id] ?? EMPTY_COMPOSER_DRAFT);
                  if (!nextDraft.prompt && nextDraft.attachments.length === 0) {
                    if (!current[activeConversation.id]) return current;
                    const next = { ...current };
                    delete next[activeConversation.id];
                    return next;
                  }
                  return { ...current, [activeConversation.id]: nextDraft };
                });
              }}
              onModelChange={(selectedModel) => updateConversation(activeConversation.id, (conversation) => ({ ...conversation, selectedModel }))}
              onLocalCommand={runLocalCommand}
              onPermissionChange={changePermissionMode}
            />
          </>
        ) : activeProject
          ? <ProjectEmptyView project={activeProject} onNewConversation={() => addConversation(activeProject.id)} />
          : <EmptyView onNewProject={addProject} />}
      </main>
      {completionNotice ? (
        <button
          className="completion-toast"
          onClick={() => {
            const project = projects.find((item) => item.conversations.some((conversation) => conversation.id === completionNotice.conversationId));
            if (project) setSelectedProjectId(project.id);
            setActiveConversationId(completionNotice.conversationId);
            setCompletionNotice(null);
          }}
          type="button"
        >
          <CheckCircle2 size={18} />
          <span>
            <strong>会话已完成</strong>
            <small>{completionNotice.title}</small>
          </span>
        </button>
      ) : null}
      {pendingQuestion ? (
        <UserQuestionDialog
          questions={pendingQuestion.questions}
          submitting={questionSubmitting}
          onSubmit={(answers) => { void resolveQuestion(answers); }}
          onCancel={() => { void cancelQuestion(); }}
        />
      ) : null}
      {!pendingQuestion && pendingPermission ? (
        <PermissionDialog
          requests={pendingPermission.requests}
          waitingForCli={!pendingPermission.direct && [...runMeta.current.values()].some((meta) => meta.conversationId === pendingPermission.conversationId && !meta.completed)}
          onDeny={() => { void resolvePermission("deny"); }}
          onAllowOnce={() => { void resolvePermission("once"); }}
          onAllowConversation={() => { void resolvePermission("conversation"); }}
        />
      ) : null}
      {pendingDeletion ? (
        <DeleteConfirmDialog
          title={pendingDeletion.kind === "conversation" ? `删除对话“${pendingDeletion.title}”？` : `删除项目“${pendingDeletion.title}”？`}
          description={pendingDeletion.kind === "conversation" && pendingDeletion.hasSession
            ? "对应的 Claude CLI 会话将移入 Windows 回收站，并从 /resume 中消失。"
            : pendingDeletion.kind === "project"
              ? "项目及其本地对话记录会从列表中移除。"
              : "这个对话会从项目中移除。"}
          detail={pendingDeletion.kind === "project" ? "项目目录和其中的文件不会被删除。" : undefined}
          error={deletionError}
          deleting={deletionBusy}
          onCancel={cancelDeletion}
          onConfirm={() => { void confirmDeletion(); }}
        />
      ) : null}
      {appSettingsLoaded && !pendingQuestion && !pendingPermission && !pendingDeletion && updateState.latestVersion && dismissedUpdateVersion !== updateState.latestVersion && (
        updateState.phase === "available" ||
        updateState.phase === "downloading" ||
        updateState.phase === "ready" ||
        (updateState.phase === "error" && updateState.errorContext === "download")
      ) ? (
        <UpdateDialog
          state={updateState}
          actionError={updateActionError}
          onDismiss={() => {
            setDismissedUpdateVersion(updateState.latestVersion ?? null);
            setUpdateActionError("");
          }}
          onDownload={downloadUpdate}
          onIgnoreVersion={ignoreUpdateVersion}
          onInstall={installUpdate}
          onOpenRelease={openUpdateRelease}
        />
      ) : null}
    </div>
  );
}
