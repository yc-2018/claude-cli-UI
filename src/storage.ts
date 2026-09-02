import type { Activity, ActivityDetail, ActivityDiffLine, Attachment, ChatMessage, Conversation, ContextCompaction, ContextUsage, PermissionMode, Project, ResponseTimelineItem, ThinkingEffort, UserQuestion } from "./types";
import { normalizeSlashCommands } from "./commands";

export const PROJECTS_STORAGE_KEY = "claude-desk.projects.v2";
export const LEGACY_TASKS_STORAGE_KEY = "claude-desk.tasks.v1";
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENT_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]{1,12})?$/i;

export function makeId() {
  return crypto.randomUUID();
}

export function pathName(path: string) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || path;
}

export function shorten(text: string, limit = 38) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}…` : singleLine;
}

function pinnedFirst<T extends { pinned?: boolean }>(items: T[]) {
  return [
    ...items.filter((item) => item.pinned),
    ...items.filter((item) => !item.pinned),
  ];
}

function normalizeActivityDetail(value: unknown): ActivityDetail | undefined {
  if (!value || typeof value !== "object") return undefined;
  const detail = value as Partial<ActivityDetail>;
  const boundedText = (text: unknown) => typeof text === "string" ? text.slice(0, 200_000) : undefined;
  const diff = Array.isArray(detail.diff)
    ? detail.diff.slice(0, 4_000).flatMap((line): ActivityDiffLine[] => {
      if (!line || typeof line !== "object") return [];
      const item = line as Partial<ActivityDiffLine>;
      if ((item.type !== "context" && item.type !== "add" && item.type !== "remove") || typeof item.text !== "string") return [];
      return [{
        type: item.type,
        text: item.text,
        oldLine: typeof item.oldLine === "number" && Number.isSafeInteger(item.oldLine) ? item.oldLine : undefined,
        newLine: typeof item.newLine === "number" && Number.isSafeInteger(item.newLine) ? item.newLine : undefined,
      }];
    })
    : undefined;
  const questions = Array.isArray(detail.questions)
    ? detail.questions.slice(0, 10).flatMap((question): UserQuestion[] => {
      if (!question || typeof question !== "object") return [];
      const item = question as Partial<UserQuestion>;
      if (typeof item.question !== "string" || !item.question.trim()) return [];
      const options = Array.isArray(item.options)
        ? item.options.slice(0, 20).flatMap((option) => {
          if (!option || typeof option !== "object") return [];
          const candidate = option as { label?: unknown; description?: unknown; preview?: unknown };
          if (typeof candidate.label !== "string" || !candidate.label.trim()) return [];
          return [{
            label: candidate.label.slice(0, 500),
            description: boundedText(candidate.description),
            preview: boundedText(candidate.preview),
          }];
        })
        : [];
      return [{
        question: item.question.slice(0, 2_000),
        header: boundedText(item.header),
        multiSelect: item.multiSelect === true,
        options,
      }];
    })
    : undefined;
  const normalized = {
    path: boundedText(detail.path),
    command: boundedText(detail.command),
    oldText: boundedText(detail.oldText),
    newText: boundedText(detail.newText),
    output: boundedText(detail.output),
    diff: diff?.length ? diff : undefined,
    questions: questions?.length ? questions : undefined,
  };
  return Object.values(normalized).some((item) => item !== undefined) ? normalized : undefined;
}

function normalizeActivity(value: unknown): Activity | null {
  if (!value || typeof value !== "object") return null;
  const activity = value as Partial<Activity>;
  if (typeof activity.id !== "string" || typeof activity.name !== "string" || typeof activity.summary !== "string") return null;
  const detail = normalizeActivityDetail(activity.detail);
  return { id: activity.id, name: activity.name, summary: activity.summary, ...(detail ? { detail } : {}) };
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<ChatMessage>;
  const legacyMessage = value as Record<string, unknown>;
  if (typeof message.id !== "string" || (message.role !== "user" && message.role !== "assistant")) return null;
  const validStatuses = new Set(["running", "done", "error", "stopped"]);
  const status = message.status && validStatuses.has(message.status) ? message.status : undefined;
  const wasInterrupted = status === "running";
  const activities = Array.isArray(message.activities)
    ? message.activities.map(normalizeActivity).filter((activity): activity is Activity => activity !== null)
    : [];
  const timeline = Array.isArray(message.timeline)
    ? message.timeline.flatMap((item): ResponseTimelineItem[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<ResponseTimelineItem>;
      if (candidate.type === "text" && typeof candidate.id === "string" && typeof candidate.content === "string") {
        return [{ id: candidate.id, type: "text", content: candidate.content }];
      }
      if (candidate.type === "activity" && typeof candidate.id === "string") {
        const activity = normalizeActivity(candidate.activity);
        if (activity) return [{ id: candidate.id, type: "activity", activity }];
      }
      return [];
    })
    : undefined;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter((attachment): attachment is Attachment => Boolean(
      attachment &&
      typeof attachment.id === "string" && SESSION_ID_PATTERN.test(attachment.id) &&
      typeof attachment.storedName === "string" && ATTACHMENT_NAME_PATTERN.test(attachment.storedName) &&
      attachment.storedName.startsWith(attachment.id) &&
      typeof attachment.name === "string" && attachment.name.length > 0 && attachment.name.length <= 255 &&
      typeof attachment.mediaType === "string" && attachment.mediaType.length <= 100 &&
      typeof attachment.size === "number" && Number.isInteger(attachment.size) && attachment.size > 0 && attachment.size <= 20 * 1024 * 1024 &&
      (attachment.kind === "image" || attachment.kind === "file"),
    ))
    : [];

  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
    thinking: typeof message.thinking === "string" ? message.thinking : undefined,
    responseStartedAt: typeof message.responseStartedAt === "number" && Number.isFinite(message.responseStartedAt)
      ? message.responseStartedAt
      : (typeof legacyMessage.thinkingStartedAt === "number" && Number.isFinite(legacyMessage.thinkingStartedAt)
        ? legacyMessage.thinkingStartedAt
        : undefined),
    responseDurationMs: typeof message.responseDurationMs === "number" && Number.isFinite(message.responseDurationMs) && message.responseDurationMs >= 0
      ? message.responseDurationMs
      : (typeof legacyMessage.thinkingDurationMs === "number" && Number.isFinite(legacyMessage.thinkingDurationMs) && legacyMessage.thinkingDurationMs >= 0
        ? legacyMessage.thinkingDurationMs
        : undefined),
    createdAt: typeof message.createdAt === "number" ? message.createdAt : Date.now(),
    status: wasInterrupted ? "stopped" : status,
    activities,
    timeline,
    attachments,
    error: wasInterrupted ? "上次运行已中断，可以重新发送任务。" : (typeof message.error === "string" ? message.error : undefined),
  };
}

function normalizeConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== "object") return null;
  const conversation = value as Partial<Conversation>;
  if (typeof conversation.id !== "string") return null;
  const modes: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages.map(normalizeMessage).filter((message): message is ChatMessage => message !== null)
    : [];

  return {
    id: conversation.id,
    title: typeof conversation.title === "string" && conversation.title ? conversation.title : "新对话",
    pinned: conversation.pinned === true ? true : undefined,
    createdAt: typeof conversation.createdAt === "number" ? conversation.createdAt : Date.now(),
    updatedAt: typeof conversation.updatedAt === "number" ? conversation.updatedAt : Date.now(),
    sessionId: typeof conversation.sessionId === "string" && SESSION_ID_PATTERN.test(conversation.sessionId)
      ? conversation.sessionId
      : undefined,
    gitBranch: typeof conversation.gitBranch === "string" && conversation.gitBranch.length <= 200
      ? conversation.gitBranch
      : undefined,
    messages,
    selectedModel: typeof conversation.selectedModel === "string" && conversation.selectedModel
      ? conversation.selectedModel
      : undefined,
    thinkingEffort: ["low", "medium", "high", "xhigh", "max"].includes(conversation.thinkingEffort as ThinkingEffort)
      ? conversation.thinkingEffort as ThinkingEffort
      : undefined,
    resolvedModel: typeof conversation.resolvedModel === "string" ? conversation.resolvedModel : undefined,
    slashCommands: normalizeSlashCommands(conversation.slashCommands),
    contextUsage: normalizeContextUsage(conversation.contextUsage),
    contextCompactions: normalizeContextCompactions(conversation.contextCompactions),
    allowedTools: Array.isArray(conversation.allowedTools)
      ? [...new Set(conversation.allowedTools.filter((tool): tool is string => typeof tool === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool)))]
      : [],
    source: conversation.source === "claude" ? "claude" : undefined,
    historyLoaded: conversation.source === "claude" ? false : undefined,
    permissionMode: modes.includes(conversation.permissionMode as PermissionMode)
      ? conversation.permissionMode as PermissionMode
      : "acceptEdits",
  };
}

function normalizeContextUsage(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<ContextUsage>;
  const usage: ContextUsage = {
    usedTokens: typeof item.usedTokens === "number" && Number.isFinite(item.usedTokens) ? Math.max(0, item.usedTokens) : undefined,
    contextWindow: typeof item.contextWindow === "number" && Number.isFinite(item.contextWindow) ? Math.max(0, item.contextWindow) : undefined,
    usedPercentage: typeof item.usedPercentage === "number" && Number.isFinite(item.usedPercentage) ? Math.max(0, item.usedPercentage) : undefined,
    remainingPercentage: typeof item.remainingPercentage === "number" && Number.isFinite(item.remainingPercentage) ? Math.max(0, item.remainingPercentage) : undefined,
  };
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
}

function normalizeContextCompactions(value: unknown): ContextCompaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): ContextCompaction[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<ContextCompaction>;
    if (typeof item.id !== "string" || (item.trigger !== "auto" && item.trigger !== "manual" && item.trigger !== "unknown") || (item.status !== "running" && item.status !== "done" && item.status !== "error")) return [];
    return [{
      id: item.id,
      trigger: item.trigger,
      status: item.status,
      startedAt: typeof item.startedAt === "number" ? item.startedAt : undefined,
      completedAt: typeof item.completedAt === "number" ? item.completedAt : undefined,
      preTokens: typeof item.preTokens === "number" ? item.preTokens : undefined,
      postTokens: typeof item.postTokens === "number" ? item.postTokens : undefined,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
      summary: typeof item.summary === "string" ? item.summary.slice(0, 200_000) : undefined,
      error: typeof item.error === "string" ? item.error.slice(0, 4_000) : undefined,
    }];
  }).slice(-20);
}

function normalizeProject(value: unknown): Project | null {
  if (!value || typeof value !== "object") return null;
  const project = value as Partial<Project>;
  if (typeof project.id !== "string" || typeof project.workspace !== "string" || !project.workspace) return null;
  const conversations = Array.isArray(project.conversations)
    ? project.conversations.map(normalizeConversation).filter((item): item is Conversation => item !== null)
    : [];

  return {
    id: project.id,
    name: typeof project.name === "string" && project.name ? project.name : pathName(project.workspace),
    customName: typeof project.customName === "string" && project.customName.trim()
      ? project.customName.trim()
      : undefined,
    pinned: project.pinned === true ? true : undefined,
    workspace: project.workspace,
    createdAt: typeof project.createdAt === "number" ? project.createdAt : Date.now(),
    updatedAt: typeof project.updatedAt === "number" ? project.updatedAt : Date.now(),
    conversations: pinnedFirst(conversations),
  };
}

function migrateLegacyTasks(value: unknown): Project[] {
  if (!Array.isArray(value)) return [];
  const grouped = new Map<string, Project>();

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const legacy = item as Record<string, unknown>;
    if (typeof legacy.workspace !== "string" || !legacy.workspace) continue;
    const conversation = normalizeConversation(legacy);
    if (!conversation) continue;
    const key = legacy.workspace.replace(/[\\/]+$/, "").toLocaleLowerCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.conversations.push(conversation);
      existing.createdAt = Math.min(existing.createdAt, conversation.createdAt);
      existing.updatedAt = Math.max(existing.updatedAt, conversation.updatedAt);
      continue;
    }
    grouped.set(key, {
      id: makeId(),
      name: pathName(legacy.workspace),
      workspace: legacy.workspace,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      conversations: [conversation],
    });
  }

  return [...grouped.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadProjects(): Project[] {
  const projectsValue = localStorage.getItem(PROJECTS_STORAGE_KEY);
  if (projectsValue !== null) {
    try {
      const parsed: unknown = JSON.parse(projectsValue);
      return parseProjects(parsed);
    } catch {
      return [];
    }
  }

  try {
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_TASKS_STORAGE_KEY) ?? "[]");
    return migrateLegacyTasks(legacy);
  } catch {
    return [];
  }
}

export function hasLegacyProjectsToMigrate() {
  return localStorage.getItem(PROJECTS_STORAGE_KEY) === null && localStorage.getItem(LEGACY_TASKS_STORAGE_KEY) !== null;
}

export function parseProjects(value: unknown): Project[] {
  return Array.isArray(value)
    ? pinnedFirst(value.map(normalizeProject).filter((project): project is Project => project !== null))
    : [];
}

export function saveProjects(projects: Project[]) {
  const serializable = projects.map((project) => ({
    ...project,
    conversations: project.conversations.map((conversation) => conversation.source === "claude"
      ? { ...conversation, messages: [], historyLoaded: false }
      : conversation),
  }));
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(serializable));
}
