import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

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
  attachments?: Attachment[];
}

interface Attachment {
  id: string;
  storedName: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file";
}

interface AttachmentUpload {
  name: string;
  mediaType: string;
  dataBase64: string;
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
  gitBranch?: string;
  resolvedModel?: string;
  permissionMode: PermissionMode;
  messages?: ImportedMessage[];
}

const activeRuns = new Map<string, ChildProcessWithoutNullStreams>();
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENT_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]{1,12})?$/i;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_PROJECT_STORE_BYTES = 50 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([{
  scheme: "claude-desk-attachment",
  privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
}]);

if (process.env.CLAUDE_DESK_USER_DATA_DIR) {
  app.setPath("userData", process.env.CLAUDE_DESK_USER_DATA_DIR);
} else {
  const legacyUserDataDirectory = join(app.getPath("appData"), "claude-desk");
  if (existsSync(legacyUserDataDirectory)) app.setPath("userData", legacyUserDataDirectory);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f7f7f5",
    title: "claude-cli-UI",
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
  const hasValidAttachments = request.attachments === undefined || (
    Array.isArray(request.attachments) &&
    request.attachments.length <= 10 &&
    request.attachments.every(isAttachment)
  );
  return (
    typeof request.runId === "string" &&
    typeof request.prompt === "string" &&
    (request.prompt.trim().length > 0 || Boolean(request.attachments?.length)) &&
    typeof request.cwd === "string" &&
    request.cwd.length > 0 &&
    typeof request.permissionMode === "string" &&
    validPermissionModes.includes(request.permissionMode as PermissionMode) &&
    hasValidSessionId &&
    hasValidSessionName &&
    hasValidModel &&
    hasValidAllowedTools &&
    hasValidAttachments
  );
}

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<Attachment>;
  return (
    typeof attachment.id === "string" && SESSION_ID_PATTERN.test(attachment.id) &&
    typeof attachment.storedName === "string" && ATTACHMENT_NAME_PATTERN.test(attachment.storedName) &&
    attachment.storedName.startsWith(attachment.id) &&
    typeof attachment.name === "string" && attachment.name.length > 0 && attachment.name.length <= 255 &&
    typeof attachment.mediaType === "string" && attachment.mediaType.length <= 100 &&
    typeof attachment.size === "number" && Number.isInteger(attachment.size) && attachment.size > 0 && attachment.size <= MAX_ATTACHMENT_BYTES &&
    (attachment.kind === "image" || attachment.kind === "file")
  );
}

function attachmentsDirectory() {
  return join(app.getPath("userData"), "attachments");
}

function projectsStorePath() {
  return join(app.getPath("userData"), "projects.json");
}

async function discoverClaudeWorkspaces() {
  if (process.env.CLAUDE_DESK_DISABLE_PROJECT_DISCOVERY === "1" || process.env.CLAUDE_DESK_TEST_WORKSPACE) return [];
  const root = join(claudeConfigDirectory(), "projects");
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  const workspaces = new Map<string, string>();

  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const sessionDirectory = join(root, directory.name);
    const files = (await readdir(sessionDirectory).catch(() => []))
      .filter((name) => name.toLowerCase().endsWith(".jsonl"))
      .slice(0, 5);
    let foundWorkspace = false;
    for (const name of files) {
      let handle;
      try {
        handle = await open(join(sessionDirectory, name), "r");
        const buffer = Buffer.alloc(128 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        for (const line of buffer.toString("utf8", 0, bytesRead).split(/\r?\n/)) {
          if (!line.trim()) continue;
          const record: unknown = JSON.parse(line);
          if (!record || typeof record !== "object") continue;
          const cwd = (record as Record<string, unknown>).cwd;
          if (typeof cwd !== "string" || !existsSync(cwd) || !statSync(cwd).isDirectory()) continue;
          workspaces.set(normalizeWorkspace(cwd), cwd);
          foundWorkspace = true;
          break;
        }
      } catch {
        // Malformed or inaccessible session files do not block other projects.
      } finally {
        await handle?.close().catch(() => undefined);
      }
      if (foundWorkspace) break;
    }
  }
  return [...workspaces.values()];
}

function saveProjectStore(value: unknown) {
  if (!Array.isArray(value)) return;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_STORE_BYTES) return;
  const directory = app.getPath("userData");
  const temporaryPath = join(directory, `projects-${process.pid}.tmp`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporaryPath, serialized, "utf8");
  renameSync(temporaryPath, projectsStorePath());
}

function attachmentPath(storedName: string) {
  return ATTACHMENT_NAME_PATTERN.test(storedName) ? join(attachmentsDirectory(), storedName) : null;
}

