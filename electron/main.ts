import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, Tray, type MessageBoxOptions } from "electron";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { UpdateManager } from "./update-manager";

type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

interface AppSettings {
  closeBehavior: "tray" | "quit";
  notifyOnCompletion: boolean;
  ignoredUpdateVersion?: string;
}

interface AppSelection {
  projectId: string | null;
  conversationId: string | null;
}

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

interface AppendRunRequest {
  runId: string;
  turnRunId: string;
  prompt: string;
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
  detail?: ImportedActivityDetail;
}

interface ImportedDiffLine {
  type: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface ImportedActivityDetail {
  path?: string;
  command?: string;
  oldText?: string;
  newText?: string;
  output?: string;
  diff?: ImportedDiffLine[];
}

type ImportedTimelineItem = {
  id: string;
  type: "text";
  content: string;
} | {
  id: string;
  type: "activity";
  activity: ImportedActivity;
};

interface ImportedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  createdAt: number;
  status?: "done";
  activities?: ImportedActivity[];
  timeline?: ImportedTimelineItem[];
}

interface ImportedContextUsage {
  usedTokens?: number;
  contextWindow?: number;
  usedPercentage?: number;
  remainingPercentage?: number;
}

interface ImportedContextCompaction {
  id: string;
  trigger: "auto" | "manual" | "unknown";
  status: "done";
  completedAt?: number;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  summary?: string;
}

interface ClaudeSessionSummary {
  sessionId: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  customTitle?: string;
  gitBranch?: string;
  resolvedModel?: string;
  permissionMode: PermissionMode;
  messages?: ImportedMessage[];
  contextUsage?: ImportedContextUsage;
  contextCompactions?: ImportedContextCompaction[];
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  currentTurnRunId: string;
  pendingTurnRunIds: string[];
  unfinishedTurnRunIds: Set<string>;
}

const activeRuns = new Map<string, ActiveRun>();
const activeNotifications = new Set<Notification>();
const DEFAULT_APP_SETTINGS: AppSettings = { closeBehavior: "tray", notifyOnCompletion: true };
let appSettings: AppSettings = DEFAULT_APP_SETTINGS;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let closePromptOpen = false;
const updateManager = new UpdateManager({
  getWindow: () => mainWindow,
  hasActiveRuns: () => activeRuns.size > 0,
  prepareToQuit: () => { isQuitting = true; },
});
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

  window.on("focus", () => window.flashFrame(false));
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void handleWindowClose(window);
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  mainWindow = window;
  return window;
}

function trayIconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "build", "icon.png");
}

function showMainWindow(conversationId?: string) {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  window.flashFrame(false);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (conversationId) {
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", () => window.webContents.send("app:navigate-conversation", conversationId));
    } else {
      window.webContents.send("app:navigate-conversation", conversationId);
    }
  }
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const image = nativeImage.createFromPath(trayIconPath()).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip("claude-cli-UI");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 claude-cli-UI", click: () => showMainWindow() },
    { type: "separator" },
    { label: "退出", click: () => { void requestQuitFromTray(); } },
  ]));
  tray.on("click", () => showMainWindow());
  return tray;
}

function quitApplication() {
  isQuitting = true;
  for (const { child } of activeRuns.values()) child.kill();
  app.quit();
}

