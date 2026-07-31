import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  LoaderCircle,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { AppSettings, Project } from "./types";

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  activeConversationId: string | null;
  appVersion: string;
  collapsed: boolean;
  cliInfo: { available: boolean; version?: string } | null;
  runningConversationIds: ReadonlySet<string>;
  appSettings: AppSettings;
  onSelectProject(id: string): void;
  onSelectConversation(id: string): void;
  onNewProject(): void;
  onNewConversation(projectId: string): void;
  onRefreshProject(projectId: string): Promise<void>;
  onOpenProject(workspace: string): void;
  onDeleteConversation(projectId: string, conversationId: string): void;
  onDeleteProject(projectId: string): void;
  onRenameConversation(conversationId: string, title: string): void;
  onRenameProject(projectId: string, name: string): void;
  onSettingsChange(settings: AppSettings): void;
  onToggle(): void;
}

interface EditingName {
  kind: "project" | "conversation";
  id: string;
  value: string;
}

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

export default function Sidebar({
  projects,
  activeProjectId,
  activeConversationId,
  appVersion,
  collapsed,
  cliInfo,
  runningConversationIds,
  appSettings,
  onSelectProject,
  onSelectConversation,
  onNewProject,
  onNewConversation,
  onRefreshProject,
  onOpenProject,
  onDeleteConversation,
  onDeleteProject,
  onRenameConversation,
  onRenameProject,
  onSettingsChange,
  onToggle,
}: Props) {
  const [closedProjects, setClosedProjects] = useState<Set<string>>(() => new Set());
  const [editingName, setEditingName] = useState<EditingName | null>(null);
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    <aside className="sidebar">
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
          return (
            <section className="project-group" key={project.id}>
              <div
                className={`project-row ${activeProjectId === project.id && !activeConversationId ? "active" : ""}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onOpenProject(project.workspace);
                }}
                title="右键在文件管理器中打开"
              >
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
                    onClick={() => {
                      onSelectProject(project.id);
                      toggleProject(project.id);
                    }}
                    title={project.workspace}
                  >
                    {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <Folder size={14} />
                    <span className="project-name">
                      <strong>{project.customName ?? project.name}</strong>
                      {project.customName ? <small>{project.name}</small> : null}
                    </span>
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
                  {project.conversations.map((conversation) => (
                    <div className={`task-row ${activeConversationId === conversation.id ? "active" : ""} ${runningConversationIds.has(conversation.id) ? "running" : ""}`} key={conversation.id}>
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
                              <strong>{conversation.title}</strong>
                              <small className="conversation-meta">
                                {conversation.source === "claude" ? <span>Claude CLI</span> : null}
                                {conversation.gitBranch ? <span title={conversation.gitBranch}>{conversation.gitBranch}</span> : null}
                                <time dateTime={new Date(conversation.updatedAt).toISOString()}>{formatConversationTime(conversation.updatedAt)}</time>
                              </small>
                            </span>
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
                  ))}
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
