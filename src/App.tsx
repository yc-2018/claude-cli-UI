import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { CheckCircle2, Folder, FolderOpen, Plus, TerminalSquare } from "lucide-react";
import Composer from "./Composer";
import ConversationView from "./ConversationView";
import DeleteConfirmDialog from "./DeleteConfirmDialog";
import PermissionDialog from "./PermissionDialog";
import Sidebar from "./Sidebar";
import { hasLegacyProjectsToMigrate, loadProjects, makeId, parseProjects, pathName, saveProjects, shorten } from "./storage";
import type {
  Activity,
  AppSelection,
  AppSettings,
  Attachment,
  ChatMessage,
  ClaudeEvent,
  ClaudeSessionHistory,
  ClaudeSessionSummary,
  Conversation,
  ModelConfig,
  PermissionMode,
  Project,
  RunRequest,
  ToolPermissionRequest,
} from "./types";

interface RunMeta {
  conversationId: string;
  responseId: string;
  completed: boolean;
  successful: boolean;
  receivedText: boolean;
  receivedThinking: boolean;
  pendingText: string;
  pendingThinking: string;
  flushTimer?: number;
}

interface PendingPermission {
  conversationId: string;
  responseId: string;
  sessionId?: string;
  requests: ToolPermissionRequest[];
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

function summarizeToolInput(input: unknown) {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  const preferred = value.command ?? value.file_path ?? value.path ?? value.pattern ?? value.query ?? value.description;
  return typeof preferred === "string" ? shorten(preferred, 90) : "";
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

function getActivities(data: Record<string, unknown>): Activity[] {
  if (data.type !== "assistant" || !data.message || typeof data.message !== "object") return [];
  const content = (data.message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    if (item.type !== "tool_use" || typeof item.name !== "string") return [];
    return [{
      id: typeof item.id === "string" ? item.id : makeId(),
      name: item.name,
      summary: summarizeToolInput(item.input),
    }];
  });
}

function getAssistantText(data: Record<string, unknown>) {
  if (data.type !== "assistant" || !data.message || typeof data.message !== "object") return "";
  const content = (data.message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("");
}

function getAssistantThinking(data: Record<string, unknown>) {
  if (data.type !== "assistant" || !data.message || typeof data.message !== "object") return "";
  const content = (data.message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return item.type === "thinking" && typeof item.thinking === "string" ? [item.thinking] : [];
  }).join("\n\n");
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
  const [completionNotice, setCompletionNotice] = useState<{ conversationId: string; title: string } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [cliInfo, setCliInfo] = useState<{ available: boolean; version?: string } | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({ options: [] });
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([]);
  const [branchingConversationId, setBranchingConversationId] = useState<string | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState("");
  const projectsRef = useRef(projects);
  const activeConversationIdRef = useRef(activeConversationId);
  const appSettingsRef = useRef(appSettings);
  const runMeta = useRef(new Map<string, RunMeta>());
  const scannedProjects = useRef(new Set<string>());
  const loadingHistories = useRef(new Set<string>());
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const branchingConversation = useRef(false);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const activeConversation = useMemo(
    () => activeProject?.conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeProject, activeConversationId],
  );
  const activeRunId = activeConversationId ? activeRuns[activeConversationId] : undefined;
  const pendingPermission = permissionQueue[0];

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
    void window.claudeDesk.getAppSettings()
      .then((settings) => {
        appSettingsRef.current = settings;
        setAppSettings(settings);
      })
      .catch(() => undefined);
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
        conversations: [...refreshed, ...additions].sort((a, b) => b.updatedAt - a.updatedAt),
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

