import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("claudeDesk", {
  selectWorkspace: () => ipcRenderer.invoke("workspace:select"),
  openWorkspace: (workspace: string) => ipcRenderer.invoke("workspace:open", workspace),
  getClaudeInfo: () => ipcRenderer.invoke("claude:info"),
  getModels: (workspace: string) => ipcRenderer.invoke("claude:models", workspace),
  getClaudeSessions: (workspace: string) => ipcRenderer.invoke("claude:sessions", workspace),
  getClaudeSession: (workspace: string, sessionId: string) => ipcRenderer.invoke("claude:session", workspace, sessionId),
  normalizeClaudeSession: (workspace: string, sessionId: string) => ipcRenderer.invoke("claude:normalize-session", workspace, sessionId),
  stageAttachments: (attachments: unknown) => ipcRenderer.invoke("attachment:stage", attachments),
  deleteAttachment: (storedName: string) => ipcRenderer.invoke("attachment:delete", storedName),
  reportError: (message: string) => ipcRenderer.send("app:renderer-error", message),
  startRun: (request: unknown) => ipcRenderer.invoke("claude:start", request),
  stopRun: (runId: string) => ipcRenderer.invoke("claude:stop", runId),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("claude:event", listener);
    return () => ipcRenderer.removeListener("claude:event", listener);
  },
});
