import { app, net, shell, type BrowserWindow } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { clean, gt } from "semver";

export type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "up-to-date" | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  portable: boolean;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  downloadAvailable?: boolean;
  error?: string;
  errorContext?: "check" | "download";
}

export interface UpdateActionResult {
  started: boolean;
  error?: string;
}

interface PortableAsset {
  name: string;
  url: string;
  fallbackUrl?: string;
  size: number;
  digest?: string;
}

interface PortableRelease {
  version: string;
  name: string;
  notes?: string;
  url: string;
  publishedAt?: string;
  asset?: PortableAsset;
}

interface PortableCleanupMarker {
  oldPath: string;
  newPath: string;
  createdAt: number;
}

interface UpdateManagerOptions {
  getWindow(): BrowserWindow | null;
  hasActiveRuns(): boolean;
  prepareToQuit(): void;
}

const GITHUB_OWNER = "yc-2018";
const GITHUB_REPOSITORY = "claude-cli-UI";
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases`;
const GITHUB_LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`;
const PORTABLE_UPDATE_MANIFEST_URL = `${GITHUB_RELEASES_URL}/latest/download/portable-update.json`;
const PORTABLE_CLEANUP_FILE = "portable-update-cleanup.json";
const UPDATE_CHECK_DELAY_MS = 4_000;
const UPDATE_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RELEASE_NOTES_LENGTH = 8_000;

function delay(milliseconds: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function fetchUpdateMetadata(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_REQUEST_TIMEOUT_MS);
  try {
    return await net.fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("连接 GitHub 超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizePathForComparison(path: string) {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const point = code.startsWith("#x")
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return namedEntities[code.toLowerCase()] ?? entity;
  });
}

