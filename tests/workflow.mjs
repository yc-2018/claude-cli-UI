import { _electron as electron } from "playwright";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
const releaseWorkflow = await readFile(resolve(root, ".github", "workflows", "windows-release.yml"), "utf8");
if (
  !releaseWorkflow.includes('$portableAssetName = "claude-cli-UI-Portable-$packageVersion.exe"') ||
  !releaseWorkflow.includes("assetName = $portableFile.Name")
) throw new Error("release workflow did not publish a GitHub-safe Portable asset name");
const workspaceDirectoryName = basename(root);
const artifacts = resolve(root, "artifacts");
const profile = resolve(artifacts, `workflow-profile-${Date.now()}`);
const claudeConfig = resolve(profile, "claude-config");
const cliSessions = resolve(claudeConfig, "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
const fakeCli = resolve(root, "tests", "fixtures", "fake-claude.mjs");
const processExitGate = resolve(profile, "release-process-exit");
const terminalLog = resolve(profile, "terminal-launches.jsonl");
const addDirLog = resolve(profile, "add-dir-launches.jsonl");
const dialogLog = resolve(profile, "directory-dialogs.jsonl");
const runLog = resolve(profile, "cli-runs.jsonl");
const shellTaskLog = resolve(profile, "shell-tasks.jsonl");
/** 收尾命令是等所有回答都结束后再延后执行的，断言「没有多执行一次」时要等过这段时间。 */
const COMPLETION_TASK_SETTLE_MS = 7_000;
const packagedExecutable = process.env.CLAUDE_DESK_TEST_EXECUTABLE;
await mkdir(profile, { recursive: true });
await mkdir(cliSessions, { recursive: true });
// 便携版每升一级文件名就换一次，快捷方式若指向这份构建产物，产物一被清理入口就失效。
// 预先放一个坏掉的 .lnk，再在入口该指向的固定副本位置留下上一版的旧副本，两样都该被换成当前这一版。
const startMenuDirectory = resolve(profile, "start-menu");
const startMenuShortcut = resolve(startMenuDirectory, "claude-cli-UI.lnk");
const launcherExecutable = resolve(profile, "launcher", "claude-cli-UI.exe");
const staleShortcutMarker = "上一版留下的过期快捷方式";
const staleLauncherMarker = "上一版留下的旧副本";
await mkdir(startMenuDirectory, { recursive: true });
await writeFile(startMenuShortcut, staleShortcutMarker, "utf8");
await mkdir(dirname(launcherExecutable), { recursive: true });
await writeFile(launcherExecutable, staleLauncherMarker, "utf8");
const updateVersion = "9.9.9";
const updateExecutableName = `claude-cli-UI Portable ${updateVersion}.exe`;
const updateAssetName = `claude-cli-UI-Portable-${updateVersion}.exe`;
const updateExecutable = Buffer.alloc(512 * 1024, 0x5a);
updateExecutable.write("MZ claude-cli-UI portable update regression fixture\n", "utf8");
const updateManifest = {
  version: updateVersion,
  fileName: updateExecutableName,
  assetName: updateAssetName,
  size: updateExecutable.byteLength,
  sha256: createHash("sha256").update(updateExecutable).digest("hex"),
};
const legacyUpdateVersion = "9.9.10";
const legacyUpdateExecutableName = `claude-cli-UI Portable ${legacyUpdateVersion}.exe`;
const legacyUpdateAssetName = `claude-cli-UI.Portable.${legacyUpdateVersion}.exe`;
const legacyUpdateExecutable = Buffer.alloc(384 * 1024, 0x6b);
legacyUpdateExecutable.write("MZ legacy GitHub-normalized portable update fixture\n", "utf8");
const legacyUpdateManifest = {
  version: legacyUpdateVersion,
  fileName: legacyUpdateExecutableName,
  size: legacyUpdateExecutable.byteLength,
  sha256: createHash("sha256").update(legacyUpdateExecutable).digest("hex"),
};
let useLegacyUpdateManifest = false;
const updateAssetRequests = [];
const updateServer = createServer((request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1));
  if (requestPath === "portable-update.json") {
    const manifest = JSON.stringify(useLegacyUpdateManifest ? legacyUpdateManifest : updateManifest);
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(manifest) });
    response.end(manifest);
    return;
  }
  updateAssetRequests.push(requestPath);
  const executable = requestPath === updateAssetName
    ? updateExecutable
    : requestPath === legacyUpdateAssetName
      ? legacyUpdateExecutable
      : null;
  if (executable) {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": executable.byteLength });
    let offset = 0;
    const writeNextChunk = () => {
      if (response.destroyed) return;
      if (offset >= executable.byteLength) {
        response.end();
        return;
      }
      const nextOffset = Math.min(executable.byteLength, offset + 32 * 1024);
      response.write(executable.subarray(offset, nextOffset));
      offset = nextOffset;
      setTimeout(writeNextChunk, 25);
    };
    writeNextChunk();
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolveListen, rejectListen) => {
  updateServer.once("error", rejectListen);
  updateServer.listen(0, "127.0.0.1", resolveListen);
});
const updateAddress = updateServer.address();
if (!updateAddress || typeof updateAddress === "string") throw new Error("failed to start the local update fixture server");
const updateBaseUrl = `http://127.0.0.1:${updateAddress.port}`;
const currentPortablePath = resolve(profile, `claude-cli-UI Portable ${packageVersion}.exe`);
await writeFile(currentPortablePath, "current portable fixture", "utf8");
const attachmentText = "attachment text fixture";
const attachmentPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av7sNwAAAABJRU5ErkJggg==";
const importedSessionId = "44444444-4444-4444-8444-444444444444";
const importedTime = Date.now() - 60_000;
await writeFile(resolve(cliSessions, `${importedSessionId}.jsonl`), [
  {
    type: "user",
    uuid: "history-user",
    timestamp: new Date(importedTime).toISOString(),
    cwd: root,
    sessionId: importedSessionId,
    gitBranch: "feature/cli-sync",
    permissionMode: "acceptEdits",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: attachmentPngBase64 } },
        { type: "text", text: "来自终端的历史对话" },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "history-assistant",
    timestamp: new Date(importedTime + 1_000).toISOString(),
    cwd: root,
    sessionId: importedSessionId,
    message: {
      id: "history-response",
      role: "assistant",
      model: "ThirdParty-A",
      content: [
        { type: "thinking", thinking: "读取终端历史并整理上下文。" },
        { type: "text", text: "先核对 CLI 历史。" },
        {
          type: "tool_use",
          id: "history-tool",
          name: "Edit",
          input: { file_path: "README.md", old_string: "旧说明", new_string: "新说明" },
        },
        { type: "text", text: "这是从 Claude CLI 会话文件恢复的回答。" },
      ],
      usage: { input_tokens: 5_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000 },
    },
  },
  {
    type: "user",
    uuid: "history-tool-result",
    timestamp: new Date(importedTime + 1_050).toISOString(),
    cwd: root,
    sessionId: importedSessionId,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "history-tool", content: "Updated README.md" }] },
    toolUseResult: {
      type: "update",
      filePath: "README.md",
      structuredPatch: [{ oldStart: 8, oldLines: 1, newStart: 8, newLines: 1, lines: ["-旧说明", "+新说明"] }],
    },
  },
  {
    type: "last-prompt",
    timestamp: new Date(importedTime + 1_100).toISOString(),
    cwd: root,
    sessionId: importedSessionId,
    lastPrompt: "来自终端的历史对话",
  },
].map((entry) => JSON.stringify(entry)).join("\n"), "utf8");

// 模型映射走文件而不是环境变量：展开模型菜单会重新读一遍配置，只有可变的来源才验证得到刷新。
const modelsFile = resolve(profile, "test-models.json");
const writeTestModels = (models) => writeFile(modelsFile, JSON.stringify(models), "utf8");
await writeTestModels({
  Sonnet: "ThirdParty-A",
  Opus: "ThirdParty-A",
  Fable: "ThirdParty-B",
  Haiku: "ThirdParty-B",
});

/**
 * 重试设置是假 CLI 从进程环境里读的，而这份环境会从测试进程原样继承：开发者自己（或上层
 * agent 运行时）导出的 CLAUDE_CODE_MAX_RETRIES 会一路漏进假 CLI，把「回到 CLI 默认就不该
 * 带重试变量」的断言顶掉。测试不能依赖开发者的环境，先把这两个变量摘干净再启动。
 */
const launchEnv = { ...process.env };
delete launchEnv.CLAUDE_CODE_MAX_RETRIES;
delete launchEnv.CLAUDE_CODE_RETRY_WATCHDOG;

const launch = () => electron.launch({
  ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
  args: packagedExecutable ? [] : [root],
  cwd: root,
  env: {
    ...launchEnv,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_DESK_USER_DATA_DIR: profile,
    CLAUDE_DESK_TEST_WORKSPACE: root,
    CLAUDE_DESK_FAKE_SESSIONS_DIR: cliSessions,
    CLAUDE_DESK_TEST_EXIT_GATE: processExitGate,
    // 轮次收尾后进程不退的兜底时长调短，否则这条回归要等满 20 秒。
    CLAUDE_DESK_EXIT_WATCHDOG_MS: "6000",
    CLAUDE_DESK_TEST_TERMINAL_LOG: terminalLog,
    CLAUDE_DESK_TEST_ADD_DIR_LOG: addDirLog,
    CLAUDE_DESK_TEST_DIALOG_LOG: dialogLog,
    CLAUDE_DESK_TEST_RUN_LOG: runLog,
    CLAUDE_DESK_TEST_SHELL_TASK_LOG: shellTaskLog,
    CLAUDE_DESK_DISABLE_NOTIFICATIONS: "1",
    CLAUDE_DESK_TEST_OFFSCREEN: "1",
    CLAUDE_DESK_DISABLE_AUTO_UPDATE_CHECK: "1",
    CLAUDE_DESK_TEST_UPDATE_BASE_URL: updateBaseUrl,
    CLAUDE_DESK_TEST_UPDATE_INSTALL: "1",
    CLAUDE_DESK_TEST_EXPECT_EFFORT: "high",
    PORTABLE_EXECUTABLE_FILE: currentPortablePath,
    CLAUDE_DESK_TEST_START_MENU_DIR: startMenuDirectory,
    CLAUDE_DESK_TEST_MODELS_FILE: modelsFile,
    CLAUDE_DESK_CLAUDE_EXECUTABLE: process.execPath,
    CLAUDE_DESK_CLAUDE_PREFIX_ARGS: JSON.stringify([fakeCli]),
  },
});

/**
 * Playwright 的 waitForFunction 会把 async 断言返回的 Promise 直接当成真值，写成 async 就等于不校验。
 * 需要读主进程状态的条件统一走这里：在测试进程里轮询，页面侧用 evaluate 真正把结果 await 出来。
 */
const waitForAsyncCondition = async (page, predicate, argument, options = {}) => {
  // 默认给到 Playwright 自己的 30s：CI 上两个构建并发时机器很忙，15s 会把偶发的慢写入误判成失败。
  const deadline = Date.now() + (options.timeout ?? 30_000);
  for (;;) {
    if (await page.evaluate(predicate, argument)) return;
    if (Date.now() > deadline) throw new Error("等待条件超时，断言没有在期限内成立");
    await new Promise((done) => setTimeout(done, 100));
  }
};

const errors = [];
/**
 * 崩溃恢复那段用例会故意把渲染进程打死、并把 localStorage 副本写坏：Electron 自己的 sandbox
 * 启动报错和「副本写失败」日志都是这段的预期输出，只在这段里放行。
 */
let expectRendererCrashNoise = false;
const rendererCrashNoise = [
  /保存项目副本失败/,
  /sandboxed_renderer\.bundle\.js script failed to run/,
  /Cannot destructure property 'preloadScripts'/,
];
const isExpectedCrashNoise = (detail) => expectRendererCrashNoise && rendererCrashNoise.some((pattern) => pattern.test(detail));
const watchErrors = (page) => {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!isExpectedCrashNoise(text)) errors.push(text);
  });
  page.on("pageerror", (error) => {
    const detail = error.stack ?? error.message;
    if (!isExpectedCrashNoise(detail)) errors.push(detail);
  });
};

const refreshProjectSessions = async (page) => {
  const projectRow = page.locator(".project-row").first();
  await projectRow.hover();
  await projectRow.locator('[title="刷新 Claude CLI 会话"]').evaluate((button) => button.click());
};

/**
 * 拖动手柄平时是 pointer-events: none，只在行 hover 或 focus-within 时才可交互。
 * 先聚焦手柄，这样即使上一步的重排把行移到了鼠标之外，拖拽也不会被父行拦住。
 */
