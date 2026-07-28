import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("claudeDesk", {
  selectWorkspace: () => ipcRenderer.invoke("workspace:select"),
  openWorkspace: (workspace: string) => ipcRenderer.invoke("workspace:open", workspace),
  getClaudeInfo: () => ipcRenderer.invoke("claude:info"),
  getModels: (workspace: string) => ipcRenderer.invoke("claude:models", workspace),
  getClaudeSessions: (workspace: string) => ipcRenderer.invoke("claude:sessions", workspace),
  getClaudeSession: (workspace: string, sessionId: string) => ipcRenderer.invoke("claude:session", workspace, sessionId),
  getClaudeSessionHistories: (workspace: string) => ipcRenderer.invoke("claude:session-histories", workspace),
  renameClaudeSession: (workspace: string, sessionId: string, title: string) => ipcRenderer.invoke("claude:rename-session", workspace, sessionId, title),
  branchClaudeSession: (workspace: string, sessionId: string, userTurn: number, title: string) => ipcRenderer.invoke("claude:branch-session", workspace, sessionId, userTurn, title),
  deleteClaudeSession: (workspace: string, sessionId: string) => ipcRenderer.invoke("claude:delete-session", workspace, sessionId),
  normalizeClaudeSession: (workspace: string, sessionId: string) => ipcRenderer.invoke("claude:normalize-session", workspace, sessionId),
  stageAttachments: (attachments: unknown) => ipcRenderer.invoke("attachment:stage", attachments),
  deleteAttachment: (storedName: string) => ipcRenderer.invoke("attachment:delete", storedName),
  getProjectStore: () => ipcRenderer.invoke("projects:load"),
  discoverProjects: () => ipcRenderer.invoke("projects:discover"),
  saveProjectStore: (projects: unknown) => ipcRenderer.send("projects:save", projects),
  getAppSettings: () => ipcRenderer.invoke("app:settings:get"),
  setAppSettings: (settings: unknown) => ipcRenderer.invoke("app:settings:set", settings),
  notifyCompletion: (conversationId: string, title: string) => ipcRenderer.invoke("app:notify-completion", { conversationId, title }),
  reportError: (message: string) => ipcRenderer.send("app:renderer-error", message),
  startRun: (request: unknown) => ipcRenderer.invoke("claude:start", request),
  stopRun: (runId: string) => ipcRenderer.invoke("claude:stop", runId),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("claude:event", listener);
    return () => ipcRenderer.removeListener("claude:event", listener);
  },
  onNavigateToConversation: (callback: (conversationId: string) => void) => {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, conversationId: unknown) => {
      if (typeof conversationId === "string") callback(conversationId);
    };
    ipcRenderer.on("app:navigate-conversation", listener);
    return () => ipcRenderer.removeListener("app:navigate-conversation", listener);
  },
});