async function requestQuitFromTray() {
  if (activeRuns.size === 0) {
    quitApplication();
    return;
  }
  const options: MessageBoxOptions = {
    type: "warning",
    title: "仍有会话正在进行",
    message: "仍有会话正在进行",
    detail: "退出会停止所有正在运行的 Claude CLI 会话。",
    buttons: ["停止并退出", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) quitApplication();
}

async function handleWindowClose(window: BrowserWindow) {
  if (appSettings.closeBehavior === "tray") {
    ensureTray();
    window.hide();
    return;
  }
  if (activeRuns.size === 0) {
    quitApplication();
    return;
  }
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "question",
      title: "仍有会话正在进行",
      message: "仍有会话正在进行",
      detail: "请选择继续在后台运行，或停止会话并退出应用。",
      buttons: ["后台继续", "停止并退出", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 0) {
      ensureTray();
      window.hide();
    } else if (result.response === 1) {
      quitApplication();
    }
  } finally {
    closePromptOpen = false;
  }
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

function isValidAppendRunRequest(value: unknown): value is AppendRunRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<AppendRunRequest>;
  return (
    typeof request.runId === "string" && request.runId.length > 0 &&
    typeof request.turnRunId === "string" && request.turnRunId.length > 0 &&
    request.runId !== request.turnRunId &&
    typeof request.prompt === "string" && (request.prompt.trim().length > 0 || Boolean(request.attachments?.length)) &&
    (request.attachments === undefined || (
      Array.isArray(request.attachments) && request.attachments.length <= 10 && request.attachments.every(isAttachment)
    ))
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

function appSettingsPath() {
  return join(app.getPath("userData"), "settings.json");
}

function appSelectionPath() {
  return join(app.getPath("userData"), "selection.json");
}

function normalizeAppSettings(value: unknown): AppSettings | null {
  if (!value || typeof value !== "object") return null;
  const settings = value as Partial<AppSettings>;
  if ((settings.closeBehavior !== "tray" && settings.closeBehavior !== "quit") || typeof settings.notifyOnCompletion !== "boolean") {
    return null;
  }
  if (
    settings.ignoredUpdateVersion !== undefined &&
    (typeof settings.ignoredUpdateVersion !== "string" ||
      settings.ignoredUpdateVersion.length === 0 ||
      settings.ignoredUpdateVersion.length > 50 ||
      !/^[0-9A-Za-z.+-]+$/.test(settings.ignoredUpdateVersion))
  ) return null;
  return {
    closeBehavior: settings.closeBehavior,
    notifyOnCompletion: settings.notifyOnCompletion,
    ...(settings.ignoredUpdateVersion ? { ignoredUpdateVersion: settings.ignoredUpdateVersion } : {}),
  };
}

async function loadAppSettings() {
  try {
    const parsed: unknown = JSON.parse(await readFile(appSettingsPath(), "utf8"));
    return normalizeAppSettings(parsed) ?? DEFAULT_APP_SETTINGS;
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

async function saveAppSettings(settings: AppSettings) {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(appSettingsPath(), JSON.stringify(settings), "utf8");
}

function normalizeAppSelection(value: unknown): AppSelection | null {
  if (!value || typeof value !== "object") return null;
  const selection = value as Partial<AppSelection>;
  const validId = (id: unknown) => id === null || (typeof id === "string" && id.length > 0 && id.length <= 200);
  if (!validId(selection.projectId) || !validId(selection.conversationId)) return null;
  return {
    projectId: selection.projectId ?? null,
    conversationId: selection.conversationId ?? null,
  };
}

function saveAppSelection(value: unknown) {
  const selection = normalizeAppSelection(value);
  if (!selection) return;
  const directory = app.getPath("userData");
  const temporaryPath = join(directory, `selection-${process.pid}.tmp`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporaryPath, JSON.stringify(selection), "utf8");
  renameSync(temporaryPath, appSelectionPath());
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

const MAX_IMPORTED_ACTIVITY_DETAIL = 200_000;

function importedDetailText(value: unknown) {
  return typeof value === "string" ? value.slice(0, MAX_IMPORTED_ACTIVITY_DETAIL) : undefined;
}

function importedActivityDetail(name: string, input: unknown): ImportedActivityDetail | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const path = importedDetailText(value.file_path ?? value.path);
  const command = importedDetailText(value.command);
  const oldText = importedDetailText(value.old_string ?? value.oldText);
  let newText = importedDetailText(value.new_string ?? value.newText);
  if (newText === undefined && /write|create/i.test(name)) newText = importedDetailText(value.content);
  if (!path && !command && oldText === undefined && newText === undefined) return undefined;
  return { path, command, oldText, newText };
}

function importedStructuredDiff(value: unknown): ImportedDiffLine[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.structuredPatch)) return undefined;
  const diff: ImportedDiffLine[] = [];
  for (const rawHunk of result.structuredPatch.slice(0, 100)) {
    if (!rawHunk || typeof rawHunk !== "object") continue;
    const hunk = rawHunk as Record<string, unknown>;
    if (!Array.isArray(hunk.lines)) continue;
    let oldLine = typeof hunk.oldStart === "number" ? hunk.oldStart : 1;
    let newLine = typeof hunk.newStart === "number" ? hunk.newStart : 1;
    for (const rawLine of hunk.lines) {
      if (typeof rawLine !== "string" || rawLine.startsWith("\\ No newline")) continue;
      const marker = rawLine[0];
      const text = marker === "+" || marker === "-" || marker === " " ? rawLine.slice(1) : rawLine;
      if (marker === "+") {
        diff.push({ type: "add", text, newLine });
        newLine += 1;
      } else if (marker === "-") {
        diff.push({ type: "remove", text, oldLine });
        oldLine += 1;
      } else {
        diff.push({ type: "context", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
      if (diff.length >= 4_000) return diff;
    }
  }
  return diff.length > 0 ? diff : undefined;
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

async function discoverSlashCommandDescriptions(workspace: string) {
  const roots = [
    join(workspace, ".claude", "commands"),
    join(claudeConfigDirectory(), "commands"),
    join(claudeConfigDirectory(), "plugins"),
  ];
  const descriptions: Record<string, string> = {};
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return visit(path, depth + 1);
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) return;
      const raw = await readFile(path, "utf8").catch(() => "");
      const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      const description = match?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
      if (!description) return;
      const relative = path.slice(directory.length + 1).replace(/[\\/]/g, "/").replace(/\.md$/i, "");
      const commandName = basename(relative).toLowerCase();
      if (commandName && !descriptions[`/${commandName}`]) descriptions[`/${commandName}`] = description;
    }));
  };
  await Promise.all(roots.map((root) => visit(root, 0)));
  return descriptions;
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

function importedUsage(record: Record<string, unknown>): ImportedContextUsage | undefined {
  const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : undefined;
  const usage = record.usage ?? message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const item = usage as Record<string, unknown>;
  const inputTokens = [item.input_tokens, item.cache_creation_input_tokens, item.cache_read_input_tokens]
    .reduce<number>((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
  return inputTokens > 0 ? { usedTokens: inputTokens } : undefined;
}

function importedCompactSummary(record: Record<string, unknown>) {
  if (record.isCompactSummary !== true || !record.message || typeof record.message !== "object") return undefined;
  return importedUserText((record.message as Record<string, unknown>).content) || undefined;
}

function importedToolResultText(content: unknown) {
  if (typeof content === "string") return content.slice(0, MAX_IMPORTED_ACTIVITY_DETAIL);
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
  return text ? text.slice(0, MAX_IMPORTED_ACTIVITY_DETAIL) : undefined;
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
  let customTitle: string | undefined;
  let gitBranch: string | undefined;
  let resolvedModel: string | undefined;
  let permissionMode: PermissionMode = "acceptEdits";
  let contextUsage: ImportedContextUsage | undefined;
  const contextCompactions: ImportedContextCompaction[] = [];
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
    if (record.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) {
      customTitle = record.customTitle.trim();
    }
    if (typeof record.gitBranch === "string" && record.gitBranch.length <= 200) gitBranch = record.gitBranch;
    const timestamp = parseTimestamp(record.timestamp);
    const usage = importedUsage(record);
    if (usage) contextUsage = { ...contextUsage, ...usage };
    const compactSummary = importedCompactSummary(record);
    if (compactSummary && contextCompactions.length > 0) {
      contextCompactions[contextCompactions.length - 1].summary = compactSummary;
    }
    if (record.type === "system" && record.subtype === "compact_boundary") {
      const metadata = record.compactMetadata && typeof record.compactMetadata === "object"
        ? record.compactMetadata as Record<string, unknown>
        : {};
      const trigger = metadata.trigger === "auto" || metadata.trigger === "manual" ? metadata.trigger : "unknown";
      contextCompactions.push({
        id: typeof record.uuid === "string" ? record.uuid : `${sessionId}-compact-${contextCompactions.length}`,
        trigger,
        status: "done",
        completedAt: timestamp,
        preTokens: typeof metadata.preTokens === "number" ? metadata.preTokens : undefined,
        postTokens: typeof metadata.postTokens === "number" ? metadata.postTokens : undefined,
        durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : undefined,
      });
      contextUsage = {
        ...contextUsage,
        usedTokens: typeof metadata.postTokens === "number" ? metadata.postTokens : contextUsage?.usedTokens,
      };
    }
    if (timestamp !== undefined) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }

    if (record.isCompactSummary === true) continue;

    if (record.type === "user" && record.message && typeof record.message === "object") {
      const message = record.message as Record<string, unknown>;
      if (includeMessages && currentAssistant && Array.isArray(message.content)) {
        const rawResult = record.toolUseResult ?? record.tool_use_result;
        const resultObject = rawResult && typeof rawResult === "object" ? rawResult as Record<string, unknown> : undefined;
        const diff = importedStructuredDiff(rawResult);
        const resultPath = importedDetailText(resultObject?.filePath ?? resultObject?.file_path);
        for (const block of message.content) {
          if (!block || typeof block !== "object") continue;
          const toolResult = block as Record<string, unknown>;
          if (toolResult.type !== "tool_result" || typeof toolResult.tool_use_id !== "string") continue;
          const activity = currentAssistant.activities?.find((item) => item.id === toolResult.tool_use_id);
          if (!activity) continue;
          const output = importedToolResultText(toolResult.content)
            ?? importedDetailText(resultObject?.stdout)
            ?? importedDetailText(resultObject?.stderr);
          activity.detail = {
            ...activity.detail,
            path: resultPath ?? activity.detail?.path,
            output: output ?? activity.detail?.output,
            diff: diff ?? activity.detail?.diff,
          };
        }
      }
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
        timeline: [],
      };
      messages.push(currentAssistant);
    }
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        currentAssistant.content += item.text;
        currentAssistant.timeline?.push({
          id: `${currentAssistant.id}-text-${currentAssistant.timeline.length}`,
          type: "text",
          content: item.text,
        });
      }
      if (item.type === "thinking" && typeof item.thinking === "string") {
        currentAssistant.thinking = `${currentAssistant.thinking ?? ""}${item.thinking}`;
      }
      if (item.type === "tool_use" && typeof item.name === "string") {
        const id = typeof item.id === "string" ? item.id : `${currentAssistant.id}-tool-${currentAssistant.activities?.length ?? 0}`;
        if (!currentAssistant.activities?.some((activity) => activity.id === id)) {
          const detail = importedActivityDetail(item.name, item.input);
          const activity = {
            id,
            name: item.name,
            summary: summarizeImportedTool(item.input),
            ...(detail ? { detail } : {}),
          };
          currentAssistant.activities?.push(activity);
          currentAssistant.timeline?.push({ id: `${currentAssistant.id}-activity-${id}`, type: "activity", activity });
        }
      }
    }
  }

  if (!sessionWorkspace || normalizeWorkspace(sessionWorkspace) !== normalizeWorkspace(workspace)) return null;
  if (!Number.isFinite(createdAt)) createdAt = fileInfo.birthtimeMs || fileInfo.mtimeMs;
  updatedAt = Math.max(updatedAt, fileInfo.mtimeMs);
  const title = customTitle || importedTitle(firstPrompt || lastPrompt || "Claude CLI 对话");
  return {
    sessionId,
    title,
    workspace: sessionWorkspace,
    createdAt,
    updatedAt,
    customTitle,
    gitBranch,
    resolvedModel,
    permissionMode,
    contextUsage,
    contextCompactions: contextCompactions.length ? contextCompactions : undefined,
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

function isConversationUserRecord(record: Record<string, unknown>) {
  if (record.type !== "user" || !record.message || typeof record.message !== "object") return false;
  return Boolean(importedUserText((record.message as Record<string, unknown>).content));
}

function replaceBranchIdentifiers(
  value: unknown,
  identifiers: ReadonlyMap<string, string>,
  sourceSessionId: string,
  branchSessionId: string,
  fieldName = "",
): unknown {
  if (typeof value === "string") {
    if (fieldName === "sessionId" && value === sourceSessionId) return branchSessionId;
    if (/uuid$/i.test(fieldName) || fieldName === "promptId") return identifiers.get(value) ?? value;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceBranchIdentifiers(item, identifiers, sourceSessionId, branchSessionId, fieldName));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    replaceBranchIdentifiers(item, identifiers, sourceSessionId, branchSessionId, key),
  ]));
}