const reorderDrag = async (row, handleSelector, target, targetPosition) => {
  const handle = row.locator(handleSelector);
  await row.hover();
  await handle.evaluate((element) => element.focus());
  // Playwright's dragTo doesn't work reliably with button[draggable], use manual events
  await handle.evaluate((el, targetPos) => {
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, targetPosition);
  await target.evaluate((el, targetPos) => {
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + (targetPos?.x ?? rect.width / 2);
    const clientY = rect.top + (targetPos?.y ?? rect.height / 2);
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
  }, targetPosition);
  await handle.evaluate((el) => {
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
};

/**
 * 会话行可能在所属项目的文件夹里和「置顶」段各渲染一次，断言默认只认文件夹里那一份，
 * 否则 Playwright 严格模式会因为一个选择器命中两个元素而报歧义。
 */
const inFolder = (page, selector, options) => page.locator(`.project-conversations ${selector}`, options);

let electronApp;
try {
  electronApp = await launch();
  let page = await electronApp.firstWindow();
  if (await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocusable()))) {
    throw new Error("后台测试窗口不应能够抢占系统焦点");
  }
  watchErrors(page);
  await page.waitForFunction(() => document.title === "claude-cli-UI");
  await page.waitForSelector(".sidebar-brand");
  if (await page.title() !== "claude-cli-UI") throw new Error("window title did not use the product name");
  if ((await page.locator(".sidebar-brand").textContent())?.trim() !== "claude-cli-UI") throw new Error("sidebar did not use the product name");
  await page.waitForFunction((version) => document.querySelector(".sidebar-version")?.textContent === `claude-cli-UI v${version}`, packageVersion);

  // result 只代表轮次完成；即使所有轮次已结束，进程真正关闭时仍必须发出 exit。
  const lifecycleRunId = "process-exit-regression";
  const lifecycleRequest = {
    runId: lifecycleRunId,
    conversationId: "process-exit-regression-conversation",
    cwd: profile,
    prompt: "进程退出通知回归测试",
    permissionMode: "acceptEdits",
  };
  const lifecycleStart = await page.evaluate((request) => {
    window.__lifecycleEvents = [];
    window.__removeLifecycleListener = window.claudeDesk.onEvent((event) => {
      if (event.runId === request.runId && (event.type === "exit" || event.data?.type === "result")) {
        window.__lifecycleEvents.push({ type: event.type, dataType: event.data?.type });
      }
    });
    return window.claudeDesk.startRun(request);
  }, lifecycleRequest);
  if (!lifecycleStart.started) throw new Error("进程退出回归测试未能启动假 CLI");
  await page.waitForFunction(() => window.__lifecycleEvents.some((event) => event.dataType === "result"));
  const blockedStart = await page.evaluate((request) => window.claudeDesk.startRun({ ...request, runId: "blocked-next-run" }), lifecycleRequest);
  if (blockedStart.started || !blockedStart.busy || blockedStart.runId !== lifecycleRunId) {
    throw new Error(`旧进程退出前不应允许新进程并发启动：${JSON.stringify(blockedStart)}`);
  }
  await writeFile(processExitGate, "release", "utf8");
  await waitForAsyncCondition(page, async (runId) => !(await window.claudeDesk.getActiveRuns()).some((run) => run.runId === runId), lifecycleRunId);
  try {
    await page.waitForFunction(() => window.__lifecycleEvents.some((event) => event.type === "exit"), undefined, { timeout: 5_000 });
  } catch {
    throw new Error("假 CLI 已退出但没有进程 exit 通知，busy 状态和提示队列无法恢复");
  }
  const lifecycleEvents = await page.evaluate(() => {
    window.__removeLifecycleListener();
    return window.__lifecycleEvents;
  });
  if (lifecycleEvents.length !== 2 || lifecycleEvents[0].dataType !== "result" || lifecycleEvents[1].type !== "exit") {
    throw new Error(`进程退出事件应仅在 result 后出现一次：${JSON.stringify(lifecycleEvents)}`);
  }

  /** 这两个回归都直接走 IPC：不新建对话，就不会牵动侧栏里那几处写死的对话条数。 */
  const collectRunEvents = async (request) => {
    const started = await page.evaluate((value) => {
      window.__runEvents = [];
      window.__removeRunListener = window.claudeDesk.onEvent((event) => {
        if (event.runId !== value.runId) return;
        window.__runEvents.push({
          type: event.type,
          dataType: event.data?.type,
          subtype: event.data?.subtype,
          result: typeof event.data?.result === "string" ? event.data.result : undefined,
          text: event.data?.message?.content?.[0]?.text,
        });
      });
      return window.claudeDesk.startRun(value);
    }, request);
    if (!started.started) throw new Error(`${request.prompt} 未能启动假 CLI：${JSON.stringify(started)}`);
  };
  const takeRunEvents = () => page.evaluate(() => {
    window.__removeRunListener();
    return window.__runEvents;
  });

  // 回归：CLI 会在我们发的提示之前先替自己跑一轮（被 --resume 拉起时处理上一个进程留下的后台
  // 任务通知），并单独为那一轮发一个空 result。过去那个 result 一到就把我们这一轮收尾了：气泡
  // 几秒内变成「已完成、没有输出」，而真正的回答才刚开始跑，之后的全部输出都挂在一个已经结束的
  // 轮次上，界面完全看不见。
  const unsolicitedRunId = "unsolicited-result-regression";
  await collectRunEvents({
    runId: unsolicitedRunId,
    conversationId: "unsolicited-result-conversation",
    cwd: profile,
    prompt: "插队轮次回归测试",
    permissionMode: "acceptEdits",
  });
  await page.waitForFunction(() => window.__runEvents.some((event) => event.type === "exit"), undefined, { timeout: 20_000 })
    .catch(() => { throw new Error("插队轮次回归测试的假 CLI 没有退出"); });
  const unsolicitedEvents = await takeRunEvents();
  const deliveredResults = unsolicitedEvents.filter((event) => event.dataType === "result");
  if (deliveredResults.length !== 1 || !deliveredResults[0].result?.includes("这一轮才真正开始输出")) {
    throw new Error(`插队那一轮的空 result 不该收尾我们这一轮：${JSON.stringify(unsolicitedEvents)}`);
  }
  // 真正的回答必须在收尾之前就送到，否则它仍然是「看不见的输出」。
  const answerIndex = unsolicitedEvents.findIndex((event) => event.text?.includes("这一轮才真正开始输出"));
  if (answerIndex < 0 || answerIndex > unsolicitedEvents.indexOf(deliveredResults[0])) {
    throw new Error(`我们这一轮的回答没有在收尾前送到渲染层：${JSON.stringify(unsolicitedEvents)}`);
  }

  // 回归：轮次答完、stdin 也关了之后，CLI 可能因为还有后台任务而一直不退出。渲染层的忙碌状态
  // 只能靠进程退出释放，过去对话就永远在转圈、待发送队列也发不出去，而那个进程还在后台改文件。
  const stuckRunId = "exit-watchdog-regression";
  await collectRunEvents({
    runId: stuckRunId,
    conversationId: "exit-watchdog-conversation",
    cwd: profile,
    prompt: "不退出回归测试",
    permissionMode: "acceptEdits",
  });
  await page.waitForFunction(() => window.__runEvents.some((event) => event.dataType === "result"));
  if (!(await page.evaluate(async (runId) => (await window.claudeDesk.getActiveRuns()).some((run) => run.runId === runId), stuckRunId))) {
    throw new Error("不退出回归测试的假 CLI 应该在 result 之后仍然活着");
  }
  await page.waitForFunction(() => window.__runEvents.some((event) => event.type === "exit"), undefined, { timeout: 30_000 })
    .catch(() => { throw new Error("轮次收尾后赖着不退的进程没有被退出看守收掉，对话会一直显示在运行") });
  await page.waitForFunction(
    async (runId) => !(await window.claudeDesk.getActiveRuns()).some((run) => run.runId === runId),
    stuckRunId,
    { timeout: 10_000 },
  );
  await takeRunEvents();
  const watchdogLog = await readFile(resolve(profile, "renderer-errors.log"), "utf8").catch(() => "");
  if (!/killing claude pid .*轮次已收尾但进程/.test(watchdogLog)) {
    throw new Error(`退出看守杀掉进程这件事没有被记下来：${watchdogLog.slice(-300)}`);
  }

  // 便携版没有安装步骤，开始菜单入口得自己维护。入口只能指向应用自留的固定副本：改成指向
  // 带版本号的构建产物，产物被清理或改名之后，入口就指向一个不存在的文件，而且再也修不回来。
  const shortcutBytes = await readFile(startMenuShortcut);
  if (shortcutBytes.toString("utf8").includes(staleShortcutMarker)) {
    throw new Error("stale start menu shortcut was left untouched");
  }
  // .lnk 里的路径按 UTF-16LE 存，部分字段退化成单字节，两种解码都看一遍最稳。
  const shortcutText = `${shortcutBytes.toString("utf16le")}${shortcutBytes.toString("latin1")}`;
  if (!shortcutText.includes(launcherExecutable)) {
    throw new Error(`start menu shortcut does not point at the fixed launcher copy: ${shortcutBytes.length} bytes`);
  }
  if (shortcutText.includes(`claude-cli-UI Portable ${packageVersion}.exe`)) {
    throw new Error("start menu shortcut still points at the versioned portable build");
  }
  // 旧副本必须被覆盖成当前这一版，否则入口打开的还是上一版程序。
  const launcherBytes = await readFile(launcherExecutable);
  if (launcherBytes.toString("utf8").includes(staleLauncherMarker)) {
    throw new Error("stale launcher copy was left untouched");
  }
  if (!launcherBytes.equals(await readFile(currentPortablePath))) {
    throw new Error(`launcher copy does not match the current portable build: ${launcherBytes.length} bytes`);
  }

  await page.locator(".settings-trigger[data-panel=\"settings\"]").click();
  const traySetting = page.locator(".segmented-control button", { hasText: "托盘后台" });
  const quitSetting = page.locator(".segmented-control button", { hasText: "退出应用" });
  const completionSetting = page.locator(".setting-toggle-row input");
  if (!(await traySetting.getAttribute("class"))?.includes("active") || !(await completionSetting.isChecked())) {
    throw new Error("background settings did not use the expected defaults");
  }
  await quitSetting.click();
  await waitForAsyncCondition(page, async () => (await window.claudeDesk.getAppSettings()).closeBehavior === "quit");
  await traySetting.click();
  await completionSetting.evaluate((input) => input.click());
  await waitForAsyncCondition(page, async () => (await window.claudeDesk.getAppSettings()).notifyOnCompletion === false);
  await completionSetting.evaluate((input) => input.click());
  await waitForAsyncCondition(page, async () => {
    const settings = await window.claudeDesk.getAppSettings();
    return settings.closeBehavior === "tray" && settings.notifyOnCompletion === true;
  });
  const updateButton = page.locator(".setting-update-button");
  if (!(await page.locator(".setting-update-row").textContent())?.includes("Portable 自动更新")) {
    throw new Error("settings did not identify the Portable update mode");
  }
  await updateButton.click();
  await page.waitForSelector(".update-dialog");
  const updateDialogText = await page.locator(".update-dialog").textContent();
  if (!updateDialogText?.includes(`发现新版本 v${updateVersion}`) || !updateDialogText.includes(`当前版本 v${packageVersion}`)) {
    throw new Error("available update details were not shown in the app dialog");
  }
  if (!updateDialogText.includes("旧版文件会移入 Windows 回收站")) {
    throw new Error("Portable update cleanup behavior was not explained");
  }
  const ignoreUpdateButton = page.locator(".update-ignore-button");
  if (await ignoreUpdateButton.count() !== 1) throw new Error("update dialog did not offer per-version suppression");
  await ignoreUpdateButton.click();
  await page.waitForSelector(".update-dialog", { state: "detached" });
  await waitForAsyncCondition(page, async (version) => (await window.claudeDesk.getAppSettings()).ignoredUpdateVersion === version, updateVersion);
  await updateButton.click();
  await page.waitForSelector(".update-dialog");
  await page.locator(".update-later-button").click();
  await page.waitForSelector(".update-dialog", { state: "detached" });
  await updateButton.click();
  await page.locator(".update-download-button").click();
  await page.waitForSelector(".update-progress-track");
  await page.waitForSelector(".update-install-button");
  if (!(await page.locator(".setting-update-row").textContent())?.includes(`v${updateVersion} 已准备好`)) {
    throw new Error("downloaded update state was not reflected in settings");
  }
  const downloadedUpdate = await readFile(resolve(profile, updateExecutableName));
  if (!downloadedUpdate.equals(updateExecutable)) throw new Error("Portable update bytes were not downloaded and verified correctly");
  if (!updateAssetRequests.includes(updateAssetName) || updateAssetRequests.includes(updateExecutableName)) {
    throw new Error(`Portable update did not use the manifest asset name: ${JSON.stringify(updateAssetRequests)}`);
  }
  await page.locator(".update-install-button").click();
  await page.waitForSelector(".update-dialog", { state: "detached" });

  useLegacyUpdateManifest = true;
  const legacyCheckState = await page.evaluate(() => window.claudeDesk.checkAppUpdate());
  if (legacyCheckState.phase !== "available" || legacyCheckState.latestVersion !== legacyUpdateVersion) {
    throw new Error(`legacy Portable manifest update check failed: ${JSON.stringify(legacyCheckState)}`);
  }
  await page.waitForSelector(".update-dialog");
  if (!(await page.locator(".update-dialog").textContent())?.includes(`发现新版本 v${legacyUpdateVersion}`)) {
    throw new Error("legacy Portable manifest update was not detected");
  }
  await page.locator(".update-download-button").click();
  await page.waitForSelector(".update-progress-track");
  await page.waitForSelector(".update-install-button");
  const downloadedLegacyUpdate = await readFile(resolve(profile, legacyUpdateExecutableName));
  if (!downloadedLegacyUpdate.equals(legacyUpdateExecutable)) {
    throw new Error("GitHub-normalized legacy Portable asset was not downloaded and verified correctly");
  }
  if (!updateAssetRequests.includes(legacyUpdateExecutableName) || !updateAssetRequests.includes(legacyUpdateAssetName)) {
    throw new Error(`legacy Portable download did not retry the GitHub-normalized asset name: ${JSON.stringify(updateAssetRequests)}`);
  }
  await page.locator(".update-later-button").click();
  await page.waitForSelector(".update-dialog", { state: "detached" });

  // 更新提示是从设置里点出来的模态框，它自己的点击不该顺手把背后的设置面板收起来。
  if (await page.locator(".settings-popover").count() !== 1) {
    throw new Error("settings popover was dismissed by clicking inside the update dialog");
  }
  await electronApp.evaluate(({ shell }) => {
    globalThis.__externalUrls = [];
    shell.openExternal = async (url) => {
      globalThis.__externalUrls.push(url);
    };
  });
  await page.locator(".setting-link-button", { hasText: "项目源码" }).click();
  await page.locator(".setting-link-button", { hasText: "问题反馈" }).click();
  await electronApp.evaluate(async () => {
    const deadline = Date.now() + 5_000;
    while (globalThis.__externalUrls.length < 2 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  });
  const settingsLinkUrls = await electronApp.evaluate(() => globalThis.__externalUrls);
  if (settingsLinkUrls.join(",") !== "https://github.com/yc-2018/claude-cli-UI,https://github.com/yc-2018/claude-cli-UI/issues/new") {
    throw new Error(`settings links did not open the project page and the issue form: ${JSON.stringify(settingsLinkUrls)}`);
  }
  // 渲染层只能点名要开哪个链接，任意 URL 不能交给 shell.openExternal。
  const rejectedProjectLink = await page.evaluate(() => window.claudeDesk.openProjectLink("https://example.com"));
  if (rejectedProjectLink !== false || await electronApp.evaluate(() => globalThis.__externalUrls.length) !== 2) {
    throw new Error("settings link IPC accepted an arbitrary URL");
  }
  // 点设置框以外的地方就收起来，不用再点一次设置按钮。
  await page.locator(".sidebar-version").click();
  await page.waitForSelector(".settings-popover", { state: "detached" });
  await page.locator(".settings-trigger[data-panel=\"settings\"]").click();
  await page.waitForSelector(".settings-popover");
  await page.locator(".settings-trigger[data-panel=\"settings\"]").click();
  await page.waitForSelector(".settings-popover", { state: "detached" });
  await page.locator(".settings-trigger[data-panel=\"settings\"]").click();
  await page.waitForSelector(".settings-popover");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".settings-popover", { state: "detached" });

  await page.locator('[data-section-label="projects"]').getByRole("button", { name: "新建项目", exact: true }).click();
  await page.waitForSelector(".composer");
  if (await page.locator(".project-group").count() !== 1) throw new Error("new project was not created");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 2);
  const importedRow = inFolder(page, ".task-row", { hasText: "来自终端的历史对话" });
  const localConversationId = await inFolder(page, ".task-row.active").getAttribute("data-conversation-id");
  if (!localConversationId) throw new Error("new local conversation was not active");
  const localRow = inFolder(page, `[data-conversation-id="${localConversationId}"]`);
  const unsentDraft = "切换会话后仍应保留的未发送草稿";
  await page.locator(".composer textarea").fill(unsentDraft);
  if (!(await importedRow.textContent())?.includes("Claude CLI")) throw new Error("imported CLI session was not identified in the sidebar");
  if (!(await importedRow.textContent())?.includes("feature/cli-sync") || await importedRow.locator("time").count() !== 1) {
    throw new Error("CLI session branch or updated time was not shown in the sidebar");
  }
  await importedRow.locator(".task-select").click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "来自终端的历史对话");
  if (!(await page.locator(".markdown").last().textContent())?.includes("恢复的回答")) throw new Error("CLI session response was not loaded");
  // CLI 的会话文件里带着每条记录的时刻，导入的回答要还原出耗时和完成时刻（提问 → 最后一条回答记录，正好 1 秒）。
  const importedDuration = page.locator(".message.assistant .response-duration").last();
  if (await importedDuration.getAttribute("data-completed-at") !== String(importedTime + 1_000)) {
    throw new Error(`imported CLI response lost its completion time: ${await importedDuration.getAttribute("data-completed-at")}`);
  }
  if (!(await importedDuration.textContent())?.includes("本次回答耗时 · 1 秒 · 完成于 ")) {
    throw new Error(`imported CLI response did not show how long it took and when it finished: ${await importedDuration.textContent()}`);
  }
  const importedContextStatus = await page.locator(".context-status").textContent();
  // 这份会话文件里唯一的用量是计费口径的累加值（5M + 1M + 2M），绝不能当成上下文占用显示；
  // 但没有可信读数时也不该只剩「未知」，而要按正文长度给出带「约」字的估算值。
  if (importedContextStatus?.includes("5.0M") || importedContextStatus?.includes("8.0M")) {
    throw new Error(`billing input tokens were incorrectly shown as context usage: ${importedContextStatus}`);
  }
  if (!importedContextStatus?.includes("上下文 约")) {
    throw new Error(`imported session without a usable reading did not fall back to an estimate: ${importedContextStatus}`);
  }
  // 回归：导入的历史回答默认收起，只露出最后那段正文；要看工具调用得自己点开。
  if (await page.locator('.message.assistant [data-timeline-kind="activity"]').count() !== 0) {
    throw new Error("导入的历史回答没有默认收起工具调用");
  }
  await page.locator(".message.assistant .tool-collapse-toggle").last().click();
  if ((await page.locator(".message.assistant [data-timeline-kind]").evaluateAll((items) => items.map((item) => item.getAttribute("data-timeline-kind")).join(","))) !== "text,activity,text") {
    throw new Error("CLI session history did not preserve text and tool event order");
  }
  await page.locator('.message.assistant [data-timeline-kind="activity"] .activity-row').click();
  if ((await page.locator(".message.assistant .tool-diff-line.add").textContent())?.includes("新说明") !== true) {
    throw new Error("CLI session history did not restore expandable edit details");
  }
  if (!(await page.locator(".thinking-toggle").last().textContent())?.includes("思考过程")) throw new Error("CLI session thinking was not loaded");
  if (await page.locator(".composer textarea").inputValue() !== "") throw new Error("draft leaked into another conversation");
  await localRow.locator(".task-select").click();
  await page.waitForFunction((draft) => document.querySelector(".composer textarea")?.value === draft, unsentDraft);
  await page.locator(".project-toggle").click();
  await page.waitForSelector(".project-conversations", { state: "detached" });
  if (
    await page.locator(".composer textarea").inputValue() !== unsentDraft ||
    await page.locator(".project-empty-view").count() !== 0
  ) {
    throw new Error("collapsing the active project closed its conversation or discarded its draft");
  }
  await page.locator(".project-toggle").click();
  await localRow.waitFor();
  await importedRow.locator(".task-select").click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "来自终端的历史对话");
  await appendFile(resolve(cliSessions, `${importedSessionId}.jsonl`), `\n${[
    {
      type: "user",
      uuid: "refreshed-history-user",
      timestamp: new Date().toISOString(),
      cwd: root,
      sessionId: importedSessionId,
      message: { role: "user", content: "从 CLI 刷新进来的新消息" },
    },
    {
      type: "assistant",
      uuid: "refreshed-history-assistant",
      timestamp: new Date(Date.now() + 10).toISOString(),
      cwd: root,
      sessionId: importedSessionId,
      message: {
        id: "refreshed-history-response",
        role: "assistant",
        model: "ThirdParty-B",
        content: [{ type: "text", text: "刷新后无需重启即可看到。" }],
        // 单次请求的真实占用：900 + 1100 + 28000 = 30000，也就是 200k 窗口的 15%。
        usage: { input_tokens: 900, cache_creation_input_tokens: 1_100, cache_read_input_tokens: 28_000, output_tokens: 700 },
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  await refreshProjectSessions(page);
  await page.waitForFunction(() => [...document.querySelectorAll(".user-bubble")].some((item) => item.textContent === "从 CLI 刷新进来的新消息"));
  if (!(await page.locator(".markdown").last().textContent())?.includes("无需重启")) throw new Error("manual project refresh did not reload CLI responses");
  await page.waitForFunction(() => document.querySelector(".context-status-text")?.textContent?.includes("上下文 15%"));
  const refreshedContextStatus = await page.locator(".context-status").textContent();
  if (refreshedContextStatus?.includes("5.0M") || refreshedContextStatus?.includes("8.0M")) {
    throw new Error(`cumulative billing tokens leaked into the context usage indicator: ${refreshedContextStatus}`);
  }
  await page.waitForTimeout(450);
  const persistedImport = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.find((conversation) => conversation.source === "claude"));
  if (!persistedImport || persistedImport.messages.length !== 0) {
    const persistedShape = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")
      .map((project) => ({
        id: project.id,
        conversations: project.conversations?.map((conversation) => ({
          title: conversation.title,
          source: conversation.source ?? null,
          sessionId: conversation.sessionId ?? null,
          messages: conversation.messages?.length,
        })),
      })));
    throw new Error(`imported CLI history was duplicated into local storage: ${JSON.stringify(persistedShape)}`);
  }

  // 文件监听：用户在终端里对同一个 session 继续问，不点刷新按钮，打开着的对话也要自己长出新轮次。
  await appendFile(resolve(cliSessions, `${importedSessionId}.jsonl`), `${[
    {
      type: "user",
      uuid: "watched-turn-user",
      timestamp: new Date().toISOString(),
      cwd: root,
      sessionId: importedSessionId,
      message: { role: "user", content: "在终端里补问的一轮" },
    },
    {
      type: "assistant",
      uuid: "watched-turn-assistant",
      timestamp: new Date(Date.now() + 10).toISOString(),
      cwd: root,
      sessionId: importedSessionId,
      message: {
        id: "watched-turn-response",
        role: "assistant",
        model: "ThirdParty-B",
        content: [{ type: "text", text: "文件监听把它自动同步过来了。" }],
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  await page.waitForFunction(() => [...document.querySelectorAll(".user-bubble")].some((item) => item.textContent === "在终端里补问的一轮"));
  if (!(await page.locator(".markdown").last().textContent())?.includes("自动同步")) {
    throw new Error("file watcher did not pull the new CLI turn into the open conversation");
  }

  // 文件监听：CLI 新建的 session 也要自己出现在侧边栏，不依赖重启或手动刷新。
  // 这个会话下面紧接着就被删掉，所以不会影响后续用例里的对话计数。
  const hiddenSessionId = "55555555-5555-4555-8555-555555555555";
  const hiddenSessionPath = resolve(cliSessions, `${hiddenSessionId}.jsonl`);
  await writeFile(hiddenSessionPath, [
    {
      type: "user",
      uuid: "hidden-user",
      timestamp: new Date().toISOString(),
      cwd: root,
      sessionId: hiddenSessionId,
      message: { role: "user", content: "准备从 UI 移除的 CLI 会话" },
    },
    {
      type: "assistant",
      uuid: "hidden-assistant",
      timestamp: new Date(Date.now() + 10).toISOString(),
      cwd: root,
      sessionId: hiddenSessionId,
      message: { id: "hidden-response", role: "assistant", model: "ThirdParty-A", content: [{ type: "text", text: "CLI 历史应继续保留。" }] },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  const hiddenRow = inFolder(page, ".task-row", { hasText: "准备从 UI 移除的 CLI 会话" });
  await hiddenRow.waitFor();
  await hiddenRow.hover();
  await hiddenRow.locator(".task-delete").click();
  const deleteConfirmation = page.locator(".delete-confirm-dialog");
  await deleteConfirmation.waitFor();
  const deleteConfirmationText = await deleteConfirmation.textContent();
  if (!deleteConfirmationText?.includes("移入 Windows 回收站") || !deleteConfirmationText.includes("从 /resume 中消失")) {
    throw new Error("session deletion did not explain its effect on CLI history");
  }
  await deleteConfirmation.locator(".delete-confirm-button.danger").click();
  await hiddenRow.waitFor({ state: "detached" });
  const deletedSessionStillExists = await readFile(hiddenSessionPath, "utf8").then(() => true, () => false);
  if (deletedSessionStillExists) throw new Error("deleted Claude CLI session remained at its original path");
  await refreshProjectSessions(page);
  if (await page.locator(".task-row", { hasText: "准备从 UI 移除的 CLI 会话" }).count()) throw new Error("deleted CLI session returned after refresh");
  await inFolder(page, ".task-select", { hasText: "新对话" }).click();

  const workspaceOpenResult = await page.evaluate((workspace) => window.claudeDesk.openWorkspace(workspace), root);
  if (!workspaceOpenResult.opened) throw new Error(`valid workspace was not opened: ${workspaceOpenResult.error}`);
  const invalidWorkspaceOpenResult = await page.evaluate(() => window.claudeDesk.openWorkspace("C:\\path-that-does-not-exist\\claude-desk"));
  if (invalidWorkspaceOpenResult.opened) throw new Error("invalid workspace was accepted");
  await page.locator(".workspace-chip").click();
  await page.locator(".project-row").click({ button: "right" });

  if (await page.locator(".composer-options select").count()) throw new Error("composer still used native select controls");
  await page.locator(".model-select .composer-select-trigger").click();
  const modelOptions = await page.locator(".model-select .composer-select-option").evaluateAll((options) => options.map((option) => {
    const role = option.querySelector("strong")?.textContent ?? "";
    const actual = option.querySelector("small")?.textContent ?? "";
    return `${role} · ${actual}`;
  }));
  if (modelOptions.length !== 4 || modelOptions.some((label) => label.includes("跟随 CLI"))) {
    throw new Error(`model roles were collapsed or fallback option remained: ${modelOptions.join(", ")}`);
  }
  if (!["Sonnet · ThirdParty-A", "Opus · ThirdParty-A", "Fable · ThirdParty-B", "Haiku · ThirdParty-B"].every((label) => modelOptions.includes(label))) {
    throw new Error(`dynamic models missing: ${modelOptions.join(", ")}`);
  }
  // 换路由后同一个角色会指向别的实际模型，所以每次展开菜单都要重新读配置；
  // 1M 变体的容量只能从模型标识看出来，菜单和上下文状态都必须打上标记。
  await page.keyboard.press("Escape");
  await writeTestModels({
    Sonnet: "Router2-Sonnet",
    Opus: "Router2-Opus[1m]",
    Fable: "ThirdParty-B",
    Haiku: "ThirdParty-B",
  });
  await page.locator(".model-select .composer-select-trigger").click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".model-select .composer-select-option small")].some((node) => node.textContent === "Router2-Opus[1m]")
  ));
  const refreshedModelOptions = await page.locator(".model-select .composer-select-option").evaluateAll((options) => options.map((option) => ({
    role: option.querySelector("strong")?.textContent ?? "",
    actual: option.querySelector("small")?.textContent ?? "",
    badge: option.querySelector(".composer-select-badge")?.textContent ?? "",
  })));
  if (!refreshedModelOptions.some((option) => option.actual === "Router2-Sonnet")) {
    throw new Error(`opening the model menu did not refresh the router mapping: ${JSON.stringify(refreshedModelOptions)}`);
  }
  const largeContextOption = refreshedModelOptions.find((option) => option.actual === "Router2-Opus[1m]");
  if (largeContextOption?.badge !== "1M") {
    throw new Error(`the 1M model was not marked in the picker: ${JSON.stringify(refreshedModelOptions)}`);
  }
  if (refreshedModelOptions.some((option) => option.actual === "ThirdParty-A")) {
    throw new Error(`stale router mapping survived the refresh: ${JSON.stringify(refreshedModelOptions)}`);
  }
  // 真实配置里很常见 _MODEL 带 [1M]、_NAME 只是展示名：容量必须仍然看得出 1M，否则用户在选模型
  // 时完全看不到自己配的 1M 路由（菜单里显示的是那个不带标记的展示名）。
  await writeTestModels({
    Sonnet: "Router2-Sonnet",
    Opus: { model: "Router2-Opus[1m]", name: "Router2-Opus" },
    Fable: "ThirdParty-B",
    Haiku: "ThirdParty-B",
  });
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".model-select .composer-select-option small")].some((node) => node.textContent === "Router2-Opus")
  ));
  const namedModelOptions = await page.locator(".model-select .composer-select-option").evaluateAll((options) => options.map((option) => ({
    role: option.querySelector("strong")?.textContent ?? "",
    actual: option.querySelector("small")?.textContent ?? "",
    badge: option.querySelector(".composer-select-badge")?.textContent ?? "",
  })));
  const namedLargeContextOption = namedModelOptions.find((option) => option.actual === "Router2-Opus");
  if (namedLargeContextOption?.badge !== "1M") {
    throw new Error(`the 1M mapping lost its marker once a display name was configured: ${JSON.stringify(namedModelOptions)}`);
  }
  // 选到 1M 模型之后，上下文状态条必须能看出这份容量，而不是只剩一个百分比。
  await page.locator('.model-select .composer-select-option[data-value="opus"]').click();
  await page.waitForFunction(() => document.querySelector(".context-window-badge")?.textContent === "1M");
  // 文件监听：配置文件被外部改掉时，不展开模型菜单界面也要自己跟上。会话此刻用的就是 1M 的 opus，
  // 所以把路由改成普通模型之后，1M 标记应该自己消失，不需要任何点击。
  await writeTestModels({
    Sonnet: "Router2-Sonnet",
    Opus: "Router3-Opus",
    Fable: "ThirdParty-B",
    Haiku: "ThirdParty-B",
  });
  await page.waitForFunction(() => !document.querySelector(".context-window-badge"));
  // 再改回去，让后面「展开菜单会刷新」的用例仍然从 1M 这个状态出发。
  await writeTestModels({
    Sonnet: "Router2-Sonnet",
    Opus: "Router2-Opus[1m]",
    Fable: "ThirdParty-B",
    Haiku: "ThirdParty-B",
  });
  await page.waitForFunction(() => document.querySelector(".context-window-badge")?.textContent === "1M");
  await page.keyboard.press("Escape");
  await writeTestModels({
    Sonnet: "ThirdParty-A",
    Opus: "ThirdParty-A",
    Fable: "ThirdParty-B",
    Haiku: "ThirdParty-B",
  });
  await page.locator(".model-select .composer-select-trigger").click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".model-select .composer-select-option small")].every((node) => node.textContent !== "Router2-Opus[1m]")
  ));
  if (await page.locator(".context-window-badge").count()) {
    throw new Error("the 1M badge stayed after the router stopped resolving to a 1M model");
  }
  // 上面为了验证 1M 标记把会话切到了 opus，后面的断言依赖它仍是 fable，这里顺手切回去。
  await page.locator('.model-select .composer-select-option[data-value="fable"]').click();
  await page.locator(".composer textarea").fill("/model");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.model-select .composer-select-trigger')?.getAttribute("aria-expanded") === "true");
  await page.waitForFunction(() => document.activeElement?.matches(".model-select .composer-select-trigger"));
  await page.keyboard.press("Escape");
  await page.locator(".model-select .composer-select-trigger").click();
  await page.locator('.model-select .composer-select-option[data-value="fable"]').click();
  await page.locator(".effort-select .composer-select-trigger").click();
  if (await page.locator(".effort-select .composer-select-option").count() !== 6) throw new Error("thinking effort picker did not expose every Claude effort level");
  if (!(await page.locator('.effort-select .composer-select-option[data-value="high"]').textContent())?.includes("更深入")) {
    throw new Error("high thinking effort option was missing its description");
  }
  await page.locator('.effort-select .composer-select-option[data-value="high"]').click();
  if (!(await page.locator(".effort-select .composer-select-value").textContent())?.includes("高")) {
    throw new Error("thinking effort selection was not reflected in the composer");
  }
  await page.locator('.project-action[title="重命名项目"]').evaluate((button) => button.click());
  const projectNameInput = page.locator('input[aria-label="项目名称"]');
  await projectNameInput.waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (!await projectNameInput.isVisible()) throw new Error("model picker stole focus from the project rename editor");
  await projectNameInput.fill("我的 Claude 项目");
  await projectNameInput.press("Enter");
  if (await page.locator(".project-name strong").textContent() !== "我的 Claude 项目") throw new Error("project custom name was not shown");
  if (await page.locator(".project-name small").textContent() !== workspaceDirectoryName) throw new Error("project real directory name was not shown");

  await inFolder(page, '.task-row.active .task-rename[title="重命名对话"]').evaluate((button) => button.click());
  await page.locator('input[aria-label="对话名称"]').fill("手动会话名");
  await page.locator('input[aria-label="对话名称"]').press("Enter");
  if (await page.locator(".task-heading h2").textContent() !== "手动会话名") throw new Error("conversation rename was not reflected in the header");

  await page.locator(".composer textarea").fill("/");
  await page.waitForSelector(".command-menu");
  if (await page.locator(".command-option").count() < 6) throw new Error("local slash commands missing");
  const compactOption = page.locator(".command-option", { hasText: "/compact" });
  if (!(await compactOption.textContent())?.includes("压缩当前对话上下文")) throw new Error("slash command descriptions were not specific");
  await page.locator(".composer textarea").fill("/plan");
  await page.locator(".composer textarea").press("Enter");
  if (!(await page.locator(".permission-select .composer-select-value").textContent())?.includes("计划模式")) {
    throw new Error("/plan did not change permission mode");
  }
  await page.locator(".permission-select .composer-select-trigger").click();
  if (await page.locator(".permission-select .composer-select-option").count() !== 5) throw new Error("custom permission picker did not expose every mode");
  if (!(await page.locator('.permission-select .composer-select-option[data-value="bypassPermissions"]').textContent())?.includes("完全访问权限")) {
    throw new Error("full access permission mode was missing");
  }
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.locator(".composer textarea").fill("计划交互问题测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".user-question-dialog", { timeout: 15_000 });
  if (!(await page.locator(".user-question-dialog").textContent())?.includes("最终交付几份文稿？")) {
    throw new Error("plan mode did not show the interactive question dialog");
  }
  await page.locator(".user-question-option", { hasText: "按章节拆分" }).click();
  await page.locator(".user-question-dialog .permission-button.primary").click();
  await page.waitForSelector('.message.assistant:last-of-type[data-status="done"]', { timeout: 15_000 });
  if (!(await page.locator(".message.assistant .markdown").last().textContent())?.includes("按章节拆分")) {
    throw new Error("plan question answer was not returned to Claude");
  }
  await page.locator(".permission-select .composer-select-trigger").click();
  await page.locator('.permission-select .composer-select-option[data-value="bypassPermissions"]').click();
  await page.locator(".composer textarea").fill("这是首次会话名称测试内容");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant:last-of-type[data-status="done"]', { timeout: 15_000 });
  await page.locator(".composer textarea").fill("/edit");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => {
    const responses = document.querySelectorAll(".message.assistant .markdown");
    return responses.item(responses.length - 1)?.textContent?.includes("流式输出稳定");
  });
  if (!(await page.locator(".context-status").textContent())?.includes("上下文")) throw new Error("context usage status was not shown");
  // 占用量只能来自单次请求的 input + cache_creation + cache_read（20k/200k = 10%），
  // result.usage 与 modelUsage.inputTokens 是累加值，被误用就会显示成 5M。
  await page.waitForFunction(() => document.querySelector(".context-status-text")?.textContent?.includes("上下文 10%"));
  const liveContextStatus = await page.locator(".context-status").textContent();
  if (liveContextStatus?.includes("M") || liveContextStatus?.includes("100%")) {
    throw new Error(`cumulative token totals were shown as context usage: ${liveContextStatus}`);
  }
  const compactButton = page.locator('[aria-label="压缩上下文"]');
  if (await compactButton.isDisabled()) throw new Error("context compact button was unexpectedly disabled");
  // 压缩过程本身必须可见：CLI 的 compact_progress 是顶层 type、既没有 subtype 也没有 status，
  // 漏接它的话整段压缩都是空白，界面只会在结束后蹦出一张卡。running 卡片存在时间很短，先挂观察器再点。
  await page.evaluate(() => {
    window.__compactionProgress = { phases: [], texts: [] };
    const record = () => {
      for (const node of document.querySelectorAll(".context-compaction.running")) {
        const phase = node.getAttribute("data-compaction-phase") ?? "";
        const text = node.textContent ?? "";
        if (phase && window.__compactionProgress.phases.at(-1) !== phase) window.__compactionProgress.phases.push(phase);
        if (text && window.__compactionProgress.texts.at(-1) !== text) window.__compactionProgress.texts.push(text);
      }
    };
    record();
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await compactButton.click();
  await page.waitForSelector(".context-compaction.done", { timeout: 15_000 });
  const compactionProgress = await page.evaluate(() => window.__compactionProgress);
  if (!compactionProgress.phases.includes("pre_hooks") || !compactionProgress.phases.includes("compacting")) {
    throw new Error(`compaction progress phases were not rendered: ${JSON.stringify(compactionProgress.phases)}`);
  }
  if (!compactionProgress.texts.some((text) => text.includes("正在执行压缩前钩子"))) {
    throw new Error(`compaction hook phase had no readable copy: ${JSON.stringify(compactionProgress.texts)}`);
  }
  // compact_start 带的 hint_text 是这次压缩为何发生的唯一说明，丢了就只剩一句「正在压缩上下文」。
  if (!compactionProgress.texts.some((text) => text.includes("上下文接近上限"))) {
    throw new Error(`compact_start hint was not rendered: ${JSON.stringify(compactionProgress.texts)}`);
  }
  const compactionDoneText = await page.locator(".context-compaction.done").last().textContent();
  // wire 上是 compact_metadata.pre_tokens（snake_case），磁盘 JSONL 才是 compactMetadata.preTokens。
  // 只认 camelCase 的话这些读数全是 undefined，卡片会退回那句没有信息量的兜底文案。
  if (!compactionDoneText?.includes("120,000") || !compactionDoneText?.includes("14,000")) {
    throw new Error(`compact token reduction was not shown: ${compactionDoneText}`);
  }
  if (!compactionDoneText?.includes("手动")) throw new Error(`compact trigger was not shown: ${compactionDoneText}`);
  if (!compactionDoneText?.includes("106,000")) throw new Error(`cumulative dropped tokens were not shown: ${compactionDoneText}`);
  if (compactionDoneText?.includes("正在整理较早的对话内容")) {
    throw new Error(`compaction card fell back to the placeholder copy: ${compactionDoneText}`);
  }
  await page.locator(".context-compaction.done summary").last().click();
  if (!(await page.locator(".context-compaction-summary").last().textContent())?.includes("已保留项目目标")) throw new Error("compact summary was not displayed");
  // 压缩卡片必须紧跟在触发它的那条消息后面，否则长对话里根本看不到上下文正在被压缩。
  const compactionPlacement = await page.evaluate(() => {
    const nodes = [...(document.querySelector(".conversation")?.children ?? [])];
    const cardIndex = nodes.findIndex((node) => node.classList.contains("context-compaction"));
    return {
      cardIndex,
      lastIndex: nodes.length - 1,
      previousIsMessage: nodes[cardIndex - 1]?.classList.contains("message") ?? false,
    };
  });
  if (compactionPlacement.cardIndex <= 0 || !compactionPlacement.previousIsMessage || compactionPlacement.cardIndex !== compactionPlacement.lastIndex) {
    throw new Error(`context compaction card was not anchored after the message that triggered it: ${JSON.stringify(compactionPlacement)}`);
  }
  await page.waitForTimeout(500);
  const normalizedSession = await readFile(resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl"), "utf8");
  if (normalizedSession.includes('"entrypoint":"sdk-cli"') || normalizedSession.includes('"promptSource":"sdk"')) {
    throw new Error("claude-cli-UI session remained hidden from the CLI resume picker");
  }
  if (!normalizedSession.includes('"entrypoint":"cli"') || !normalizedSession.includes('"promptSource":"typed"')) {
    throw new Error("claude-cli-UI session was not normalized for the CLI resume picker");
  }
  await page.evaluate(() => {
    window.__cliCommandClipboardWrites = [];
    navigator.clipboard.writeText = async (text) => { window.__cliCommandClipboardWrites.push(text); };
  });
  await page.locator(".task-title-command").click();
  await page.waitForSelector(".cli-command-popover");
  const expectedCliCommand = `cd /d "${root}" && claude --resume "22222222-2222-4222-8222-222222222222"`;
  const expectedSkipCliCommand = `${expectedCliCommand} --dangerously-skip-permissions`;
  // 两条命令并排给出：平时用第一条，需要免确认连跑的场合用带 --dangerously-skip-permissions 的第二条。
  if (JSON.stringify(await page.locator(".cli-command-row code").allTextContents()) !== JSON.stringify([expectedCliCommand, expectedSkipCliCommand])) {
    throw new Error("conversation title did not list both CMD resume commands");
  }
  if (await page.evaluate(() => window.__cliCommandClipboardWrites.length) !== 0) {
    throw new Error("conversation title copied the CMD command before the copy action was clicked");
  }
  await page.locator('[aria-label="复制 CMD 命令"]').click();
  if (await page.evaluate(() => window.__cliCommandClipboardWrites.at(-1)) !== expectedCliCommand) {
    throw new Error("CMD resume command was not copied from the popover action");
  }
  await page.waitForSelector('[aria-label="CMD 命令已复制"]');
  await page.locator('[aria-label="复制跳过权限的 CMD 命令"]').click();
  if (await page.evaluate(() => window.__cliCommandClipboardWrites.at(-1)) !== expectedSkipCliCommand) {
    throw new Error("--dangerously-skip-permissions resume command was not copied from the popover action");
  }
  // 两个直开终端的按钮：命令一律在主进程里按终端语法拼好，渲染层只点名要哪种终端。
  await page.locator('[aria-label="在 CMD 中运行 CMD 命令"]').click();
  await page.locator('[aria-label="在 PowerShell 中运行跳过权限的 CMD 命令"]').click();
  const readTerminalLaunches = async () => (await readFile(terminalLog, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const terminalDeadline = Date.now() + 5_000;
  let terminalLaunches = await readTerminalLaunches();
  while (terminalLaunches.length < 2 && Date.now() < terminalDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    terminalLaunches = await readTerminalLaunches();
  }
  if (terminalLaunches.length !== 2) {
    throw new Error(`直开终端的两次点击没有都落到主进程：${JSON.stringify(terminalLaunches)}`);
  }
  if (terminalLaunches[0].kind !== "cmd" || terminalLaunches[0].command !== expectedCliCommand) {
    throw new Error(`CMD 终端没有拿到 cmd 语法的恢复命令：${JSON.stringify(terminalLaunches[0])}`);
  }
  // PowerShell 不认 cmd 的 `cd /d` 和 5.1 里的 `&&`，必须换成 PowerShell 自己的写法才跑得起来。
  const expectedPowershellCommand = `Set-Location -LiteralPath '${root}'; claude --resume '22222222-2222-4222-8222-222222222222' --dangerously-skip-permissions`;
  if (terminalLaunches[1].kind !== "powershell" || terminalLaunches[1].command !== expectedPowershellCommand) {
    throw new Error(`PowerShell 终端没有拿到 PowerShell 语法的恢复命令：${JSON.stringify(terminalLaunches[1])}`);
  }
  await page.locator('[aria-label="关闭 CMD 命令"]').click();
  await page.waitForSelector(".cli-command-popover", { state: "detached" });
  await inFolder(page, '.task-row.active .task-rename[title="重命名对话"]').evaluate((button) => button.click());
  await page.locator('input[aria-label="对话名称"]').fill("UI 同步会话名");
  await page.locator('input[aria-label="对话名称"]').press("Enter");
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "UI 同步会话名");
  await waitForAsyncCondition(page, async () => {
    const project = JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0];
    return project?.conversations?.some((conversation) => conversation.title === "UI 同步会话名");
  });
  const renamedSession = await readFile(resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl"), "utf8");
  if (!renamedSession.includes('"type":"custom-title","customTitle":"UI 同步会话名"')) {
    throw new Error("UI conversation rename was not written to Claude CLI history");
  }
  await appendFile(resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl"), `${JSON.stringify({
    type: "custom-title",
    customTitle: "CLI 外部改名",
    sessionId: "22222222-2222-4222-8222-222222222222",
    timestamp: new Date().toISOString(),
  })}\n`, "utf8");
  await refreshProjectSessions(page);
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "CLI 外部改名");
  await page.waitForTimeout(450);
  const completed = await page.evaluate(() => ({
    bodySize: document.body.innerText.length,
    projects: JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]"),
  }));
  const firstConversation = completed.projects[0]?.conversations?.find((conversation) => conversation.sessionId === "22222222-2222-4222-8222-222222222222");
  if (completed.bodySize < 500) throw new Error("rendered conversation is unexpectedly blank");
  if (firstConversation?.messages?.at(-1)?.status !== "done") throw new Error("completed response was not persisted");
  if (!firstConversation?.messages?.at(-1)?.thinking?.includes("检查上下文")) {
    throw new Error(`thinking content was not persisted: ${JSON.stringify({
      messages: firstConversation?.messages?.map((message) => `${message.role}|${message.thinking ? "T" : "-"}|${message.status ?? ""}`),
      conversations: completed.projects[0]?.conversations?.map((conversation) => `${conversation.title}|${conversation.source ?? "ui"}|${conversation.messages?.length}`),
    })}`);
  }
  if (firstConversation?.selectedModel !== "fable" || firstConversation?.resolvedModel !== "ThirdParty-B") {
    throw new Error("selected model role was not mapped through CLI");
  }
  if (firstConversation?.thinkingEffort !== "high") throw new Error("thinking effort selection was not persisted");
  if (firstConversation?.title !== "CLI 外部改名") throw new Error("CLI custom title was not synchronized back to the UI");
  const thinkingToggle = page.locator(".thinking-toggle").last();
  if (await thinkingToggle.getAttribute("aria-expanded") !== "false") throw new Error("completed thinking was not collapsed");
  await thinkingToggle.click();
  if (!(await page.locator(".thinking-content").last().textContent())?.includes("检查上下文")) throw new Error("thinking content was not rendered");
  await page.screenshot({ path: resolve(artifacts, "thinking-expanded.png") });

  await appendFile(resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl"), `${[
    {
      type: "user",
      uuid: "local-refresh-user",
      timestamp: new Date().toISOString(),
      cwd: root,
      sessionId: "22222222-2222-4222-8222-222222222222",
      message: { role: "user", content: "从 CLI 追加到 UI 会话" },
    },
    {
      type: "assistant",
      uuid: "local-refresh-assistant",
      timestamp: new Date(Date.now() + 10).toISOString(),
      cwd: root,
      sessionId: "22222222-2222-4222-8222-222222222222",
      message: { id: "local-refresh-response", role: "assistant", model: "ThirdParty-B", content: [{ type: "text", text: "UI 创建的会话也已同步。" }] },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  await refreshProjectSessions(page);
  await page.waitForFunction(() => [...document.querySelectorAll(".user-bubble")].some((item) => item.textContent === "从 CLI 追加到 UI 会话"));
  if (await page.locator(".task-heading h2").textContent() !== "CLI 外部改名") throw new Error("refresh overwrote the synchronized conversation title");

  const sourceBeforeBranch = await readFile(resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl"), "utf8");
  const firstAssistantMessage = page.locator(".message.assistant").first();
  await firstAssistantMessage.hover();
  await firstAssistantMessage.locator('[aria-label="从这里分叉"]').click();
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "CLI 外部改名 (2)");
  await page.waitForFunction(() => {
    const project = JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0];
    return typeof project?.conversations?.find((conversation) => conversation.title === "CLI 外部改名 (2)")?.sessionId === "string";
  });
  const branchSessionId = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0];
    return project?.conversations?.find((conversation) => conversation.title === "CLI 外部改名 (2)")?.sessionId;
  });
  if (typeof branchSessionId !== "string" || branchSessionId === "22222222-2222-4222-8222-222222222222") {
    throw new Error("message branch did not receive an independent session ID");
  }
  const branchPath = resolve(cliSessions, `${branchSessionId}.jsonl`);
  const branchHistory = await readFile(branchPath, "utf8");
  const sourceAfterBranch = await readFile(resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl"), "utf8");
  if (sourceAfterBranch !== sourceBeforeBranch) throw new Error("branching modified the source Claude CLI session");
  if (!branchHistory.includes("这是首次会话名称测试内容") || branchHistory.includes("从 CLI 追加到 UI 会话")) {
    throw new Error("message branch did not stop after the selected conversation turn");
  }
  const branchRecords = branchHistory.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  if (!branchRecords.some((record) => record.type === "custom-title" && record.customTitle === "CLI 外部改名 (2)")) {
    throw new Error("message branch title was not written to Claude CLI history");
  }
  if (branchRecords.some((record) => typeof record.sessionId === "string" && record.sessionId !== branchSessionId)) {
    throw new Error("message branch retained the source session ID");
  }
  const sourceUuids = new Set(sourceBeforeBranch.trim().split(/\r?\n/).flatMap((line) => {
    const uuid = JSON.parse(line).uuid;
    return typeof uuid === "string" ? [uuid] : [];
  }));
  if (branchRecords.some((record) => typeof record.uuid === "string" && sourceUuids.has(record.uuid))) {
    throw new Error("message branch reused source transcript UUIDs");
  }
  await refreshProjectSessions(page);
  if (await inFolder(page, ".task-row strong").filter({ hasText: /^CLI 外部改名 \(2\)$/ }).count() !== 1) {
    throw new Error("message branch disappeared after refreshing CLI sessions");
  }
  await page.locator(".composer textarea").fill("分支继续测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await page.waitForTimeout(200);
  const continuedBranchHistory = await readFile(branchPath, "utf8");
  if (!continuedBranchHistory.includes("分支继续测试")) throw new Error("new messages were not written to the branched CLI session");
  const activeBranchSessionId = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0];
    return project?.conversations?.find((conversation) => conversation.title === "CLI 外部改名 (2)")?.sessionId;
  });
  if (activeBranchSessionId !== branchSessionId) throw new Error("continuing a branch switched back to the source session");
  await inFolder(page, ".task-row strong").filter({ hasText: /^CLI 外部改名$/ }).click();
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "CLI 外部改名");

  await page.locator(".composer textarea").evaluate((textarea, payload) => {
    const transfer = new DataTransfer();
    const binary = atob(payload.pngBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], "clipboard-image.png", { type: "image/png" }));
    transfer.items.add(new File([payload.text], "notes.txt", { type: "text/plain" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, { pngBase64: attachmentPngBase64, text: attachmentText });
  await page.waitForFunction(() => document.querySelectorAll(".attachment-item").length === 2);
  await page.waitForFunction(() => (document.querySelector(".attachment-item img") instanceof HTMLImageElement) && document.querySelector(".attachment-item img").naturalWidth > 0);
  if (!(await page.locator(".attachment-list").textContent())?.includes("notes.txt")) throw new Error("pasted file was not shown in the composer");
  await page.locator('.attachment-open[aria-label="预览 clipboard-image.png"]').click();
  await page.waitForSelector(".attachment-preview-dialog");
  if (await page.locator(".attachment-preview-dialog img").getAttribute("alt") !== "clipboard-image.png") {
    throw new Error("pasted image preview did not show the selected image");
  }
  await page.locator('[aria-label="关闭附件预览"]').click();
  await page.locator(".composer textarea").fill("附件回归测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (await page.locator(".sent-image").count() !== 1 || await page.locator(".sent-file", { hasText: "notes.txt" }).count() !== 1) {
    throw new Error("sent attachments were not rendered in the conversation");
  }
  await page.locator('.sent-image [aria-label="预览 clipboard-image.png"]').click();
  await page.waitForSelector(".attachment-preview-dialog");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".attachment-preview-dialog", { state: "detached" });
  await electronApp.evaluate(({ shell }) => {
    globalThis.__attachmentOpenPaths = [];
    shell.openPath = async (path) => {
      globalThis.__attachmentOpenPaths.push(path);
      return "";
    };
  });
  await page.locator(".sent-file", { hasText: "notes.txt" }).click();
  await electronApp.evaluate(async () => {
    const deadline = Date.now() + 5_000;
    while (globalThis.__attachmentOpenPaths.length === 0 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  });
  const openedAttachmentPaths = await electronApp.evaluate(() => globalThis.__attachmentOpenPaths);
  if (openedAttachmentPaths.length !== 1 || !/[\\/]attachments[\\/][0-9a-f-]+\.txt$/i.test(openedAttachmentPaths[0])) {
    throw new Error("sent file did not request opening through the main process");
  }
  await page.waitForTimeout(450);
  const persistedAttachments = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.find((conversation) => conversation.sessionId === "22222222-2222-4222-8222-222222222222")?.messages?.find((message) => message.content === "附件回归测试")?.attachments);
  if (!Array.isArray(persistedAttachments) || persistedAttachments.length !== 2 || persistedAttachments.some((attachment) => attachment.dataBase64)) {
    throw new Error("attachment metadata was not persisted safely");
  }

  // 附加目录（对应 CLI 的 /add-dir）：发送框按钮管理列表，运行时必须逐个传给 CLI，移除后下一轮立即生效。
  await page.locator(".add-dir-button").click();
  await page.waitForSelector(".add-dir-menu");
  if (await page.locator(".add-dir-item").count() !== 0) throw new Error("additional directory list was not empty before the first add");
  await page.locator(".add-dir-menu .add-dir-add").click();
  await page.waitForFunction(() => document.querySelectorAll(".add-dir-item").length === 1);
  if (!(await page.locator(".add-dir-item").textContent())?.includes(workspaceDirectoryName)) {
    throw new Error("picked additional directory was not listed in the manager");
  }
  if (await page.locator(".add-dir-count").textContent() !== "1") throw new Error("add-dir badge did not reflect the directory count");
  // /add-dir 是本地命令：只打开管理弹层，绝不把这条文本发给 Claude。
  await page.keyboard.press("Escape");
  await page.waitForSelector(".add-dir-menu", { state: "detached" });
  const messageCountBeforeLocalCommand = await page.locator(".message").count();
  await page.locator(".composer textarea").fill("/add-dir");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".add-dir-menu");
  if (await page.locator(".composer textarea").inputValue() !== "") throw new Error("/add-dir did not clear the composer");
  await page.waitForTimeout(200);
  if (await page.locator(".message").count() !== messageCountBeforeLocalCommand) throw new Error("/add-dir leaked into the conversation as a prompt");
  await page.keyboard.press("Escape");
  await page.locator(".composer textarea").fill("附加目录回归测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const readAddDirRuns = async () => (await readFile(addDirLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const addDirRun = (await readAddDirRuns()).reverse().find((run) => run.prompt === "附加目录回归测试");
  if (!addDirRun || addDirRun.addDirs.length !== 2 || addDirRun.addDirs[0] !== root || !/[\\/]attachments$/.test(addDirRun.addDirs[1] ?? "")) {
    throw new Error(`additional directory was not passed to the CLI as --add-dir: ${JSON.stringify(addDirRun)}`);
  }
  // 附加目录随项目持久化：先等它落进主进程项目库，重新加载后徽标和列表才会从存储里恢复。
  await waitForAsyncCondition(page, async (expected) => {
    const projects = await window.claudeDesk.getProjectStore();
    return Array.isArray(projects) && projects.some((project) => project.conversations.some((conversation) =>
      Array.isArray(conversation.additionalDirectories) && conversation.additionalDirectories.includes(expected)));
  }, root);
  await page.reload();
  // 套件前面跑过更新流程，主进程里还挂着「可安装」状态：重载后更新对话框会再弹出来盖住发送框，先收掉它。
  await page.waitForSelector(".update-overlay", { timeout: 3_000 }).catch(() => null);
  if (await page.locator(".update-overlay").count()) {
    await page.locator(".update-later-button").click();
    await page.waitForSelector(".update-overlay", { state: "detached" });
  }
  await page.waitForFunction(() => document.querySelector(".add-dir-count")?.textContent === "1");
  await page.locator(".add-dir-button").click();
  await page.waitForFunction(() => document.querySelectorAll(".add-dir-item").length === 1);
  await page.locator('.add-dir-item [aria-label^="移除"]').click();
  await page.waitForFunction(() => !document.querySelector(".add-dir-count"));
  await page.keyboard.press("Escape");
  await page.locator(".composer textarea").fill("附加目录移除测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const removeRun = (await readAddDirRuns()).reverse().find((run) => run.prompt === "附加目录移除测试");
  if (!removeRun || removeRun.addDirs.length !== 1) {
    throw new Error(`removed additional directory was still passed to the CLI: ${JSON.stringify(removeRun)}`);
  }
  // 主进程拒绝相对路径：渲染层塞不进能改写命令行的 --add-dir 参数。
  const invalidAddDir = await page.evaluate(async (workspace) => {
    try {
      await window.claudeDesk.startRun({
        runId: "add-dir-validation-run",
        conversationId: "add-dir-validation-conversation",
        prompt: "非法附加目录测试",
        cwd: workspace,
        permissionMode: "acceptEdits",
        additionalDirectories: ["relative\\dir"],
      });
      return "accepted";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, root);
  if (!invalidAddDir.includes("无效的运行参数")) throw new Error(`relative additional directory was not rejected: ${invalidAddDir}`);
  // 目录选择框的起始位置：附加目录首次打开要落在当前项目目录，任何一次都不能退回系统默认的「下载」。
  const directoryDialogs = (await readFile(dialogLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const addDirDialog = directoryDialogs.find((entry) => entry.hint === root);
  if (!addDirDialog || addDirDialog.defaultPath !== root) {
    throw new Error(`add-dir picker did not start from the project workspace: ${JSON.stringify(directoryDialogs)}`);
  }
  if (directoryDialogs.some((entry) => !/^[A-Za-z]:[\\/]/.test(entry.defaultPath) || /[\\/]Downloads$/i.test(entry.defaultPath))) {
    throw new Error(`directory picker fell back to the system default folder: ${JSON.stringify(directoryDialogs)}`);
  }

  // 重试次数：界面上选的次数要变成 CLI 的 CLAUDE_CODE_MAX_RETRIES，超过 15 次还要带上看守开关才不会被 CLI 截断。
  const readRuns = async () => (await readFile(runLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  /**
   * 夹具是在收到提示那一刻才写这份日志，而「等最后一条回答变成 done」有可能被上一轮早已结束的
   * 回答立刻满足（编辑后重发要先去读截断点，中间隔着一次 IPC）。所以一律轮询等这一轮真的进日志，
   * 而不是只读一次就断言。
   */
  const waitForRun = async (prompt) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = (await readRuns()).reverse().find((item) => item.prompt === prompt);
      if (run) return run;
      await page.waitForTimeout(250);
    }
    return undefined;
  };
  await page.locator(".retry-select .composer-select-trigger").click();
  await page.locator(".retry-select .composer-select-option", { hasText: "重试 30 次" }).click();
  await page.waitForFunction(() => document.querySelector(".retry-select .composer-select-value")?.textContent?.includes("重试 30 次"));
  await page.locator(".composer textarea").fill("重试次数回归测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const retryRun = await waitForRun("重试次数回归测试");
  if (!retryRun || retryRun.maxRetries !== "30" || retryRun.retryWatchdog !== "1") {
    throw new Error(`retry count was not passed to the CLI: ${JSON.stringify(retryRun)}`);
  }
  // 回到 CLI 默认：不该再往环境里塞任何重试变量。
  await page.locator(".retry-select .composer-select-trigger").click();
  await page.locator(".retry-select .composer-select-option", { hasText: "重试 10 次" }).click();
  await page.locator(".composer textarea").fill("重试默认回归测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const defaultRetryRun = await waitForRun("重试默认回归测试");
  if (!defaultRetryRun || defaultRetryRun.maxRetries !== null || defaultRetryRun.retryWatchdog !== null) {
    throw new Error(`default retry count still overrode the CLI env: ${JSON.stringify(defaultRetryRun)}`);
  }

  // 定时发送：到点由界面自己把这句话发进这个对话，列表里能看能撤。
  const pad = (value) => String(value).padStart(2, "0");
  const laterToday = new Date(Date.now() + 90 * 60 * 1000);
  const laterTime = `${pad(laterToday.getHours())}:${pad(laterToday.getMinutes())}`;
  await page.locator(".schedule-send-button").click();
  await page.locator(".schedule-send-time input").fill(laterTime);
  await page.locator(".schedule-send-prompt").fill("定时发送取消测试");
  await page.locator(".schedule-send-submit").click();
  await page.waitForFunction(() => document.querySelector(".schedule-send-count")?.textContent === "1");
  await page.keyboard.press("Escape");
  // 侧边栏的定时任务面板要看得到它，并且能导航、能取消。
  await page.locator('.settings-trigger[data-panel="schedule"]').click();
  await page.waitForSelector(".schedule-task-item");
  const scheduledText = await page.locator(".schedule-task-item").first().textContent();
  if (!scheduledText?.includes(laterTime) || !scheduledText.includes("定时发送取消测试")) {
    throw new Error(`scheduled prompt was not listed in the sidebar: ${scheduledText}`);
  }
  await page.locator(".schedule-task-cancel").first().click();
  await page.waitForFunction(() => !document.querySelector(".schedule-task-item"));
  await page.keyboard.press("Escape");
  if (await page.locator(".schedule-send-count").count()) throw new Error("canceling a scheduled prompt left the composer badge behind");
  // 当前这一分钟就算到点：排进去之后应该很快真的发出去。
  const now = new Date();
  const dueTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  await page.locator(".schedule-send-button").click();
  await page.locator(".schedule-send-time input").fill(dueTime);
  await page.locator(".schedule-send-prompt").fill("定时发送到点测试");
  await page.locator(".schedule-send-submit").click();
  await page.waitForFunction(
    () => [...document.querySelectorAll(".user-bubble")].some((item) => item.textContent === "定时发送到点测试"),
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (!(await page.locator(".markdown").last().textContent())?.includes("测试通过：定时发送到点测试")) {
    throw new Error("scheduled prompt was not actually sent to Claude");
  }
  if (await page.locator(".schedule-send-count").count()) throw new Error("a fired scheduled prompt stayed in the list");

  // 全部回答完成后执行：只有在有对话正在回答时才能布置，答完之后命令要真的被执行一次。
  await page.locator('.settings-trigger[data-panel="completion"]').click();
  if (!(await page.locator(".completion-task-submit").isDisabled())) {
    throw new Error("completion task could be armed while nothing was answering");
  }
  await page.keyboard.press("Escape");
  await page.locator(".composer textarea").fill("慢任务");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".send-button.stop");
  await page.locator('.settings-trigger[data-panel="completion"]').click();
  await page.locator(".completion-task-examples button", { hasText: "锁屏" }).click();
  if (await page.locator(".completion-task-input").inputValue() !== "rundll32.exe user32.dll,LockWorkStation") {
    throw new Error("completion task example did not fill the command");
  }
  await page.locator(".completion-task-input").fill("echo completion-task-fired");
  await page.locator(".completion-task-submit").click();
  await page.waitForFunction(() => document.querySelector(".completion-task-submit")?.textContent?.includes("撤销布置"));
  await page.keyboard.press("Escape");
  if (!(await page.locator('.settings-trigger[data-panel="completion"]').getAttribute("class"))?.includes("armed")) {
    throw new Error("armed completion task was not reflected on the sidebar button");
  }
  await writeFile(processExitGate, "go", "utf8");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await page.waitForFunction(
    async () => (await window.claudeDesk.getActiveRuns()).length === 0,
    undefined,
    { timeout: 20_000 },
  );
  const firedTask = await (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const lines = (await readFile(shellTaskLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
      const found = lines.map((line) => JSON.parse(line)).find((task) => task.command === "echo completion-task-fired");
      if (found) return found;
      await page.waitForTimeout(500);
    }
    return null;
  })();
  if (!firedTask || firedTask.shell !== "cmd") {
    throw new Error(`completion task was not executed after every answer finished: ${JSON.stringify(firedTask)}`);
  }
  if (await page.locator('.settings-trigger[data-panel="completion"].armed').count()) {
    throw new Error("completion task stayed armed after it ran");
  }
  // 命令只执行一次：布置已经撤掉，后面再跑一轮不该再执行它。
  await page.locator(".composer textarea").fill("收尾命令只执行一次测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await page.waitForTimeout(COMPLETION_TASK_SETTLE_MS);
  const firedCount = (await readFile(shellTaskLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((task) => task.command === "echo completion-task-fired").length;
  if (firedCount !== 1) throw new Error(`completion task ran ${firedCount} times, expected exactly once`);

  // 停止后重新编辑：新的一轮必须带上截断点，让 CLI 把被放弃的那一轮顶掉（对应 esc esc 里的
  // Restore conversation），而不是在原会话后面再堆一条。单开一个对话跑，免得和别的用例互相干扰。
  const conversationBeforeRewind = await page.locator(".task-heading h2").textContent();
  await page.locator(".project-row").first().hover();
  await page.locator('.project-action[title="新建对话"]').click();
  await page.waitForFunction(() => document.querySelector(".conversation-intro") !== null);
  await page.locator(".composer textarea").fill("回退重编辑测试 一");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await page.locator(".composer textarea").fill("回退重编辑测试 二");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  // 直接从会话文件里取这两个 uuid：断言的就是「发给 CLI 的截断点正是被放弃那一轮的位置」。
  const chainRecords = async () => {
    const files = await readdir(cliSessions);
    const records = [];
    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      for (const line of (await readFile(resolve(cliSessions, file), "utf8")).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // 跳过写坏的行。
        }
      }
    }
    return records;
  };
  const droppedTurn = (await chainRecords()).find((record) => record.type === "user" && record.message?.content === "回退重编辑测试 二");
  if (!droppedTurn?.uuid || !droppedTurn.parentUuid) {
    throw new Error(`fake CLI did not write a chained session record: ${JSON.stringify(droppedTurn)}`);
  }
  const lastUserBubble = page.locator(".message.user").last();
  await lastUserBubble.hover();
  await lastUserBubble.locator('[aria-label="编辑并重新发送"]').click();
  const rewindEditBox = lastUserBubble.locator(".user-bubble.editing textarea");
  await rewindEditBox.waitFor();
  await rewindEditBox.fill("回退重编辑测试 三");
  await rewindEditBox.press("Enter");
  // 重发要先读一次截断点再改状态，这段空档里最后一条回答还是上一轮那条（早就 done 了）。
  // 必须先等气泡换过来，否则「等 done」会立刻通过，日志里这一轮还没开始。
  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll(".user-bubble")].map((item) => item.textContent);
    return bubbles.includes("回退重编辑测试 三") && !bubbles.includes("回退重编辑测试 二");
  });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const rewoundRun = await waitForRun("回退重编辑测试 三");
  if (!rewoundRun || rewoundRun.resumeSessionAt !== droppedTurn.parentUuid || rewoundRun.resumeDropsTurn !== droppedTurn.uuid) {
    throw new Error(`edited turn did not truncate the resumed session: ${JSON.stringify({ rewoundRun, droppedTurn: { uuid: droppedTurn.uuid, parentUuid: droppedTurn.parentUuid } })}`);
  }
  // 被顶掉的那一轮仍留在会话文件里（CLI 只是把它移出对话链），但界面上不能再出现第二条。
  if (await page.locator(".user-bubble", { hasText: "回退重编辑测试 二" }).count()) {
    throw new Error("the superseded turn stayed visible in the conversation");
  }
  await waitForAsyncCondition(page, async () => {
    const projects = await window.claudeDesk.getProjectStore();
    return Array.isArray(projects) && projects.some((project) => project.conversations.some((conversation) =>
      Array.isArray(conversation.droppedPromptUuids) && conversation.droppedPromptUuids.length > 0));
  });
  // 重新读一遍历史：被放弃的那一轮不能靠文件顺序又冒出来。
  await refreshProjectSessions(page);
  await page.waitForTimeout(500);
  if (await page.locator(".user-bubble", { hasText: "回退重编辑测试 二" }).count()) {
    throw new Error("re-importing the session resurrected the superseded turn");
  }
  // CLI 拒绝回退时（要丢的那段混进了别的内容）：错误要说人话，而且不能把一条仍然有效的提问
  // 记成「已被顶掉」——否则重新导入历史时它会从界面上凭空消失。
  const rejectedTurn = (await chainRecords()).find((record) => record.type === "user" && record.message?.content === "回退重编辑测试 三");
  if (!rejectedTurn?.uuid) throw new Error("fake CLI did not record the edited turn");
  const rewrittenBubble = page.locator(".message.user").last();
  await rewrittenBubble.hover();
  await rewrittenBubble.locator('[aria-label="编辑并重新发送"]').click();
  const rejectEditBox = rewrittenBubble.locator(".user-bubble.editing textarea");
  await rejectEditBox.waitFor();
  await rejectEditBox.fill("回退被拒测试");
  await rejectEditBox.press("Enter");
  // 同样先等气泡换过来：这一轮注定失败，但在它出现之前最后一条回答还是上一轮那条 done。
  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll(".user-bubble")].map((item) => item.textContent);
    return bubbles.includes("回退被拒测试") && !bubbles.includes("回退重编辑测试 三");
  });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "error");
  const rejectedError = await page.locator(".message.assistant").last().textContent();
  if (!rejectedError?.includes("Claude CLI 拒绝回退它") || rejectedError.includes("--resume-drops-turn")) {
    throw new Error(`rewind refusal was not explained in the UI: ${rejectedError}`);
  }
  await waitForAsyncCondition(page, async (uuid) => {
    const projects = await window.claudeDesk.getProjectStore();
    const conversations = Array.isArray(projects) ? projects.flatMap((project) => project.conversations ?? []) : [];
    return conversations.every((conversation) => !(conversation.droppedPromptUuids ?? []).includes(uuid));
  }, rejectedTurn.uuid);

  // 把选中项还回去：后面的用例都接着原来那个对话继续。
  if (!conversationBeforeRewind) throw new Error("could not remember which conversation was open before the rewind test");  await inFolder(page, ".task-row strong")
    .filter({ hasText: new RegExp(`^${conversationBeforeRewind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
    .click();
  await page.waitForFunction((title) => document.querySelector(".task-heading h2")?.textContent === title, conversationBeforeRewind);

  await page.evaluate(() => {
    const container = document.querySelector(".conversation-scroll");
    if (container) container.scrollTop = 0;
  });
  await page.locator(".composer textarea").fill("自动滚动测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const bottomDistance = await page.locator(".conversation-scroll").evaluate((container) => container.scrollHeight - container.clientHeight - container.scrollTop);
  if (bottomDistance > 2) throw new Error(`conversation did not scroll to the bottom after send: ${bottomDistance}px`);

  await page.locator(".composer textarea").fill("滚动锁定测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"] .thinking-content');
  await page.waitForFunction(() => (document.querySelector('.message.assistant[data-status="running"] .thinking-content')?.textContent?.length ?? 0) > 120);
  await page.locator(".conversation-scroll").evaluate((container) => {
    // 滚走必须带上真实的用户意图：内容长高、以及浏览器还原先前被夹掉的偏移，都会发出同样的 scroll 事件。
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => (document.querySelector('.message.assistant[data-status="running"] .thinking-content')?.textContent?.length ?? 0) > 360);
  await page.waitForFunction(() => Number(document.querySelector('.message.assistant[data-status="running"] .response-duration')?.getAttribute("data-elapsed-seconds")) >= 1);
  if (!(await page.locator('.message.assistant[data-status="running"] .response-duration').textContent())?.includes("正在回答")) {
    throw new Error("running response did not show an elapsed duration");
  }
  const heldScrollTop = await page.locator(".conversation-scroll").evaluate((container) => container.scrollTop);
  if (heldScrollTop > 2) throw new Error(`streaming output stole the user's scroll position: ${heldScrollTop}px`);
  await page.locator(".conversation-scroll").evaluate((container) => {
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (Number(await page.locator('.message.assistant:last-of-type .response-duration').getAttribute("data-elapsed-seconds")) < 1) {
    throw new Error("completed response did not retain its elapsed duration");
  }
  if (!(await page.locator('.message.assistant:last-of-type .response-duration').textContent())?.includes("本次回答耗时")) {
    throw new Error("completed response duration was not labeled clearly");
  }
  // 结束时刻要和耗时一起记下来：只有耗时的话，回头看长任务不知道它是几点跑完的。
  const liveCompletedAt = Number(await page.locator('.message.assistant:last-of-type .response-duration').getAttribute("data-completed-at"));
  if (!Number.isFinite(liveCompletedAt) || Math.abs(Date.now() - liveCompletedAt) > 60_000) {
    throw new Error(`completed response did not record when it finished: ${liveCompletedAt}`);
  }
  if (!(await page.locator('.message.assistant:last-of-type .response-duration').textContent())?.includes(`完成于 ${new Date(liveCompletedAt).toTimeString().slice(0, 8)}`)) {
    throw new Error(`completed response did not show when it finished: ${await page.locator('.message.assistant:last-of-type .response-duration').textContent()}`);
  }
  const resumedBottomDistance = await page.locator(".conversation-scroll").evaluate((container) => container.scrollHeight - container.clientHeight - container.scrollTop);
  if (resumedBottomDistance > 2) throw new Error(`bottom-follow did not resume: ${resumedBottomDistance}px`);

  // 回归：打开长对话时内容要分几拍才稳定下来（代码块排版、长提问量完溢出后补上的「展开全部」、图片占位），
  // 这些后到的高度变化必须跟着贴回底部，否则会停在半空、还得手动滚好几下才到底。
  await page.locator(".conversation-scroll").evaluate((container) => {
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => {
    const filler = document.createElement("div");
    filler.id = "settle-filler";
    filler.style.height = "1200px";
    document.querySelector(".conversation")?.append(filler);
  });
  await page.waitForFunction(() => {
    const container = document.querySelector(".conversation-scroll");
    return container && container.scrollHeight - container.clientHeight - container.scrollTop <= 2;
  }, undefined, { timeout: 5_000 });
  // 反过来，用户自己滚上去之后，后到的高度变化不能再把视图拽回底部。
  await page.locator(".conversation-scroll").evaluate((container) => {
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => {
    const filler = document.querySelector("#settle-filler");
    if (filler) filler.style.height = "2400px";
  });
  await page.waitForTimeout(200);
  const settledScrollTop = await page.locator(".conversation-scroll").evaluate((container) => container.scrollTop);
  if (settledScrollTop > 2) throw new Error(`内容继续长高时把用户滚上去的位置拽回了底部：${settledScrollTop}px`);
  await page.evaluate(() => { document.querySelector("#settle-filler")?.remove(); });
  await page.locator(".conversation-scroll").evaluate((container) => {
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll"));
  });

  await page.evaluate(() => {
    window.__clipboardWrites = [];
    navigator.clipboard.writeText = async (text) => { window.__clipboardWrites.push(text); };
  });
  const lastUserMessage = page.locator(".message.user").last();
  await lastUserMessage.hover();
  await lastUserMessage.locator('[aria-label="复制"]').click();
  await lastUserMessage.locator('[aria-label="已复制"]').waitFor();
  const copiedUserText = await page.evaluate(() => window.__clipboardWrites.at(-1));
  if (copiedUserText !== "滚动锁定测试") throw new Error(`user message copy did not reach the clipboard: ${copiedUserText}`);
  await lastUserMessage.locator('[aria-label="复制"]').waitFor();
  const lastAssistantMessage = page.locator(".message.assistant").last();
  await lastAssistantMessage.hover();
  await lastAssistantMessage.locator('[aria-label="复制"]').click();
  await lastAssistantMessage.locator('[aria-label="已复制"]').waitFor();
  const copiedAssistantText = await page.evaluate(() => window.__clipboardWrites.at(-1));
  if (!copiedAssistantText.includes("滚动锁定测试完成")) throw new Error("assistant message copy did not reach the clipboard");

  const earlierUserMessage = page.locator(".message.user").nth(-2);
  await earlierUserMessage.hover();
  if (await earlierUserMessage.locator('[aria-label="编辑并重新发送"]').count()) {
    throw new Error("edit action appeared on an older user message");
  }
  await lastUserMessage.hover();
  await lastUserMessage.locator('[aria-label="编辑并重新发送"]').click();
  const editBox = lastUserMessage.locator(".user-bubble.editing textarea");
  await editBox.waitFor();
  if (await editBox.inputValue() !== "滚动锁定测试") throw new Error("edit draft did not preload the original message");
  await editBox.press("Escape");
  if (await editBox.count()) throw new Error("Escape did not cancel message editing");
  await lastUserMessage.hover();
  await lastUserMessage.locator('[aria-label="编辑并重新发送"]').click();
  // The edited text must avoid fake-CLI trigger keywords (e.g. "滚动锁定测试") so the resent prompt hits the default response branch.
  await editBox.fill("重新编辑后的提问");
  await editBox.press("Enter");
  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll(".user-bubble")];
    return bubbles.some((item) => item.textContent === "重新编辑后的提问") && !bubbles.some((item) => item.textContent === "滚动锁定测试");
  });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (!(await page.locator(".markdown").last().textContent())?.includes("测试通过：重新编辑后的提问")) {
    throw new Error("edited message was not resent to Claude");
  }

  await page.locator(".composer textarea").fill("/st");
  await page.waitForSelector(".command-menu");
  if (!(await page.locator(".command-menu").textContent())?.includes("/story")) throw new Error("CLI slash commands were not merged");
  await page.screenshot({ path: resolve(artifacts, "slash-menu.png") });
  await page.locator(".composer textarea").fill("");

  await page.locator(".composer textarea").fill("/plan");
  await page.locator(".composer textarea").press("Enter");
  await page.locator(".composer textarea").fill("计划询问测试");
  await page.locator(".composer textarea").press("Enter");
  const planQuestion = page.locator(".activity-question", { hasText: "最终交付几份文稿？" });
  await planQuestion.waitFor();
  const planQuestionText = await planQuestion.textContent();
  if (!planQuestionText?.includes("交付形式") || !planQuestionText.includes("一份完整文稿") || !planQuestionText.includes("按章节拆分")) {
    throw new Error("plan mode AskUserQuestion options were not shown");
  }
  if (await page.locator(".activity-entry", { has: planQuestion }).locator(".activity-detail").count() !== 1) {
    throw new Error("plan mode question was not expanded automatically");
  }
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");

  await page.locator(".composer textarea").fill("结束事件缺失测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done", undefined, { timeout: 5_000 });
  if (!(await page.locator(".message.assistant .markdown").last().textContent())?.includes("最终总结已经输出")) {
    throw new Error("assistant end_turn fallback lost the final response text");
  }
  // 侧栏转圈和停止按钮都跟着 activeRuns 走，而 activeRuns 只在进程 exit 事件到达时才清空：
  // main 发 exit 之前还要先等行队列排完、再等 session 规范化的文件 I/O，所以 exit 必然晚于这条
  // 由 end_turn 兜底合成的 result。读一次就断言会在 CI 磁盘偏慢时误报（已在 v0.1.83 的 main
  // 推送上失败过一次，同一个提交的 tag 推送却通过）。这里改成轮询等它们清掉，真清不掉仍然报错。
  try {
    await page.waitForFunction(() => (
      document.querySelectorAll('.task-row.active[aria-label="会话正在运行"], .task-row.active .conversation-running-icon').length === 0
      && document.querySelectorAll(".send-button.stop").length === 0
    ), undefined, { timeout: 15_000 });
  } catch {
    const stuckBusyState = await page.evaluate(() => ({
      runningIcon: document.querySelectorAll('.task-row.active[aria-label="会话正在运行"], .task-row.active .conversation-running-icon').length,
      stopButton: document.querySelectorAll(".send-button.stop").length,
    }));
    throw new Error(`assistant end_turn fallback left the conversation busy: ${JSON.stringify(stuckBusyState)}`);
  }

  await page.locator(".composer textarea").fill("/edit");
  await page.locator(".composer textarea").press("Enter");
  await page.locator(".composer textarea").fill("思考阶段测试");
  await page.locator(".composer textarea").press("Enter");
  const thinkingPhaseResponse = page.locator(".message.assistant").last();
  await thinkingPhaseResponse.locator(".thinking-toggle", { hasText: "正在思考" }).waitFor();
  await thinkingPhaseResponse.locator(".response-text-block", { hasText: "已经进入回答阶段" }).waitFor();
  if ((await thinkingPhaseResponse.locator(".thinking-toggle").textContent())?.includes("正在思考")) {
    throw new Error("thinking indicator remained active after response text started");
  }
  if (await thinkingPhaseResponse.locator(".thinking-toggle .mini-spinner").count() !== 0) {
    throw new Error("thinking block kept a spinner after the answer phase started");
  }
  if (await thinkingPhaseResponse.locator(".response-duration .mini-spinner").count() !== 1) {
    throw new Error("active answer timer did not show the running indicator");
  }
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");

  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__permissionNotifyCalls = [];
    ipcMain.removeHandler("app:notify-permission");
    ipcMain.handle("app:notify-permission", (_event, request) => {
      globalThis.__permissionNotifyCalls.push(request);
      return true;
    });
  });
  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".permission-dialog");
  if (!(await page.locator(".permission-dialog").textContent())?.includes("WebSearch") || !(await page.locator(".permission-dialog").textContent())?.includes("LongCat-2.0")) {
    throw new Error("permission dialog did not show the requested tool and input");
  }
  const deniedPermissionResponse = page.locator(".message.assistant").last();
  const deniedPermissionText = await deniedPermissionResponse.textContent();
  if (!deniedPermissionText?.includes("我先保留这段阶段性说明") || !deniedPermissionText.includes("需要你授权网络搜索后才能继续")) {
    throw new Error("multiple assistant updates before permission were not preserved");
  }
  await page.waitForTimeout(200);
  if (await electronApp.evaluate(() => globalThis.__permissionNotifyCalls.length) !== 0) {
    throw new Error("focused permission request triggered a background notification");
  }
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new Event("blur"));
  });
  await electronApp.evaluate(async () => {
    const deadline = Date.now() + 5_000;
    while (globalThis.__permissionNotifyCalls.length !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  const permissionNotifyCall = await electronApp.evaluate(() => globalThis.__permissionNotifyCalls[0]);
  if (permissionNotifyCall?.title !== "CLI 外部改名" || !permissionNotifyCall?.tools?.includes("WebSearch")) {
    throw new Error("background permission notification did not identify the conversation and tool");
  }
  await page.evaluate(() => { delete document.hasFocus; });
  await page.screenshot({ path: resolve(artifacts, "permission-dialog.png") });
  await page.locator(".permission-deny").click();
  await page.waitForSelector(".permission-dialog", { state: "detached" });
  if (!(await page.locator(".message-error").last().textContent())?.includes("已拒绝")) throw new Error("permission denial was not reflected in the conversation");

  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".permission-dialog");
  await page.waitForTimeout(1_200);
  await page.locator(".permission-allow-once").click();
  await page.waitForSelector(".permission-dialog", { state: "detached" });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const continuedPermissionElapsed = Number(await page.locator(".message.assistant").last().locator(".response-duration").getAttribute("data-elapsed-seconds"));
  if (continuedPermissionElapsed < 1) throw new Error("permission continuation reset the response timer");
  const allowedPermissionText = await page.locator(".message.assistant").last().textContent();
  if (!allowedPermissionText?.includes("我先保留这段阶段性说明") || !allowedPermissionText.includes("需要你授权网络搜索后才能继续") || !allowedPermissionText.includes("测试通过")) {
    throw new Error("permission retry replaced output that was already visible");
  }
  let permissionConversation = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.find((conversation) => conversation.sessionId === "22222222-2222-4222-8222-222222222222"));
  if (permissionConversation.allowedTools?.includes("WebSearch")) throw new Error("allow once persisted the tool permission");

  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".permission-dialog");
  await page.locator(".permission-allow-conversation").click();
  await page.waitForSelector(".permission-dialog", { state: "detached" });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await page.waitForTimeout(450);
  permissionConversation = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.find((conversation) => conversation.sessionId === "22222222-2222-4222-8222-222222222222"));
  if (!permissionConversation.allowedTools?.includes("WebSearch")) throw new Error("conversation permission was not persisted");

  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (await page.locator(".permission-dialog").count()) throw new Error("persisted conversation permission prompted again");

  // #1 API 重试：CLI 重试时渲染层必须显示重试状态而不是一直停在「正在准备回答」。
  // 提示只在重试期间存在，逐次 waitForSelector 采样会被主进程的偶发卡顿整段错过，
  // 所以挂 MutationObserver 把出现过的文案和「是否与占位提示同时出现」都记下来再断言。
  const watchRetryNotices = () => page.evaluate(() => {
    window.__retryNotices = [];
    window.__retryWithPlaceholder = false;
    const record = () => {
      const notice = document.querySelector(".retry-notice");
      if (!notice) return;
      const text = notice.textContent ?? "";
      if (text && window.__retryNotices.at(-1) !== text) window.__retryNotices.push(text);
      if (document.querySelector(".thinking")) window.__retryWithPlaceholder = true;
    };
    record();
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await watchRetryNotices();
  await page.locator(".composer textarea").fill("API重试测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => (window.__retryNotices?.length ?? 0) > 0);
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (await page.locator(".retry-notice").count() > 0) throw new Error("retry notice was not cleared after response completed");
  if (await page.evaluate(() => window.__retryWithPlaceholder)) throw new Error("preparing-answer placeholder shown alongside retry notice");
  const retryNotices = await page.evaluate(() => window.__retryNotices);
  const firstRetry = retryNotices.find((text) => text.includes("第 1/10 次"));
  if (!firstRetry) throw new Error(`retry notice did not show attempt count: ${JSON.stringify(retryNotices)}`);
  // error 是字符串 overloaded、状态码走 error_status 529：两者都要能映射成可读文案，否则真实重试提示等于没显示。
  if (!firstRetry.includes("服务过载")) throw new Error(`retry notice did not surface the real error string: ${firstRetry}`);
  if (!firstRetry.includes("529")) throw new Error(`retry notice did not surface the HTTP status: ${firstRetry}`);
  // 连响应头都没回的重试没有状态码，只有 no_response.waited_ms 能说明它在等什么。
  const noResponseRetry = retryNotices.find((text) => text.includes("第 2/10 次"));
  if (!noResponseRetry) throw new Error(`no-response retry was not rendered: ${JSON.stringify(retryNotices)}`);
  if (!noResponseRetry.includes("已等待 30s")) {
    throw new Error(`retry notice did not surface the no-response wait: ${noResponseRetry}`);
  }
  // error 只是分类词时必须把服务端回的原话一起显示，光写「服务端错误」看不出到底哪里错了。
  if (!noResponseRetry.includes("服务端错误：upstream connect error or disconnect/reset before headers")) {
    throw new Error(`retry notice dropped the server error detail: ${noResponseRetry}`);
  }

  // #1b 子代理重试：走的是 tool_progress.subagent_retry，不认这条的话主对话同样只停在「正在准备回答」
  await watchRetryNotices();
  await page.locator(".composer textarea").fill("子代理重试测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => (window.__retryNotices?.length ?? 0) > 0);
  // 子代理恢复后 CLI 只是少发 subagent_retry，没有别的信号，提示必须靠它撤掉。
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (await page.locator(".retry-notice").count() > 0) throw new Error("subagent retry notice was not cleared after recovery");
  if (await page.evaluate(() => window.__retryWithPlaceholder)) throw new Error("preparing-answer placeholder shown alongside subagent retry notice");
  const subagentRetries = await page.evaluate(() => window.__retryNotices);
  const subagentRetry = subagentRetries.find((text) => text.includes("第 2/10 次"));
  if (!subagentRetry) throw new Error(`subagent retry notice was not rendered: ${JSON.stringify(subagentRetries)}`);
  if (!subagentRetry.includes("Explore")) throw new Error(`subagent retry notice did not name the agent: ${subagentRetry}`);
  // 子代理的 error 是 API 的错误信封，原话套在 error.error.message 里，也得读出来。
  if (!subagentRetry.includes("Overloaded by upstream provider")) {
    throw new Error(`subagent retry notice dropped the server error detail: ${subagentRetry}`);
  }

  // #4 直连权限：「本对话始终允许」必须发整工具 session 规则，不得原样回显按命令的 localSettings 建议
  await page.locator(".composer textarea").fill("直连权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".permission-dialog");
  if (!(await page.locator(".permission-dialog").textContent())?.includes("PowerShell")) {
    throw new Error("direct permission dialog did not identify the PowerShell tool");
  }
  await page.locator(".permission-allow-conversation").click();
  await page.waitForSelector(".permission-dialog", { state: "detached" });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (!(await page.locator(".message.assistant").last().textContent())?.includes("两条命令都执行完了")) {
    throw new Error("direct permission test did not complete both commands (fake CLI may have rejected the rule shape)");
  }
  if (await page.locator(".permission-dialog").count()) throw new Error("blanket conversation permission re-prompted on second different command");

  await page.locator(".project-row").first().hover();
  await page.locator('.project-action[title="新建对话"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 5);
  if (await page.locator(".conversation-intro").count() !== 1) throw new Error("new conversation did not open independently");
  // 回归：新建对话必须默认使用完全访问权限，用户不必先改模式就能连续执行命令。
  if (!(await page.locator(".permission-select .composer-select-value").textContent())?.includes("完全访问权限")) {
    throw new Error("new conversation did not default to full access permission mode");
  }

  await page.locator(".composer textarea").fill("后台提醒测试 第二个对话");
  await page.locator(".composer textarea").press("Enter");
  const backgroundConversationRow = inFolder(page, ".task-row", { hasText: "后台提醒测试 第二个对话" });
  await backgroundConversationRow.locator(".conversation-running-icon").waitFor();
  await inFolder(page, ".task-row strong").filter({ hasText: /^CLI 外部改名$/ }).click();
  await page.waitForSelector(".completion-toast");
  if (!(await page.locator(".completion-toast").textContent())?.includes("后台提醒测试 第二个对话")) {
    throw new Error("background completion reminder did not identify the finished conversation");
  }
  if (await backgroundConversationRow.locator(".conversation-running-icon").count()) {
    throw new Error("running conversation indicator remained after completion");
  }
  await page.locator(".completion-toast").click();
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "后台提醒测试 第二个对话");
  if (!(await page.locator(".markdown").last().textContent())?.includes("后台会话提醒测试完成")) {
    throw new Error("completion reminder did not navigate to the finished conversation");
  }
  await page.locator(".composer textarea").fill("/clear");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".conversation-intro");
  if (await page.locator(".message").count()) throw new Error("/clear did not clear only the active conversation");
  await inFolder(page, ".task-row strong").filter({ hasText: /^CLI 外部改名$/ }).click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "这是首次会话名称测试内容");

  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__completionNotifyCalls = [];
    ipcMain.removeHandler("app:notify-completion");
    ipcMain.handle("app:notify-completion", (_event, request) => {
      globalThis.__completionNotifyCalls.push(request);
      return true;
    });
  });
  await page.locator(".composer textarea").fill("前台运行完成测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await page.waitForTimeout(300);
  if (await electronApp.evaluate(() => globalThis.__completionNotifyCalls.length) !== 0) {
    throw new Error("focused active conversation triggered a completion notification");
  }
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
  });
  await page.locator(".composer textarea").fill("失焦运行完成测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await electronApp.evaluate(async () => {
    const deadline = Date.now() + 5_000;
    while (globalThis.__completionNotifyCalls.length !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  const notifyCall = await electronApp.evaluate(() => globalThis.__completionNotifyCalls[0]);
  if (notifyCall?.title !== "CLI 外部改名") throw new Error("unfocused completion notified with the wrong conversation");
  await page.evaluate(() => { delete document.hasFocus; });

  await page.locator(".composer textarea").fill("/new");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 6);
  await page.locator(".composer textarea").fill("/project");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 7);
  if (await page.locator(".project-group").count() !== 1) throw new Error("same workspace created a duplicate project");

  await page.locator(".composer textarea").fill("模拟失败");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="error"]');
  if (!(await page.locator(".message-error").last().textContent())?.includes("模拟 CLI 错误")) throw new Error("stderr was not shown");

  await page.locator(".composer textarea").fill("空响应");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll('.message.assistant[data-status="error"]').length === 2);

  await page.locator(".composer textarea").fill("时间线排序测试");
  await page.locator(".composer textarea").press("Enter");
  const timelineResponse = page.locator(".message.assistant").last();
  await timelineResponse.waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const timelineKinds = await timelineResponse.locator("[data-timeline-kind]").evaluateAll((items) => items.map((item) => item.getAttribute("data-timeline-kind")));
  if (timelineKinds.join(",") !== "text,activity,text,activity,text") {
    throw new Error(`assistant output was grouped instead of preserving CLI event order: ${timelineKinds.join(",")}`);
  }
  const timelineText = await timelineResponse.locator('[data-timeline-kind="text"]').allTextContents();
  if (timelineText.join("|") !== "先说明当前处理方案。|编辑已经完成，继续检查。|最终总结已经完成。") {
    throw new Error(`assistant text phases were merged or lost: ${timelineText.join("|")}`);
  }
  if ((await timelineResponse.locator('[data-timeline-kind="activity"] .activity-name').allTextContents()).join(",") !== "Edit,Bash") {
    throw new Error("assistant tool calls did not remain in their original timeline positions");
  }
  if (await timelineResponse.locator(".mini-spinner").count()) throw new Error("completed timeline activity still appeared to be running");
  const timelineActivities = timelineResponse.locator('[data-timeline-kind="activity"]');
  await timelineActivities.nth(0).locator(".activity-row").click();
  const editDetail = timelineActivities.nth(0).locator(".activity-detail");
  await editDetail.waitFor();
  if (!(await editDetail.locator(".activity-detail-path").textContent())?.includes("src/App.tsx")) throw new Error("edit detail did not show the full file path");
  if ((await editDetail.locator(".tool-diff-line.remove").allTextContents()).join("").includes("const before = true;") === false) {
    throw new Error("edit detail did not show removed lines");
  }
  if ((await editDetail.locator(".tool-diff-line.add").allTextContents()).join("").includes("const checked = true;") === false) {
    throw new Error("edit detail did not show added lines");
  }
  const diffColors = await editDetail.locator(".tool-diff-line.remove, .tool-diff-line.add").evaluateAll((lines) => lines.map((line) => getComputedStyle(line).backgroundColor));
  if (diffColors.length < 2 || new Set(diffColors).size < 2) throw new Error("edit diff did not distinguish removed and added lines with red/green colors");
  if ((await editDetail.locator(".diff-old-line, .diff-new-line").allTextContents()).every((value) => !value.trim())) {
    throw new Error("edit diff did not show line numbers");
  }
  await timelineActivities.nth(0).locator(".activity-row").click();
  await timelineActivities.nth(1).locator(".activity-row").click();
  const bashDetail = timelineActivities.nth(1).locator(".activity-detail");
  if (!(await bashDetail.textContent())?.includes("npm test") || !(await bashDetail.textContent())?.includes("All tests passed.")) {
    throw new Error("bash detail did not show the complete command and output");
  }

  await page.locator(".composer textarea").fill("子代理测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"]');
  // 子代理的 end_turn 与 result 先到，主轮次必须继续等真正的回答，不能两秒钟就显示“已完成”。
  await page.waitForTimeout(1_500);
  if (await page.locator('.message.assistant[data-status="running"]').count() !== 1) {
    throw new Error("subagent end_turn or result finished the main turn while Claude was still working");
  }
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done", undefined, { timeout: 15_000 });
  if (!(await page.locator(".markdown").last().textContent())?.includes("子代理测试完成")) {
    throw new Error("subagent turn lost the final answer");
  }
  // 子代理那条 95 万 token 的用量不属于主对话占用，真实占用是 30k/200k = 15%。
  await page.waitForFunction(() => document.querySelector(".context-status-text")?.textContent?.includes("上下文 15%"));

  // 回归：1M 路由上一次请求 75 万 token 的真实占用必须显示成百分比。CLI 报回来的实际模型标识不带
  // [1M]，之前按标识把窗口猜成 200k，超过 200k 的真实读数全被当成累加值丢掉，状态条只剩
  // 「上下文用量未知」；input 与缓存读也不能重复相加算成 1.5M。
  await writeTestModels({
    Sonnet: "ThirdParty-A",
    Opus: "Router2-Opus[1m]",
    Fable: "ThirdParty-B",
    Haiku: "ThirdParty-B",
  });
  await page.locator(".model-select .composer-select-trigger").click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".model-select .composer-select-option small")].some((node) => node.textContent === "Router2-Opus[1m]")
  ));
  await page.locator('.model-select .composer-select-option[data-value="opus"]').click();
  await page.waitForFunction(() => document.querySelector(".context-window-badge")?.textContent === "1M");
  await page.locator(".composer textarea").fill("上下文窗口读数测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector(".context-status-text")?.textContent?.includes("上下文 75%"));
  const largeContextStatus = await page.locator(".context-status").textContent();
  if (largeContextStatus?.includes("1.5M") || largeContextStatus?.includes("未知")) {
    throw new Error(`a real 1M-route reading was discarded or double counted: ${largeContextStatus}`);
  }
  await page.waitForSelector('.message.assistant:last-of-type[data-status="done"]', { timeout: 15_000 });
  // 切回普通路由：后面的断言依赖 fable 与 200k 窗口，抬上去的窗口也不能粘住下一轮读数。
  await writeTestModels({
    Sonnet: "ThirdParty-A",
    Opus: "ThirdParty-A",
    Fable: "ThirdParty-B",
    Haiku: "ThirdParty-B",
  });
  await page.locator(".model-select .composer-select-trigger").click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".model-select .composer-select-option small")].some((node) => node.textContent === "ThirdParty-B")
  ));
  await page.locator('.model-select .composer-select-option[data-value="fable"]').click();

  await page.locator(".composer textarea").fill("后台托盘测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"]');
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await page.waitForTimeout(150);
  if (await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())) {
    throw new Error("default window close behavior did not hide the app to the tray");
  }
  await page.waitForSelector('.message.assistant:last-of-type[data-status="done"]', { state: "attached" });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
  await page.waitForFunction(() => document.visibilityState === "visible");
  if (!(await page.locator(".markdown").last().textContent())?.includes("托盘后台运行测试完成")) {
    throw new Error("Claude CLI run was interrupted while the window was hidden to the tray");
  }

  await rm(processExitGate);
  await page.locator(".composer textarea").fill("慢任务");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"]');
  if (await page.locator(".composer textarea").isDisabled()) throw new Error("composer was disabled while Claude was replying");
  const guidedPrompts = ["引导当前任务", "第二次追击", "第三次追击"];
  for (const [guidedIndex, prompt] of guidedPrompts.entries()) {
    await page.locator(".composer textarea").fill(prompt);
    await page.locator(".composer textarea").press("Enter");
    const guidedPrompt = page.locator(".prompt-queue-item", { hasText: prompt });
    await guidedPrompt.waitFor();
    if (await page.locator('.message.assistant[data-status="running"]').count() !== 1) throw new Error("queued prompt created a second running response");
    if (await page.locator('.message.assistant[data-status="running"] .response-duration').count() !== 1) throw new Error("queued prompt created a second response timer");
    await guidedPrompt.locator(".guide-prompt").click();
    await page.waitForFunction((guidedText) => ![...document.querySelectorAll(".prompt-queue-item")].some((element) => element.textContent?.includes(guidedText)), prompt);
    if (await page.locator(".user-bubble", { hasText: prompt }).count() !== 1) throw new Error(`guided prompt disappeared from the conversation: ${prompt}`);
    if (await page.locator('.message.assistant[data-status="running"]').count() !== 1) throw new Error("guiding created a second running response");
    // 追加的信息必须落在对话末尾（当前位置），并且自带一个属于它自己的排队气泡，而不是被塞进上一条回答里。
    const guidedTail = await page.locator(".conversation .message").evaluateAll((messages) => messages.slice(-2).map((message) => ({
      role: message.classList.contains("user") ? "user" : "assistant",
      status: message.getAttribute("data-status"),
      text: message.textContent ?? "",
    })));
    if (
      guidedTail.length !== 2 ||
      guidedTail[0].role !== "user" ||
      !guidedTail[0].text.includes(prompt) ||
      guidedTail[1].role !== "assistant" ||
      !["queued", "running"].includes(guidedTail[1].status ?? "")
    ) throw new Error(`appended prompt did not render at the current position: ${JSON.stringify(guidedTail)}`);
    if (guidedIndex === 0) {
      if (await page.locator(".message.assistant .queued-hint").count() < 1) throw new Error("appended turn did not show that it is waiting in line");
      await page.screenshot({ path: resolve(artifacts, "workflow-queued-turn.png") });
    }
  }
  const runningModelTrigger = page.locator(".model-select .composer-select-trigger");
  if (await runningModelTrigger.isDisabled()) throw new Error("model picker was disabled while Claude was replying");
  await runningModelTrigger.click();
  const originalRunningModel = await page.locator('.model-select .composer-select-option[aria-selected="true"]').getAttribute("data-value");
  const alternateRunningModel = await page.locator(".model-select .composer-select-option").evaluateAll((options, original) => (
    options.find((option) => option.getAttribute("data-value") !== original)?.getAttribute("data-value") ?? null
  ), originalRunningModel);
  if (!originalRunningModel || !alternateRunningModel) throw new Error("model picker did not expose an alternate model during a run");
  await page.locator(`.model-select .composer-select-option[data-value="${alternateRunningModel}"]`).click();
  await runningModelTrigger.click();
  if (await page.locator(`.model-select .composer-select-option[data-value="${alternateRunningModel}"]`).getAttribute("aria-selected") !== "true") {
    throw new Error("model selection did not change while Claude was replying");
  }
  await page.locator(`.model-select .composer-select-option[data-value="${originalRunningModel}"]`).click();
  if (await page.locator('.message.assistant[data-status="running"]').count() !== 1) throw new Error("changing models interrupted the active response");
  const runningPermissionTrigger = page.locator(".permission-select .composer-select-trigger");
  if (await runningPermissionTrigger.isDisabled()) throw new Error("permission picker was disabled while Claude was replying");
  await runningPermissionTrigger.click();
  await page.locator('.permission-select .composer-select-option[data-value="plan"]').click();
  if (!(await page.locator(".permission-select .composer-select-value").textContent())?.includes("计划模式")) {
    throw new Error("permission mode could not be changed while Claude was replying");
  }
  await runningPermissionTrigger.click();
  await page.locator('.permission-select .composer-select-option[data-value="acceptEdits"]').click();
  for (const prompt of ["队列第一条", "队列第二条", "队列第三条"]) {
    await page.locator(".composer textarea").fill(prompt);
    await page.locator(".send-button:not(.stop)").click();
  }
  await page.waitForFunction(() => document.querySelectorAll(".prompt-queue-item").length === 3);
  if ((await page.locator(".prompt-queue-content strong").allTextContents()).join(",") !== "队列第一条,队列第二条,队列第三条") {
    throw new Error("multiple prompts did not retain their queue order");
  }
  const queuedThird = page.locator(".prompt-queue-item", { hasText: "队列第三条" });
  const queuedFirst = page.locator(".prompt-queue-item", { hasText: "队列第一条" });
  await queuedThird.dragTo(queuedFirst, { targetPosition: { x: 80, y: 2 } });
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".prompt-queue-content strong")].map((element) => element.textContent).join(",") ===
    "队列第三条,队列第一条,队列第二条"
  ));
  await page.locator(".prompt-queue-item", { hasText: "队列第一条" }).locator('[aria-label="从队列删除"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".prompt-queue-item").length === 2);
  await page.locator(".prompt-queue-item", { hasText: "队列第二条" }).locator('[aria-label="移回输入框编辑"]').click();
  if (await page.locator(".composer textarea").inputValue() !== "队列第二条") throw new Error("queued prompt did not return to the composer for editing");
  if ((await page.locator(".prompt-queue-content strong").allTextContents()).join(",") !== "队列第三条") {
    throw new Error("editing a queued prompt did not remove it from the queue");
  }
  await page.locator(".composer textarea").fill("队列第二条已编辑");
  await page.locator(".send-button:not(.stop)").click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".prompt-queue-content strong")].map((element) => element.textContent).join(",") ===
    "队列第三条,队列第二条已编辑"
  ));
  // 等三次追加各自的回答都收尾，再核对顺序；队列里的提示词会另起新一轮，不能拿“没有运行中”当收尾信号。
  await page.waitForFunction(() => [...document.querySelectorAll(".message.assistant")].some((message) => (
    message.getAttribute("data-status") === "done" && (message.textContent ?? "").includes("测试通过：第三次追击")
  )), undefined, { timeout: 30_000 });
  // 每一次追加都有自己的一问一答，回答不能被合并进上一条气泡，顺序也必须是发出的顺序。
  const guidedTurnOrder = await page.locator(".conversation .message").evaluateAll((messages) => messages.map((message) => ({
    role: message.classList.contains("user") ? "user" : "assistant",
    status: message.getAttribute("data-status"),
    text: message.textContent ?? "",
  })).filter((message) => ["慢任务", "引导当前任务", "第二次追击", "第三次追击"].some((text) => message.text.includes(text))));
  const guidedExpected = [
    { role: "user", text: "慢任务" },
    { role: "assistant", text: "慢任务阶段完成" },
    { role: "user", text: "引导当前任务" },
    { role: "assistant", text: "测试通过：引导当前任务" },
    { role: "user", text: "第二次追击" },
    { role: "assistant", text: "测试通过：第二次追击" },
    { role: "user", text: "第三次追击" },
    { role: "assistant", text: "测试通过：第三次追击" },
  ];
  if (
    guidedTurnOrder.length !== guidedExpected.length ||
    guidedExpected.some(({ role, text }, index) => (
      guidedTurnOrder[index].role !== role ||
      !guidedTurnOrder[index].text.includes(text) ||
      (role === "assistant" && guidedTurnOrder[index].status !== "done")
    ))
  ) throw new Error(`guided turn rendered in the wrong order: ${JSON.stringify(guidedTurnOrder)}`);
  // 三条追加回答已经完成，但进程仍停在退出屏障；队列必须等真实退出才能继续。
  await waitForAsyncCondition(page, async () => (await window.claudeDesk.getActiveRuns()).some((run) => run.turnRunIds.length === 0));
  if (await page.locator(".send-button.stop").count() !== 1 ||
    (await page.locator(".prompt-queue-content strong").allTextContents()).join(",") !== "队列第三条,队列第二条已编辑") {
    throw new Error("进程真正退出之前必须保留忙碌状态和待发送队列");
  }
  await writeFile(processExitGate, "release", "utf8");
  try {
    await page.waitForFunction(() => [...document.querySelectorAll(".user-bubble")].some((element) => element.textContent === "队列第三条"));
  } catch {
    const queueState = await page.evaluate(() => ({
      queue: [...document.querySelectorAll(".prompt-queue-content strong")].map((element) => element.textContent),
      bubbles: [...document.querySelectorAll(".user-bubble")].map((element) => element.textContent),
      running: document.querySelectorAll('.message.assistant[data-status="running"]').length,
      queued: document.querySelectorAll('.message.assistant[data-status="queued"]').length,
      stopButtons: document.querySelectorAll(".send-button.stop").length,
    }));
    throw new Error(`queued prompts stopped draining: ${JSON.stringify(queueState)}`);
  }
  await page.waitForFunction(() => [...document.querySelectorAll(".user-bubble")].some((element) => element.textContent === "队列第二条已编辑"));
  await page.waitForFunction(() => document.querySelectorAll(".prompt-queue-item").length === 0);
  await page.waitForFunction(() => document.querySelectorAll('.message.assistant[data-status="running"]').length === 0);
  await page.waitForFunction(() => document.querySelectorAll(".send-button.stop").length === 0);
  const queuedUserMessages = await page.locator(".user-bubble").allTextContents();
  const thirdIndex = queuedUserMessages.indexOf("队列第三条");
  const editedSecondIndex = queuedUserMessages.indexOf("队列第二条已编辑");
  if (thirdIndex < 0 || editedSecondIndex !== thirdIndex + 1 || queuedUserMessages.includes("队列第一条")) {
    throw new Error(`queued prompts did not execute in the edited order: ${queuedUserMessages.join(" | ")}`);
  }
  // 回归：CLI 在一轮进行中被追加提示时，可能把它并进当前这一轮而不再单独回答（真实 CLI 在工具
  // 调用循环里就是这样）。此时追加轮次永远等不到属于自己的输出，过去会一直停在“排队中”，
  // 主进程也因为还有未完成的轮次而不关 stdin，导致进程挂住、停止按钮永远不消失。
  await page.locator(".composer textarea").fill("折叠追加测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"]');
  await page.locator(".composer textarea").fill("折叠追加的第二条");
  await page.locator(".composer textarea").press("Enter");
  const foldedPrompt = page.locator(".prompt-queue-item", { hasText: "折叠追加的第二条" });
  await foldedPrompt.waitFor();
  await foldedPrompt.locator(".guide-prompt").click();
  await page.waitForFunction(() => document.querySelectorAll(".message.assistant .queued-hint").length === 1);
  // 引导进去的提示已经交给正在跑的 Claude 了，不能再说成「等上一条回答结束后开始」——那是界面排队的说法。
  const guidedHint = await page.locator(".message.assistant .queued-hint").textContent();
  if (!guidedHint?.includes("已插入当前任务") || guidedHint.includes("排队中")) {
    throw new Error(`引导后的提示没有和界面排队区分开：${guidedHint}`);
  }
  if (!(await page.locator(".message.assistant .queued-hint.appended").count())) {
    throw new Error("引导后的提示没有标成已插入当前任务");
  }
  // 追加的轮次必须被明确收尾并说明原因，而不是一直挂在“排队中”。
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".message.assistant")].some((message) => (
      message.getAttribute("data-status") === "error" &&
      (message.textContent ?? "").includes("并进上一条回答")
    ))
  ), undefined, { timeout: 25_000 });
  await page.waitForFunction(() => document.querySelectorAll(".message.assistant .queued-hint").length === 0);
  // 收尾之后进程必须真的结束：停止按钮消失，没有轮次还停在运行中。
  await page.waitForFunction(() => document.querySelectorAll(".send-button.stop").length === 0, undefined, { timeout: 25_000 });
  if (await page.locator('.message.assistant[data-status="running"]').count() !== 0) {
    throw new Error("folded appended turn left a response stuck in the running state");
  }
  if (!(await page.locator(".user-bubble", { hasText: "折叠追加的第二条" }).count())) {
    throw new Error("folded appended prompt disappeared from the conversation");
  }

  // 回归：工具调用进行中引导一条提示。实测真实 CLI 不回显这条 user 消息、也不给上一轮单独发
  // result，只在最后发一个；过去这会让引导的气泡一直停在「已插入当前任务」，而它自己的工具调用
  // 全算进上一条回答。现在注入后的第一个 tool_result 就把归属交接过去。
  await page.locator(".composer textarea").fill("工具中引导测试");
  await page.locator(".composer textarea").press("Enter");
  // 第一轮的工具调用已经在跑了，这时候才引导，复刻“插进正在跑的那一轮”。
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.message.assistant[data-status="running"]')]
      .some((message) => (message.textContent ?? "").includes("src/before.ts"))
  ), undefined, { timeout: 25_000 });
  await page.locator(".composer textarea").fill("顺手把 guided 那个文件也改一下");
  await page.locator(".composer textarea").press("Enter");
  const handoffPrompt = page.locator(".prompt-queue-item", { hasText: "顺手把 guided" });
  await handoffPrompt.waitFor();
  await handoffPrompt.locator(".guide-prompt").click();
  await page.waitForFunction(() => !document.querySelector(".prompt-queue-item"));
  // 交接之后：上一轮正常收尾，引导的那一轮接手剩下的输出并自己结束。
  await page.waitForFunction(() => {
    const assistants = [...document.querySelectorAll(".message.assistant")];
    const guided = assistants.at(-1);
    return guided?.getAttribute("data-status") === "done" && (guided.textContent ?? "").includes("引导的提示已经处理完");
  }, undefined, { timeout: 30_000 });
  const handoffBubbles = await page.locator(".conversation .message").evaluateAll((messages) => messages.map((message) => ({
    role: message.classList.contains("user") ? "user" : "assistant",
    status: message.getAttribute("data-status"),
    text: message.textContent ?? "",
  })));
  const guidedIndex = handoffBubbles.findIndex((bubble) => bubble.role === "user" && bubble.text.includes("顺手把 guided"));
  if (guidedIndex < 0) throw new Error("引导的提问没有留在对话里");
  const guidedBubble = handoffBubbles[guidedIndex + 1];
  const previousBubble = [...handoffBubbles.slice(0, guidedIndex)].reverse().find((bubble) => bubble.role === "assistant");
  if (!guidedBubble || guidedBubble.role !== "assistant") throw new Error("引导的提问后面没有属于它的回答气泡");
  if (!previousBubble) throw new Error("找不到被引导打断的那条回答");
  // 手上那次没跑完的工具调用仍属于上一条回答，分界点之后的工具调用必须算到引导的气泡上。
  if (!previousBubble.text.includes("src/before.ts") || previousBubble.text.includes("src/guided.ts")) {
    throw new Error(`交接前的工具调用归属不对：${JSON.stringify(previousBubble)}`);
  }
  if (!guidedBubble.text.includes("src/guided.ts")) {
    throw new Error(`引导之后的工具调用没有算到引导的气泡上：${JSON.stringify(guidedBubble)}`);
  }
  if (previousBubble.status !== "done") {
    throw new Error(`被引导打断的那条回答没有正常收尾：${JSON.stringify(previousBubble)}`);
  }
  // 交接过的轮次是被真的回答了，不能再报成“并进上一条回答”。
  if (guidedBubble.text.includes("并进上一条回答")) {
    throw new Error(`交接过的引导轮次被误判成折叠：${JSON.stringify(guidedBubble)}`);
  }
  if (await page.locator(".message.assistant .queued-hint").count() !== 0) {
    throw new Error("交接之后引导的气泡还挂着「已插入当前任务」");
  }
  await page.screenshot({ path: resolve(artifacts, "workflow-guided-handoff.png") });
  await page.waitForFunction(() => document.querySelectorAll(".send-button.stop").length === 0, undefined, { timeout: 25_000 });

  // 回归：排队/引导进去的轮次里弹出的提问和授权框，过去点「提交回答」「取消」「允许」都会得到
  // 「Claude CLI 没有接受…」：事件带的是轮次 run id，主进程只认进程 run id，回复永远找不到进程；
  // 对话框还会一直挂着（CLI 活着在等答案），用户除了重启没有别的出路。这里把回答、取消、授权
  // 三种控件都在追加轮次里走一遍。「计划交互问题测试」分支要求进程以计划模式、高思考强度启动，
  // 先把两者设好，跑完再还原。
  await page.locator(".permission-select .composer-select-trigger").click();
  const permissionModeBeforeAppendedQuestion = (await page.locator('.permission-select .composer-select-option[aria-selected="true"]').getAttribute("data-value")) ?? "acceptEdits";
  await page.locator('.permission-select .composer-select-option[data-value="plan"]').click();
  await page.locator(".effort-select .composer-select-trigger").click();
  const effortBeforeAppendedQuestion = (await page.locator('.effort-select .composer-select-option[aria-selected="true"]').getAttribute("data-value")) ?? "auto";
  await page.locator('.effort-select .composer-select-option[data-value="high"]').click();
  const guideIntoAppendedTurn = async (guidedPrompt) => {
    await page.locator(".composer textarea").fill("计划交互引导测试");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector('.message.assistant[data-status="running"]');
    await page.locator(".composer textarea").fill(guidedPrompt);
    await page.locator(".composer textarea").press("Enter");
    const queuedGuidedPrompt = page.locator(".prompt-queue-item", { hasText: guidedPrompt });
    await queuedGuidedPrompt.waitFor();
    await queuedGuidedPrompt.locator(".guide-prompt").click();
    await page.waitForFunction(() => !document.querySelector(".prompt-queue-item"));
  };
  const finishAppendedTurn = async (expectedText, failure) => {
    await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done", undefined, { timeout: 15_000 });
    if (!(await page.locator(".message.assistant").last().textContent())?.includes(expectedText)) throw new Error(failure);
    await page.waitForFunction(() => document.querySelectorAll(".send-button.stop").length === 0, undefined, { timeout: 25_000 });
  };

  // 1. 追加轮次里回答提问：答案必须真的送到 CLI（假 CLI 收到答案后才会回显「你选择了」）。
  await guideIntoAppendedTurn("计划交互问题测试");
  await page.waitForSelector(".user-question-dialog", { timeout: 15_000 });
  if (!(await page.locator(".user-question-dialog").textContent())?.includes("最终交付几份文稿？")) {
    throw new Error("appended turn did not show the interactive question dialog");
  }
  await page.screenshot({ path: resolve(artifacts, "workflow-appended-question.png") });
  await page.locator(".user-question-option", { hasText: "按章节拆分" }).click();
  await page.locator(".user-question-dialog .permission-button.primary").click();
  await page.waitForSelector(".user-question-dialog", { state: "detached", timeout: 10_000 });
  await finishAppendedTurn("你选择了：按章节拆分", "answer to a question raised in an appended turn did not reach Claude CLI");

  // 2. 追加轮次里取消提问：取消也是一条真实的控制响应，CLI 收到后按「跳过」继续往下跑。
  await guideIntoAppendedTurn("计划交互问题测试");
  await page.waitForSelector(".user-question-dialog", { timeout: 15_000 });
  await page.locator(".user-question-dialog .permission-button.secondary").click();
  await page.waitForSelector(".user-question-dialog", { state: "detached", timeout: 10_000 });
  await finishAppendedTurn("问题被跳过了", "cancelling a question raised in an appended turn did not reach Claude CLI");
  // 3. 追加轮次里授权：直连权限框走同一条回复通道，同样必须按进程 run id 送达。
  await guideIntoAppendedTurn("直连权限测试");
  await page.waitForSelector(".permission-dialog", { timeout: 15_000 });
  if (!(await page.locator(".permission-dialog").textContent())?.includes("PowerShell")) {
    throw new Error("appended turn did not show the direct permission dialog");
  }
  await page.locator(".permission-allow-conversation").click();
  await page.waitForSelector(".permission-dialog", { state: "detached", timeout: 10_000 });
  await finishAppendedTurn("两条命令都执行完了", "permission granted in an appended turn did not reach Claude CLI");

  // 还原模式和思考强度，后面的用例按原来的状态跑。
  await page.locator(".permission-select .composer-select-trigger").click();
  await page.locator(`.permission-select .composer-select-option[data-value="${permissionModeBeforeAppendedQuestion}"]`).click();
  await page.locator(".effort-select .composer-select-trigger").click();
  await page.locator(`.effort-select .composer-select-option[data-value="${effortBeforeAppendedQuestion}"]`).click();

  // 回归：Claude 还在输出时重命名对话，过去会静默失败——界面和 session 文件都不变。现在界面立刻改名，
  // 文件要等进程退出才补写，避免插一行把 CLI 正在写的那条记录切断。
  const activeConversationTitle = await page.locator(".task-heading h2").textContent();
  const openActiveRenameEditor = async () => {
    await inFolder(page, '.task-row.active .task-rename[title="重命名对话"]').evaluate((button) => button.click());
    await page.locator('input[aria-label="对话名称"]').waitFor();
  };
  await page.locator(".composer textarea").fill("运行中改名测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"]');
  const activeSessionId = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")
    .flatMap((project) => project.conversations)
    .find((conversation) => conversation.title === document.querySelector(".task-heading h2")?.textContent)?.sessionId);
  if (!activeSessionId) throw new Error("运行中的对话没有 session id，重命名回归无法验证");
  const renameWhileRunningSession = resolve(cliSessions, `${activeSessionId}.jsonl`);
  // 界面在进程启动的那一刻就标成运行中，假 CLI 要等收到 stdin 才落历史，先等文件真的出现。
  const readRenameSession = async () => readFile(renameWhileRunningSession, "utf8").catch(() => "");
  for (let attempt = 0; !(await readRenameSession()).includes("运行中改名测试"); attempt += 1) {
    if (attempt >= 60) throw new Error("假 CLI 没有为运行中改名测试写出 session 历史");
    await page.waitForTimeout(50);
  }
  await openActiveRenameEditor();
  await page.locator('input[aria-label="对话名称"]').fill("运行中改的名字");
  await page.locator('input[aria-label="对话名称"]').press("Enter");
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "运行中改的名字");
  if (await inFolder(page, ".task-row.active strong").textContent() !== "运行中改的名字") {
    throw new Error("运行中的重命名没有同步到侧边栏");
  }
  if (await page.locator('.message.assistant[data-status="running"]').count() !== 1) {
    throw new Error("重命名把正在运行的回答收尾了");
  }
  if ((await readRenameSession()).includes("运行中改的名字")) {
    throw new Error("运行中的重命名被直接写进了 Claude 正在追加的 session 文件");
  }
  await page.waitForFunction(() => document.querySelectorAll(".send-button.stop").length === 0, undefined, { timeout: 25_000 });
  for (let attempt = 0; ; attempt += 1) {
    if ((await readRenameSession()).includes('"customTitle":"运行中改的名字"')) break;
    if (attempt >= 60) throw new Error("进程退出后没有把运行中改的名字补写进 Claude CLI 历史");
    await page.waitForTimeout(100);
  }
  // 改回原来的名字：后面的用例还按原名找这个对话。这次不在运行中，必须立刻落盘。
  await openActiveRenameEditor();
  await page.locator('input[aria-label="对话名称"]').fill(activeConversationTitle);
  await page.locator('input[aria-label="对话名称"]').press("Enter");
  await page.waitForFunction((expected) => document.querySelector(".task-heading h2")?.textContent === expected, activeConversationTitle);

  // 回归：超长提问默认折叠，展开按钮把它放回全高。
  const longPromptText = `运行中改名测试补充说明：\n${Array.from({ length: 22 }, (item, index) => `第 ${index + 1} 行需求细节。`).join("\n")}`;
  await page.locator(".composer textarea").fill(longPromptText);
  await page.locator(".composer textarea").press("Enter");
  const longBubble = page.locator(".message.user", { hasText: "运行中改名测试补充说明" }).last();
  await longBubble.locator(".user-message-fold").waitFor();
  const collapsedLongPrompt = await longBubble.locator(".user-message-text").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  if (collapsedLongPrompt.clientHeight >= collapsedLongPrompt.scrollHeight - 2) {
    throw new Error(`超长提问没有被默认折叠：${JSON.stringify(collapsedLongPrompt)}`);
  }
  await longBubble.locator(".user-message-fold").click();
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll(".message.user")]
      .reverse()
      .find((element) => element.textContent?.includes("运行中改名测试补充说明"))
      ?.querySelector(".user-message-text");
    return text && !text.classList.contains("collapsed") && text.clientHeight >= text.scrollHeight - 2;
  });
  await page.waitForFunction(() => document.querySelectorAll(".send-button.stop").length === 0, undefined, { timeout: 25_000 });

  await inFolder(page, ".task-select", { hasText: "来自终端的历史对话" }).click();
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "来自终端的历史对话");
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(artifacts, "workflow-complete.png") });
  const localSessionPath = resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl");
  const localSessionBeforeRestart = await readFile(localSessionPath, "utf8");
  await writeFile(
    localSessionPath,
    localSessionBeforeRestart.replaceAll('"entrypoint":"cli"', '"entrypoint":"sdk-cli"').replaceAll('"promptSource":"typed"', '"promptSource":"sdk"'),
    "utf8",
  );
  await electronApp.close();
  electronApp = undefined;
  const projectStore = JSON.parse(await readFile(resolve(profile, "projects.json"), "utf8"));
  if (!Array.isArray(projectStore) || projectStore.length !== 1 || projectStore[0]?.conversations?.length !== 7) {
    throw new Error("main-process project store was not written");
  }
  const persistedSettings = JSON.parse(await readFile(resolve(profile, "settings.json"), "utf8"));
  if (
    persistedSettings.closeBehavior !== "tray" ||
    persistedSettings.notifyOnCompletion !== true ||
    persistedSettings.ignoredUpdateVersion !== updateVersion
  ) {
    throw new Error("background settings were not persisted by the main process");
  }
  const persistedSelection = JSON.parse(await readFile(resolve(profile, "selection.json"), "utf8"));
  if (persistedSelection.projectId !== projectStore[0].id || persistedSelection.conversationId !== `claude-${importedSessionId}`) {
    throw new Error(`active project/conversation selection was not persisted: ${JSON.stringify(persistedSelection)}`);
  }
  await rm(resolve(profile, "Local Storage"), { recursive: true, force: true });

  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForSelector(".project-group");
  useLegacyUpdateManifest = false;
  await waitForAsyncCondition(page, async (version) => (await window.claudeDesk.getAppSettings()).ignoredUpdateVersion === version, updateVersion);
  const ignoredUpdateState = await page.evaluate(() => window.claudeDesk.checkAppUpdate());
  if (ignoredUpdateState.phase !== "available" || ignoredUpdateState.latestVersion !== updateVersion) {
    throw new Error(`ignored update version was not discovered: ${JSON.stringify(ignoredUpdateState)}`);
  }
  await page.waitForTimeout(250);
  if (await page.locator(".update-dialog").count()) throw new Error("ignored update version prompted again after restart");
  await page.locator(".settings-trigger[data-panel=\"settings\"]").click();
  await page.locator(".setting-update-button").click();
  await page.waitForSelector(".update-dialog");
  await page.locator(".update-later-button").click();
  await page.waitForSelector(".update-dialog", { state: "detached" });
  await page.locator(".settings-trigger[data-panel=\"settings\"]").click();
  useLegacyUpdateManifest = true;
  const newerUpdateState = await page.evaluate(() => window.claudeDesk.checkAppUpdate());
  if (newerUpdateState.phase !== "available" || newerUpdateState.latestVersion !== legacyUpdateVersion) {
    throw new Error(`newer update version was not discovered after ignoring an older version: ${JSON.stringify(newerUpdateState)}`);
  }
  await page.waitForSelector(".update-dialog");
  await page.locator(".update-later-button").click();
  await page.waitForSelector(".update-dialog", { state: "detached" });
  await waitForAsyncCondition(page, async () => {
    const project = JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0];
    const conversation = project?.conversations?.find((item) => item.sessionId === "22222222-2222-4222-8222-222222222222");
    return Boolean(conversation);
  });
  await page.waitForTimeout(300);
  const localSessionAfterRestart = await readFile(localSessionPath, "utf8");
  if (localSessionAfterRestart.includes('"entrypoint":"sdk-cli"') || localSessionAfterRestart.includes('"promptSource":"sdk"')) {
    throw new Error("existing local UI session was not migrated for the CLI resume picker");
  }
  if (await page.locator(".project-group").count() !== 1 || await page.locator(".project-conversations .task-row").count() !== 7) {
    throw new Error("project/conversation hierarchy did not survive restart");
  }
  if (await page.locator(".project-name strong").textContent() !== "我的 Claude 项目" || await page.locator(".project-name small").textContent() !== workspaceDirectoryName) {
    throw new Error("project name mapping did not survive restart");
  }
  if (await page.locator('.message.assistant[data-status="running"]').count()) throw new Error("running state survived restart");
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "来自终端的历史对话");
  if (await inFolder(page, ".task-row.active", { hasText: "来自终端的历史对话" }).count() !== 1) {
    throw new Error("last active conversation was not restored after restart");
  }
  await inFolder(page, ".task-select", { hasText: "来自终端的历史对话" }).click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "来自终端的历史对话");
  if (await page.locator(".markdown", { hasText: "恢复的回答" }).count() === 0) throw new Error("CLI session was not reloaded after restart");

  const localConversationRow = inFolder(page, ".task-row").filter({ has: page.getByText("CLI 外部改名", { exact: true }) });
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    globalThis.__deleteFocusCalls = 0;
    const focus = window.focus.bind(window);
    window.focus = () => {
      globalThis.__deleteFocusCalls += 1;
      focus();
    };
  });
  await localConversationRow.locator(".task-delete").evaluate((button) => button.click());
  await page.locator(".delete-confirm-dialog").waitFor();
  await page.locator(".delete-confirm-button.secondary").click();
  await page.locator(".delete-confirm-dialog").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.matches(".composer textarea"));
  await page.keyboard.type("取消删除后焦点测试");
  if (await page.locator(".composer textarea").inputValue() !== "取消删除后焦点测试") {
    throw new Error("composer did not accept keyboard input after canceling conversation deletion");
  }
  await page.locator(".composer textarea").fill("");
  if (await localConversationRow.count() !== 1) throw new Error("canceling deletion removed the conversation");

  await localConversationRow.locator(".task-delete").evaluate((button) => button.click());
  await page.locator(".delete-confirm-button.danger").click();
  await localConversationRow.waitFor({ state: "detached" });
  if (await electronApp.evaluate(() => globalThis.__deleteFocusCalls) < 1) {
    throw new Error("deleting a conversation did not restore the native window focus");
  }
  await page.waitForFunction(() => document.activeElement?.matches(".composer textarea"));
  await page.keyboard.type("删除后当前会话焦点测试");
  if (await page.locator(".composer textarea").inputValue() !== "删除后当前会话焦点测试") {
    throw new Error("composer did not accept keyboard input immediately after deleting another conversation");
  }
  await page.locator(".composer textarea").fill("");
  await refreshProjectSessions(page);
  if (await page.locator(".task-row strong").filter({ hasText: /^CLI 外部改名$/ }).count()) throw new Error("deleted UI-created session returned after refresh");
  const deletedLocalSessionStillExists = await readFile(localSessionPath, "utf8").then(() => true, () => false);
  if (deletedLocalSessionStillExists) throw new Error("deleted UI-created session remained in Claude CLI history");

  await inFolder(page, ".task-row strong").filter({ hasText: /^CLI 外部改名 \(2\)$/ }).click();
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "CLI 外部改名 (2)");
  await page.waitForFunction(() => document.activeElement?.matches(".composer textarea"));
  await page.keyboard.type("删除后切换会话焦点测试");
  if (await page.locator(".composer textarea").inputValue() !== "删除后切换会话焦点测试") {
    throw new Error("composer did not accept keyboard input after deleting and switching conversations");
  }
  await page.locator(".composer textarea").fill("");

  await page.locator(".project-row").first().hover();
  await page.locator('.project-action[title="新建对话"]').click();
  await page.waitForSelector(".conversation-intro");
  await page.waitForFunction(() => document.activeElement?.matches(".composer textarea"));
  await page.keyboard.type("删除后新建会话焦点测试");
  if (await page.locator(".composer textarea").inputValue() !== "删除后新建会话焦点测试") {
    throw new Error("composer did not accept keyboard input after deleting and creating a conversation");
  }
  await inFolder(page, ".task-row.active .task-delete").evaluate((button) => button.click());
  await page.locator(".delete-confirm-button.danger").click();
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 6);
  await page.waitForSelector(".project-row.active");
  if (await page.locator(".task-row.active").count() !== 0 || await page.locator(".composer").count() !== 0 || await page.locator(".project-empty-view").count() !== 1) {
    throw new Error("deleting the active conversation did not leave its project selected without opening another conversation");
  }
  await waitForAsyncCondition(page, async () => (await window.claudeDesk.getAppSelection()).conversationId === null);

  await electronApp.close();
  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForSelector(".project-row.active");
  if (await page.locator(".task-row.active").count() !== 0 || await page.locator(".project-empty-view").count() !== 1) {
    throw new Error("project-only selection was not restored after restart");
  }

  await page.evaluate(() => window.claudeDesk.saveAppSelection({ projectId: "missing-project", conversationId: "missing-conversation" }));
  await page.waitForTimeout(100);
  await electronApp.close();
  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForSelector(".task-row.active");
  if (await inFolder(page, ".task-row.active").count() !== 1 || await page.locator(".composer").count() !== 1) {
    throw new Error("missing saved project did not fall back to the first available conversation");
  }

  await page.evaluate(() => {
    const projectKey = "claude-desk.projects.v2";
    const legacyKey = "claude-desk.tasks.v1";
    const now = Date.now();
    const originalSetItem = Storage.prototype.setItem;
    localStorage.removeItem(projectKey);
    originalSetItem.call(localStorage, legacyKey, JSON.stringify([
      { id: "legacy-1", title: "旧对话一", workspace: "C:\\Projects\\legacy", createdAt: now, updatedAt: now, messages: [], permissionMode: "acceptEdits" },
      { id: "legacy-2", title: "旧对话二", workspace: "C:\\Projects\\legacy", createdAt: now, updatedAt: now, messages: [], permissionMode: "plan" },
    ]));
    Storage.prototype.setItem = function setItem(key, value) {
      if (key !== projectKey) originalSetItem.call(this, key, value);
    };
    location.reload();
  });
  await page.waitForSelector(".project-group");
  if (await page.locator(".project-group").count() !== 1 || await page.locator(".project-conversations .task-row").count() !== 2) {
    throw new Error("legacy tasks were not grouped by workspace");
  }

  await page.evaluate(() => {
    const key = "claude-desk.projects.v2";
    const originalSetItem = Storage.prototype.setItem;
    originalSetItem.call(localStorage, key, "{broken-json");
    Storage.prototype.setItem = function setItem(storageKey, value) {
      if (storageKey !== key) originalSetItem.call(this, storageKey, value);
    };
    location.reload();
  });
  await page.waitForSelector(".project-group");
  if (await page.locator(".fatal-error").count()) throw new Error("corrupt project data reached the error boundary");

  await electronApp.close();
  electronApp = undefined;
  const orderingNow = Date.now();
  const orderingConversation = (id, title, age) => ({
    id,
    title,
    createdAt: orderingNow - age,
    updatedAt: orderingNow - age,
    messages: [],
    permissionMode: "acceptEdits",
  });
  const orderingProjects = [{
    id: "order-project-a",
    name: "排序项目 A",
    workspace: profile,
    createdAt: orderingNow - 9_000,
    updatedAt: orderingNow - 1_000,
    conversations: [
      orderingConversation("order-conversation-a", "排序会话 A", 3_000),
      orderingConversation("order-conversation-b", "排序会话 B", 1_000),
      orderingConversation("order-conversation-c", "排序会话 C", 2_000),
    ],
  }, {
    id: "order-project-b",
    name: "排序项目 B",
    workspace: claudeConfig,
    createdAt: orderingNow - 8_000,
    updatedAt: orderingNow - 2_000,
    conversations: [orderingConversation("order-conversation-d", "排序会话 D", 4_000)],
  }, {
    id: "order-project-c",
    name: "排序项目 C",
    workspace: profile,
    createdAt: orderingNow - 7_000,
    updatedAt: orderingNow - 3_000,
    conversations: [orderingConversation("order-conversation-e", "排序会话 E", 5_000)],
  }];
  await writeFile(resolve(profile, "projects.json"), JSON.stringify(orderingProjects), "utf8");
  await writeFile(resolve(profile, "selection.json"), JSON.stringify({
    projectId: "order-project-a",
    conversationId: "order-conversation-a",
  }), "utf8");
  await rm(resolve(profile, "Local Storage"), { recursive: true, force: true });
  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForFunction(() => document.querySelectorAll(".project-group").length === 3);

  // 回归：启动时只展开当前对话所在的项目。项目和对话一多，全展开的侧栏要滚很久才能找到东西，
  // 所以除了活动项目（order-project-a）以外都应该是收起状态。
  const startupFolds = await page.evaluate(() => [...document.querySelectorAll(".project-group")].map((group) => ({
    id: group.getAttribute("data-project-id"),
    expanded: Boolean(group.querySelector(".project-conversations")),
  })));
  if (JSON.stringify(startupFolds) !== JSON.stringify([
    { id: "order-project-a", expanded: true },
    { id: "order-project-b", expanded: false },
    { id: "order-project-c", expanded: false },
  ])) throw new Error(`启动时的项目展开状态不对，应只展开活动对话所在的项目：${JSON.stringify(startupFolds)}`);

  // 「临时对话」段取代了原来的「全部对话」：没有临时对话时只显示空状态和新建入口，
  // 不再把每个会话在侧边栏里重复渲染一遍。
  if (await page.locator('[data-section="all"]').count()) {
    throw new Error("the removed all-conversations section is still rendered");
  }
  if (await page.locator('[data-section="scratch"] .task-row').count()) {
    throw new Error("scratch section listed conversations that belong to real projects");
  }
  if (!(await page.locator('[data-section="scratch"] .task-list-empty').count())) {
    throw new Error("scratch section did not show its empty hint before any temporary conversation existed");
  }
  if (!(await page.locator('[data-section="pinned"] .task-list-empty').count())) {
    throw new Error("pinned section did not show its empty hint before anything was pinned");
  }

  // data-project-id 现在同时挂在项目组和会话行上，选择器必须限定到 .project-group，否则 Playwright 严格模式会报歧义。
  const projectA = page.locator('.project-group[data-project-id="order-project-a"]');
  const projectB = page.locator('.project-group[data-project-id="order-project-b"]');
  const projectC = page.locator('.project-group[data-project-id="order-project-c"]');
  const pinnedSectionLabel = page.locator('[data-section-label="pinned"]');
  const projectsSectionLabel = page.locator('[data-section-label="projects"]');
  const expandProjects = projectsSectionLabel.getByRole("button", { name: "展开项目分组的所有项目", exact: true });
  const collapseProjects = projectsSectionLabel.getByRole("button", { name: "收起项目分组的所有项目", exact: true });
  const expandPinned = pinnedSectionLabel.getByRole("button", { name: "展开置顶分组的所有项目", exact: true });
  const collapsePinned = pinnedSectionLabel.getByRole("button", { name: "收起置顶分组的所有项目", exact: true });
  if (!(await expandPinned.isDisabled()) || !(await collapsePinned.isDisabled())) {
    throw new Error("空置顶分组的批量操作应禁用");
  }
  if (await page.locator('[data-section-label="scratch"] .sidebar-section-projects-action').count()) {
    throw new Error("临时对话没有项目，不应出现批量项目操作");
  }
  const waitForProjectFolds = (pinned, projects) => page.waitForFunction(({ pinned, projects }) => (
    document.querySelectorAll('[data-section="pinned"] .project-conversations').length === pinned &&
    document.querySelectorAll('[data-section="projects"] .project-conversations').length === projects
  ), { pinned, projects });

  // 批量操作只改变项目树，不关闭活动对话、不清空输入中的草稿。
  const foldDraft = "批量收起仍保留的草稿";
  await page.locator(".composer textarea").fill(foldDraft);
  const foldHeading = await page.locator(".task-heading h2").textContent();
  await collapseProjects.click();
  await collapseProjects.click();
  await waitForProjectFolds(0, 0);
  if (await page.locator(".project-group").count() !== 3 ||
    await page.locator(".task-heading h2").textContent() !== foldHeading ||
    await page.locator(".composer textarea").inputValue() !== foldDraft) {
    throw new Error("批量收起隐藏了项目行、关闭了活动对话或清空了草稿");
  }
  // 更新活动项目的标题会触发新的 projects 引用，不能因此把刚收起的项目自动展开。
  await projectA.locator(".project-row").hover();
  await projectA.locator('[title="重命名项目"]').click();
  await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("批量折叠回归测试");
  await page.getByRole("textbox", { name: "项目名称", exact: true }).press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-project-id="order-project-a"] .project-name strong')?.textContent === "批量折叠回归测试");
  await waitForProjectFolds(0, 0);
  await projectA.locator(".project-row").hover();
  await projectA.locator('[title="重命名项目"]').click();
  await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("排序项目 A");
  await page.getByRole("textbox", { name: "项目名称", exact: true }).press("Enter");
  await expandProjects.click();
  await expandProjects.click();
  await waitForProjectFolds(0, 3);
  if (await projectA.locator(".task-row.active").getAttribute("data-conversation-id") !== "order-conversation-a" ||
    await page.locator(".composer textarea").inputValue() !== foldDraft) {
    throw new Error("全部展开改变了活动对话或草稿");
  }
  await page.locator(".composer textarea").fill("");

  await reorderDrag(projectC, ".project-drag-handle", projectA.locator(".project-row"), { x: 24, y: 2 });
  await page.waitForFunction(() => (
    [...document.querySelectorAll('[data-section="projects"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") ===
    "order-project-c,order-project-a,order-project-b"
  ));

  // 置顶项目整个搬进「置顶」段，并从「项目」段消失。
  await projectB.locator(".project-row").hover();
  await projectB.locator('[title="置顶项目"]').click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll('[data-section="pinned"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") === "order-project-b" &&
    [...document.querySelectorAll('[data-section="projects"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") === "order-project-c,order-project-a" &&
    document.querySelector('.project-group[data-project-id="order-project-b"]')?.getAttribute("data-pinned") === "true"
  ));

  // 跨段排序已取消，改置顶/取消置顶一律靠拖到段标题完成。
  await pinnedSectionLabel.scrollIntoViewIfNeeded();
  await reorderDrag(projectA, ".project-drag-handle", pinnedSectionLabel, { x: 24, y: 2 });
  await page.waitForFunction(() => (
    [...document.querySelectorAll('[data-section="pinned"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") === "order-project-a,order-project-b" &&
    [...document.querySelectorAll('[data-section="projects"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") === "order-project-c" &&
    document.querySelector('.project-group[data-project-id="order-project-a"]')?.getAttribute("data-pinned") === "true"
  ));
  // 两个分组互不影响；展开隐藏分组时也应恢复分组本身，不需要额外点标题。
  await collapsePinned.click();
  await waitForProjectFolds(0, 1);
  await collapseProjects.click();
  await waitForProjectFolds(0, 0);
  await pinnedSectionLabel.locator(".sidebar-section-toggle").click();
  await page.locator('[data-section="pinned"]').waitFor({ state: "detached" });
  await expandPinned.click();
  await waitForProjectFolds(2, 0);
  await collapsePinned.click();
  await waitForProjectFolds(0, 0);
  await projectsSectionLabel.locator(".sidebar-section-toggle").click();
  await page.locator('[data-section="projects"]').waitFor({ state: "detached" });
  await expandProjects.click();
  await waitForProjectFolds(0, 1);
  await expandPinned.click();
  await waitForProjectFolds(2, 1);

  await reorderDrag(projectA, ".project-drag-handle", projectsSectionLabel, { x: 24, y: 2 });
  await page.waitForFunction(() => (
    [...document.querySelectorAll('[data-section="pinned"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") === "order-project-b" &&
    [...document.querySelectorAll('[data-section="projects"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") === "order-project-a,order-project-c" &&
    document.querySelector('.project-group[data-project-id="order-project-a"]')?.getAttribute("data-pinned") === "false"
  ));
  await reorderDrag(projectA, ".project-drag-handle", pinnedSectionLabel, { x: 24, y: 2 });
  await page.waitForFunction(() => (
    [...document.querySelectorAll('[data-section="pinned"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")).join(",") === "order-project-a,order-project-b" &&
    document.querySelector('.project-group[data-project-id="order-project-a"]')?.getAttribute("data-pinned") === "true"
  ));

  const conversationA = projectA.locator('[data-conversation-id="order-conversation-a"]');
  const conversationB = projectA.locator('[data-conversation-id="order-conversation-b"]');
  const conversationC = projectA.locator('[data-conversation-id="order-conversation-c"]');
  await reorderDrag(conversationC, ".task-drag-handle", conversationA, { x: 24, y: 2 });
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.project-group[data-project-id="order-project-a"] .task-row')]
      .map((element) => element.getAttribute("data-conversation-id")).join(",") ===
    "order-conversation-c,order-conversation-a,order-conversation-b"
  ));

  await conversationB.hover();
  await conversationB.locator('[title="置顶会话"]').click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.project-group[data-project-id="order-project-a"] .task-row')]
      .map((element) => element.getAttribute("data-conversation-id")).join(",") ===
      "order-conversation-b,order-conversation-c,order-conversation-a" &&
    document.querySelector('.project-group[data-project-id="order-project-a"] [data-conversation-id="order-conversation-b"]')
      ?.getAttribute("data-pinned") === "true"
  ));

  await reorderDrag(conversationA, ".task-drag-handle", conversationB, { x: 24, y: 2 });
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.project-group[data-project-id="order-project-a"] .task-row')]
      .map((element) => element.getAttribute("data-conversation-id")).join(",") ===
      "order-conversation-a,order-conversation-b,order-conversation-c" &&
    document.querySelector('.project-group[data-project-id="order-project-a"] [data-conversation-id="order-conversation-a"]')
      ?.getAttribute("data-pinned") === "true"
  ));
  await reorderDrag(conversationA, ".task-drag-handle", conversationC, { x: 24, y: 32 });
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.project-group[data-project-id="order-project-a"] .task-row')]
      .map((element) => element.getAttribute("data-conversation-id")).join(",") ===
      "order-conversation-b,order-conversation-c,order-conversation-a" &&
    document.querySelector('.project-group[data-project-id="order-project-a"] [data-conversation-id="order-conversation-a"]')
      ?.getAttribute("data-pinned") === "false"
  ));

  // 未置顶项目里的会话一旦置顶，就从原文件夹搬到置顶段，只在一处出现。
  const conversationE = projectC.locator('[data-conversation-id="order-conversation-e"]');
  await conversationE.hover();
  await conversationE.locator('[title="置顶会话"]').click();
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-section="pinned"] .loose-conversations [data-conversation-id="order-conversation-e"]').length === 1 &&
    document.querySelectorAll('.project-group[data-project-id="order-project-c"] [data-conversation-id="order-conversation-e"]').length === 0
  ));
  const looseConversationE = page.locator('[data-section="pinned"] .loose-conversations [data-conversation-id="order-conversation-e"]');
  await looseConversationE.hover();
  await looseConversationE.locator('[title="取消置顶会话"]').click();
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-section="pinned"] .loose-conversations [data-conversation-id="order-conversation-e"]').length === 0 &&
    document.querySelectorAll('.project-group[data-project-id="order-project-c"] [data-conversation-id="order-conversation-e"]').length === 1
  ));

  const dragGapAcceptance = await page.evaluate(() => {
    const dispatchGapDrag = (handle, target, clientY) => {
      const dataTransfer = new DataTransfer();
      handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
      const dragOverEvent = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY,
        dataTransfer,
      });
      target.dispatchEvent(dragOverEvent);
      handle.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
      return dragOverEvent.defaultPrevented;
    };
    const projectList = document.querySelector('[data-section="pinned"]');
    const projectLabel = document.querySelector('[data-section-label="pinned"]');
    const settingsTrigger = document.querySelector('.settings-trigger[data-panel="settings"]');
    const projectHandle = document.querySelector('.project-group[data-project-id="order-project-a"] .project-drag-handle');
    const conversationList = document.querySelector('.project-group[data-project-id="order-project-a"] .project-conversations');
    const conversationHandle = document.querySelector('.project-group[data-project-id="order-project-a"] [data-conversation-id="order-conversation-a"] .task-drag-handle');
    if (!projectList || !projectLabel || !settingsTrigger || !projectHandle || !conversationList || !conversationHandle) return null;
    return {
      project: dispatchGapDrag(projectHandle, projectList, projectList.getBoundingClientRect().bottom - 2),
      projectLabel: dispatchGapDrag(projectHandle, projectLabel, projectLabel.getBoundingClientRect().top + 2),
      projectOutsideSortArea: dispatchGapDrag(projectHandle, settingsTrigger, settingsTrigger.getBoundingClientRect().top + 2),
      conversation: dispatchGapDrag(conversationHandle, conversationList, conversationList.getBoundingClientRect().bottom - 2),
    };
  });
  if (
    !dragGapAcceptance?.project ||
    !dragGapAcceptance.projectLabel ||
    !dragGapAcceptance.projectOutsideSortArea ||
    !dragGapAcceptance.conversation
  ) {
    throw new Error(`dragging over list gaps still used a forbidden drop target: ${JSON.stringify(dragGapAcceptance)}`);
  }

  await projectA.locator(".project-row").hover();
  await projectA.locator('[title="刷新 Claude CLI 会话"]').click();
  await page.waitForFunction(() => !document.querySelector('.project-group[data-project-id="order-project-a"] [title="刷新 Claude CLI 会话"]')?.hasAttribute("disabled"));
  const orderAfterRefresh = await projectA.locator(".task-row").evaluateAll((elements) => (
    elements.map((element) => element.getAttribute("data-conversation-id"))
  ));
  if (orderAfterRefresh.join(",") !== "order-conversation-b,order-conversation-c,order-conversation-a") {
    throw new Error(`refresh replaced the manual conversation order: ${orderAfterRefresh.join(",")}`);
  }

  await waitForAsyncCondition(page, async () => {
    const projects = await window.claudeDesk.getProjectStore();
    if (!Array.isArray(projects)) return false;
    const projectIds = projects.map((project) => project.id).join(",");
    const orderedProject = projects.find((project) => project.id === "order-project-a");
    const conversationIds = orderedProject?.conversations?.map((conversation) => conversation.id).join(",");
    return projectIds === "order-project-a,order-project-b,order-project-c" &&
      orderedProject?.pinned === true &&
      projects[1]?.pinned === true &&
      conversationIds === "order-conversation-b,order-conversation-c,order-conversation-a" &&
      orderedProject?.conversations?.[0]?.pinned === true;
  });

  await electronApp.close();
  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForFunction(() => document.querySelectorAll(".project-group").length === 3);
  const restoredOrder = await page.evaluate(() => ({
    projects: [...document.querySelectorAll(".project-group")].map((element) => element.getAttribute("data-project-id")),
    conversations: [...document.querySelectorAll('.project-group[data-project-id="order-project-a"] .task-row')]
      .map((element) => element.getAttribute("data-conversation-id")),
    projectAPinned: document.querySelector('.project-group[data-project-id="order-project-a"]')?.getAttribute("data-pinned"),
    projectBPinned: document.querySelector('.project-group[data-project-id="order-project-b"]')?.getAttribute("data-pinned"),
    conversationPinned: document.querySelector('.project-group[data-project-id="order-project-a"] [data-conversation-id="order-conversation-b"]')
      ?.getAttribute("data-pinned"),
    pinnedSectionProjects: [...document.querySelectorAll('[data-section="pinned"] .project-group')]
      .map((element) => element.getAttribute("data-project-id")),
    sections: [...document.querySelectorAll(".sidebar-section-label")].map((element) => element.getAttribute("data-section-label")),
  }));
  if (
    restoredOrder.projects.join(",") !== "order-project-a,order-project-b,order-project-c" ||
    restoredOrder.conversations.join(",") !== "order-conversation-b,order-conversation-c,order-conversation-a" ||
    restoredOrder.projectAPinned !== "true" ||
    restoredOrder.projectBPinned !== "true" ||
    restoredOrder.conversationPinned !== "true" ||
    restoredOrder.pinnedSectionProjects.join(",") !== "order-project-a,order-project-b" ||
    restoredOrder.sections.join(",") !== "pinned,projects,scratch"
  ) throw new Error(`project/conversation order or pin state did not survive restart: ${JSON.stringify(restoredOrder)}`);

  // 临时对话：不选文件夹也能直接开一次对话，它归在内建的「临时对话」分组下，
  // 不出现在「项目」段，并且能真的把 CLI 跑起来（cwd 是 userData 下的 scratch 目录）。
  await page.locator('[data-section-label="scratch"] .sidebar-section-action').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-section="scratch"] .task-row').length === 1);
  if (await page.locator(".project-group").count() !== 3) {
    throw new Error("the scratch group leaked into the project section");
  }
  const scratchGroupName = await page.locator(".workspace-chip strong").textContent();
  if (scratchGroupName !== "临时对话") throw new Error(`temporary conversation was not scoped to the scratch group: ${scratchGroupName}`);
  await page.locator(".composer textarea").fill("临时对话测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  // 项目持久化带 350ms 防抖，而且流式输出期间每次状态更新都会把它重置；刚收到 done 就立刻
  // 读存储只会读到这一轮开始前的快照，所以这里主动等落盘而不是断言一次。
  const readScratch = () => page.evaluate(async () => {
    const projects = await window.claudeDesk.getProjectStore();
    const scratch = Array.isArray(projects) ? projects.find((project) => project.kind === "scratch") : undefined;
    return {
      workspace: scratch?.workspace ?? "",
      conversations: scratch?.conversations?.length ?? 0,
      pinned: scratch?.pinned ?? null,
    };
  });
  let scratchRun = await readScratch();
  for (let attempt = 0; attempt < 50 && scratchRun.conversations !== 1; attempt += 1) {
    await page.waitForTimeout(100);
    scratchRun = await readScratch();
  }
  if (scratchRun.conversations !== 1 || !scratchRun.workspace.replace(/\\/g, "/").endsWith("/scratch")) {
    throw new Error(`temporary conversation was not persisted under the scratch workspace: ${JSON.stringify(scratchRun)}`);
  }
  // 临时对话分组不能被置顶：置顶会让同一批会话在「置顶」和「临时对话」两段里重复出现。
  if (scratchRun.pinned !== null) {
    throw new Error(`the scratch group accepted a pin state: ${JSON.stringify(scratchRun)}`);
  }

  await electronApp.close();
  electronApp = undefined;

  // 回归：一个项目里对话太多时侧栏默认只列 7 条，其余要点「展开」才出现。一个项目开近百个
  // 对话，全铺开单是这一个项目就能把侧栏占满，别的项目要翻很久才找得到。
  const crowdedNow = Date.now();
  const crowdedProjectId = "crowded-project";
  const crowdedConversationId = (index) => "crowded-conversation-" + index;
  await writeFile(resolve(profile, "projects.json"), JSON.stringify([{
    id: crowdedProjectId,
    name: "对话很多的项目",
    workspace: resolve(profile, "crowded-workspace"),
    createdAt: crowdedNow - 60_000,
    updatedAt: crowdedNow - 1_000,
    conversations: Array.from({ length: 10 }, (item, index) => ({
      id: crowdedConversationId(index + 1),
      title: "批量任务 " + (index + 1),
      createdAt: crowdedNow - (10 - index) * 1_000,
      updatedAt: crowdedNow - (10 - index) * 1_000,
      messages: [],
      permissionMode: "acceptEdits",
    })),
  }]), "utf8");
  // 打开的是第 9 个对话：它排在默认 7 条之外，仍然必须留在列表里并标成当前对话。
  await writeFile(resolve(profile, "selection.json"), JSON.stringify({
    projectId: crowdedProjectId,
    conversationId: crowdedConversationId(9),
  }), "utf8");
  await rm(resolve(profile, "Local Storage"), { recursive: true, force: true });
  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  const crowdedGroup = page.locator('.project-group[data-project-id="' + crowdedProjectId + '"]');
  await crowdedGroup.locator(".conversation-list-toggle").waitFor();
  const crowdedRowIds = () => crowdedGroup.locator(".task-row").evaluateAll((rows) => (
    rows.map((row) => row.getAttribute("data-conversation-id"))
  ));
  const crowdedToggleText = () => crowdedGroup.locator(".conversation-list-toggle").textContent();
  const expectedDefaultRows = [
    ...Array.from({ length: 7 }, (item, index) => crowdedConversationId(index + 1)),
    crowdedConversationId(9),
  ];
  const crowdedDefaultRows = await crowdedRowIds();
  if (crowdedDefaultRows.join(",") !== expectedDefaultRows.join(",") ||
    await crowdedToggleText() !== "展开其余 2 条对话") {
    throw new Error("对话过多的项目没有默认只列 7 条并带上当前对话：" + crowdedDefaultRows.join(",") + " / " + await crowdedToggleText());
  }
  if (await crowdedGroup.locator(".task-row.active").getAttribute("data-conversation-id") !== crowdedConversationId(9)) {
    throw new Error("排在默认条数之外的当前对话没有显示为活动行");
  }
  // 树形前缀跟着可见条数走：末行必须是 └─，中间几行不能画成末行。
  const crowdedDefaultBranches = await crowdedGroup.locator(".conversation-rows .tree-branch").evaluateAll((branches) => (
    branches.map((branch) => branch.textContent).join(",")
  ));
  if (crowdedDefaultBranches !== "├─,├─,├─,├─,├─,├─,├─,└─") {
    throw new Error("默认视图的树形前缀不对：" + crowdedDefaultBranches);
  }
  await crowdedGroup.locator(".conversation-list-toggle").click();
  await page.waitForFunction((projectId) => (
    document.querySelectorAll('.project-group[data-project-id="' + projectId + '"] .task-row').length === 10
  ), crowdedProjectId);
  if (await crowdedToggleText() !== "收起对话列表") {
    throw new Error("展开后没有留下收起入口：" + await crowdedToggleText());
  }
  // 收起项目再打开：回到默认条数，而不是接着铺满一屏。
  await crowdedGroup.locator(".project-toggle").click();
  await crowdedGroup.locator(".project-conversations").waitFor({ state: "detached" });
  await crowdedGroup.locator(".project-toggle").click();
  await crowdedGroup.locator(".conversation-list-toggle").waitFor();
  const crowdedReopenedRows = await crowdedRowIds();
  if (crowdedReopenedRows.join(",") !== expectedDefaultRows.join(",") ||
    await crowdedToggleText() !== "展开其余 2 条对话") {
    throw new Error("重新打开项目后没有回到默认条数：" + crowdedReopenedRows.join(","));
  }

  await electronApp.close();

  // 回归：渲染进程被 Chromium 或系统杀掉之后（整机内存吃紧时最常见），窗口会一直白着，而主进程和
  // Claude 子进程都还在跑。界面必须自己重载回来，而且不能把崩溃前的内容弄丢。
  // 这段用自己播种的存储跑，和前面的用例互不影响。
  const crashNow = Date.now();
  await writeFile(resolve(profile, "projects.json"), JSON.stringify([{
    id: "crash-project",
    name: "崩溃恢复",
    workspace: profile,
    createdAt: crashNow,
    updatedAt: crashNow,
    conversations: [{
      id: "crash-conversation",
      title: "崩溃恢复对话",
      createdAt: crashNow,
      updatedAt: crashNow,
      messages: [{ id: "crash-message", role: "user", content: "崩溃前的正文", createdAt: crashNow }],
      permissionMode: "acceptEdits",
    }],
  }]), "utf8");
  await writeFile(resolve(profile, "selection.json"), JSON.stringify({
    projectId: "crash-project",
    conversationId: "crash-conversation",
  }), "utf8");
  await rm(resolve(profile, "Local Storage"), { recursive: true, force: true });
  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForSelector(".task-row.active");

  // localStorage 里那份只是 projects.json 丢了之后的兜底副本：副本写失败（整份历史大起来之后
  // 超配额最常见）绝不能连带把真正的存储挡掉，否则新建的对话一重启就没了。
  // 只对装了标记的那一次加载生效，后面的加载不受影响。
  expectRendererCrashNoise = true;
  await page.addInitScript(() => {
    if (localStorage.getItem("claude-desk-test.fail-project-mirror") !== "1") return;
    localStorage.removeItem("claude-desk-test.fail-project-mirror");
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === "claude-desk.projects.v2") throw new DOMException("quota exceeded", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    };
  });
  await page.evaluate(() => localStorage.setItem("claude-desk-test.fail-project-mirror", "1"));
  await page.reload();
  await page.waitForSelector(".task-row.active");
  // 新建对话按钮要悬停才显形，这里只关心它触发的保存，直接派发点击。
  await page.locator('.project-action[title="新建对话"]').evaluate((button) => button.click());
  await page.waitForSelector(".conversation-intro");
  const mirrorFailureConversationId = await page.evaluate(async () => (await window.claudeDesk.getAppSelection()).conversationId);
  if (!mirrorFailureConversationId || mirrorFailureConversationId === "crash-conversation") {
    throw new Error(`新建的对话没有成为当前对话：${mirrorFailureConversationId}`);
  }
  await waitForAsyncCondition(page, async (expected) => {
    const projects = await window.claudeDesk.getProjectStore();
    return Array.isArray(projects)
      && projects.some((project) => project.conversations.some((conversation) => conversation.id === expected));
  }, mirrorFailureConversationId, { timeout: 10_000 }).catch(() => {
    throw new Error("localStorage 副本写失败时，新建的对话没有写进 projects.json");
  });
  // 崩溃之后 Playwright 对这个页面的 CDP 调用会异步抛 "Target crashed"，断言只走主进程侧。
  const storeBeforeCrash = await readFile(resolve(profile, "projects.json"), "utf8")
    .then((raw) => JSON.parse(raw).flatMap((project) => project.conversations.map((item) => `${item.id.slice(0, 8)}:${item.messages.length}`)))
    .catch((error) => `store unreadable: ${error.code ?? error.message}`);
  console.log("DEBUG store-before-crash", JSON.stringify(storeBeforeCrash), "new:", mirrorFailureConversationId?.slice(0, 8));
  const ignoreTargetCrash = (error) => {
    const detail = error?.message ?? String(error);
    if (!detail.includes("Target crashed")) errors.push(detail);
  };
  process.on("uncaughtException", ignoreTargetCrash);
  process.on("unhandledRejection", ignoreTargetCrash);
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
  });
  let recovery = { alive: false, detail: "没有探到任何界面状态" };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    const probe = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      if (!target || target.isDestroyed()) return "窗口已经被销毁";
      if (target.webContents.isCrashed()) return "渲染进程仍然是崩溃状态";
      return await target.webContents.executeJavaScript(`JSON.stringify({
        rows: document.querySelectorAll(".task-row").length,
        active: document.querySelectorAll(".task-row.active").length,
        fatal: Boolean(document.querySelector(".fatal-error")),
        loading: Boolean(document.querySelector(".history-loading")),
        text: (document.body.textContent || "").slice(0, 100),
      })`).catch((error) => `探测失败：${error.message}`);
    });
    const storeNow = await readFile(resolve(profile, "projects.json"), "utf8")
      .then((raw) => JSON.parse(raw).flatMap((project) => project.conversations.map((item) => `${item.id.slice(0, 8)}:${item.messages.length}`)))
      .catch((error) => `store unreadable: ${error.code ?? error.message}`);
    recovery = { alive: false, detail: `${probe} store=${JSON.stringify(storeNow)}` };
    try {
      const state = JSON.parse(probe);
      if (state.active > 0 && !state.fatal) {
        recovery = { alive: true, detail: probe };
        break;
      }
    } catch {
      // 还没加载出可解析的状态，继续等。
    }
  }
  process.off("uncaughtException", ignoreTargetCrash);
  process.off("unhandledRejection", ignoreTargetCrash);
  if (!recovery.alive) throw new Error(`渲染进程崩溃后界面没有自己恢复，窗口一直是白屏：${recovery.detail}`);
  const crashLog = await readFile(resolve(profile, "renderer-errors.log"), "utf8").catch(() => "");
  if (!crashLog.includes("reloading renderer")) {
    throw new Error(`渲染进程崩溃没有被记录成一次重载：${crashLog.slice(-300)}`);
  }
  if (!/renderer crashed \(.*\), system memory free \d+MB of \d+MB/.test(crashLog)) {
    throw new Error(`崩溃日志里没有记下当时的内存水位：${crashLog.slice(-300)}`);
  }
  // 崩溃过的页面不再交给 Playwright 继续操作，换一个干净实例检查恢复流程有没有把数据弄丢。
  await electronApp.close();
  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForSelector(".task-row.active");
  const survivors = JSON.parse(await readFile(resolve(profile, "projects.json"), "utf8"))
    .flatMap((project) => project.conversations);
  if (
    survivors.length !== 2 ||
    !survivors.some((conversation) => conversation.id === mirrorFailureConversationId) ||
    survivors.find((conversation) => conversation.id === "crash-conversation")?.messages?.[0]?.content !== "崩溃前的正文"
  ) {
    throw new Error(`崩溃恢复把存储里的内容弄丢了：${JSON.stringify(survivors.map((item) => ({ id: item.id, messages: item.messages.length })))}`);
  }
  expectRendererCrashNoise = false;

  await electronApp.close();
  electronApp = undefined;

  console.log(JSON.stringify({
    errors,
    selectedModel: firstConversation.selectedModel,
    cliModel: firstConversation.resolvedModel,
    projects: 1,
    conversations: 7,
    importedCliHistory: true,
    additionalDirectories: true,
    apiRetryOverride: true,
    scheduledPrompts: true,
    completionShellTask: true,
    truncatingResumeOnEdit: true,
    slashCommands: true,
    legacyMigration: true,
    corruptDataRecovery: true,
    unsolicitedResultIgnored: true,
    stuckProcessExitWatchdog: true,
    projectMirrorFailure: true,
    rendererCrashRecovery: true,
    reorderingAndPinning: true,
    conversationListCap: true,
    portableAssetMapping: true,
    legacyGithubAssetFallback: true,
    startMenuLauncherCopy: true,
  }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} finally {
  if (electronApp) await electronApp.close().catch(() => undefined);
  await new Promise((resolveClose) => updateServer.close(() => resolveClose(undefined)));
}
