import { _electron as electron } from "playwright";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
const workspaceDirectoryName = basename(root);
const artifacts = resolve(root, "artifacts");
const profile = resolve(artifacts, `workflow-profile-${Date.now()}`);
const claudeConfig = resolve(profile, "claude-config");
const cliSessions = resolve(claudeConfig, "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
const fakeCli = resolve(root, "tests", "fixtures", "fake-claude.mjs");
const packagedExecutable = process.env.CLAUDE_DESK_TEST_EXECUTABLE;
await mkdir(profile, { recursive: true });
await mkdir(cliSessions, { recursive: true });
const updateVersion = "9.9.9";
const updateExecutableName = `claude-cli-UI Portable ${updateVersion}.exe`;
const updateExecutable = Buffer.alloc(512 * 1024, 0x5a);
updateExecutable.write("MZ claude-cli-UI portable update regression fixture\n", "utf8");
const updateManifest = JSON.stringify({
  version: updateVersion,
  fileName: updateExecutableName,
  size: updateExecutable.byteLength,
  sha256: createHash("sha256").update(updateExecutable).digest("hex"),
});
const updateServer = createServer((request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1));
  if (requestPath === "portable-update.json") {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(updateManifest) });
    response.end(updateManifest);
    return;
  }
  if (requestPath === updateExecutableName) {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": updateExecutable.byteLength });
    let offset = 0;
    const writeNextChunk = () => {
      if (response.destroyed) return;
      if (offset >= updateExecutable.byteLength) {
        response.end();
        return;
      }
      const nextOffset = Math.min(updateExecutable.byteLength, offset + 32 * 1024);
      response.write(updateExecutable.subarray(offset, nextOffset));
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
        { type: "tool_use", id: "history-tool", name: "Read", input: { file_path: "README.md" } },
        { type: "text", text: "这是从 Claude CLI 会话文件恢复的回答。" },
      ],
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

const launch = () => electron.launch({
  ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
  args: packagedExecutable ? [] : [root],
  cwd: root,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_DESK_USER_DATA_DIR: profile,
    CLAUDE_DESK_TEST_WORKSPACE: root,
    CLAUDE_DESK_FAKE_SESSIONS_DIR: cliSessions,
    CLAUDE_DESK_DISABLE_NOTIFICATIONS: "1",
    CLAUDE_DESK_DISABLE_AUTO_UPDATE_CHECK: "1",
    CLAUDE_DESK_TEST_UPDATE_BASE_URL: updateBaseUrl,
    CLAUDE_DESK_TEST_UPDATE_INSTALL: "1",
    PORTABLE_EXECUTABLE_FILE: currentPortablePath,
    CLAUDE_DESK_TEST_MODELS: JSON.stringify({
      Sonnet: "ThirdParty-A",
      Opus: "ThirdParty-A",
      Fable: "ThirdParty-B",
      Haiku: "ThirdParty-B",
    }),
    CLAUDE_DESK_CLAUDE_EXECUTABLE: process.execPath,
    CLAUDE_DESK_CLAUDE_PREFIX_ARGS: JSON.stringify([fakeCli]),
  },
});

const errors = [];
const watchErrors = (page) => {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
};

const refreshProjectSessions = async (page) => {
  const projectRow = page.locator(".project-row").first();
  await projectRow.hover();
  await projectRow.locator('[title="刷新 Claude CLI 会话"]').evaluate((button) => button.click());
};

