import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

interface RunRequest {
  runId: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  allowedTools?: string[];
  permissionMode: PermissionMode;
}

interface ClaudeSettings {
  model?: unknown;
  env?: Record<string, unknown>;
}

interface ImportedActivity {
  id: string;
  name: string;
  summary: string;
}

interface ImportedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  createdAt: number;
  status?: "done";
  activities?: ImportedActivity[];
}

interface ClaudeSessionSummary {
  sessionId: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  resolvedModel?: string;
  permissionMode: PermissionMode;
  messages?: ImportedMessage[];
}

const activeRuns = new Map<string, ChildProcessWithoutNullStreams>();

if (process.env.CLAUDE_DESK_USER_DATA_DIR) {
  app.setPath("userData", process.env.CLAUDE_DESK_USER_DATA_DIR);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f7f7f5",
    title: "Claude Desk",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f2f2ef",
      symbolColor: "#4d4d48",
      height: 44,
    },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../dist/index.html"));
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    const line = `${new Date().toISOString()} renderer ${details.reason} (${details.exitCode})\n`;
    void appendFile(join(app.getPath("userData"), "renderer-errors.log"), line, "utf8");
  });
}

function findClaudeExecutable(): string {
  const pathEntries = (process.env.PATH ?? "").split(";").filter(Boolean);

  for (const pathEntry of pathEntries) {
    const directExe = join(pathEntry, "claude.exe");
    if (existsSync(directExe)) return directExe;

    const cmdShim = join(pathEntry, "claude.cmd");
    const nativeExe = join(pathEntry, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(cmdShim) && existsSync(nativeExe)) return nativeExe;
  }

  return process.platform === "win32" ? "claude.cmd" : "claude";
}

function getClaudeInvocation(args: string[]) {
  const executable = process.env.CLAUDE_DESK_CLAUDE_EXECUTABLE || findClaudeExecutable();
  let prefixArgs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env.CLAUDE_DESK_CLAUDE_PREFIX_ARGS ?? "[]");
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) prefixArgs = parsed;
  } catch {
    prefixArgs = [];
  }
  return { executable, args: [...prefixArgs, ...args], shell: process.platform === "win32" && executable.toLowerCase().endsWith(".cmd") };
}

function isValidRunRequest(value: unknown): value is RunRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RunRequest>;
  const validPermissionModes: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
  const hasValidSessionId = request.sessionId === undefined || (
    typeof request.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.sessionId)
  );
  const hasValidModel = request.model === undefined || (
    typeof request.model === "string" &&
    request.model.length > 0 &&
    request.model.length <= 200 &&
    !/[\r\n&|<>^%"]/.test(request.model)
  );
  const hasValidSessionName = request.sessionName === undefined || (
    typeof request.sessionName === "string" &&
    request.sessionName.length > 0 &&
    request.sessionName.length <= 40 &&
    !/[\r\n&|<>^%"!()]/.test(request.sessionName)
  );
  const hasValidAllowedTools = request.allowedTools === undefined || (
    Array.isArray(request.allowedTools) &&
    request.allowedTools.length <= 100 &&
    request.allowedTools.every((tool) => typeof tool === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool))
  );
  return (
    typeof request.runId === "string" &&
    typeof request.prompt === "string" &&
    request.prompt.trim().length > 0 &&
    typeof request.cwd === "string" &&
    request.cwd.length > 0 &&
    typeof request.permissionMode === "string" &&
    validPermissionModes.includes(request.permissionMode as PermissionMode) &&
    hasValidSessionId &&
    hasValidSessionName &&
    hasValidModel &&
    hasValidAllowedTools
  );
}

async function readClaudeSettings(path: string): Promise<ClaudeSettings | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as ClaudeSettings : null;
  } catch {
    return null;
  }
}

function normalizeWorkspace(path: string) {
  return path.replace(/[\\/]+$/, "").toLocaleLowerCase();
}

function summarizeImportedTool(input: unknown) {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  const preferred = value.command ?? value.file_path ?? value.path ?? value.pattern ?? value.query ?? value.description;
  if (typeof preferred === "string") return preferred.replace(/\s+/g, " ").trim().slice(0, 90);
  try {
    return JSON.stringify(input).slice(0, 90);
  } catch {
    return "";
  }
}

function importedTitle(text: string) {
  const title = text.replace(/\s+/g, " ").trim();
  return title.length > 38 ? `${title.slice(0, 38)}…` : title;
}

