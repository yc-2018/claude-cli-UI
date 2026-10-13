import { useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  GripVertical,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  PowerOff,
  RefreshCw,
  Settings,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import type { AppSettings, AppUpdateState, Conversation, Project, ReorderPosition, ScheduledPrompt, ShellTask } from "./types";

/** 「全部回答完成后执行」的常用收尾动作，省得用户自己去记命令。 */
const COMPLETION_TASK_EXAMPLES: { label: string; task: ShellTask }[] = [
  { label: "关机", task: { shell: "cmd", command: "shutdown /s /t 60" } },
  { label: "休眠", task: { shell: "cmd", command: "shutdown /h" } },
  { label: "睡眠", task: { shell: "cmd", command: "C:\\Windows\\System32\\rundll32.exe powrprof.dll,SetSuspendState 0,1,0" } },
  { label: "锁屏", task: { shell: "cmd", command: "rundll32.exe user32.dll,LockWorkStation" } },
];

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  activeConversationId: string | null;
  appVersion: string;
  collapsed: boolean;
  cliInfo: { available: boolean; version?: string } | null;
  runningConversationIds: ReadonlySet<string>;
  appSettings: AppSettings;
  updateState: AppUpdateState;
  /** 全部对话里还没发出去的定时任务。 */
  scheduledPrompts: ScheduledPrompt[];
  /** 是否有对话正在回答：没有时不能布置「回答完成后执行」。 */
  anyConversationRunning: boolean;
  /** 已经布置好的收尾命令，没布置时为 null。 */
  armedCompletionTask: ShellTask | null;
  onSelectConversation(id: string): void;
  onNewProject(): void;
  onNewConversation(projectId: string): void;
  onNewScratchConversation(): void;
  onRefreshProject(projectId: string): Promise<void>;
  onOpenProject(workspace: string): void;
  onDeleteConversation(projectId: string, conversationId: string): void;
  onDeleteProject(projectId: string): void;
  onRenameConversation(conversationId: string, title: string): void;
  onRenameProject(projectId: string, name: string): void;
  onReorderConversation(projectId: string, sourceId: string, targetId: string, position: ReorderPosition): void;
  onReorderProject(sourceId: string, targetId: string, position: ReorderPosition): void;
  onToggleConversationPinned(projectId: string, conversationId: string): void;
  onToggleProjectPinned(projectId: string): void;
  onSettingsChange(settings: AppSettings): void;
  onCancelScheduledPrompt(id: string): void;
  onOpenScheduledPrompt(item: ScheduledPrompt): void;
  /** 传 null 表示撤掉已布置的收尾命令。 */
  onArmCompletionTask(task: ShellTask | null): void;
  onCheckForUpdates(): void;
  onToggle(): void;
}

/** 侧边栏底部那一行三个按钮各自对应的面板。 */
type BottomPanel = "settings" | "schedule" | "completion" | null;

interface EditingName {  kind: "project" | "conversation";
  id: string;
  // 同一个会话可能在所属文件夹和「置顶」里各渲染一次，重命名输入框只能出现在点了改名的那一份上：
  // 两个 autoFocus 输入框会互相抢焦点，先失焦的那个立刻触发保存，改名框还没输入就消失了。
  section: SectionKey;
  value: string;
}

type SectionKey = "pinned" | "scratch" | "projects";

type DragItem = {
  kind: "project";
  id: string;
  pinned: boolean;
  section: SectionKey;
} | {
  kind: "conversation";
  projectId: string;
  id: string;
  pinned: boolean;
  section: SectionKey;
};

type DropTarget = DragItem & { position: ReorderPosition };

