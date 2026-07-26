import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Project } from "./types";

interface Props {
  projects: Project[];
  activeConversationId: string | null;
  collapsed: boolean;
  cliInfo: { available: boolean; version?: string } | null;
  onSelectConversation(id: string): void;
  onNewProject(): void;
  onNewConversation(projectId: string): void;
  onOpenProject(workspace: string): void;
  onDeleteConversation(projectId: string, conversationId: string): void;
  onDeleteProject(projectId: string): void;
  onRenameConversation(conversationId: string, title: string): void;
  onRenameProject(projectId: string, name: string): void;
  onToggle(): void;
}

interface EditingName {
  kind: "project" | "conversation";
  id: string;
  value: string;
}

export default function Sidebar({
  projects,
  activeConversationId,
  collapsed,
  cliInfo,
  onSelectConversation,
  onNewProject,
  onNewConversation,
  onOpenProject,
  onDeleteConversation,
  onDeleteProject,
  onRenameConversation,
  onRenameProject,
  onToggle,
}: Props) {
  const [closedProjects, setClosedProjects] = useState<Set<string>>(() => new Set());
  const [editingName, setEditingName] = useState<EditingName | null>(null);

  useEffect(() => {
    const activeProject = projects.find((project) => project.conversations.some((item) => item.id === activeConversationId));
    if (!activeProject) return;
    setClosedProjects((current) => {
      if (!current.has(activeProject.id)) return current;
      const next = new Set(current);
      next.delete(activeProject.id);
      return next;
    });
  }, [projects, activeConversationId]);

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
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark"><Sparkles size={16} /></div>
        <span>Claude Desk</span>
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
          return (
            <section className="project-group" key={project.id}>
              <div
                className="project-row"
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
                  <button className="project-toggle" onClick={() => toggleProject(project.id)} title={project.workspace}>
                    {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <Folder size={14} />
                    <span className="project-name">
                      <strong>{project.customName ?? project.name}</strong>
                      {project.customName ? <small>{project.name}</small> : null}
                    </span>
                  </button>
                )}
                {editingName?.kind === "project" && editingName.id === project.id ? null : (
                  <>
                    <button className="project-action" onClick={() => onNewConversation(project.id)} title="新建对话"><Plus size={14} /></button>
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
                    <div className={`task-row ${activeConversationId === conversation.id ? "active" : ""}`} key={conversation.id}>
                      {editingName?.kind === "conversation" && editingName.id === conversation.id ? (
                        <div className="rename-editor conversation-rename-editor">
                          <MessageSquareText size={14} />
                          <input
                            aria-label="对话名称"
                            autoFocus
                            value={editingName.value}
                            onChange={(event) => setEditingName({ ...editingName, value: event.target.value })}
                            onKeyDown={(event) => renameKeyDown(event, editingName)}
                            onBlur={() => saveEditingName(editingName)}
                          />
                        </div>
                      ) : (
                        <>
                          <button className="task-select" onClick={() => onSelectConversation(conversation.id)}>
                            <MessageSquareText size={14} />
                            <span>
                              <strong>{conversation.title}</strong>
                              {conversation.source === "claude" ? <small>Claude CLI</small> : null}
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
                            title="删除对话"
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
      <div className="sidebar-footer">
        <span className={`status-dot ${cliInfo && !cliInfo.available ? "off" : ""}`} />
        {cliInfo ? (cliInfo.available ? `Claude CLI ${cliInfo.version ?? ""}` : "未找到 Claude CLI") : "正在检测 Claude CLI"}
      </div>
    </aside>
  );
}
