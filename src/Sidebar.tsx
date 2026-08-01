import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  GripVertical,
  LoaderCircle,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { AppSettings, AppUpdateState, Project, ReorderPosition } from "./types";

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
  onSelectConversation(id: string): void;
  onNewProject(): void;
  onNewConversation(projectId: string): void;
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
  onCheckForUpdates(): void;
  onToggle(): void;
}

interface EditingName {
  kind: "project" | "conversation";
  id: string;
  value: string;
}

type DragItem = {
  kind: "project";
  id: string;
  pinned: boolean;
} | {
  kind: "conversation";
  projectId: string;
  id: string;
  pinned: boolean;
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
  onSelectConversation,
  onNewProject,
  onNewConversation,
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
  onCheckForUpdates,
  onToggle,
}: Props) {
  const [closedProjects, setClosedProjects] = useState<Set<string>>(() => new Set());
  const [editingName, setEditingName] = useState<EditingName | null>(null);
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const draggedItemRef = useRef<DragItem | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen]);

  useEffect(() => {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    if (!activeProject) return;
    setClosedProjects((current) => {
      if (!current.has(activeProject.id)) return current;
      const next = new Set(current);
      next.delete(activeProject.id);
      return next;
    });
  }, [projects, activeProjectId]);

  const toggleProject = (projectId: string) => {
    setClosedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
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
  };

  const sameDragScope = (source: DragItem | null, target: DragItem) => {
    if (!source || source.kind !== target.kind) return false;
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
    if (source.kind === "conversation") {
      const group = eventTarget?.closest<HTMLElement>(".project-group");
      if (!group || group.dataset.projectId !== source.projectId) {
        updateDropTarget(null);
        return;
      }
      const project = projects.find((item) => item.id === source.projectId);
      if (!project) {
        updateDropTarget(null);
        return;
      }
      const rows = Array.from(group.querySelectorAll<HTMLElement>(".task-row"));
      const candidates = rows.flatMap((element) => {
        const conversation = project.conversations.find((item) => item.id === element.dataset.conversationId);
        return conversation ? [{
          element,
          item: {
            kind: "conversation" as const,
            projectId: project.id,
            id: conversation.id,
            pinned: Boolean(conversation.pinned),
          },
        }] : [];
      });
      nearestDropTarget(event.clientY, candidates);
      return;
    }
    if (!eventTarget?.closest(".sidebar-section-label, .project-list")) {
      updateDropTarget(null);
      return;
    }
    const groups = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".project-list > .project-group"));
    const candidates = groups.flatMap((group) => {
      const project = projects.find((item) => item.id === group.dataset.projectId);
      const row = group.querySelector<HTMLElement>(".project-row");
      return project && row ? [{
        element: row,
        item: { kind: "project" as const, id: project.id, pinned: Boolean(project.pinned) },
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
            setSettingsOpen(true);
            onToggle();
          }}
          title="设置"
        >
          <Settings size={17} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" onDragOver={dragOverSidebar} onDrop={dropOnSidebar}>
      <div className="sidebar-brand">
        <div className="brand-mark"><Sparkles size={16} /></div>
        <span>claude-cli-UI</span>
        <button className="icon-button sidebar-toggle" onClick={onToggle} title="收起侧边栏"><PanelLeftClose size={18} /></button>
      </div>
      <button className="new-task-button" onClick={onNewProject}>
        <Plus size={16} />
        <span>新建项目</span>
      </button>
      <div className="sidebar-section-label">项目</div>
      <nav className="project-list" aria-label="项目列表">
        {projects.length === 0 ? <div className="task-list-empty">还没有项目</div> : null}
        {projects.map((project) => {
          const closed = closedProjects.has(project.id);
          const projectRunning = project.conversations.some((conversation) => runningConversationIds.has(conversation.id));
          const projectDragItem: DragItem = { kind: "project", id: project.id, pinned: Boolean(project.pinned) };
          const projectDropPosition = dropTarget?.kind === "project" && dropTarget.id === project.id
            ? dropTarget.position
            : null;
          return (
            <section
              className={`project-group ${project.pinned ? "pinned" : ""} ${draggedItem?.kind === "project" && draggedItem.id === project.id ? "dragging" : ""} ${projectDropPosition ? `drop-${projectDropPosition}` : ""}`}
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
                {editingName?.kind === "project" && editingName.id === project.id ? null : (
                  <button
                    aria-label={`拖动项目 ${project.customName ?? project.name} 排序`}
                    className="reorder-handle project-drag-handle"
                    draggable
                    onDragEnd={clearDrag}
                    onDragStart={(event) => startDrag(event, projectDragItem)}
                    title="拖动排序（拖到置顶区域可置顶，拖回普通区域可取消置顶）"
                    type="button"
                  >
                    <GripVertical size={13} />
                  </button>
                )}
                {editingName?.kind === "project" && editingName.id === project.id ? (
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
                {editingName?.kind === "project" && editingName.id === project.id ? null : (
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
                      onClick={() => setEditingName({ kind: "project", id: project.id, value: project.customName ?? project.name })}
                      title="重命名项目"
                    >
                      <Pencil size={13} />
                    </button>
                    <button className="project-action delete" onClick={() => onDeleteProject(project.id)} title="删除项目"><Trash2 size={13} /></button>
                  </>
                )}
              </div>
              {!closed ? (
                <div className="project-conversations">
                  {project.conversations.map((conversation) => {
                    const conversationDragItem: DragItem = {
                      kind: "conversation",
                      projectId: project.id,
                      id: conversation.id,
                      pinned: Boolean(conversation.pinned),
                    };
                    const conversationDropPosition = dropTarget?.kind === "conversation" &&
                      dropTarget.projectId === project.id && dropTarget.id === conversation.id
                      ? dropTarget.position
                      : null;
                    return (
                    <div
                      className={`task-row ${activeConversationId === conversation.id ? "active" : ""} ${runningConversationIds.has(conversation.id) ? "running" : ""} ${conversation.pinned ? "pinned" : ""} ${draggedItem?.kind === "conversation" && draggedItem.id === conversation.id ? "dragging" : ""} ${conversationDropPosition ? `drop-${conversationDropPosition}` : ""}`}
                      data-conversation-id={conversation.id}
                      data-pinned={conversation.pinned ? "true" : "false"}
                      key={conversation.id}
                      onDragOver={(event) => dragOver(event, conversationDragItem)}
                      onDrop={(event) => dropItem(event, conversationDragItem)}
                    >
                      {editingName?.kind === "conversation" && editingName.id === conversation.id ? null : (
                        <button
                          aria-label={`拖动会话 ${conversation.title} 排序`}
                          className="reorder-handle task-drag-handle"
                          draggable
                          onDragEnd={clearDrag}
                          onDragStart={(event) => startDrag(event, conversationDragItem)}
                          title="拖动排序（仅限当前项目，拖到置顶区域可置顶）"
                          type="button"
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                      {editingName?.kind === "conversation" && editingName.id === conversation.id ? (
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
                            onClick={() => onToggleConversationPinned(project.id, conversation.id)}
                            title={conversation.pinned ? "取消置顶会话" : "置顶会话"}
                          >
                            {conversation.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                          </button>
                          <button
                            className="task-rename"
                            onClick={() => setEditingName({ kind: "conversation", id: conversation.id, value: conversation.title })}
                            title="重命名对话"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="task-delete"
                            onClick={() => onDeleteConversation(project.id, conversation.id)}
                            title={conversation.sessionId ? "删除对话和 CLI /resume 历史" : "删除对话"}
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                    );
                  })}
                  {project.conversations.length === 0 ? (
                    <button className="empty-conversation" onClick={() => onNewConversation(project.id)}>新建对话</button>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        {settingsOpen ? (
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
          </section>
        ) : null}
        <button className={`settings-trigger ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((value) => !value)} type="button">
          <Settings size={15} />
          <span>设置</span>
        </button>
        <div className="sidebar-version">claude-cli-UI v{appVersion || "…"}</div>
        <div className="sidebar-footer">
          <span className={`status-dot ${cliInfo && !cliInfo.available ? "off" : ""}`} />
          {cliInfo ? (cliInfo.available ? `Claude CLI ${cliInfo.version ?? ""}` : "未找到 Claude CLI") : "正在检测 Claude CLI"}
        </div>
      </div>
    </aside>
  );
}