function formatConversationTime(timestamp: number) {
  const value = new Date(timestamp);
  const now = new Date();
  const sameDay = value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate();
  return new Intl.DateTimeFormat("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : {
      ...(value.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(value);
}

function updateStatusText(state: AppUpdateState) {
  if (state.phase === "checking") return "正在检查 GitHub Releases…";
  if (state.phase === "available") return `发现新版本 v${state.latestVersion}`;
  if (state.phase === "downloading") return `正在下载 v${state.latestVersion} · ${Math.round(state.percent ?? 0)}%`;
  if (state.phase === "ready") return `v${state.latestVersion} 已准备好`;
  if (state.phase === "up-to-date") return "当前已经是最新版本";
  if (state.phase === "error") return "检查失败，点击重试";
  return state.portable ? "Portable 自动更新" : "自动检查 GitHub Releases";
}

export default function Sidebar({
  projects,
  activeProjectId,
  activeConversationId,
  appVersion,
  collapsed,
  cliInfo,
  runningConversationIds,
  appSettings,
  updateState,
  scheduledPrompts,
  anyConversationRunning,
  armedCompletionTask,
  onSelectConversation,
  onNewProject,
  onNewConversation,
  onNewScratchConversation,
  onRefreshProject,
  onOpenProject,
  onDeleteConversation,
  onDeleteProject,
  onRenameConversation,
  onRenameProject,
  onReorderConversation,
  onReorderProject,
  onToggleConversationPinned,
  onToggleProjectPinned,
  onSettingsChange,
  onCancelScheduledPrompt,
  onOpenScheduledPrompt,
  onArmCompletionTask,
  onCheckForUpdates,
  onToggle,
}: Props) {
  // 启动时只展开当前对话所在的项目：项目和对话一多，全展开的侧栏要滚很久才能找到东西。
  // 惰性初始化读的是挂载那一刻的 props，App 在 storageReady 之前不渲染侧栏，所以项目和选中项已经就位。
  const [closedProjects, setClosedProjects] = useState<Set<string>>(() => new Set(
    projects.filter((project) => project.id !== activeProjectId).map((project) => project.id),
  ));
  const [closedSections, setClosedSections] = useState<Set<SectionKey>>(() => new Set());
  const [editingName, setEditingName] = useState<EditingName | null>(null);
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(() => new Set());
  // 底部三个按钮共用一套开合：同时只开一个面板，外部点击和 Esc 的处理也只写一份。
  const [openPanel, setOpenPanel] = useState<BottomPanel>(null);
  const [taskDraft, setTaskDraft] = useState<ShellTask>(() => armedCompletionTask ?? appSettings.completionTask ?? { shell: "cmd", command: "" });
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [pinDropSection, setPinDropSection] = useState<SectionKey | null>(null);
  const draggedItemRef = useRef<DragItem | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openPanel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPanel(null);
    };
    // 点面板和底部按钮以外的任何地方都收起来：用 pointerdown 而不是 click，按下就收，底下那一下点击照常生效。
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // 盖在上面的模态框（更新提示、权限询问等）由它自己接管这次点击，不该顺手把背后的面板收起来。
      if (!target || settingsRef.current?.contains(target) || target.closest("[aria-modal]")) return;
      setOpenPanel(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [openPanel]);

  // 只在切换项目时展开目标，消息或标题更新不能撤销用户刚做的收起操作。
  useEffect(() => {
    if (!activeProjectId) return;
    setClosedProjects((current) => {
      if (!current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.delete(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  const toggleProject = (projectId: string) => {
    setClosedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const setSectionProjectsExpanded = (section: SectionKey, sectionProjects: Project[], expanded: boolean) => {
    setClosedProjects((current) => {
      const next = new Set(current);
      for (const project of sectionProjects) {
        if (expanded) next.delete(project.id);
        else next.add(project.id);
      }
      return next;
    });
    if (expanded) {
      setClosedSections((current) => {
        if (!current.has(section)) return current;
        const next = new Set(current);
        next.delete(section);
        return next;
      });
    }
  };

  const toggleSection = (section: SectionKey) => {
    setClosedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const saveEditingName = (editing: EditingName) => {
    if (editing.kind === "project") onRenameProject(editing.id, editing.value);
    else onRenameConversation(editing.id, editing.value);
    setEditingName(null);
  };

  const refreshProject = async (projectId: string) => {
    if (refreshingProjects.has(projectId)) return;
    setRefreshingProjects((current) => new Set(current).add(projectId));
    try {
      await onRefreshProject(projectId);
    } finally {
      setRefreshingProjects((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
    }
  };

  const renameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, editing: EditingName) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveEditingName(editing);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditingName(null);
    }
  };

  const clearDrag = () => {
    draggedItemRef.current = null;
    dropTargetRef.current = null;
    setDraggedItem(null);
    setDropTarget(null);
    setPinDropSection(null);
  };

  // 拖到「置顶」标题 = 置顶；拖到「项目」标题 = 取消置顶。替代了过去拖到唯一标题的做法。
  const dragOverPinTarget = (event: React.DragEvent<HTMLElement>, section: SectionKey) => {
    const source = draggedItemRef.current;
    if (!source) return;
    const wantPinned = section === "pinned";
    if (source.pinned === wantPinned) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    updateDropTarget(null);
    setPinDropSection(section);
  };

  const dropOnPinTarget = (event: React.DragEvent<HTMLElement>, section: SectionKey) => {
    const source = draggedItemRef.current;
    if (!source) return;
    const wantPinned = section === "pinned";
    if (source.pinned === wantPinned) return;
    event.preventDefault();
    event.stopPropagation();
    if (source.kind === "project") onToggleProjectPinned(source.id);
    else onToggleConversationPinned(source.projectId, source.id);
    clearDrag();
  };

  const sameDragScope = (source: DragItem | null, target: DragItem) => {
    if (!source || source.kind !== target.kind) return false;
    // 三个区段各自排序：跨区段拖拽由标题栏负责改置顶，不走重排。
    if (source.section !== target.section) return false;
    if (source.kind === "conversation" && target.kind === "conversation") {
      return source.projectId === target.projectId;
    }
    return source.kind === "project" && target.kind === "project";
  };

  const updateDropTarget = (target: DropTarget | null) => {
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  const commitDrop = (source: DragItem, target: DragItem, position: ReorderPosition) => {
    if (!sameDragScope(source, target) || source.id === target.id) return;
    if (source.kind === "project" && target.kind === "project") {
      onReorderProject(source.id, target.id, position);
    } else if (source.kind === "conversation" && target.kind === "conversation") {
      onReorderConversation(source.projectId, source.id, target.id, position);
    }
  };

  const nearestDropTarget = (
    clientY: number,
    candidates: Array<{ element: HTMLElement; item: DragItem }>,
  ) => {
    const source = draggedItemRef.current;
    const compatible = candidates.filter(({ item }) => sameDragScope(source, item) && source?.id !== item.id);
    if (compatible.length === 0) {
      updateDropTarget(null);
      return;
    }
    const nearest = compatible.reduce((best, candidate) => {
      const bounds = candidate.element.getBoundingClientRect();
      const distance = Math.abs(clientY - (bounds.top + bounds.height / 2));
      return distance < best.distance ? { candidate, bounds, distance } : best;
    }, (() => {
      const candidate = compatible[0];
      const bounds = candidate.element.getBoundingClientRect();
      return { candidate, bounds, distance: Math.abs(clientY - (bounds.top + bounds.height / 2)) };
    })());
    updateDropTarget({
      ...nearest.candidate.item,
      position: clientY < nearest.bounds.top + nearest.bounds.height / 2 ? "before" : "after",
    });
  };

  const startDrag = (event: React.DragEvent<HTMLButtonElement>, item: DragItem) => {
    draggedItemRef.current = item;
    setDraggedItem(item);
    updateDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
  };

  const dragOver = (event: React.DragEvent<HTMLElement>, target: DragItem) => {
    const source = draggedItemRef.current;
    if (!sameDragScope(source, target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (!source || source.id === target.id) {
      updateDropTarget(null);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const position: ReorderPosition = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    updateDropTarget({ ...target, position });
  };

  const dropItem = (event: React.DragEvent<HTMLElement>, target: DragItem) => {
    const source = draggedItemRef.current;
    if (!sameDragScope(source, target) || !source) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const position: ReorderPosition = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    commitDrop(source, target, position);
    clearDrag();
  };

  const dragOverSidebar = (event: React.DragEvent<HTMLElement>) => {
    const source = draggedItemRef.current;
    if (!source) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const eventTarget = event.target instanceof Element ? event.target : null;
    // 标题栏那一下由 dragOverPinTarget 接管，这里不要抢着算重排位置。
    if (eventTarget?.closest(".sidebar-section-label")) return;
    setPinDropSection(null);
    const scope = event.currentTarget.querySelector<HTMLElement>(`[data-section="${source.section}"]`);
    if (!scope) {
      updateDropTarget(null);
      return;
    }
    if (source.kind === "conversation") {
      const project = projects.find((item) => item.id === source.projectId);
      if (!project) {
        updateDropTarget(null);
        return;
      }
      const rows = Array.from(scope.querySelectorAll<HTMLElement>(`.task-row[data-project-id="${source.projectId}"]`));
      const candidates = rows.flatMap((element) => {
        const conversation = project.conversations.find((item) => item.id === element.dataset.conversationId);
        return conversation ? [{
          element,
          item: {
            kind: "conversation" as const,
            projectId: project.id,
            id: conversation.id,
            pinned: Boolean(conversation.pinned),
            section: source.section,
          },
        }] : [];
      });
      nearestDropTarget(event.clientY, candidates);
      return;
    }
    const groups = Array.from(scope.querySelectorAll<HTMLElement>(".project-list > .project-group"));
    const candidates = groups.flatMap((group) => {
      const project = projects.find((item) => item.id === group.dataset.projectId);
      const row = group.querySelector<HTMLElement>(".project-row");
      return project && row ? [{
        element: row,
        item: { kind: "project" as const, id: project.id, pinned: Boolean(project.pinned), section: source.section },
      }] : [];
    });
    nearestDropTarget(event.clientY, candidates);
  };

  const dropOnSidebar = (event: React.DragEvent<HTMLElement>) => {
    const source = draggedItemRef.current;
    const target = dropTargetRef.current;
    if (!source) return;
    event.preventDefault();
    if (target) commitDrop(source, target, target.position);
    clearDrag();
  };

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <button className="icon-button" onClick={onToggle} title="展开侧边栏"><PanelLeftOpen size={18} /></button>
        <button className="icon-button new-icon" onClick={onNewProject} title="新建项目"><Plus size={18} /></button>
        <div className="sidebar-collapsed-spacer" />
        <button
          className="icon-button"
          onClick={() => {
            setOpenPanel("settings");
            onToggle();
          }}
          title="设置"
        >
          <Settings size={17} />
        </button>
      </aside>
    );
  }

  const renderConversationRow = (
    conversation: Conversation,
    projectId: string,
    section: SectionKey,
    isLast: boolean,
    draggable: boolean,
  ) => {
    const conversationDragItem: DragItem = {
      kind: "conversation",
      projectId,
      id: conversation.id,
      pinned: Boolean(conversation.pinned),
      section,
    };
    const conversationDropPosition = dropTarget?.kind === "conversation" &&
      dropTarget.projectId === projectId && dropTarget.id === conversation.id && dropTarget.section === section
      ? dropTarget.position
      : null;
    const editing = editingName?.kind === "conversation" && editingName.id === conversation.id && editingName.section === section;
    return (
      <div
        className={`task-row ${activeConversationId === conversation.id ? "active" : ""} ${runningConversationIds.has(conversation.id) ? "running" : ""} ${conversation.pinned ? "pinned" : ""} ${draggedItem?.kind === "conversation" && draggedItem.id === conversation.id && draggedItem.section === section ? "dragging" : ""} ${conversationDropPosition ? `drop-${conversationDropPosition}` : ""}`}
        data-conversation-id={conversation.id}
        data-project-id={projectId}
        data-pinned={conversation.pinned ? "true" : "false"}
        key={conversation.id}
        onDragOver={draggable ? (event) => dragOver(event, conversationDragItem) : undefined}
        onDrop={draggable ? (event) => dropItem(event, conversationDragItem) : undefined}
      >
        <span className="tree-branch" aria-hidden="true">{isLast ? "└─" : "├─"}</span>
        {editing || !draggable ? null : (
          <button
            aria-label={`拖动会话 ${conversation.title} 排序`}
            className="reorder-handle task-drag-handle"
            draggable
            onDragEnd={clearDrag}
            onDragStart={(event) => startDrag(event, conversationDragItem)}
            title="拖动排序；拖到「项目」标题取消置顶"
            type="button"
          >
            <GripVertical size={12} />
          </button>
        )}
        {editing ? (
          <div className="rename-editor conversation-rename-editor">
            <MessageSquareText size={14} />
            <input
              aria-label="对话名称"
              autoFocus
              maxLength={100}
              value={editingName.value}
              onChange={(event) => setEditingName({ ...editingName, value: event.target.value })}
              onKeyDown={(event) => renameKeyDown(event, editingName)}
              onBlur={() => saveEditingName(editingName)}
            />
          </div>
        ) : (
          <>
            <button className="task-select" onClick={() => onSelectConversation(conversation.id)}>
              {runningConversationIds.has(conversation.id)
                ? <LoaderCircle className="conversation-running-icon" size={14} aria-label="会话正在运行" />
                : <MessageSquareText size={14} />}
              <span>
                <span className="conversation-title-line">
                  <strong>{conversation.title}</strong>
                  {conversation.pinned ? <Pin className="pin-indicator" size={10} aria-label="已置顶会话" /> : null}
                </span>
                <small className="conversation-meta">
                  {conversation.source === "claude" ? <span>Claude CLI</span> : null}
                  {conversation.gitBranch ? <span title={conversation.gitBranch}>{conversation.gitBranch}</span> : null}
                  <time dateTime={new Date(conversation.updatedAt).toISOString()}>{formatConversationTime(conversation.updatedAt)}</time>
                </small>
              </span>
            </button>
            <button
              aria-label={conversation.pinned ? `取消置顶会话 ${conversation.title}` : `置顶会话 ${conversation.title}`}
              aria-pressed={Boolean(conversation.pinned)}
              className="task-pin"
              onClick={() => onToggleConversationPinned(projectId, conversation.id)}
              title={conversation.pinned ? "取消置顶会话" : "置顶会话"}
            >
              {conversation.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button
              className="task-rename"
              onClick={() => setEditingName({ kind: "conversation", id: conversation.id, section, value: conversation.title })}
              title="重命名对话"
            >
              <Pencil size={13} />
            </button>
            <button
              className="task-delete"
              onClick={() => onDeleteConversation(projectId, conversation.id)}
              title={conversation.sessionId ? "删除对话和 CLI /resume 历史" : "删除对话"}
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
    );
  };

  const renderProjectGroup = (project: Project, section: SectionKey, conversations: Conversation[]) => {
    const closed = closedProjects.has(project.id);
    const projectRunning = project.conversations.some((conversation) => runningConversationIds.has(conversation.id));
    const projectDragItem: DragItem = { kind: "project", id: project.id, pinned: Boolean(project.pinned), section };
    const projectDropPosition = dropTarget?.kind === "project" && dropTarget.id === project.id && dropTarget.section === section
      ? dropTarget.position
      : null;
    const editing = editingName?.kind === "project" && editingName.id === project.id && editingName.section === section;
    return (
      <section
        className={`project-group ${project.pinned ? "pinned" : ""} ${draggedItem?.kind === "project" && draggedItem.id === project.id && draggedItem.section === section ? "dragging" : ""} ${projectDropPosition ? `drop-${projectDropPosition}` : ""}`}
        data-pinned={project.pinned ? "true" : "false"}
        data-project-id={project.id}
        key={project.id}
      >
        <div
          className={`project-row ${activeProjectId === project.id && !activeConversationId ? "active" : ""}`}
          onDragOver={(event) => dragOver(event, projectDragItem)}
          onDrop={(event) => dropItem(event, projectDragItem)}
          onContextMenu={(event) => {
            event.preventDefault();
            onOpenProject(project.workspace);
          }}
          title="右键在文件管理器中打开"
        >
          {editing ? null : (
            <button
              aria-label={`拖动项目 ${project.customName ?? project.name} 排序`}
              className="reorder-handle project-drag-handle"
              draggable
              onDragEnd={clearDrag}
              onDragStart={(event) => startDrag(event, projectDragItem)}
              title="拖动排序（拖到「置顶」标题可置顶，拖到「项目」标题可取消置顶）"
              type="button"
            >
              <GripVertical size={13} />
            </button>
          )}
          {editing ? (
            <div className="rename-editor project-rename-editor">
              <Folder size={14} />
              <input
                aria-label="项目名称"
                autoFocus
                value={editingName.value}
                onChange={(event) => setEditingName({ ...editingName, value: event.target.value })}
                onKeyDown={(event) => renameKeyDown(event, editingName)}
                onBlur={() => saveEditingName(editingName)}
              />
            </div>
          ) : (
            <button
              className="project-toggle"
              aria-expanded={!closed}
              onClick={() => toggleProject(project.id)}
              title={project.workspace}
            >
              {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <Folder size={14} />
              <span className="project-name">
                <strong>{project.customName ?? project.name}</strong>
                {project.customName ? <small>{project.name}</small> : null}
              </span>
              {project.pinned ? <Pin className="pin-indicator" size={11} aria-label="已置顶项目" /> : null}
              {projectRunning ? <LoaderCircle className="project-running-icon" size={13} aria-label="项目中有会话正在运行" /> : null}
            </button>
          )}
          {editing ? null : (
            <>
              <button className="project-action" onClick={() => onNewConversation(project.id)} title="新建对话"><Plus size={14} /></button>
              <button
                aria-label={`刷新 ${project.customName ?? project.name} 的 Claude CLI 会话`}
                className="project-action refresh"
                disabled={refreshingProjects.has(project.id)}
                onClick={() => { void refreshProject(project.id); }}
                title="刷新 Claude CLI 会话"
              >
                <RefreshCw className={refreshingProjects.has(project.id) ? "spinning" : undefined} size={13} />
              </button>
              <button
                aria-label={project.pinned ? `取消置顶项目 ${project.customName ?? project.name}` : `置顶项目 ${project.customName ?? project.name}`}
                aria-pressed={Boolean(project.pinned)}
                className="project-action pin"
                onClick={() => onToggleProjectPinned(project.id)}
                title={project.pinned ? "取消置顶项目" : "置顶项目"}
              >
                {project.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
              <button
                className="project-action rename"
                onClick={() => setEditingName({ kind: "project", id: project.id, section, value: project.customName ?? project.name })}
                title="重命名项目"
              >
                <Pencil size={13} />
              </button>
              <button className="project-action delete" onClick={() => onDeleteProject(project.id)} title="删除项目"><Trash2 size={13} /></button>
            </>
          )}
        </div>
        {!closed ? (
          <div className="conversation-rows project-conversations">
            {conversations.map((conversation, index) =>
              renderConversationRow(conversation, project.id, section, index === conversations.length - 1, true))}
            {conversations.length === 0 ? (
              <button className="empty-conversation" onClick={() => onNewConversation(project.id)}>新建对话</button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  };

  // 临时对话是内建分组，既不出现在「项目」段，也不参与项目置顶。
  const scratchProject = projects.find((project) => project.kind === "scratch") ?? null;
  const folderProjects = projects.filter((project) => project.kind !== "scratch");
  const pinnedProjects = folderProjects.filter((project) => project.pinned);
  const unpinnedProjects = folderProjects.filter((project) => !project.pinned);
  // 置顶区里的对话只从「未置顶项目」里捞：置顶项目已经整个搬进来了，它的对话跟着走。
  const pinnedConversations = [...unpinnedProjects, ...(scratchProject ? [scratchProject] : [])].flatMap((project) =>
    project.conversations.filter((conversation) => conversation.pinned).map((conversation) => ({ conversation, projectId: project.id })));
  // 已置顶的临时对话只留在置顶段，不在这里重复渲染。
  const scratchConversations = scratchProject?.conversations.filter((conversation) => !conversation.pinned) ?? [];
  const pinnedEmpty = pinnedProjects.length === 0 && pinnedConversations.length === 0;
  // 标题栏既要能折叠，又要挂一个「新建」入口，所以拆成两层：外层保留 .sidebar-section-label 承接拖拽，内层按钮负责折叠。
  const sectionLabel = (
    section: SectionKey,
    text: string,
    count: number,
    options: { pinTarget?: boolean; action?: { label: string; onClick(): void }; projects?: Project[] } = {},
  ) => (
    <div
      className={`sidebar-section-label ${options.pinTarget && pinDropSection === section ? "pin-drop" : ""}`}
      data-section-label={section}
      onDragOver={options.pinTarget ? (event) => dragOverPinTarget(event, section) : undefined}
      onDrop={options.pinTarget ? (event) => dropOnPinTarget(event, section) : undefined}
    >
      <button className="sidebar-section-toggle" aria-expanded={!closedSections.has(section)} onClick={() => toggleSection(section)} type="button">
        {closedSections.has(section) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span>{text}</span>
        <span className="sidebar-section-count">{count}</span>
      </button>
      {options.action ? (
        <button
          aria-label={options.action.label}
          className="sidebar-section-action"
          onClick={options.action.onClick}
          title={options.action.label}
          type="button"
        >
          <Plus size={13} />
        </button>
      ) : null}
      {options.projects ? [true, false].map((expanded) => {
        const sectionProjects = options.projects;
        if (!sectionProjects) return null;
        const label = `${expanded ? "展开" : "收起"}${text}分组的所有项目`;
        const Icon = expanded ? ChevronsUpDown : ChevronsDownUp;
        return (
          <button
            key={String(expanded)}
            aria-label={label}
            className="sidebar-section-action sidebar-section-projects-action"
            disabled={sectionProjects.length === 0}
            onClick={() => setSectionProjectsExpanded(section, sectionProjects, expanded)}
            title={label}
            type="button"
          >
            <Icon size={13} />
          </button>
        );
      }) : null}
    </div>
  );

  return (
    <aside className="sidebar" onDragOver={dragOverSidebar} onDrop={dropOnSidebar}>
      <div className="sidebar-brand">
        <div className="brand-mark"><Sparkles size={16} /></div>
        <span>claude-cli-UI</span>
        <button className="icon-button sidebar-toggle" onClick={onToggle} title="收起侧边栏"><PanelLeftClose size={18} /></button>
      </div>
      <div className="sidebar-sections">
        <div className="sidebar-section" data-section-group="pinned">
          {sectionLabel("pinned", "置顶", pinnedProjects.length + pinnedConversations.length, { pinTarget: true, projects: pinnedProjects })}
          {!closedSections.has("pinned") ? (
            <nav className="project-list" data-section="pinned" aria-label="置顶">
              {pinnedEmpty ? <div className="task-list-empty">把项目或对话拖到这里置顶</div> : null}
              {pinnedProjects.map((project) => renderProjectGroup(project, "pinned", project.conversations))}
              {pinnedConversations.length > 0 ? (
                <div className="conversation-rows loose-conversations">
                  {pinnedConversations.map(({ conversation, projectId }, index) =>
                    renderConversationRow(conversation, projectId, "pinned", index === pinnedConversations.length - 1, true))}
                </div>
              ) : null}
            </nav>
          ) : null}
        </div>
        <div className="sidebar-section" data-section-group="projects">
          {sectionLabel("projects", "项目", unpinnedProjects.length, {
            pinTarget: true,
            action: { label: "新建项目", onClick: onNewProject },
            projects: unpinnedProjects,
          })}
          {!closedSections.has("projects") ? (
            <nav className="project-list" data-section="projects" aria-label="项目列表">
              {unpinnedProjects.length === 0 ? <div className="task-list-empty">还没有项目</div> : null}
              {unpinnedProjects.map((project) =>
                renderProjectGroup(project, "projects", project.conversations.filter((conversation) => !conversation.pinned)))}
            </nav>
          ) : null}
        </div>
        <div className="sidebar-section" data-section-group="scratch">
          {sectionLabel("scratch", "临时对话", scratchConversations.length, {
            action: { label: "新建临时对话", onClick: onNewScratchConversation },
          })}
          {!closedSections.has("scratch") ? (
            <nav className="project-list" data-section="scratch" aria-label="临时对话">
              {scratchConversations.length === 0 ? <div className="task-list-empty">不用选文件夹，直接开一次对话</div> : null}
              {scratchConversations.length > 0 && scratchProject ? (
                <div className="conversation-rows loose-conversations">
                  {scratchConversations.map((conversation, index) =>
                    renderConversationRow(conversation, scratchProject.id, "scratch", index === scratchConversations.length - 1, true))}
                </div>
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
      <div className="sidebar-bottom">
        <div className="settings-anchor" ref={settingsRef}>
          {openPanel === "settings" ? (
            <section className="settings-popover" aria-label="设置">
              <div className="settings-heading">设置</div>
              <div className="setting-group">
                <span className="setting-label">关闭窗口</span>
                <div className="segmented-control" role="group" aria-label="关闭窗口行为">
                  <button
                    className={appSettings.closeBehavior === "tray" ? "active" : ""}
                    onClick={() => onSettingsChange({ ...appSettings, closeBehavior: "tray" })}
                    type="button"
                  >
                    托盘后台
                  </button>
                  <button
                    className={appSettings.closeBehavior === "quit" ? "active" : ""}
                    onClick={() => onSettingsChange({ ...appSettings, closeBehavior: "quit" })}
                    type="button"
                  >
                    退出应用
                  </button>
                </div>
              </div>
              <label className="setting-toggle-row">
                <span>后台会话完成提醒</span>
                <input
                  checked={appSettings.notifyOnCompletion}
                  onChange={(event) => onSettingsChange({ ...appSettings, notifyOnCompletion: event.target.checked })}
                  type="checkbox"
                />
                <span className="toggle-track" aria-hidden="true"><span /></span>
              </label>
              <div className="setting-update-row">
                <span>
                  <strong>应用更新</strong>
                  <small>{updateStatusText(updateState)}</small>
                </span>
                <button
                  className="setting-update-button"
                  disabled={updateState.phase === "checking"}
                  onClick={onCheckForUpdates}
                  type="button"
                >
                  <RefreshCw className={updateState.phase === "checking" ? "spinning" : undefined} size={13} />
                  {updateState.phase === "available" || updateState.phase === "downloading" || updateState.phase === "ready" ? "查看" : "检查"}
                </button>
              </div>
              <div className="setting-link-row">
                <button
                  className="setting-link-button"
                  onClick={() => void window.claudeDesk.openProjectLink("repository")}
                  type="button"
                >
                  <Star size={13} />
                  项目源码
                </button>
                <button
                  className="setting-link-button"
                  onClick={() => void window.claudeDesk.openProjectLink("issues")}
                  type="button"
                >
                  <MessageCircleQuestion size={13} />
                  问题反馈
                </button>
              </div>
            </section>
          ) : null}
          {openPanel === "schedule" ? (
            <section className="settings-popover" aria-label="定时任务">
              <div className="settings-heading">定时任务</div>
              {scheduledPrompts.length === 0 ? (
                <div className="schedule-task-empty">还没有定时任务。在发送框底部的闹钟按钮里配一句话和时间。</div>
              ) : (
                <div className="schedule-task-list">
                  {scheduledPrompts.map((item) => (
                    <div className="schedule-task-item" key={item.id}>
                      <button
                        className="schedule-task-open"
                        onClick={() => {
                          onOpenScheduledPrompt(item);
                          setOpenPanel(null);
                        }}
                        title="跳到这个对话"
                        type="button"
                      >
                        <strong>{item.time}</strong>
                        <span>
                          <small>{item.conversationTitle}</small>
                          <em>{item.prompt}</em>
                        </span>
                      </button>
                      <button
                        aria-label={`取消 ${item.time} 的定时任务`}
                        className="schedule-task-cancel"
                        onClick={() => onCancelScheduledPrompt(item.id)}
                        title="取消"
                        type="button"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}
          {openPanel === "completion" ? (
            <section className="settings-popover" aria-label="回答完成后执行">
              <div className="settings-heading">全部回答完成后执行</div>
              <div className="completion-task-note">
                {armedCompletionTask
                  ? "已布置：等所有对话都答完就执行下面这条命令。"
                  : anyConversationRunning
                    ? "等所有对话都答完后执行一条本机命令，适合挂着长回答去睡觉。"
                    : "现在没有对话在回答，布置了也没有等待的对象，所以暂时不能设置。"}
              </div>
              <div className="setting-group">
                <span className="setting-label">执行方式</span>
                <div className="segmented-control" role="group" aria-label="执行方式">
                  <button
                    className={taskDraft.shell === "cmd" ? "active" : ""}
                    disabled={!anyConversationRunning || Boolean(armedCompletionTask)}
                    onClick={() => setTaskDraft((draft) => ({ ...draft, shell: "cmd" }))}
                    type="button"
                  >
                    CMD
                  </button>
                  <button
                    className={taskDraft.shell === "powershell" ? "active" : ""}
                    disabled={!anyConversationRunning || Boolean(armedCompletionTask)}
                    onClick={() => setTaskDraft((draft) => ({ ...draft, shell: "powershell" }))}
                    type="button"
                  >
                    PowerShell
                  </button>
                </div>
              </div>
              <input
                aria-label="要执行的命令"
                className="completion-task-input"
                disabled={!anyConversationRunning || Boolean(armedCompletionTask)}
                onChange={(event) => setTaskDraft((draft) => ({ ...draft, command: event.target.value }))}
                placeholder="shutdown /s /t 60"
                spellCheck={false}
                type="text"
                value={armedCompletionTask ? armedCompletionTask.command : taskDraft.command}
              />
              <div className="completion-task-examples">
                {COMPLETION_TASK_EXAMPLES.map((example) => (
                  <button
                    disabled={!anyConversationRunning || Boolean(armedCompletionTask)}
                    key={example.label}
                    onClick={() => setTaskDraft(example.task)}
                    title={example.task.command}
                    type="button"
                  >
                    {example.label}
                  </button>
                ))}
              </div>
              <button
                className="completion-task-submit"
                disabled={armedCompletionTask ? false : (!anyConversationRunning || !taskDraft.command.trim())}
                onClick={() => onArmCompletionTask(armedCompletionTask ? null : { ...taskDraft, command: taskDraft.command.trim() })}
                type="button"
              >
                <PowerOff size={13} />
                <span>{armedCompletionTask ? "撤销布置" : "答完后执行"}</span>
              </button>
            </section>
          ) : null}
          <div className="sidebar-tools">
            <button className={`settings-trigger ${openPanel === "settings" ? "active" : ""}`} data-panel="settings" onClick={() => setOpenPanel((panel) => panel === "settings" ? null : "settings")} type="button">
              <Settings size={15} />
              <span>设置</span>
            </button>
            <button
              className={`settings-trigger ${openPanel === "schedule" ? "active" : ""}`}
              data-panel="schedule"
              onClick={() => setOpenPanel((panel) => panel === "schedule" ? null : "schedule")}
              title="查看、取消还没发送的定时任务"
              type="button"
            >
              <AlarmClock size={15} />
              <span>定时任务</span>
              {scheduledPrompts.length > 0 ? <em className="sidebar-tool-count">{scheduledPrompts.length}</em> : null}
            </button>
            <button
              className={`settings-trigger ${openPanel === "completion" ? "active" : ""} ${armedCompletionTask ? "armed" : ""}`}
              data-panel="completion"
              onClick={() => setOpenPanel((panel) => {
                if (panel === "completion") return null;
                // 设置是异步读进来的，开面板时再把上次用过的命令填上，比挂载那一刻去读可靠。
                setTaskDraft((draft) => draft.command ? draft : (appSettings.completionTask ?? draft));
                return "completion";
              })}
              title="全部对话回答完成时执行一条本机命令"
              type="button"
            >
              <PowerOff size={15} />
              <span>答完执行</span>
            </button>
          </div>
        </div>
        <div className="sidebar-version">claude-cli-UI v{appVersion || "…"}</div>
        <div className="sidebar-footer">
          <span className={`status-dot ${cliInfo && !cliInfo.available ? "off" : ""}`} />
          {cliInfo ? (cliInfo.available ? `Claude CLI ${cliInfo.version ?? ""}` : "未找到 Claude CLI") : "正在检测 Claude CLI"}
        </div>
      </div>
    </aside>
  );
}