function parseTimestamp(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function parseClaudeSession(filePath: string, workspace: string, includeMessages: boolean): Promise<ClaudeSessionSummary | null> {
  let raw: string;
  let fileInfo;
  try {
    [raw, fileInfo] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
  } catch {
    return null;
  }

  const fileName = filePath.split(/[\\/]/).at(-1) ?? "";
  const fileSessionId = fileName.replace(/\.jsonl$/i, "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileSessionId)) return null;

  let sessionId = fileSessionId;
  let sessionWorkspace = "";
  let firstPrompt = "";
  let lastPrompt = "";
  let resolvedModel: string | undefined;
  let permissionMode: PermissionMode = "acceptEdits";
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;
  let currentAssistant: ImportedMessage | undefined;
  const messages: ImportedMessage[] = [];
  const validModes: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof record.cwd === "string") sessionWorkspace = record.cwd;
    if (typeof record.sessionId === "string") sessionId = record.sessionId;
    if (typeof record.lastPrompt === "string") lastPrompt = record.lastPrompt;
    const timestamp = parseTimestamp(record.timestamp);
    if (timestamp !== undefined) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }

    if (record.type === "user" && record.message && typeof record.message === "object") {
      const message = record.message as Record<string, unknown>;
      if (typeof message.content !== "string" || !message.content.trim()) continue;
      const prompt = message.content.trim();
      if (!firstPrompt) firstPrompt = prompt;
      if (typeof record.permissionMode === "string" && validModes.includes(record.permissionMode as PermissionMode)) {
        permissionMode = record.permissionMode as PermissionMode;
      }
      currentAssistant = undefined;
      if (includeMessages) {
        messages.push({
          id: typeof record.uuid === "string" ? record.uuid : `${sessionId}-user-${messages.length}`,
          role: "user",
          content: prompt,
          createdAt: timestamp ?? updatedAt ?? Date.now(),
        });
      }
      continue;
    }

    if (record.type !== "assistant" || !record.message || typeof record.message !== "object") continue;
    const message = record.message as Record<string, unknown>;
    if (typeof message.model === "string") resolvedModel = message.model;
    if (!includeMessages || !Array.isArray(message.content)) continue;
    if (!currentAssistant) {
      currentAssistant = {
        id: typeof message.id === "string" ? message.id : `${sessionId}-assistant-${messages.length}`,
        role: "assistant",
        content: "",
        createdAt: timestamp ?? updatedAt ?? Date.now(),
        status: "done",
        activities: [],
      };
      messages.push(currentAssistant);
    }
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") currentAssistant.content += item.text;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        currentAssistant.thinking = `${currentAssistant.thinking ?? ""}${item.thinking}`;
      }
      if (item.type === "tool_use" && typeof item.name === "string") {
        const id = typeof item.id === "string" ? item.id : `${currentAssistant.id}-tool-${currentAssistant.activities?.length ?? 0}`;
        if (!currentAssistant.activities?.some((activity) => activity.id === id)) {
          currentAssistant.activities?.push({ id, name: item.name, summary: summarizeImportedTool(item.input) });
        }
      }
    }
  }

  if (!sessionWorkspace || normalizeWorkspace(sessionWorkspace) !== normalizeWorkspace(workspace)) return null;
  if (!Number.isFinite(createdAt)) createdAt = fileInfo.birthtimeMs || fileInfo.mtimeMs;
  updatedAt = Math.max(updatedAt, fileInfo.mtimeMs);
  const title = importedTitle(firstPrompt || lastPrompt || "Claude CLI 对话");
  return {
    sessionId,
    title,
    workspace: sessionWorkspace,
    createdAt,
    updatedAt,
    resolvedModel,
    permissionMode,
    ...(includeMessages ? { messages } : {}),
  };
}

