import type { Activity, Attachment, ChatMessage, Conversation, PermissionMode, Project } from "./types";

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

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<ChatMessage>;
  if (typeof message.id !== "string" || (message.role !== "user" && message.role !== "assistant")) return null;
  const validStatuses = new Set(["running", "done", "error", "stopped"]);
  const status = message.status && validStatuses.has(message.status) ? message.status : undefined;
  const wasInterrupted = status === "running";
  const activities = Array.isArray(message.activities)
    ? message.activities.filter((activity): activity is Activity => Boolean(
      activity && typeof activity.id === "string" && typeof activity.name === "string" && typeof activity.summary === "string",
    ))
    : [];
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
    createdAt: typeof message.createdAt === "number" ? message.createdAt : Date.now(),
    status: wasInterrupted ? "stopped" : status,
    activities,
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
    createdAt: typeof conversation.createdAt === "number" ? conversation.createdAt : Date.now(),
    updatedAt: typeof conversation.updatedAt === "number" ? conversation.updatedAt : Date.now(),
    sessionId: typeof conversation.sessionId === "string" && SESSION_ID_PATTERN.test(conversation.sessionId)
      ? conversation.sessionId
      : undefined,
    messages,
    selectedModel: typeof conversation.selectedModel === "string" && conversation.selectedModel
      ? conversation.selectedModel
      : undefined,
    resolvedModel: typeof conversation.resolvedModel === "string" ? conversation.resolvedModel : undefined,
    slashCommands: Array.isArray(conversation.slashCommands)
      ? [...new Set(conversation.slashCommands.filter((command): command is string => typeof command === "string" && command.startsWith("/")))]
      : [],
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
    workspace: project.workspace,
    createdAt: typeof project.createdAt === "number" ? project.createdAt : Date.now(),
    updatedAt: typeof project.updatedAt === "number" ? project.updatedAt : Date.now(),
    conversations,
    hiddenSessionIds: Array.isArray(project.hiddenSessionIds)
      ? [...new Set(project.hiddenSessionIds.filter((id): id is string => typeof id === "string" && SESSION_ID_PATTERN.test(id)))]
      : [],
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
      return Array.isArray(parsed)
        ? parsed.map(normalizeProject).filter((project): project is Project => project !== null)
        : [];
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

export function saveProjects(projects: Project[]) {
  const serializable = projects.map((project) => ({
    ...project,
    conversations: project.conversations.map((conversation) => conversation.source === "claude"
      ? { ...conversation, messages: [], historyLoaded: false }
      : conversation),
  }));
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(serializable));
}
