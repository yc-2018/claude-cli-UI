import { watch, type FSWatcher, type WatchOptions } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BrowserWindow } from "electron";

/** 主进程发现 Claude 自己的文件变了之后推给 renderer 的信号，只说「哪一类变了」，不带内容。 */
export interface ClaudeWatchEvent {
  kind: "sessions" | "settings";
  /** sessions 事件带上 `~/.claude/projects` 下的目录名，renderer 用它匹配是哪个项目。 */
  projectKey?: string;
}

interface ClaudeWatcherOptions {
  getWindow(): BrowserWindow | null;
  getConfigDirectory(): string;
}

// Claude CLI 的 JSONL 是一条消息追加一行，一轮对话会连写好几行。用尾部防抖把这些写入收成一次
// 同步，400ms 足够合并一条消息内部的多次写事件，又不会让界面看起来落后于终端。
const WATCH_DEBOUNCE_MS = 400;
const SETTINGS_FILE_NAMES = ["settings.json", "settings.local.json"];
// 配置类事件不区分来源，全部挤进同一个防抖桶；用 session ID 不可能出现的名字避免和 projectKey 撞车。
const SETTINGS_BUCKET = "settings";

export class ClaudeWatcher {
  private readonly options: ClaudeWatcherOptions;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private workspace: string | null = null;

  constructor(options: ClaudeWatcherOptions) {
    this.options = options;
  }

  initialize() {
    const configDirectory = this.options.getConfigDirectory();

    // 一个 recursive watcher 覆盖全部项目目录，连临时对话用的 scratch 目录也一起看住了。
    this.open("projects", join(configDirectory, "projects"), { recursive: true }, (filename) => {
      const relative = filename.replace(/\\/g, "/");
      // 有些项目目录下还有 memory 之类的子目录，只有 session 文件值得触发同步。
      if (!relative.endsWith(".jsonl")) return;
      const projectKey = relative.split("/")[0];
      if (!projectKey || projectKey.endsWith(".jsonl")) return;
      this.schedule(projectKey, { kind: "sessions", projectKey });
    });

    this.open("config", configDirectory, {}, (filename) => {
      if (SETTINGS_FILE_NAMES.includes(filename)) this.schedule(SETTINGS_BUCKET, { kind: "settings" });
    });

    // 测试里模型配置来自 CLAUDE_DESK_TEST_MODELS_FILE 而不是 settings.json，不看住这个文件就没法
    // 验证「外部改了配置，界面自己更新」。
    const testModelsFile = process.env.CLAUDE_DESK_TEST_MODELS_FILE;
    if (testModelsFile) {
      const testModelsName = basename(testModelsFile);
      this.open("test-models", dirname(testModelsFile), {}, (filename) => {
        if (filename === testModelsName) this.schedule(SETTINGS_BUCKET, { kind: "settings" });
      });
    }
  }

  /** 模型配置还能来自 workspace 下的 .claude，所以活动项目换了就把这一个 watcher 挪过去。 */
  watchWorkspace(workspace: string) {
    if (this.workspace === workspace) return;
    this.workspace = workspace;
    this.close("workspace");
    if (!workspace) return;
    this.open("workspace", join(workspace, ".claude"), {}, (filename) => {
      if (SETTINGS_FILE_NAMES.includes(filename)) this.schedule(SETTINGS_BUCKET, { kind: "settings" });
    });
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const key of [...this.watchers.keys()]) this.close(key);
    this.workspace = null;
  }

  private open(key: string, directory: string, options: WatchOptions, onChange: (filename: string) => void) {
    this.close(key);
    try {
      const watcher = watch(directory, { ...options, persistent: false }, (_type, filename) => {
        if (typeof filename === "string" && filename) onChange(filename);
      });
      // 目录被删掉或权限变了只该让这一个 watcher 失效，绝不能冒泡成未捕获异常把主进程带走。
      watcher.on("error", () => this.close(key));
      this.watchers.set(key, watcher);
    } catch {
      // Claude 还没建过这个目录，就没什么可监听的；下次启动或用户下次操作时再试。
    }
  }

  private close(key: string) {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    this.watchers.delete(key);
    try {
      watcher.close();
    } catch {
      // 已经失效的 watcher 关不上也无所谓，引用已经摘掉了。
    }
  }

  private schedule(bucket: string, event: ClaudeWatchEvent) {
    const existing = this.timers.get(bucket);
    if (existing) clearTimeout(existing);
    this.timers.set(bucket, setTimeout(() => {
      this.timers.delete(bucket);
      this.emit(event);
    }, WATCH_DEBOUNCE_MS));
  }

  private emit(event: ClaudeWatchEvent) {
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("claude:watch", event);
  }
}