function plainReleaseNotes(value: string) {
  return decodeHtmlEntities(value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "- ")
    .replace(/<\s*\/\s*(?:h[1-6]|p|div|li|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function releaseNotesText(info: UpdateInfo) {
  if (typeof info.releaseNotes === "string") return plainReleaseNotes(info.releaseNotes).slice(0, MAX_RELEASE_NOTES_LENGTH);
  if (!Array.isArray(info.releaseNotes)) return undefined;
  const notes = info.releaseNotes
    .map((item) => plainReleaseNotes(`${item.version ? `v${item.version}\n` : ""}${item.note ?? ""}`))
    .filter(Boolean)
    .join("\n\n");
  return notes ? notes.slice(0, MAX_RELEASE_NOTES_LENGTH) : undefined;
}

function isPortableAssetName(name: string) {
  return /portable/i.test(name) && /\.exe$/i.test(name);
}

function testUpdateBaseUrl() {
  const value = process.env.CLAUDE_DESK_TEST_UPDATE_BASE_URL;
  if (!value || !process.env.CLAUDE_DESK_TEST_WORKSPACE) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function safeExecutableName(name: string) {
  return (
    basename(name) === name &&
    name.length > 0 &&
    name.length <= 180 &&
    /\.exe$/i.test(name) &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(name)
  );
}

function normalizeDigest(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(value.trim());
  return match?.[1].toLowerCase();
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function portableAssetUrl(version: string, name: string) {
  const testBaseUrl = testUpdateBaseUrl();
  if (testBaseUrl) return `${testBaseUrl}/${encodeURIComponent(name)}`;
  return `${GITHUB_RELEASES_URL}/download/v${version}/${encodeURIComponent(name)}`;
}

function githubNormalizedAssetName(name: string) {
  return name.replace(/[^a-z0-9._-]+/gi, ".");
}

function parsePortableManifest(value: unknown): PortableRelease {
  if (!value || typeof value !== "object") throw new Error("Portable 更新清单无效");
  const manifest = value as Record<string, unknown>;
  const version = typeof manifest.version === "string" ? clean(manifest.version) : null;
  const name = typeof manifest.fileName === "string" ? manifest.fileName : "";
  const declaredAssetName = typeof manifest.assetName === "string" ? manifest.assetName : "";
  const size = typeof manifest.size === "number" && Number.isSafeInteger(manifest.size) && manifest.size > 0 ? manifest.size : 0;
  const digest = normalizeDigest(manifest.sha256);
  if (!version || !safeExecutableName(name) || !isPortableAssetName(name) || name !== `claude-cli-UI Portable ${version}.exe` || size <= 0 || !digest) {
    throw new Error("Portable 更新清单缺少有效的版本、文件大小或 SHA-256");
  }
  const normalizedAssetName = githubNormalizedAssetName(name);
  const expectedAssetNames = new Set([
    name,
    normalizedAssetName,
    `claude-cli-UI-Portable-${version}.exe`,
  ]);
  const assetName = declaredAssetName || name;
  if (!safeExecutableName(assetName) || !isPortableAssetName(assetName) || !expectedAssetNames.has(assetName)) {
    throw new Error("Portable 更新清单包含无效的 GitHub 资产名");
  }
  return {
    version,
    name: `claude-cli-UI v${version}`,
    url: `${GITHUB_RELEASES_URL}/tag/v${version}`,
    asset: {
      name,
      url: portableAssetUrl(version, assetName),
      fallbackUrl: !declaredAssetName && normalizedAssetName !== name
        ? portableAssetUrl(version, normalizedAssetName)
        : undefined,
      size,
      digest,
    },
  };
}

function parseLatestReleaseFallback(value: unknown): PortableRelease {
  if (!value || typeof value !== "object") throw new Error("GitHub 返回了无效的版本信息");
  const release = value as Record<string, unknown>;
  const version = typeof release.tag_name === "string" ? clean(release.tag_name) : null;
  if (!version) throw new Error("GitHub Release 缺少有效的版本号");
  return {
    version,
    name: `claude-cli-UI v${version}`,
    url: `${GITHUB_RELEASES_URL}/tag/v${version}`,
  };
}

export class UpdateManager {
  private state: AppUpdateState;
  private portableRelease: PortableRelease | null = null;
  private portableDownloadPath: string | null = null;
  private checkPromise: Promise<AppUpdateState> | null = null;
  private downloadPromise: Promise<AppUpdateState> | null = null;
  private autoCheckTimer: NodeJS.Timeout | null = null;
  private setupUpdaterConfigured = false;

  constructor(private readonly options: UpdateManagerOptions) {
    this.state = {
      phase: "idle",
      currentVersion: app.getVersion(),
      portable: this.isPortable(),
    };
  }

  initialize() {
    if (!this.isPortable()) this.configureSetupUpdater();
    void this.cleanupPreviousPortable();
    if (
      app.isPackaged &&
      process.env.CLAUDE_DESK_DISABLE_AUTO_UPDATE_CHECK !== "1"
    ) {
      this.autoCheckTimer = setTimeout(() => {
        this.autoCheckTimer = null;
        void this.checkForUpdates(false);
      }, UPDATE_CHECK_DELAY_MS);
    }
  }

  dispose() {
    if (this.autoCheckTimer) clearTimeout(this.autoCheckTimer);
    this.autoCheckTimer = null;
  }

  getState() {
    return this.state;
  }

  async checkForUpdates(manual = true) {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.performUpdateCheck(manual).finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  async downloadUpdate() {
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.performDownload().finally(() => {
      this.downloadPromise = null;
    });
    return this.downloadPromise;
  }

  async installUpdate(): Promise<UpdateActionResult> {
    if (this.state.phase !== "ready") return { started: false, error: "更新尚未下载完成" };
    if (this.options.hasActiveRuns()) return { started: false, error: "仍有会话正在运行，请等待会话结束后再更新" };
    if (process.env.CLAUDE_DESK_TEST_UPDATE_VERSION || process.env.CLAUDE_DESK_TEST_UPDATE_INSTALL === "1") return { started: true };

    if (!this.isPortable()) {
      try {
        this.options.prepareToQuit();
        autoUpdater.quitAndInstall(false, true);
        return { started: true };
      } catch (error) {
        return { started: false, error: `无法启动安装程序：${errorMessage(error)}` };
      }
    }

    const oldPath = this.portableExecutablePath();
    const newPath = this.portableDownloadPath;
    if (!oldPath || !newPath || !existsSync(newPath)) {
      return { started: false, error: "找不到已经下载的 Portable 更新文件" };
    }
    try {
      await this.writeCleanupMarker({ oldPath, newPath, createdAt: Date.now() });
      app.releaseSingleInstanceLock();
      const child = spawn(newPath, [], {
        cwd: dirname(newPath),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
      child.unref();
      this.options.prepareToQuit();
      app.quit();
      return { started: true };
    } catch (error) {
      app.requestSingleInstanceLock();
      return { started: false, error: `无法启动新版 Portable：${errorMessage(error)}` };
    }
  }

  async openReleasePage() {
    const releaseUrl = this.state.releaseUrl?.startsWith(GITHUB_RELEASES_URL)
      ? this.state.releaseUrl
      : GITHUB_RELEASES_URL;
    await shell.openExternal(releaseUrl);
    return true;
  }

  private isPortable() {
    return Boolean(this.portableExecutablePath()) || process.env.CLAUDE_DESK_TEST_PORTABLE === "1";
  }

  private portableExecutablePath() {
    const value = process.env.PORTABLE_EXECUTABLE_FILE;
    return value && isAbsolute(value) ? resolve(value) : null;
  }

  private emitState(state: AppUpdateState) {
    this.state = state;
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("app:update-state", state);
    return state;
  }

  private stateWith(values: Partial<AppUpdateState>) {
    return this.emitState({
      ...this.state,
      ...values,
      currentVersion: app.getVersion(),
      portable: this.isPortable(),
    });
  }

  private async performUpdateCheck(manual: boolean) {
    this.stateWith({ phase: "checking", error: undefined, errorContext: undefined, percent: undefined });
    const testVersion = process.env.CLAUDE_DESK_TEST_UPDATE_VERSION;
    if (testVersion) {
      const version = clean(testVersion);
      if (!version) return this.stateWith({ phase: "error", error: "测试更新版本号无效", errorContext: "check" });
      this.portableRelease = {
        version,
        name: `claude-cli-UI v${version}`,
        notes: plainReleaseNotes(process.env.CLAUDE_DESK_TEST_UPDATE_NOTES ?? "改进 Portable 自动更新流程，并补充应用内更新提示。"),
        url: `${GITHUB_RELEASES_URL}/tag/v${version}`,
        asset: { name: `claude-cli-UI Portable ${version}.exe`, url: `${GITHUB_RELEASES_URL}/download/v${version}/claude-cli-UI%20Portable%20${version}.exe`, size: 1024 },
      };
      return this.stateWith({
        phase: "available",
        latestVersion: version,
        releaseName: this.portableRelease.name,
        releaseNotes: this.portableRelease.notes,
        releaseUrl: this.portableRelease.url,
        downloadAvailable: true,
      });
    }
    if (!app.isPackaged && !testUpdateBaseUrl()) {
      return this.stateWith({ phase: "error", error: "开发模式下不执行自动更新", errorContext: "check" });
    }
    try {
      if (this.isPortable()) return await this.checkPortableRelease();
      this.configureSetupUpdater();
      await autoUpdater.checkForUpdates();
      return this.state;
    } catch (error) {
      const message = `检查更新失败：${errorMessage(error)}`;
      if (!manual) void this.log(message);
      return this.stateWith({ phase: "error", error: message, errorContext: "check" });
    }
  }

  private async checkPortableRelease() {
    const requestHeaders = {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      "User-Agent": `claude-cli-UI/${app.getVersion()}`,
    };
    const manifestUrl = testUpdateBaseUrl() ? `${testUpdateBaseUrl()}/portable-update.json` : PORTABLE_UPDATE_MANIFEST_URL;
    const manifestResponse = await fetchUpdateMetadata(manifestUrl, requestHeaders);
    let release: PortableRelease;
    if (manifestResponse.ok) {
      release = parsePortableManifest(await manifestResponse.json());
    } else {
      const releaseResponse = await fetchUpdateMetadata(GITHUB_LATEST_RELEASE_URL, requestHeaders);
      if (!releaseResponse.ok) throw new Error(`GitHub Releases 返回 ${releaseResponse.status}`);
      release = parseLatestReleaseFallback(await releaseResponse.json());
    }
    this.portableRelease = release;
    if (!gt(release.version, app.getVersion())) {
      return this.stateWith({
        phase: "up-to-date",
        latestVersion: release.version,
        releaseName: release.name,
        releaseNotes: release.notes,
        releaseUrl: release.url,
        publishedAt: release.publishedAt,
        downloadAvailable: Boolean(release.asset),
      });
    }
    return this.stateWith({
      phase: "available",
      latestVersion: release.version,
      releaseName: release.name,
      releaseNotes: release.notes,
      releaseUrl: release.url,
      publishedAt: release.publishedAt,
      downloadAvailable: Boolean(release.asset),
    });
  }

  private configureSetupUpdater() {
    if (this.setupUpdaterConfigured) return;
    this.setupUpdaterConfigured = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL({ provider: "github", owner: GITHUB_OWNER, repo: GITHUB_REPOSITORY });
    autoUpdater.on("checking-for-update", () => {
      this.stateWith({ phase: "checking", error: undefined, errorContext: undefined });
    });
    autoUpdater.on("update-available", (info) => {
      this.stateWith({
        phase: "available",
        latestVersion: info.version,
        releaseName: `claude-cli-UI v${info.version}`,
        releaseNotes: releaseNotesText(info),
        releaseUrl: GITHUB_RELEASES_URL,
        publishedAt: info.releaseDate,
        downloadAvailable: true,
        error: undefined,
        errorContext: undefined,
      });
    });
    autoUpdater.on("update-not-available", (info) => {
      this.stateWith({
        phase: "up-to-date",
        latestVersion: info.version,
        releaseName: `claude-cli-UI v${info.version}`,
        releaseNotes: releaseNotesText(info),
        releaseUrl: GITHUB_RELEASES_URL,
        publishedAt: info.releaseDate,
        downloadAvailable: false,
        error: undefined,
        errorContext: undefined,
      });
    });
    autoUpdater.on("download-progress", (progress) => this.handleSetupDownloadProgress(progress));
    autoUpdater.on("update-downloaded", (info) => {
      this.stateWith({
        phase: "ready",
        latestVersion: info.version,
        percent: 100,
        error: undefined,
        errorContext: undefined,
      });
    });
    autoUpdater.on("error", (error) => {
      const context = this.state.phase === "downloading" ? "download" : "check";
      this.stateWith({ phase: "error", error: errorMessage(error), errorContext: context });
      void this.log(`Updater error: ${errorMessage(error)}`);
    });
  }

  private handleSetupDownloadProgress(progress: ProgressInfo) {
    this.stateWith({
      phase: "downloading",
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      error: undefined,
      errorContext: undefined,
    });
  }

  private async performDownload() {
    if (this.state.phase !== "available" && !(this.state.phase === "error" && this.state.errorContext === "download")) {
      return this.stateWith({ phase: "error", error: "当前没有可下载的更新", errorContext: "download" });
    }
    if (process.env.CLAUDE_DESK_TEST_UPDATE_VERSION) {
      this.stateWith({ phase: "downloading", percent: 42, transferred: 420, total: 1000, bytesPerSecond: 500 });
      await delay(150);
      this.portableDownloadPath = "test-portable-update.exe";
      return this.stateWith({ phase: "ready", percent: 100, transferred: 1000, total: 1000, bytesPerSecond: 500 });
    }
    if (!this.isPortable()) {
      try {
        this.stateWith({ phase: "downloading", percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, error: undefined, errorContext: undefined });
        await autoUpdater.downloadUpdate();
        return this.state;
      } catch (error) {
        return this.stateWith({ phase: "error", error: `下载更新失败：${errorMessage(error)}`, errorContext: "download" });
      }
    }
    try {
      return await this.downloadPortableUpdate();
    } catch (error) {
      const message = `下载 Portable 更新失败：${errorMessage(error)}`;
      void this.log(message);
      return this.stateWith({ phase: "error", error: message, errorContext: "download" });
    }
  }

  private async downloadPortableUpdate() {
    const release = this.portableRelease;
    const asset = release?.asset;
    if (!release || !asset) throw new Error("当前 Release 没有 Portable 安装包，请前往发布页下载");
    const oldPath = this.portableExecutablePath();
    if (!oldPath) throw new Error("无法确定当前 Portable 文件的位置");

    const destination = await this.preparePortableDestination(asset, release.version, oldPath);
    if (destination.existing) {
      this.portableDownloadPath = destination.finalPath;
      return this.stateWith({ phase: "ready", percent: 100, transferred: asset.size, total: asset.size });
    }

    const requestHeaders = { "User-Agent": `claude-cli-UI/${app.getVersion()}` };
    let response = await net.fetch(asset.url, { headers: requestHeaders });
    if ((!response.ok || !response.body) && response.status === 404 && asset.fallbackUrl) {
      response = await net.fetch(asset.fallbackUrl, { headers: requestHeaders });
    }
    if (!response.ok || !response.body) throw new Error(`GitHub 下载返回 ${response.status}`);

    const total = Number(response.headers.get("content-length")) || asset.size;
    const hash = createHash("sha256");
    const handle = await open(destination.temporaryPath, "wx");
    let transferred = 0;
    const startedAt = Date.now();
    let lastProgressAt = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        await handle.write(buffer);
        hash.update(buffer);
        transferred += buffer.byteLength;
        const now = Date.now();
        if (now - lastProgressAt >= 150) {
          lastProgressAt = now;
          this.stateWith({
            phase: "downloading",
            percent: total > 0 ? Math.min(100, transferred / total * 100) : undefined,
            transferred,
            total,
            bytesPerSecond: Math.round(transferred / Math.max(1, (now - startedAt) / 1000)),
            error: undefined,
            errorContext: undefined,
          });
        }
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(destination.temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    if (asset.size > 0 && transferred !== asset.size) {
      await unlink(destination.temporaryPath).catch(() => undefined);
      throw new Error(`文件大小不一致，预期 ${asset.size} 字节，实际 ${transferred} 字节`);
    }
    if (asset.digest && hash.digest("hex") !== asset.digest) {
      await unlink(destination.temporaryPath).catch(() => undefined);
      throw new Error("下载文件的 SHA-256 校验失败");
    }
    await rename(destination.temporaryPath, destination.finalPath);
    this.portableDownloadPath = destination.finalPath;
    return this.stateWith({
      phase: "ready",
      percent: 100,
      transferred,
      total: total || transferred,
      bytesPerSecond: Math.round(transferred / Math.max(1, (Date.now() - startedAt) / 1000)),
      error: undefined,
      errorContext: undefined,
    });
  }

  private async preparePortableDestination(asset: PortableAsset, version: string, oldPath: string) {
    const directories = [...new Set([dirname(oldPath), app.getPath("downloads")].map((path) => normalize(resolve(path))))];
    let lastError: unknown;
    for (const directory of directories) {
      try {
        await mkdir(directory, { recursive: true });
        let finalPath = join(directory, asset.name);
        if (normalizePathForComparison(finalPath) === normalizePathForComparison(oldPath)) {
          const parsed = parse(asset.name);
          finalPath = join(directory, `${parsed.name} ${version}${parsed.ext}`);
        }
        if (existsSync(finalPath)) {
          if (await this.isValidPortableFile(finalPath, asset)) {
            return { finalPath, temporaryPath: "", existing: true };
          }
          const parsed = parse(finalPath);
          finalPath = join(directory, `${parsed.name} (${Date.now()})${parsed.ext}`);
        }
        const temporaryPath = join(directory, `.${basename(finalPath)}.${process.pid}-${randomUUID()}.download`);
        const probe = await open(temporaryPath, "wx");
        await probe.close();
        await unlink(temporaryPath);
        return { finalPath, temporaryPath, existing: false };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Portable 所在目录和下载目录都不可写：${errorMessage(lastError)}`);
  }

  private async isValidPortableFile(path: string, asset: PortableAsset) {
    try {
      const info = await stat(path);
      if (!info.isFile() || (asset.size > 0 && info.size !== asset.size)) return false;
      return asset.digest ? await sha256File(path) === asset.digest : true;
    } catch {
      return false;
    }
  }

  private cleanupMarkerPath() {
    return join(app.getPath("userData"), PORTABLE_CLEANUP_FILE);
  }

  private async writeCleanupMarker(marker: PortableCleanupMarker) {
    await mkdir(app.getPath("userData"), { recursive: true });
    const path = this.cleanupMarkerPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(marker), "utf8");
    await unlink(path).catch(() => undefined);
    await rename(temporaryPath, path);
  }

  private async cleanupPreviousPortable() {
    const currentPath = this.portableExecutablePath();
    if (!currentPath) return;
    const markerPath = this.cleanupMarkerPath();
    let marker: PortableCleanupMarker;
    try {
      marker = JSON.parse(await readFile(markerPath, "utf8")) as PortableCleanupMarker;
    } catch {
      return;
    }
    const valid = (
      marker &&
      typeof marker.oldPath === "string" && isAbsolute(marker.oldPath) && extname(marker.oldPath).toLowerCase() === ".exe" &&
      typeof marker.newPath === "string" && isAbsolute(marker.newPath) &&
      typeof marker.createdAt === "number" && Date.now() - marker.createdAt < 7 * 24 * 60 * 60 * 1000 &&
      normalizePathForComparison(marker.newPath) === normalizePathForComparison(currentPath) &&
      normalizePathForComparison(marker.oldPath) !== normalizePathForComparison(currentPath)
    );
    if (!valid) {
      await unlink(markerPath).catch(() => undefined);
      return;
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (!existsSync(marker.oldPath)) {
        await unlink(markerPath).catch(() => undefined);
        return;
      }
      try {
        await shell.trashItem(marker.oldPath);
        await unlink(markerPath).catch(() => undefined);
        return;
      } catch (error) {
        if (attempt === 11) {
          void this.log(`Unable to recycle previous Portable executable: ${errorMessage(error)}`);
          return;
        }
        await delay(500);
      }
    }
  }

  private async log(message: string) {
    const path = join(app.getPath("userData"), "update.log");
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    await writeFile(path, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8", flag: "a" }).catch(() => undefined);
  }
}
