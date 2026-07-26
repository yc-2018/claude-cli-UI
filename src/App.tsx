import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderOpen, Sparkles, TerminalSquare } from "lucide-react";
import Composer from "./Composer";
import ConversationView from "./ConversationView";
import PermissionDialog from "./PermissionDialog";
import Sidebar from "./Sidebar";
import { hasLegacyProjectsToMigrate, loadProjects, makeId, parseProjects, pathName, saveProjects, shorten } from "./storage";
import type {
  Activity,
  Attachment,
  ChatMessage,
  ClaudeEvent,
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
    messages: [],
    resolvedModel: summary.resolvedModel,
    slashCommands: [],
    permissionMode: summary.permissionMode,
    source: "claude",
    historyLoaded: false,
  };
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

export default function App() {
  const [initialProjects] = useState<Project[]>(loadProjects);
  const [preferLegacyProjects] = useState(hasLegacyProjectsToMigrate);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [storageReady, setStorageReady] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    initialProjects.flatMap((project) => project.conversations)[0]?.id ?? null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeRuns, setActiveRuns] = useState<Record<string, string>>({});
  const [cliInfo, setCliInfo] = useState<{ available: boolean; version?: string } | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({ options: [] });
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([]);
  const projectsRef = useRef(projects);
  const runMeta = useRef(new Map<string, RunMeta>());
  const scannedProjects = useRef(new Set<string>());
  const loadingHistories = useRef(new Set<string>());

  const activeProject = useMemo(
    () => projects.find((project) => project.conversations.some((item) => item.id === activeConversationId)) ?? null,
    [projects, activeConversationId],
  );
  const activeConversation = useMemo(
    () => activeProject?.conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeProject, activeConversationId],
  );
  const activeRunId = activeConversationId ? activeRuns[activeConversationId] : undefined;
  const pendingPermission = permissionQueue[0];

  useEffect(() => {
    let canceled = false;
    void window.claudeDesk.getProjectStore().then(async (stored) => {
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
      setProjects(loaded);
      setActiveConversationId((current) => loaded.some((project) => project.conversations.some((conversation) => conversation.id === current))
        ? current
        : loaded.flatMap((project) => project.conversations)[0]?.id ?? null);
      setStorageReady(true);
      if (stored === null) window.claudeDesk.saveProjectStore(loaded);
    }).catch(() => {
      if (!canceled) setStorageReady(true);
    });
    return () => { canceled = true; };
  }, [initialProjects, preferLegacyProjects]);

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
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    for (const project of projects) {
      if (scannedProjects.current.has(project.id)) continue;
      scannedProjects.current.add(project.id);
      const localSessionIds = project.conversations.flatMap((conversation) => (
        conversation.source !== "claude" && conversation.sessionId ? [conversation.sessionId] : []
      ));
      const normalizeLocalSessions = Promise.all(localSessionIds.map((sessionId) => (
        window.claudeDesk.normalizeClaudeSession(project.workspace, sessionId).catch(() => false)
      )));
      void normalizeLocalSessions.then(() => window.claudeDesk.getClaudeSessions(project.workspace)).then((sessions) => {
        setProjects((current) => current.map((item) => {
          if (item.id !== project.id) return item;
          const hidden = new Set(item.hiddenSessionIds ?? []);
          const sessionById = new Map(sessions.map((session) => [session.sessionId, session] as const));
          const refreshed = item.conversations.map((conversation) => {
            const session = conversation.sessionId ? sessionById.get(conversation.sessionId) : undefined;
            return conversation.source === "claude" && session
              ? {
                ...conversation,
                updatedAt: Math.max(conversation.updatedAt, session.updatedAt),
                resolvedModel: session.resolvedModel ?? conversation.resolvedModel,
              }
              : conversation;
          });
          const known = new Map(refreshed.flatMap((conversation) => conversation.sessionId
            ? [[conversation.sessionId, conversation] as const]
            : []));
          const additions: Conversation[] = [];
          for (const session of sessions) {
            if (hidden.has(session.sessionId)) continue;
            const existing = known.get(session.sessionId);
            if (!existing) {
              additions.push(importedConversation(session));
              continue;
            }
          }
          if (additions.length === 0) return { ...item, conversations: refreshed.sort((a, b) => b.updatedAt - a.updatedAt) };
          return {
            ...item,
            updatedAt: Math.max(item.updatedAt, ...additions.map((conversation) => conversation.updatedAt)),
            conversations: [...refreshed, ...additions].sort((a, b) => b.updatedAt - a.updatedAt),
          };
        }));
        setActiveConversationId((current) => current ?? (sessions[0] ? `claude-${sessions[0].sessionId}` : null));
      }).catch(() => {
        // A missing or unreadable Claude history directory simply has no sessions to merge.
      });
    }
  }, [projects, storageReady]);

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
      runMeta.current.delete(event.runId);
    }
  }), [flushPendingText, updateConversation, updateResponse]);

  const addConversation = (projectId: string) => {
    const conversation = createConversation();
    setProjects((current) => current.map((project) => project.id === projectId
      ? { ...project, updatedAt: Date.now(), conversations: [conversation, ...project.conversations] }
      : project));
    setActiveConversationId(conversation.id);
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
    setActiveConversationId(conversation.id);
  };

  const openProject = async (workspace: string) => {
    try {
      const result = await window.claudeDesk.openWorkspace(workspace);
      if (!result.opened) window.alert(result.error ?? "无法打开项目目录");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "无法打开项目目录");
    }
  };

  const deleteConversation = (projectId: string, conversationId: string) => {
    if (activeRuns[conversationId]) return;
    const deleted = projects.find((project) => project.id === projectId)?.conversations.find((conversation) => conversation.id === conversationId);
    const remaining = projects.flatMap((project) => project.id === projectId
      ? project.conversations.filter((item) => item.id !== conversationId)
      : project.conversations);
    setProjects((current) => current.map((project) => project.id === projectId
      ? {
        ...project,
        conversations: project.conversations.filter((item) => item.id !== conversationId),
        hiddenSessionIds: deleted?.source === "claude" && deleted.sessionId
          ? [...new Set([...(project.hiddenSessionIds ?? []), deleted.sessionId])]
          : project.hiddenSessionIds,
      }
      : project));
    setPermissionQueue((current) => current.filter((item) => item.conversationId !== conversationId));
    if (activeConversationId === conversationId) setActiveConversationId(remaining[0]?.id ?? null);
  };

  const deleteProject = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || project.conversations.some((item) => activeRuns[item.id])) return;
    if (!window.confirm(`删除项目“${project.customName ?? project.name}”及其本地对话记录？项目文件不会被删除。`)) return;
    const remaining = projects.filter((item) => item.id !== projectId);
    setProjects(remaining);
    if (project.conversations.some((item) => item.id === activeConversationId)) {
      setActiveConversationId(remaining.flatMap((item) => item.conversations)[0]?.id ?? null);
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

  const renameConversation = (conversationId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    updateConversation(conversationId, (conversation) => ({ ...conversation, title: trimmed, updatedAt: Date.now() }));
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
        : makeClaudeSessionName((activeConversation.messages.find((message) => message.role === "user")?.content ?? prompt) || attachments[0]?.name || "附件"),
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

  const resolvePermission = async (decision: "deny" | "once" | "conversation") => {
    if (!pendingPermission || activeRuns[pendingPermission.conversationId]) return;
    setPermissionQueue((current) => current.filter((item) => item.responseId !== pendingPermission.responseId));

    const names = [...new Set(pendingPermission.requests.map((request) => request.toolName))];
    if (decision === "deny") {
      const meta: RunMeta = {
        conversationId: pendingPermission.conversationId,
        responseId: pendingPermission.responseId,
        completed: true,
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
    <div className="app-shell">
      <div className="title-drag-region" />
      <Sidebar
        projects={projects}
        activeConversationId={activeConversationId}
        collapsed={sidebarCollapsed}
        cliInfo={cliInfo}
        onSelectConversation={setActiveConversationId}
        onNewProject={addProject}
        onNewConversation={addConversation}
        onOpenProject={(workspace) => { void openProject(workspace); }}
        onDeleteConversation={deleteConversation}
        onDeleteProject={deleteProject}
        onRenameConversation={renameConversation}
        onRenameProject={renameProject}
        onToggle={() => setSidebarCollapsed((value) => !value)}
      />
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
            />
            <Composer
              key={`composer-${activeConversation.id}`}
              conversation={activeConversation}
              modelConfig={modelConfig}
              running={Boolean(activeRunId)}
              loadingHistory={activeConversation.source === "claude" && !activeConversation.historyLoaded}
              onSend={sendPrompt}
              onStop={stopRun}
              onModelChange={(selectedModel) => updateConversation(activeConversation.id, (conversation) => ({ ...conversation, selectedModel }))}
              onLocalCommand={runLocalCommand}
              onPermissionChange={(permissionMode: PermissionMode) => updateConversation(activeConversation.id, (conversation) => ({ ...conversation, permissionMode }))}
            />
          </>
        ) : <EmptyView onNewProject={addProject} />}
      </main>
      {pendingPermission ? (
        <PermissionDialog
          requests={pendingPermission.requests}
          waitingForCli={Boolean(activeRuns[pendingPermission.conversationId])}
          onDeny={() => { void resolvePermission("deny"); }}
          onAllowOnce={() => { void resolvePermission("once"); }}
          onAllowConversation={() => { void resolvePermission("conversation"); }}
        />
      ) : null}
    </div>
  );
}