async function createClaudeSessionBranch(workspace: string, sourceSessionId: string, userTurn: number, title: string) {
  const sessionsDirectory = claudeSessionsDirectory(workspace);
  const sourcePath = join(sessionsDirectory, `${sourceSessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch {
    return { branched: false, error: "找不到对应的 Claude CLI 会话文件" };
  }

  const selectedRecords: Record<string, unknown>[] = [];
  let currentUserTurn = 0;
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
    if (typeof record.sessionId === "string" && record.sessionId !== sourceSessionId) {
      return { branched: false, error: "Claude CLI 会话文件包含不一致的 session ID" };
    }
    if (isConversationUserRecord(record)) {
      currentUserTurn += 1;
      if (currentUserTurn > userTurn) break;
    }
    if (record.type !== "custom-title") selectedRecords.push(record);
  }
  if (currentUserTurn < userTurn || selectedRecords.length === 0) {
    return { branched: false, error: "找不到选中的消息位置，请刷新会话后重试" };
  }

  const branchSessionId = randomUUID();
  const identifiers = new Map<string, string>();
  for (const record of selectedRecords) {
    for (const key of ["uuid", "promptId"] as const) {
      const identifier = record[key];
      if (typeof identifier === "string" && identifier && !identifiers.has(identifier)) {
        identifiers.set(identifier, randomUUID());
      }
    }
  }
  const branchedRecords = selectedRecords.map((record) => (
    replaceBranchIdentifiers(record, identifiers, sourceSessionId, branchSessionId) as Record<string, unknown>
  ));
  branchedRecords.push({
    type: "custom-title",
    customTitle: title,
    sessionId: branchSessionId,
    timestamp: new Date().toISOString(),
  });

  const branchPath = join(sessionsDirectory, `${branchSessionId}.jsonl`);
  try {
    await writeFile(branchPath, `${branchedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
    const session = await parseClaudeSession(branchPath, workspace, true);
    if (!session?.messages) throw new Error("新分支无法被 Claude CLI 解析");
    return { branched: true, session };
  } catch (error) {
    await unlink(branchPath).catch(() => undefined);
    return {
      branched: false,
      error: error instanceof Error ? error.message : "无法创建 Claude CLI 会话分支",
    };
  }
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

ipcMain.handle("app:settings:get", () => appSettings);

ipcMain.handle("app:get-version", () => app.getVersion());

ipcMain.handle("app:update:get-state", () => updateManager.getState());

ipcMain.handle("app:update:check", () => updateManager.checkForUpdates(true));

ipcMain.handle("app:update:download", () => updateManager.downloadUpdate());

ipcMain.handle("app:update:install", () => updateManager.installUpdate());

ipcMain.handle("app:update:open-release", () => updateManager.openReleasePage());

ipcMain.handle("app:settings:set", async (_event, value: unknown) => {
  const normalized = normalizeAppSettings(value);
  if (!normalized) throw new Error("设置数据无效");
  appSettings = normalized;
  await saveAppSettings(appSettings);
  return appSettings;
});

ipcMain.handle("app:focus-window", (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return false;
  if (owner.isMinimized()) owner.restore();
  owner.show();
  owner.focus();
  owner.webContents.focus();
  return owner.isFocused();
});

ipcMain.handle("app:notify-completion", (_event, value: unknown) => {
  if (
    process.env.CLAUDE_DESK_DISABLE_NOTIFICATIONS === "1" ||
    !appSettings.notifyOnCompletion ||
    !Notification.isSupported() ||
    !value ||
    typeof value !== "object"
  ) return false;
  const request = value as Record<string, unknown>;
  if (
    typeof request.conversationId !== "string" || request.conversationId.length === 0 || request.conversationId.length > 200 ||
    typeof request.title !== "string" || request.title.length === 0 || request.title.length > 100
  ) return false;
  const notification = new Notification({
    title: "会话已完成",
    body: `“${request.title}”已完成`,
    icon: trayIconPath(),
  });
  activeNotifications.add(notification);
  notification.on("click", () => {
    activeNotifications.delete(notification);
    showMainWindow(request.conversationId as string);
  });
  notification.on("close", () => activeNotifications.delete(notification));
  notification.on("failed", () => activeNotifications.delete(notification));
  notification.show();
  return true;
});

ipcMain.handle("app:notify-permission", (event, value: unknown) => {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  const requestedTools = Array.isArray(request.tools) ? request.tools : [];
  const tools = requestedTools.filter((tool): tool is string => (
    typeof tool === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool)
  ));
  if (
    typeof request.requestId !== "string" || request.requestId.length === 0 || request.requestId.length > 200 ||
    typeof request.conversationId !== "string" || request.conversationId.length === 0 || request.conversationId.length > 200 ||
    typeof request.title !== "string" || request.title.length === 0 || request.title.length > 100 ||
    tools.length === 0 || tools.length !== requestedTools.length
  ) return false;
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return false;
  if (owner.isVisible() && owner.isFocused() && !owner.isMinimized()) return false;

  owner.flashFrame(true);
  if (process.env.CLAUDE_DESK_DISABLE_NOTIFICATIONS === "1" || !Notification.isSupported()) return true;

  const visibleTools = tools.slice(0, 3).join("、");
  const remainingCount = tools.length - 3;
  const notification = new Notification({
    title: "Claude 正在等待授权",
    body: `“${request.title}”请求使用 ${visibleTools}${remainingCount > 0 ? ` 等 ${tools.length} 个工具` : ""}`,
    icon: trayIconPath(),
    urgency: "critical",
  });
  activeNotifications.add(notification);
  notification.on("click", () => {
    activeNotifications.delete(notification);
    showMainWindow(request.conversationId as string);
  });
  notification.on("close", () => activeNotifications.delete(notification));
  notification.on("failed", () => activeNotifications.delete(notification));
  notification.show();
  return true;
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

ipcMain.handle("claude:rename-session", async (_event, workspace: unknown, sessionId: unknown, title: unknown) => {
  if (
    typeof workspace !== "string" ||
    !existsSync(workspace) ||
    !statSync(workspace).isDirectory() ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 100
  ) return { renamed: false, error: "会话名称无效" };

  const sessionFile = join(claudeSessionsDirectory(workspace), `${sessionId}.jsonl`);
  let needsLeadingNewline = false;
  try {
    const details = await stat(sessionFile);
    if (!details.isFile()) return { renamed: false, error: "找不到对应的 Claude CLI 会话文件" };
    if (details.size > 0) {
      const handle = await open(sessionFile, "r");
      try {
        const lastByte = Buffer.alloc(1);
        await handle.read(lastByte, 0, 1, details.size - 1);
        needsLeadingNewline = lastByte[0] !== 10 && lastByte[0] !== 13;
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  } catch {
    return { renamed: false, error: "找不到对应的 Claude CLI 会话文件" };
  }
  const record = JSON.stringify({
    type: "custom-title",
    customTitle: title.trim(),
    sessionId,
    timestamp: new Date().toISOString(),
  });
  try {
    await appendFile(sessionFile, `${needsLeadingNewline ? "\n" : ""}${record}\n`, "utf8");
    return { renamed: true };
  } catch (error) {
    return {
      renamed: false,
      error: error instanceof Error ? error.message : "无法写入 Claude CLI 会话名称",
    };
  }
});

ipcMain.handle("claude:branch-session", async (_event, workspace: unknown, sessionId: unknown, userTurn: unknown, title: unknown) => {
  if (
    typeof workspace !== "string" ||
    !existsSync(workspace) ||
    !statSync(workspace).isDirectory() ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    typeof userTurn !== "number" ||
    !Number.isSafeInteger(userTurn) ||
    userTurn < 1 ||
    userTurn > 10_000 ||
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 100
  ) return { branched: false, error: "会话分支参数无效" };
  return createClaudeSessionBranch(workspace, sessionId, userTurn, title.trim());
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

ipcMain.handle("selection:load", async () => {
  try {
    return normalizeAppSelection(JSON.parse(await readFile(appSelectionPath(), "utf8")));
  } catch {
    return null;
  }
});

ipcMain.on("selection:save", (_event, value: unknown) => {
  try {
    saveAppSelection(value);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    void appendFile(join(app.getPath("userData"), "renderer-errors.log"), `${new Date().toISOString()} selection save failed: ${detail}\n`, "utf8");
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
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    request.permissionMode,
  ];
  if (request.sessionId) args.push("--resume", request.sessionId);
  if (request.sessionName) args.push("--name", request.sessionName);
  if (request.model) args.push("--model", request.model);
  if (request.allowedTools?.length) args.push("--allowedTools", [...new Set(request.allowedTools)].join(","));
  await mkdir(attachmentsDirectory(), { recursive: true });
  args.push("--add-dir", attachmentsDirectory());

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
  const activeRun: ActiveRun = {
    child,
    currentTurnRunId: request.runId,
    pendingTurnRunIds: [],
    unfinishedTurnRunIds: new Set([request.runId]),
  };
  activeRuns.set(request.runId, activeRun);

  const output = createInterface({ input: child.stdout });
  const slashDescriptionsPromise = discoverSlashCommandDescriptions(request.cwd).catch(() => ({} as Record<string, string>));
  let observedSessionId = request.sessionId;
  output.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const data: unknown = JSON.parse(line);
      if (data && typeof data === "object") {
        const sessionId = (data as Record<string, unknown>).session_id;
        if (typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)) observedSessionId = sessionId;
        if ((data as Record<string, unknown>).type === "system" && Array.isArray((data as Record<string, unknown>).slash_commands)) {
          (data as Record<string, unknown>).slash_command_descriptions = await slashDescriptionsPromise;
        }
      }
      emit(owner, { runId: activeRun.currentTurnRunId, type: "message", data });
      if (data && typeof data === "object" && (data as Record<string, unknown>).type === "result") {
        activeRun.unfinishedTurnRunIds.delete(activeRun.currentTurnRunId);
        const nextTurnRunId = activeRun.pendingTurnRunIds.shift();
        if (nextTurnRunId) activeRun.currentTurnRunId = nextTurnRunId;
        else activeRun.child.stdin.end();
        if (observedSessionId) {
          void normalizeClaudeDeskSession(request.cwd, observedSessionId, existingSessionPrefix).catch(() => undefined);
        }
      }
    } catch {
      emit(owner, { runId: activeRun.currentTurnRunId, type: "raw", text: line });
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
  });

  child.on("error", (error) => {
    activeRuns.delete(request.runId);
    for (const turnRunId of activeRun.unfinishedTurnRunIds) emit(owner, { runId: turnRunId, type: "error", message: error.message });
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
    for (const turnRunId of activeRun.unfinishedTurnRunIds) {
      emit(owner, { runId: turnRunId, type: "exit", code, stderr: stderr.trim() });
    }
  });

  const attachmentContext = fileAttachmentPaths.length > 0
    ? `\n\n用户附加了以下本地文件，请根据请求读取并使用它们：\n${fileAttachmentPaths.map((path) => `- ${path}`).join("\n")}`
    : "";
  const inputPrompt = `${request.prompt.trim() || "请查看并说明这些附件。"}${attachmentContext}`;
  child.stdin.write(`${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [...imageContent, { type: "text", text: inputPrompt }],
      },
    })}\n`, "utf8");
  return { started: true };
});

ipcMain.handle("claude:append", async (_event, value: unknown) => {
  if (!isValidAppendRunRequest(value)) throw new Error("无效的追加参数");
  const request = value;
  const activeRun = activeRuns.get(request.runId);
  if (!activeRun || activeRun.child.stdin.destroyed || activeRun.child.stdin.writableEnded) return { appended: false };
  const resolvedAttachments = await Promise.all((request.attachments ?? []).map(async (attachment) => {
    const filePath = attachmentPath(attachment.storedName);
    if (!filePath) throw new Error("附件路径无效");
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile() || details.size !== attachment.size) throw new Error(`附件已丢失：${attachment.name}`);
    return { attachment, filePath };
  }));
  const imageContent = await Promise.all(resolvedAttachments.filter(({ attachment }) => attachment.kind === "image").map(async ({ attachment, filePath }) => ({
    type: "image",
    source: { type: "base64", media_type: attachment.mediaType, data: (await readFile(filePath)).toString("base64") },
  })));
  const filePaths = resolvedAttachments.filter(({ attachment }) => attachment.kind === "file").map(({ filePath }) => filePath);
  const attachmentContext = filePaths.length > 0
    ? `\n\n用户附加了以下本地文件，请根据请求读取并使用它们：\n${filePaths.map((path) => `- ${path}`).join("\n")}`
    : "";
  activeRun.pendingTurnRunIds.push(request.turnRunId);
  activeRun.unfinishedTurnRunIds.add(request.turnRunId);
  activeRun.child.stdin.write(`${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [...imageContent, { type: "text", text: `${request.prompt.trim() || "请查看并说明这些附件。"}${attachmentContext}` }],
    },
  })}\n`, "utf8");
  return { appended: true };
});

ipcMain.handle("claude:stop", (_event, runId: string) => {
  const activeRun = activeRuns.get(runId);
  if (!activeRun) return false;
  return activeRun.child.kill();
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  appSettings = await loadAppSettings();
  protocol.handle("claude-desk-attachment", (request) => {
    const storedName = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const filePath = attachmentPath(storedName);
    if (!filePath || !existsSync(filePath)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  createWindow();
  updateManager.initialize();
  app.on("second-instance", () => showMainWindow());
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  updateManager.dispose();
  for (const { child } of activeRuns.values()) child.kill();
  tray?.destroy();
  tray = null;
  for (const notification of activeNotifications) notification.close();
  activeNotifications.clear();
});