async function scanClaudeSessions(workspace: string, includeMessages = false) {
  const testDirectory = process.env.CLAUDE_DESK_TEST_SESSIONS_DIR;
  const encodedWorkspace = workspace.replace(/[:\\/]/g, "-");
  const sessionsDirectory = testDirectory || join(homedir(), ".claude", "projects", encodedWorkspace);
  let files: string[];
  try {
    files = (await readdir(sessionsDirectory)).filter((file) => file.toLowerCase().endsWith(".jsonl"));
  } catch {
    return [];
  }
  const sessions = await Promise.all(files.map((file) => parseClaudeSession(join(sessionsDirectory, file), workspace, includeMessages)));
  return sessions.filter((session): session is ClaudeSessionSummary => session !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getModelConfig(workspace: string) {
  const roles = [
    { role: "Sonnet", value: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
    { role: "Opus", value: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
    { role: "Fable", value: "fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
    { role: "Haiku", value: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
  ] as const;
  const testModels = process.env.CLAUDE_DESK_TEST_MODELS;
  if (testModels) {
    try {
      const parsed: unknown = JSON.parse(testModels);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const values = parsed as Record<string, unknown>;
        return {
          options: roles.map(({ role, value }) => ({
            role,
            value,
            actualModel: typeof values[role] === "string" && values[role] ? values[role] as string : value,
          })),
        };
      }
    } catch {
      // Fall through to normal settings discovery.
    }
  }

  const paths = [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.local.json"),
    join(workspace, ".claude", "settings.json"),
    join(workspace, ".claude", "settings.local.json"),
  ];
  const roleModels = new Map<string, string>();
  let defaultModel: string | undefined;

  for (const path of paths) {
    const settings = await readClaudeSettings(path);
    if (!settings) continue;
    if (!settings.env || typeof settings.env !== "object") continue;
    if (typeof settings.env.ANTHROPIC_MODEL === "string" && settings.env.ANTHROPIC_MODEL) {
      defaultModel = settings.env.ANTHROPIC_MODEL;
    }
    for (const { role, envKey } of roles) {
      const namedValue = settings.env[`${envKey}_NAME`];
      const modelValue = settings.env[envKey];
      if (typeof namedValue === "string" && namedValue) roleModels.set(role, namedValue);
      else if (typeof modelValue === "string" && modelValue) roleModels.set(role, modelValue);
    }
  }

  return {
    options: roles.map(({ role, value }) => ({
      role,
      value,
      actualModel: roleModels.get(role) ?? defaultModel ?? value,
    })),
  };
}

function emit(window: BrowserWindow, payload: Record<string, unknown>) {
  if (!window.isDestroyed()) window.webContents.send("claude:event", payload);
}

ipcMain.handle("workspace:select", async () => {
  if (process.env.CLAUDE_DESK_TEST_WORKSPACE) return process.env.CLAUDE_DESK_TEST_WORKSPACE;
  const result = await dialog.showOpenDialog({
    title: "选择 Claude 的工作目录",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("workspace:open", async (_event, workspace: unknown) => {
  if (typeof workspace !== "string" || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
    return { opened: false, error: "项目目录不存在" };
  }
  if (process.env.CLAUDE_DESK_TEST_WORKSPACE === workspace) return { opened: true };
  const error = await shell.openPath(workspace);
  return error ? { opened: false, error } : { opened: true };
});

ipcMain.on("app:renderer-error", (_event, value: unknown) => {
  if (typeof value !== "string") return;
  const line = `${new Date().toISOString()} ${value.slice(0, 8_000)}\n`;
  void appendFile(join(app.getPath("userData"), "renderer-errors.log"), line, "utf8");
});

ipcMain.handle("claude:info", async () => new Promise<{ available: boolean; version?: string }>((resolve) => {
  const invocation = getClaudeInvocation(["--version"]);
  const child = spawn(invocation.executable, invocation.args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    shell: invocation.shell,
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.on("error", () => resolve({ available: false }));
  child.on("close", (code) => resolve(code === 0
    ? { available: true, version: output.trim() }
    : { available: false }));
}));

ipcMain.handle("claude:models", async (_event, workspace: unknown) => {
  if (typeof workspace !== "string" || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
    return { options: [] };
  }
  return getModelConfig(workspace);
});

ipcMain.handle("claude:sessions", async (_event, workspace: unknown) => {
  if (typeof workspace !== "string" || !existsSync(workspace) || !statSync(workspace).isDirectory()) return [];
  const sessions = await scanClaudeSessions(workspace);
  return sessions.map(({ messages: _messages, ...summary }) => summary);
});

ipcMain.handle("claude:session", async (_event, workspace: unknown, sessionId: unknown) => {
  if (
    typeof workspace !== "string" ||
    !existsSync(workspace) ||
    !statSync(workspace).isDirectory() ||
    typeof sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
  ) return null;
  return (await scanClaudeSessions(workspace, true)).find((session) => session.sessionId === sessionId) ?? null;
});

ipcMain.handle("claude:start", async (event, value: unknown) => {
  if (!isValidRunRequest(value)) throw new Error("无效的运行参数");
  const request = value;
  if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
    throw new Error("工作目录不存在");
  }
  if (activeRuns.has(request.runId)) throw new Error("任务已经在运行");

  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    request.permissionMode,
  ];
  if (request.sessionId) args.push("--resume", request.sessionId);
  if (request.sessionName) args.push("--name", request.sessionName);
  if (request.model) args.push("--model", request.model);
  if (request.allowedTools?.length) args.push("--allowedTools", [...new Set(request.allowedTools)].join(","));

  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error("窗口已经关闭");

  const invocation = getClaudeInvocation(args);
  const child = spawn(invocation.executable, invocation.args, {
    cwd: request.cwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    windowsHide: true,
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeRuns.set(request.runId, child);

  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try {
      emit(owner, { runId: request.runId, type: "message", data: JSON.parse(line) });
    } catch {
      emit(owner, { runId: request.runId, type: "raw", text: line });
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
  });

  child.on("error", (error) => {
    activeRuns.delete(request.runId);
    emit(owner, { runId: request.runId, type: "error", message: error.message });
  });

  child.on("close", (code) => {
    activeRuns.delete(request.runId);
    emit(owner, {
      runId: request.runId,
      type: "exit",
      code,
      stderr: stderr.trim(),
    });
  });

  child.stdin.end(request.prompt, "utf8");
  return { started: true };
});

ipcMain.handle("claude:stop", (_event, runId: string) => {
  const child = activeRuns.get(runId);
  if (!child) return false;
  return child.kill();
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const child of activeRuns.values()) child.kill();
  if (process.platform !== "darwin") app.quit();
});
