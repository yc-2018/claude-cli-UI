import { _electron as electron } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workspaceDirectoryName = basename(root);
const artifacts = resolve(root, "artifacts");
const profile = resolve(artifacts, `workflow-profile-${Date.now()}`);
const cliSessions = resolve(profile, "claude-history");
const fakeCli = resolve(root, "tests", "fixtures", "fake-claude.mjs");
await mkdir(profile, { recursive: true });
await mkdir(cliSessions, { recursive: true });
const importedSessionId = "44444444-4444-4444-8444-444444444444";
const importedTime = Date.now() - 60_000;
await writeFile(resolve(cliSessions, `${importedSessionId}.jsonl`), [
  {
    type: "user",
    uuid: "history-user",
    timestamp: new Date(importedTime).toISOString(),
    cwd: root,
    sessionId: importedSessionId,
    permissionMode: "acceptEdits",
    message: { role: "user", content: "来自终端的历史对话" },
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
  args: [root],
  cwd: root,
  env: {
    ...process.env,
    CLAUDE_DESK_USER_DATA_DIR: profile,
    CLAUDE_DESK_TEST_WORKSPACE: root,
    CLAUDE_DESK_TEST_SESSIONS_DIR: cliSessions,
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

let electronApp;
try {
  electronApp = await launch();
  let page = await electronApp.firstWindow();
  watchErrors(page);

  await page.click(".new-task-button");
  await page.waitForSelector(".composer");
  if (await page.locator(".project-group").count() !== 1) throw new Error("new project was not created");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 2);
  const importedRow = page.locator(".task-row", { hasText: "来自终端的历史对话" });
  if (!(await importedRow.textContent())?.includes("Claude CLI")) throw new Error("imported CLI session was not identified in the sidebar");
  await importedRow.locator(".task-select").click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "来自终端的历史对话");
  if (!(await page.locator(".markdown").last().textContent())?.includes("恢复的回答")) throw new Error("CLI session response was not loaded");
  if (!(await page.locator(".thinking-toggle").last().textContent())?.includes("思考过程")) throw new Error("CLI session thinking was not loaded");
  await page.waitForTimeout(450);
  const persistedImport = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.find((conversation) => conversation.source === "claude"));
  if (!persistedImport || persistedImport.messages.length !== 0) throw new Error("imported CLI history was duplicated into local storage");
  await page.locator(".task-select", { hasText: "新对话" }).click();

  const workspaceOpenResult = await page.evaluate((workspace) => window.claudeDesk.openWorkspace(workspace), root);
  if (!workspaceOpenResult.opened) throw new Error(`valid workspace was not opened: ${workspaceOpenResult.error}`);
  const invalidWorkspaceOpenResult = await page.evaluate(() => window.claudeDesk.openWorkspace("C:\\path-that-does-not-exist\\claude-desk"));
  if (invalidWorkspaceOpenResult.opened) throw new Error("invalid workspace was accepted");
  await page.locator(".workspace-chip").click();
  await page.locator(".project-row").click({ button: "right" });

  const modelOptions = await page.locator(".model-select option").allTextContents();
  if (modelOptions.length !== 4 || modelOptions.some((label) => label.includes("跟随 CLI"))) {
    throw new Error(`model roles were collapsed or fallback option remained: ${modelOptions.join(", ")}`);
  }
  if (!["Sonnet · ThirdParty-A", "Opus · ThirdParty-A", "Fable · ThirdParty-B", "Haiku · ThirdParty-B"].every((label) => modelOptions.includes(label))) {
    throw new Error(`dynamic models missing: ${modelOptions.join(", ")}`);
  }
  await page.locator(".composer textarea").fill("/model");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.activeElement?.classList.contains("model-select"));
  await page.keyboard.press("Escape");
  await page.locator(".model-select").selectOption("fable");

  await page.locator(".project-row").hover();
  await page.locator('.project-action[title="重命名项目"]').click();
  await page.locator('input[aria-label="项目名称"]').fill("我的 Claude 项目");
  await page.locator('input[aria-label="项目名称"]').press("Enter");
  if (await page.locator(".project-name strong").textContent() !== "我的 Claude 项目") throw new Error("project custom name was not shown");
  if (await page.locator(".project-name small").textContent() !== workspaceDirectoryName) throw new Error("project real directory name was not shown");

  await page.locator(".task-row.active").hover();
  await page.locator('.task-row.active .task-rename[title="重命名对话"]').click();
  await page.locator('input[aria-label="对话名称"]').fill("手动会话名");
  await page.locator('input[aria-label="对话名称"]').press("Enter");
  if (await page.locator(".task-heading h2").textContent() !== "手动会话名") throw new Error("conversation rename was not reflected in the header");

  await page.locator(".composer textarea").fill("/");
  await page.waitForSelector(".command-menu");
  if (await page.locator(".command-option").count() < 6) throw new Error("local slash commands missing");
  await page.locator(".composer textarea").fill("/plan");
  await page.locator(".composer textarea").press("Enter");
  if (await page.locator('.select-control select').last().inputValue() !== "plan") throw new Error("/plan did not change permission mode");
  await page.locator(".composer textarea").fill("/edit");
  await page.locator(".composer textarea").press("Enter");

  await page.locator(".composer textarea").fill("这是首次会话名称测试内容");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="done"]', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector(".markdown")?.textContent?.includes("流式输出稳定"));
  await page.waitForTimeout(500);

  const completed = await page.evaluate(() => ({
    bodySize: document.body.innerText.length,
    projects: JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]"),
  }));
  const firstConversation = completed.projects[0]?.conversations?.[0];
  if (completed.bodySize < 500) throw new Error("rendered conversation is unexpectedly blank");
  if (firstConversation?.messages?.at(-1)?.status !== "done") throw new Error("completed response was not persisted");
  if (!firstConversation?.messages?.at(-1)?.thinking?.includes("检查上下文")) throw new Error("thinking content was not persisted");
  if (firstConversation?.selectedModel !== "fable" || firstConversation?.resolvedModel !== "ThirdParty-B") {
    throw new Error("selected model role was not mapped through CLI");
  }
  if (firstConversation?.title !== "手动会话名") throw new Error("the first prompt overwrote a manual conversation name");
  const thinkingToggle = page.locator(".thinking-toggle").last();
  if (await thinkingToggle.getAttribute("aria-expanded") !== "false") throw new Error("completed thinking was not collapsed");
  await thinkingToggle.click();
  if (!(await page.locator(".thinking-content").last().textContent())?.includes("检查上下文")) throw new Error("thinking content was not rendered");
  await page.screenshot({ path: resolve(artifacts, "thinking-expanded.png") });

  await page.evaluate(() => {
    const container = document.querySelector(".conversation-scroll");
    if (container) container.scrollTop = 0;
  });
  await page.locator(".composer textarea").fill("自动滚动测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  const bottomDistance = await page.locator(".conversation-scroll").evaluate((container) => container.scrollHeight - container.clientHeight - container.scrollTop);
  if (bottomDistance > 2) throw new Error(`conversation did not scroll to the bottom after send: ${bottomDistance}px`);

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
  let permissionConversation = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.[0]);
  if (permissionConversation.allowedTools?.includes("WebSearch")) throw new Error("allow once persisted the tool permission");

  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".permission-dialog");
  await page.locator(".permission-allow-conversation").click();
  await page.waitForSelector(".permission-dialog", { state: "detached" });
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  await page.waitForTimeout(450);
  permissionConversation = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-desk.projects.v2") ?? "[]")[0]?.conversations?.[0]);
  if (!permissionConversation.allowedTools?.includes("WebSearch")) throw new Error("conversation permission was not persisted");

  await page.locator(".composer textarea").fill("权限测试");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector('.message.assistant:last-of-type')?.getAttribute("data-status") === "done");
  if (await page.locator(".permission-dialog").count()) throw new Error("persisted conversation permission prompted again");

  await page.locator('.project-action[title="新建对话"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 3);
  if (await page.locator(".conversation-intro").count() !== 1) throw new Error("new conversation did not open independently");

  await page.locator(".composer textarea").fill("第二个对话");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="done"]');
  await page.locator(".composer textarea").fill("/clear");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".conversation-intro");
  if (await page.locator(".message").count()) throw new Error("/clear did not clear only the active conversation");
  await page.locator(".task-select", { hasText: "手动会话名" }).click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "这是首次会话名称测试内容");

  await page.locator(".composer textarea").fill("/new");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 4);
  await page.locator(".composer textarea").fill("/project");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".project-conversations .task-row").length === 5);
  if (await page.locator(".project-group").count() !== 1) throw new Error("same workspace created a duplicate project");

  await page.locator(".composer textarea").fill("模拟失败");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="error"]');
  if (!(await page.locator(".message-error").last().textContent())?.includes("模拟 CLI 错误")) throw new Error("stderr was not shown");

  await page.locator(".composer textarea").fill("空响应");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll('.message.assistant[data-status="error"]').length === 2);

  await page.locator(".composer textarea").fill("慢任务");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector('.message.assistant[data-status="running"]');
  await page.locator(".send-button.stop").click();
  await page.waitForSelector('.message.assistant[data-status="stopped"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(artifacts, "workflow-complete.png") });
  await electronApp.close();
  electronApp = undefined;

  electronApp = await launch();
  page = await electronApp.firstWindow();
  watchErrors(page);
  await page.waitForSelector(".project-group");
  if (await page.locator(".project-group").count() !== 1 || await page.locator(".project-conversations .task-row").count() !== 5) {
    throw new Error("project/conversation hierarchy did not survive restart");
  }
  if (await page.locator(".project-name strong").textContent() !== "我的 Claude 项目" || await page.locator(".project-name small").textContent() !== workspaceDirectoryName) {
    throw new Error("project name mapping did not survive restart");
  }
  if (await page.locator('.message.assistant[data-status="running"]').count()) throw new Error("running state survived restart");
  await page.locator(".task-select", { hasText: "来自终端的历史对话" }).click();
  await page.waitForFunction(() => document.querySelector(".user-bubble")?.textContent === "来自终端的历史对话");
  if (!(await page.locator(".markdown").last().textContent())?.includes("恢复的回答")) throw new Error("CLI session was not reloaded after restart");

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
  await page.waitForSelector(".empty-view");
  if (await page.locator(".fatal-error").count()) throw new Error("corrupt project data reached the error boundary");
  await electronApp.close();
  electronApp = undefined;

  console.log(JSON.stringify({
    errors,
    selectedModel: firstConversation.selectedModel,
    cliModel: firstConversation.resolvedModel,
    projects: 1,
    conversations: 5,
    importedCliHistory: true,
    slashCommands: true,
    legacyMigration: true,
    corruptDataRecovery: true,
  }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} finally {
  if (electronApp) await electronApp.close().catch(() => undefined);
}