let electronApp;
try {
  electronApp = await launch();
  let page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForFunction(() => document.title === "claude-cli-UI");
  await page.waitForSelector(".sidebar-brand");
  if (await page.title() !== "claude-cli-UI") throw new Error("window title did not use the product name");
  if ((await page.locator(".sidebar-brand").textContent())?.trim() !== "claude-cli-UI") throw new Error("sidebar did not use the product name");
  await page.waitForFunction((version) => document.querySelector(".sidebar-version")?.textContent === `claude-cli-UI v${version}`, packageVersion);

  await page.locator(".settings-trigger").click();
  const traySetting = page.locator(".segmented-control button", { hasText: "托盘后台" });
  const quitSetting = page.locator(".segmented-control button", { hasText: "退出应用" });
  const completionSetting = page.locator(".setting-toggle-row input");
  if (!(await traySetting.getAttribute("class"))?.includes("active") || !(await completionSetting.isChecked())) {
    throw new Error("background settings did not use the expected defaults");
  }
  await quitSetting.click();
  await page.waitForFunction(async () => (await window.claudeDesk.getAppSettings()).closeBehavior === "quit");
  await traySetting.click();
  await completionSetting.evaluate((input) => input.click());
  await page.waitForFunction(async () => (await window.claudeDesk.getAppSettings()).notifyOnCompletion === false);
  await completionSetting.evaluate((input) => input.click());
  await page.waitForFunction(async () => {
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
  await page.locator(".update-install-button").click();
  await page.waitForSelector(".update-dialog", { state: "detached" });
  await page.keyboard.press("Escape");

  await page.click(".new-task-button");
  await page.waitForSelector(".composer");
  if (await page.locator(".project-group").count() !== 1) throw new Error("new project was not created");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 2);
  const importedRow = page.locator(".task-row", { hasText: "来自终端的历史对话" });
  if (!(await importedRow.textContent())?.includes("Claude CLI")) throw new Error("imported CLI session was not identified in the sidebar");
  if (!(await importedRow.textContent())?.includes("feature/cli-sync") || await importedRow.locator("time").count() !== 1) {
    throw new Error("CLI session branch or updated time was not shown in the sidebar");
  }
  await importedRow.locator(".task-select").click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "来自终端的历史对话");
  if (!(await page.locator(".markdown").last().textContent())?.includes("恢复的回答")) throw new Error("CLI session response was not loaded");
  if (!(await page.locator(".thinking-toggle").last().textContent())?.includes("思考过程")) throw new Error("CLI session thinking was not loaded");
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
      message: { id: "refreshed-history-response", role: "assistant", model: "ThirdParty-B", content: [{ type: "text", text: "刷新后无需重启即可看到。" }] },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  await refreshProjectSessions(page);
  await page.waitForFunction(() => [...document.querySelectorAll(".user-bubble")].some((item) => item.textContent === "从 CLI 刷新进来的新消息"));
  if (!(await page.locator(".markdown").last().textContent())?.includes("无需重启")) throw new Error("manual project refresh did not reload CLI responses");
  await page.waitForTimeout(450);
  const persistedImport = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.find((conversation) => conversation.source === "claude"));
  if (!persistedImport || persistedImport.messages.length !== 0) throw new Error("imported CLI history was duplicated into local storage");

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
  await refreshProjectSessions(page);
  const hiddenRow = page.locator(".task-row", { hasText: "准备从 UI 移除的 CLI 会话" });
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
  await page.locator(".task-select", { hasText: "新对话" }).click();

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
  await page.locator(".composer textarea").fill("/model");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.model-select .composer-select-trigger')?.getAttribute("aria-expanded") === "true");
  await page.waitForFunction(() => document.activeElement?.matches(".model-select .composer-select-trigger"));
  await page.keyboard.press("Escape");
  await page.locator(".model-select .composer-select-trigger").click();
  await page.locator('.model-select .composer-select-option[data-value="fable"]').click();

  await page.locator('.project-action[title="重命名项目"]').evaluate((button) => button.click());
  await page.locator('input[aria-label="项目名称"]').fill("我的 Claude 项目");
  await page.locator('input[aria-label="项目名称"]').press("Enter");
  if (await page.locator(".project-name strong").textContent() !== "我的 Claude 项目") throw new Error("project custom name was not shown");
  if (await page.locator(".project-name small").textContent() !== workspaceDirectoryName) throw new Error("project real directory name was not shown");

  await page.locator('.task-row.active .task-rename[title="重命名对话"]').evaluate((button) => button.click());
  await page.locator('input[aria-label="对话名称"]').fill("手动会话名");
  await page.locator('input[aria-label="对话名称"]').press("Enter");
  if (await page.locator(".task-heading h2").textContent() !== "手动会话名") throw new Error("conversation rename was not reflected in the header");

  await page.locator(".composer textarea").fill("/");
  await page.waitForSelector(".command-menu");
  if (await page.locator(".command-option").count() < 6) throw new Error("local slash commands missing");
  await page.locator(".composer textarea").fill("/plan");
  await page.locator(".composer textarea").press("Enter");
  if (!(await page.locator(".permission-select .composer-select-value").textContent())?.includes("计划模式")) {
    throw new Error("/plan did not change permission mode");
  }
  await page.locator(".permission-select .composer-select-trigger").click();
  if (await page.locator(".permission-select .composer-select-option").count() !== 4) throw new Error("custom permission picker did not expose every mode");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.locator(".composer textarea").fill("/edit");
  await page.locator(".composer textarea").press("Enter");

  await page.locator(".composer textarea").fill("这是首次会话名称测试内容");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="done"]', { timeout: 15_000 });
  await page.waitForFunction(() => {
    const responses = document.querySelectorAll(".message.assistant .message-body > .markdown");
    return responses.item(responses.length - 1)?.textContent?.includes("流式输出稳定");
  });
  await page.waitForTimeout(500);
  const normalizedSession = await readFile(resolve(cliSessions, "22222222-2222-4222-8222-222222222222.jsonl"), "utf8");
  if (normalizedSession.includes('"entrypoint":"sdk-cli"') || normalizedSession.includes('"promptSource":"sdk"')) {
    throw new Error("claude-cli-UI session remained hidden from the CLI resume picker");
  }
  if (!normalizedSession.includes('"entrypoint":"cli"') || !normalizedSession.includes('"promptSource":"typed"')) {
    throw new Error("claude-cli-UI session was not normalized for the CLI resume picker");
  }
  await page.locator('.task-row.active .task-rename[title="重命名对话"]').evaluate((button) => button.click());
  await page.locator('input[aria-label="对话名称"]').fill("UI 同步会话名");
  await page.locator('input[aria-label="对话名称"]').press("Enter");
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "UI 同步会话名");
  await page.waitForFunction(async () => {
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
  if (!firstConversation?.messages?.at(-1)?.thinking?.includes("检查上下文")) throw new Error("thinking content was not persisted");
  if (firstConversation?.selectedModel !== "fable" || firstConversation?.resolvedModel !== "ThirdParty-B") {
    throw new Error("selected model role was not mapped through CLI");
  }
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
  if (await page.locator(".task-row strong").filter({ hasText: /^CLI 外部改名 \(2\)$/ }).count() !== 1) {
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
  await page.locator(".task-row strong").filter({ hasText: /^CLI 外部改名$/ }).click();
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
  await page.locator(".composer textarea").fill("附件回归测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (await page.locator(".sent-image").count() !== 1 || await page.locator(".sent-file", { hasText: "notes.txt" }).count() !== 1) {
    throw new Error("sent attachments were not rendered in the conversation");
  }
  await page.waitForTimeout(450);
  const persistedAttachments = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.find((conversation) => conversation.sessionId === "22222222-2222-4222-8222-222222222222")?.messages?.find((message) => message.content === "附件回归测试")?.attachments);
  if (!Array.isArray(persistedAttachments) || persistedAttachments.length !== 2 || persistedAttachments.some((attachment) => attachment.dataBase64)) {
    throw new Error("attachment metadata was not persisted safely");
  }

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
    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => (document.querySelector('.message.assistant[data-status="running"] .thinking-content')?.textContent?.length ?? 0) > 360);
  const heldScrollTop = await page.locator(".conversation-scroll").evaluate((container) => container.scrollTop);
  if (heldScrollTop > 2) throw new Error(`streaming output stole the user's scroll position: ${heldScrollTop}px`);
  await page.locator(".conversation-scroll").evaluate((container) => {
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const resumedBottomDistance = await page.locator(".conversation-scroll").evaluate((container) => container.scrollHeight - container.clientHeight - container.scrollTop);
  if (resumedBottomDistance > 2) throw new Error(`bottom-follow did not resume: ${resumedBottomDistance}px`);

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

  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".permission-dialog");
  if (!(await page.locator(".permission-dialog").textContent())?.includes("WebSearch") || !(await page.locator(".permission-dialog").textContent())?.includes("LongCat-2.0")) {
    throw new Error("permission dialog did not show the requested tool and input");
  }
  await page.screenshot({ path: resolve(artifacts, "permission-dialog.png") });
  await page.locator(".permission-deny").click();
  await page.waitForSelector(".permission-dialog", { state: "detached" });
  if (!(await page.locator(".message-error").last().textContent())?.includes("已拒绝")) throw new Error("permission denial was not reflected in the conversation");

  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".permission-dialog");
  await page.locator(".permission-allow-once").click();
  await page.waitForSelector(".permission-dialog", { state: "detached" });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
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

  await page.locator(".project-row").first().hover();
  await page.locator('.project-action[title="新建对话"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 4);
  if (await page.locator(".conversation-intro").count() !== 1) throw new Error("new conversation did not open independently");

  await page.locator(".composer textarea").fill("后台提醒测试 第二个对话");
  await page.locator(".composer textarea").press("Enter");
  const backgroundConversationRow = page.locator(".task-row", { hasText: "后台提醒测试 第二个对话" });
  await backgroundConversationRow.locator(".conversation-running-icon").waitFor();
  await page.locator(".task-row strong").filter({ hasText: /^CLI 外部改名$/ }).click();
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
  await page.locator(".task-row strong").filter({ hasText: /^CLI 外部改名$/ }).click();
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
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 5);
  await page.locator(".composer textarea").fill("/project");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 6);
  if (await page.locator(".project-group").count() !== 1) throw new Error("same workspace created a duplicate project");

  await page.locator(".composer textarea").fill("模拟失败");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="error"]');
  if (!(await page.locator(".message-error").last().textContent())?.includes("模拟 CLI 错误")) throw new Error("stderr was not shown");

  await page.locator(".composer textarea").fill("空响应");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll('.message.assistant[data-status="error"]').length === 2);

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

  await page.locator(".composer textarea").fill("慢任务");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"]');
  await page.locator(".send-button.stop").click();
  await page.waitForSelector('.message.assistant[data-status="stopped"]');
  await page.locator(".task-select", { hasText: "来自终端的历史对话" }).click();
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
  if (!Array.isArray(projectStore) || projectStore.length !== 1 || projectStore[0]?.conversations?.length !== 6) {
    throw new Error("main-process project store was not written");
  }
  const persistedSettings = JSON.parse(await readFile(resolve(profile, "settings.json"), "utf8"));
  if (persistedSettings.closeBehavior !== "tray" || persistedSettings.notifyOnCompletion !== true) {
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
  await page.waitForFunction(async () => {
    const project = JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0];
    const conversation = project?.conversations?.find((item) => item.sessionId === "22222222-2222-4222-8222-222222222222");
    return Boolean(conversation);
  });
  await page.waitForTimeout(300);
  const localSessionAfterRestart = await readFile(localSessionPath, "utf8");
  if (localSessionAfterRestart.includes('"entrypoint":"sdk-cli"') || localSessionAfterRestart.includes('"promptSource":"sdk"')) {
    throw new Error("existing local UI session was not migrated for the CLI resume picker");
  }
  if (await page.locator(".project-group").count() !== 1 || await page.locator(".project-conversations .task-row").count() !== 6) {
    throw new Error("project/conversation hierarchy did not survive restart");
  }
  if (await page.locator(".project-name strong").textContent() !== "我的 Claude 项目" || await page.locator(".project-name small").textContent() !== workspaceDirectoryName) {
    throw new Error("project name mapping did not survive restart");
  }
  if (await page.locator('.message.assistant[data-status="running"]').count()) throw new Error("running state survived restart");
  await page.waitForFunction(() => document.querySelector(".task-heading h2")?.textContent === "来自终端的历史对话");
  if (await page.locator(".task-row.active", { hasText: "来自终端的历史对话" }).count() !== 1) {
    throw new Error("last active conversation was not restored after restart");
  }
  await page.locator(".task-select", { hasText: "来自终端的历史对话" }).click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "来自终端的历史对话");
  if (await page.locator(".markdown", { hasText: "恢复的回答" }).count() === 0) throw new Error("CLI session was not reloaded after restart");

  const localConversationRow = page.locator(".task-row").filter({ has: page.getByText("CLI 外部改名", { exact: true }) });
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

  await page.locator(".task-row strong").filter({ hasText: /^CLI 外部改名 \(2\)$/ }).click();
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
  await page.locator(".task-row.active .task-delete").evaluate((button) => button.click());
  await page.locator(".delete-confirm-button.danger").click();
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 5);
  await page.waitForSelector(".project-row.active");
  if (await page.locator(".task-row.active").count() !== 0 || await page.locator(".composer").count() !== 0 || await page.locator(".project-empty-view").count() !== 1) {
    throw new Error("deleting the active conversation did not leave its project selected without opening another conversation");
  }
  await page.waitForFunction(async () => (await window.claudeDesk.getAppSelection()).conversationId === null);

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
  if (await page.locator(".task-row.active").count() !== 1 || await page.locator(".composer").count() !== 1) {
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

  console.log(JSON.stringify({
    errors,
    selectedModel: firstConversation.selectedModel,
    cliModel: firstConversation.resolvedModel,
    projects: 1,
    conversations: 6,
    importedCliHistory: true,
    slashCommands: true,
    legacyMigration: true,
    corruptDataRecovery: true,
  }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} finally {
  if (electronApp) await electronApp.close().catch(() => undefined);
  await new Promise((resolveClose) => updateServer.close(() => resolveClose(undefined)));
}