function normalizeAttachmentExtension(name: string) {
  const extension = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(extension) ? `.${extension}` : "";
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

function claudeConfigDirectory() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function claudeSessionsDirectory(workspace: string) {
  const testDirectory = process.env.CLAUDE_DESK_TEST_SESSIONS_DIR;
  const projectKey = workspace.replace(/[^A-Za-z0-9]/g, "-");
  return testDirectory || join(claudeConfigDirectory(), "projects", projectKey);
}

function importedUserText(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n").trim();
}

async function normalizeClaudeDeskSession(workspace: string, sessionId: string, existingPrefix: string) {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  const filePath = join(claudeSessionsDirectory(workspace), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  if (existingPrefix && !raw.startsWith(existingPrefix)) return;

  let changed = false;
  const appended = raw.slice(existingPrefix.length);
  const normalizedAppend = appended.split(/(\r?\n)/).map((part) => {
    if (!part.trim() || part === "\n" || part === "\r\n") return part;
    try {
      const parsed: unknown = JSON.parse(part);
      if (!parsed || typeof parsed !== "object") return part;
      const record = parsed as Record<string, unknown>;
      if (record.sessionId !== sessionId) return part;
      if (record.entrypoint === "sdk-cli") {
        record.entrypoint = "cli";
        changed = true;
      }
      if (record.promptSource === "sdk") {
        record.promptSource = "typed";
        changed = true;
      }
      return JSON.stringify(record);
    } catch {
      return part;
    }
  }).join("");

  if (!changed) return;
  const normalized = `${existingPrefix}${normalizedAppend}`;
  const temporaryPath = `${filePath}.claude-desk-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, normalized, "utf8");
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
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
  if (!SESSION_ID_PATTERN.test(fileSessionId)) return null;

  let sessionId = fileSessionId;
  let sessionWorkspace = "";
  let firstPrompt = "";
  let lastPrompt = "";
  let gitBranch: string | undefined;
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
    if (typeof record.gitBranch === "string" && record.gitBranch.length <= 200) gitBranch = record.gitBranch;
    const timestamp = parseTimestamp(record.timestamp);
    if (timestamp !== undefined) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }

    if (record.type === "user" && record.message && typeof record.message === "object") {
      const message = record.message as Record<string, unknown>;
      const prompt = importedUserText(message.content);
      if (!prompt) continue;
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
    gitBranch,
    resolvedModel,
    permissionMode,
    ...(includeMessages ? { messages } : {}),
  };
}

async function scanClaudeSessions(workspace: string, includeMessages = false) {
  const sessionsDirectory = claudeSessionsDirectory(workspace);
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

ipcMain.handle("claude:session-histories", async (_event, workspace: unknown) => {
  if (typeof workspace !== "string" || !existsSync(workspace) || !statSync(workspace).isDirectory()) return [];
  return scanClaudeSessions(workspace, true);
});

ipcMain.handle("claude:delete-session", async (_event, workspace: unknown, sessionId: unknown) => {
  if (
    typeof workspace !== "string" ||
    !existsSync(workspace) ||
    !statSync(workspace).isDirectory() ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) return { deleted: false, error: "会话参数无效" };

  const sessionsDirectory = claudeSessionsDirectory(workspace);
  const sessionFile = join(sessionsDirectory, `${sessionId}.jsonl`);
  const sessionDirectory = join(sessionsDirectory, sessionId);
  const targets = [sessionDirectory, sessionFile].filter((path) => existsSync(path));
  try {
    for (const path of targets) await shell.trashItem(path);
    return { deleted: true };
  } catch (error) {
    return {
      deleted: false,
      error: error instanceof Error ? error.message : "无法将 Claude CLI 会话移入回收站",
    };
  }
});

ipcMain.handle("claude:normalize-session", async (_event, workspace: unknown, sessionId: unknown) => {
  if (
    typeof workspace !== "string" ||
    !existsSync(workspace) ||
    !statSync(workspace).isDirectory() ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) return false;
  await normalizeClaudeDeskSession(workspace, sessionId, "");
  return true;
});

ipcMain.handle("projects:load", async () => {
  try {
    const value: unknown = JSON.parse(await readFile(projectsStorePath(), "utf8"));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
});

ipcMain.handle("projects:discover", () => discoverClaudeWorkspaces());

ipcMain.on("projects:save", (_event, value: unknown) => {
  try {
    saveProjectStore(value);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    void appendFile(join(app.getPath("userData"), "renderer-errors.log"), `${new Date().toISOString()} project save failed: ${detail}\n`, "utf8");
  }
});

ipcMain.handle("attachment:stage", async (_event, value: unknown) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new Error("一次最多添加 10 个附件");
  }

  const uploads = value as Partial<AttachmentUpload>[];
  const decoded = uploads.map((upload) => {
    if (
      typeof upload.name !== "string" || upload.name.length === 0 || upload.name.length > 255 ||
      typeof upload.mediaType !== "string" || upload.mediaType.length > 100 ||
      typeof upload.dataBase64 !== "string" || upload.dataBase64.length === 0 || upload.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(upload.dataBase64)
    ) throw new Error("附件数据无效");
    const data = Buffer.from(upload.dataBase64, "base64");
    if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) {
      throw new Error("单个附件不能超过 20 MB");
    }
    return { name: upload.name, mediaType: upload.mediaType || "application/octet-stream", data };
  });

  if (decoded.reduce((total, upload) => total + upload.data.length, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error("附件总大小不能超过 40 MB");
  }

  await mkdir(attachmentsDirectory(), { recursive: true });
  return Promise.all(decoded.map(async (upload): Promise<Attachment> => {
    const id = randomUUID();
    const storedName = `${id}${normalizeAttachmentExtension(upload.name)}`;
    await writeFile(join(attachmentsDirectory(), storedName), upload.data, { flag: "wx" });
    return {
      id,
      storedName,
      name: upload.name,
      mediaType: upload.mediaType,
      size: upload.data.length,
      kind: IMAGE_MEDIA_TYPES.has(upload.mediaType) ? "image" : "file",
    };
  }));
});

ipcMain.handle("attachment:delete", async (_event, storedName: unknown) => {
  if (typeof storedName !== "string") return false;
  const filePath = attachmentPath(storedName);
  if (!filePath) return false;
  return unlink(filePath).then(() => true).catch(() => false);
});

ipcMain.handle("claude:start", async (event, value: unknown) => {
  if (!isValidRunRequest(value)) throw new Error("无效的运行参数");
  const request = value;
  if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
    throw new Error("工作目录不存在");
  }
  if (activeRuns.has(request.runId)) throw new Error("任务已经在运行");
  const resolvedAttachments = await Promise.all((request.attachments ?? []).map(async (attachment) => {
    const filePath = attachmentPath(attachment.storedName);
    if (!filePath) throw new Error("附件路径无效");
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile() || details.size !== attachment.size) throw new Error(`附件已丢失：${attachment.name}`);
    return { attachment, filePath };
  }));
  const imageAttachments = resolvedAttachments.filter(({ attachment }) => attachment.kind === "image");
  const fileAttachmentPaths = resolvedAttachments
    .filter(({ attachment }) => attachment.kind === "file")
    .map(({ filePath }) => filePath);
  const imageContent = await Promise.all(imageAttachments.map(async ({ attachment, filePath }) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: attachment.mediaType,
      data: (await readFile(filePath)).toString("base64"),
    },
  })));
  let existingSessionPrefix = "";
  if (request.sessionId) {
    const existingPath = join(claudeSessionsDirectory(request.cwd), `${request.sessionId}.jsonl`);
    existingSessionPrefix = await readFile(existingPath, "utf8").catch(() => "");
  }

  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    request.permissionMode,
  ];
  if (imageAttachments.length > 0) args.push("--input-format", "stream-json");
  if (request.sessionId) args.push("--resume", request.sessionId);
  if (request.sessionName) args.push("--name", request.sessionName);
  if (request.model) args.push("--model", request.model);
  if (request.allowedTools?.length) args.push("--allowedTools", [...new Set(request.allowedTools)].join(","));
  if (fileAttachmentPaths.length > 0) args.push("--add-dir", attachmentsDirectory());

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
  let observedSessionId = request.sessionId;
  output.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const data: unknown = JSON.parse(line);
      if (data && typeof data === "object") {
        const sessionId = (data as Record<string, unknown>).session_id;
        if (typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)) observedSessionId = sessionId;
      }
      emit(owner, { runId: request.runId, type: "message", data });
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

  child.on("close", async (code) => {
    activeRuns.delete(request.runId);
    if (observedSessionId) {
      try {
        await normalizeClaudeDeskSession(request.cwd, observedSessionId, existingSessionPrefix);
      } catch (error) {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        await appendFile(join(app.getPath("userData"), "renderer-errors.log"), `${new Date().toISOString()} session normalization failed: ${detail}\n`, "utf8").catch(() => undefined);
      }
    }
    emit(owner, {
      runId: request.runId,
      type: "exit",
      code,
      stderr: stderr.trim(),
    });
  });

  const attachmentContext = fileAttachmentPaths.length > 0
    ? `\n\n用户附加了以下本地文件，请根据请求读取并使用它们：\n${fileAttachmentPaths.map((path) => `- ${path}`).join("\n")}`
    : "";
  const inputPrompt = `${request.prompt.trim() || "请查看并说明这些附件。"}${attachmentContext}`;
  if (imageAttachments.length > 0) {
    child.stdin.end(`${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [...imageContent, { type: "text", text: inputPrompt }],
      },
    })}\n`, "utf8");
  } else {
    child.stdin.end(inputPrompt, "utf8");
  }
  return { started: true };
});

ipcMain.handle("claude:stop", (_event, runId: string) => {
  const child = activeRuns.get(runId);
  if (!child) return false;
  return child.kill();
});

if (hasSingleInstanceLock) app.whenReady().then(() => {
  protocol.handle("claude-desk-attachment", (request) => {
    const storedName = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const filePath = attachmentPath(storedName);
    if (!filePath || !existsSync(filePath)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  createWindow();
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const child of activeRuns.values()) child.kill();
  if (process.platform !== "darwin") app.quit();
});