  const changeAppSettings = (settings: AppSettings) => {
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
        window.alert("无法保存设置");
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
    updateResponse(meta, (message) => ({
      ...message,
      content: message.content + text,
      thinking: `${message.thinking ?? ""}${thinking}` || undefined,
    }));
  }, [updateResponse]);

  useEffect(() => window.claudeDesk.onEvent((event: ClaudeEvent) => {
    const meta = runMeta.current.get(event.runId);
    if (!meta) return;

    if (event.type === "message" && event.data) {
      const data = event.data;
      if (data.type === "system" && typeof data.session_id === "string") {
        const slashCommands = Array.isArray(data.slash_commands)
          ? [...new Set(data.slash_commands
            .filter((command): command is string => typeof command === "string")
            .map((command) => `/${command.replace(/^\//, "")}`))]
          : undefined;
        updateConversation(meta.conversationId, (conversation) => ({
          ...conversation,
          sessionId: data.session_id as string,
          gitBranch: typeof data.git_branch === "string" ? data.git_branch : conversation.gitBranch,
          resolvedModel: typeof data.model === "string" ? data.model : conversation.resolvedModel,
          slashCommands: slashCommands ?? conversation.slashCommands,
        }));
      }

      const delta = getTextDelta(data);
      if (delta) {
        meta.receivedText = true;
        meta.pendingText += delta;
        if (meta.flushTimer === undefined) meta.flushTimer = window.setTimeout(() => flushPendingText(meta), 50);
      }

      const thinkingDelta = getThinkingDelta(data);
      if (thinkingDelta) {
        meta.receivedThinking = true;
        meta.pendingThinking += thinkingDelta;
        if (meta.flushTimer === undefined) meta.flushTimer = window.setTimeout(() => flushPendingText(meta), 50);
      }

      const activities = getActivities(data);
      if (activities.length > 0) {
        updateResponse(meta, (message) => {
          const known = new Set((message.activities ?? []).map((item) => item.id));
          return { ...message, activities: [...(message.activities ?? []), ...activities.filter((item) => !known.has(item.id))] };
        });
      }

      if (data.type === "assistant") {
        const fullText = meta.receivedText ? "" : getAssistantText(data);
        const fullThinking = meta.receivedThinking ? "" : getAssistantThinking(data);
        if (fullText || fullThinking) {
          updateResponse(meta, (message) => ({
            ...message,
            content: fullText || message.content,
            thinking: fullThinking || message.thinking,
          }));
        }
      }

      if (data.type === "result") {
        flushPendingText(meta);
        meta.completed = true;
        const permissionRequests = getPermissionRequests(data);
        const isError = data.is_error === true;
        meta.successful = !isError && permissionRequests.length === 0;
        const resultText = typeof data.result === "string" ? data.result : "";
        updateResponse(meta, (message) => ({
          ...message,
          content: message.content || resultText,
          status: permissionRequests.length > 0 ? "stopped" : (isError ? "error" : "done"),
          error: isError ? resultText || "Claude 未能完成这次任务" : undefined,
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
      }
    }

    if (event.type === "raw" && event.text) {
      meta.pendingText += event.text + "\n";
      if (meta.flushTimer === undefined) meta.flushTimer = window.setTimeout(() => flushPendingText(meta), 50);
    }
    if (event.type === "error") {
      flushPendingText(meta);
      meta.completed = true;
      meta.successful = false;
      updateResponse(meta, (message) => ({ ...message, status: "error", error: event.message ?? "无法启动 Claude CLI" }));
    }
    if (event.type === "exit") {
      flushPendingText(meta);
      if (!meta.completed) {
        const detail = event.stderr || (event.code === 0 ? "Claude 已结束，但没有返回结果" : `Claude CLI 退出，代码 ${event.code ?? "未知"}`);
        updateResponse(meta, (message) => ({ ...message, status: "error", error: detail }));
      }
      setActiveRuns((current) => {
        const next = { ...current };
        delete next[meta.conversationId];
        return next;
      });
      if (meta.successful) notifyConversationCompleted(meta.conversationId);
      runMeta.current.delete(event.runId);
    }
  }), [flushPendingText, notifyConversationCompleted, updateConversation, updateResponse]);

  const addConversation = (projectId: string) => {
    const conversation = createConversation();
    setProjects((current) => current.map((project) => project.id === projectId
      ? { ...project, updatedAt: Date.now(), conversations: [conversation, ...project.conversations] }
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

  const selectProject = (projectId: string) => {
    if (!projects.some((project) => project.id === projectId)) return;
    setSelectedProjectId(projectId);
    setActiveConversationId(null);
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
    setProjects((current) => [project, ...current]);
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
    if (!trimmed || trimmed.length > 100 || activeRuns[conversationId]) return;
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

  const branchConversation = async (userTurn: number) => {
    if (
      !activeProject ||
      !activeConversation?.sessionId ||
      activeRunId ||
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
        ? { ...project, updatedAt: Date.now(), conversations: [branch, ...project.conversations] }
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

  const sendPrompt = async (prompt: string, attachments: Attachment[]) => {
    if (!activeProject || !activeConversation || activeRunId || (activeConversation.source === "claude" && !activeConversation.historyLoaded)) return;
    const runId = makeId();
    const responseId = makeId();
    const now = Date.now();
    const userMessage: ChatMessage = { id: makeId(), role: "user", content: prompt, attachments, createdAt: now };
    const response: ChatMessage = { id: responseId, role: "assistant", content: "", createdAt: now, status: "running", activities: [] };
    const firstPrompt = activeConversation.messages.length === 0;

    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      title: firstPrompt && conversation.title === "新对话" ? shorten(prompt || attachments[0]?.name || "附件", 28) : conversation.title,
      updatedAt: now,
      messages: [...conversation.messages, userMessage, response],
    }));
    runMeta.current.set(runId, {
      conversationId: activeConversation.id,
      responseId,
      completed: false,
      successful: false,
      receivedText: false,
      receivedThinking: false,
      pendingText: "",
      pendingThinking: "",
    });
    setActiveRuns((current) => ({ ...current, [activeConversation.id]: runId }));

    const request: RunRequest = {
      runId,
      prompt,
      cwd: activeProject.workspace,
      sessionId: activeConversation.sessionId,
      sessionName: activeConversation.sessionId
        ? undefined
        : (activeConversation.title !== "新对话"
          ? activeConversation.title.slice(0, 100)
          : makeClaudeSessionName((activeConversation.messages.find((message) => message.role === "user")?.content ?? prompt) || attachments[0]?.name || "附件")),
      model: getModelArgument(activeConversation, modelConfig),
      allowedTools: activeConversation.allowedTools,
      permissionMode: activeConversation.permissionMode,
      attachments,
    };
    try {
      await window.claudeDesk.startRun(request);
    } catch (error) {
      const meta = runMeta.current.get(runId);
      if (meta) updateResponse(meta, (message) => ({ ...message, status: "error", error: error instanceof Error ? error.message : "启动失败" }));
      setActiveRuns((current) => {
        const next = { ...current };
        delete next[activeConversation.id];
        return next;
      });
      runMeta.current.delete(runId);
    }
  };

  const editAndResend = async (messageId: string, content: string) => {
    if (!activeProject || !activeConversation || activeRunId || (activeConversation.source === "claude" && !activeConversation.historyLoaded)) return;
    const index = activeConversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const target = activeConversation.messages[index];
    if (target.role !== "user") return;
    const isLastUserMessage = activeConversation.messages.slice(index + 1).every((message) => message.role !== "user");
    if (!isLastUserMessage) return;
    const attachments = target.attachments ?? [];
    setPermissionQueue((current) => current.filter((item) => item.conversationId !== activeConversation.id));
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      updatedAt: Date.now(),
      messages: conversation.messages.slice(0, index),
    }));
    await sendPrompt(content, attachments);
  };

  const resolvePermission = async (decision: "deny" | "once" | "conversation") => {
    if (!pendingPermission || activeRuns[pendingPermission.conversationId]) return;
    setPermissionQueue((current) => current.filter((item) => item.responseId !== pendingPermission.responseId));

    const names = [...new Set(pendingPermission.requests.map((request) => request.toolName))];
    if (decision === "deny") {
      const meta: RunMeta = {
        conversationId: pendingPermission.conversationId,
        responseId: pendingPermission.responseId,
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
      responseId: pendingPermission.responseId,
      completed: false,
      successful: false,
      receivedText: false,
      receivedThinking: false,
      pendingText: "",
      pendingThinking: "",
    };
    updateResponse(meta, (message) => ({ ...message, content: "", thinking: undefined, status: "running", error: undefined }));
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
        delete next[conversation.id];
        return next;
      });
      runMeta.current.delete(runId);
    }
  };

  const stopRun = async () => {
    if (!activeConversation || !activeRunId) return;
    const meta = runMeta.current.get(activeRunId);
    if (meta) {
      meta.completed = true;
      updateResponse(meta, (message) => ({ ...message, status: "stopped" }));
    }
    try {
      const stopped = await window.claudeDesk.stopRun(activeRunId);
      if (!stopped && meta) {
        meta.completed = false;
        updateResponse(meta, (message) => ({ ...message, status: "running", error: "暂时无法停止 Claude CLI。" }));
      }
    } catch (error) {
      if (meta) {
        meta.completed = false;
        updateResponse(meta, (message) => ({ ...message, status: "running", error: error instanceof Error ? error.message : "停止失败" }));
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
        onSelectProject={selectProject}
        onSelectConversation={selectConversation}
        onNewProject={addProject}
        onNewConversation={addConversation}
        onRefreshProject={refreshProject}
        onOpenProject={(workspace) => { void openProject(workspace); }}
        onDeleteConversation={deleteConversation}
        onDeleteProject={deleteProject}
        onRenameConversation={renameConversation}
        onRenameProject={renameProject}
        onSettingsChange={changeAppSettings}
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
                <h2>{activeConversation.title}</h2>
                <button className="workspace-chip" onClick={() => { void openProject(activeProject.workspace); }} title="在文件管理器中打开项目">
                  <Folder size={13} />
                  <strong>{activeProject.customName ?? activeProject.name}</strong>
                  {activeProject.customName ? <small>{activeProject.name}</small> : null}
                </button>
              </div>
            </header>
            <ConversationView
              key={`conversation-${activeConversation.id}`}
              messages={activeConversation.messages}
              loadingHistory={activeConversation.source === "claude" && !activeConversation.historyLoaded}
              onBranch={activeConversation.sessionId ? branchConversation : undefined}
              branchDisabled={Boolean(activeRunId) || branchingConversationId === activeConversation.id}
              onEditResend={editAndResend}
              editDisabled={Boolean(activeRunId)}
            />
            <Composer
              key={`composer-${activeConversation.id}`}
              conversation={activeConversation}
              modelConfig={modelConfig}
              running={Boolean(activeRunId)}
              loadingHistory={activeConversation.source === "claude" && !activeConversation.historyLoaded}
              focusRequest={composerFocusRequest}
              onSend={sendPrompt}
              onStop={stopRun}
              onModelChange={(selectedModel) => updateConversation(activeConversation.id, (conversation) => ({ ...conversation, selectedModel }))}
              onLocalCommand={runLocalCommand}
              onPermissionChange={(permissionMode: PermissionMode) => updateConversation(activeConversation.id, (conversation) => ({ ...conversation, permissionMode }))}
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
      {pendingPermission ? (
        <PermissionDialog
          requests={pendingPermission.requests}
          waitingForCli={Boolean(activeRuns[pendingPermission.conversationId])}
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
    </div>
  );
}
