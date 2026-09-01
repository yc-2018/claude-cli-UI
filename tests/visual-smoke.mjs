import { _electron as electron } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const profile = resolve(artifacts, `visual-profile-${Date.now()}`);
const fakeCli = resolve(root, "tests", "fixtures", "fake-claude.mjs");
await mkdir(artifacts, { recursive: true });

const electronApp = await electron.launch({
  args: [root],
  cwd: root,
  env: {
    ...process.env,
    CLAUDE_DESK_USER_DATA_DIR: profile,
    CLAUDE_DESK_DISABLE_PROJECT_DISCOVERY: "1",
    CLAUDE_DESK_TEST_WORKSPACE: root,
    CLAUDE_DESK_DISABLE_AUTO_UPDATE_CHECK: "1",
    CLAUDE_DESK_TEST_UPDATE_VERSION: "9.9.9",
    CLAUDE_DESK_TEST_UPDATE_NOTES: "<h2>更新内容</h2><ul><li>修复 &amp; 优化 Portable 更新</li></ul>",
    CLAUDE_DESK_TEST_PORTABLE: "1",
    CLAUDE_DESK_CLAUDE_EXECUTABLE: process.execPath,
    CLAUDE_DESK_CLAUDE_PREFIX_ARGS: JSON.stringify([fakeCli]),
    CLAUDE_DESK_TEST_MODELS: JSON.stringify({
      Sonnet: "LongCat-2.0",
      Opus: "LongCat-2.0",
      Fable: "LongCat-2.0",
      Haiku: "LongCat-2.0",
    }),
  },
});
try {
const page = await electronApp.firstWindow();
const errors = [];

page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

await page.setViewportSize({ width: 1320, height: 860 });
await page.evaluate(() => {
  localStorage.removeItem("claude-desk.tasks.v1");
  localStorage.removeItem("claude-desk.projects.v2");
  localStorage.removeItem("claude-desk.sidebar-width.v1");
});
await page.reload();
await page.waitForSelector(".empty-view");
await page.screenshot({ path: resolve(artifacts, "empty-state.png") });

await page.evaluate((workspace) => {
  const now = Date.now();
  const key = "claude-desk.projects.v2";
  const originalSetItem = Storage.prototype.setItem;
  const seededProjects = [{
    id: "visual-project",
    name: "sample-dashboard",
    pinned: true,
    workspace,
    createdAt: now,
    updatedAt: now,
    conversations: [{
      id: "visual-conversation",
      title: "检查登录流程并修复会话恢复",
      pinned: true,
      createdAt: now,
      updatedAt: now,
      sessionId: "11111111-1111-4111-8111-111111111111",
      gitBranch: "feature/auth-session-refresh",
      resolvedModel: "LongCat-2.0",
      permissionMode: "acceptEdits",
      slashCommands: ["/story", "/compact"],
      contextUsage: { usedTokens: 42000, contextWindow: 200000, usedPercentage: 21, remainingPercentage: 79 },
      contextCompactions: [{ id: "visual-compact", trigger: "auto", status: "done", preTokens: 180000, postTokens: 42000, summary: "保留了项目目标和关键决策。" }],
      messages: [
        { id: "u1", role: "user", content: "检查登录流程，找出刷新后会退出的问题并修复。", createdAt: now - 2000 },
        {
          id: "a1",
          role: "assistant",
          content: "问题出在会话初始化顺序：页面在令牌恢复完成前就触发了未登录跳转。\n\n我调整了初始化状态，并补充了回归测试：\n\n```ts\nif (session.status === 'loading') return;\n```\n\n现在刷新页面会等待会话恢复后再判断路由。",
          createdAt: now - 1000,
          status: "done",
          thinking: "先检查会话恢复状态，再验证令牌刷新顺序。",
          responseStartedAt: now - 9000,
          responseDurationMs: 8000,
          activities: [
            { id: "t1", name: "Grep", summary: "session status" },
            { id: "t2", name: "Read", summary: "src/auth/session.ts" },
            {
              id: "t3",
              name: "Edit",
              summary: "src/router/guard.ts",
              detail: {
                path: "src/router/guard.ts",
                oldText: "if (!session) redirect('/login');",
                newText: "if (session.status === 'loading') return;\nif (!session) redirect('/login');",
                diff: [
                  { type: "remove", text: "if (!session) redirect('/login');", oldLine: 42 },
                  { type: "add", text: "if (session.status === 'loading') return;", newLine: 42 },
                  { type: "add", text: "if (!session) redirect('/login');", newLine: 43 }
                ]
              }
            }
          ],
          timeline: [
            { id: "phase-1", type: "text", content: "问题出在会话初始化顺序：页面在令牌恢复完成前就触发了未登录跳转。" },
            { id: "activity-t1", type: "activity", activity: { id: "t1", name: "Grep", summary: "session status" } },
            { id: "activity-t2", type: "activity", activity: { id: "t2", name: "Read", summary: "src/auth/session.ts" } },
            { id: "phase-2", type: "text", content: "我调整了初始化状态，并补充了回归测试：\n\n```ts\nif (session.status === 'loading') return;\n```" },
            {
              id: "activity-t3",
              type: "activity",
              activity: {
                id: "t3",
                name: "Edit",
                summary: "src/router/guard.ts",
                detail: {
                  path: "src/router/guard.ts",
                  oldText: "if (!session) redirect('/login');",
                  newText: "if (session.status === 'loading') return;\nif (!session) redirect('/login');",
                  diff: [
                    { type: "remove", text: "if (!session) redirect('/login');", oldLine: 42 },
                    { type: "add", text: "if (session.status === 'loading') return;", newLine: 42 },
                    { type: "add", text: "if (!session) redirect('/login');", newLine: 43 }
                  ]
                }
              }
            },
            { id: "phase-3", type: "text", content: "现在刷新页面会等待会话恢复后再判断路由。" }
          ]
        }
      ]
    }, {
      id: "visual-conversation-2",
      title: "添加数据导出功能",
      createdAt: now - 5000,
      updatedAt: now - 5000,
      permissionMode: "plan",
      messages: []
    }]
  }];
  originalSetItem.call(localStorage, key, JSON.stringify(seededProjects));
  window.claudeDesk.saveProjectStore(seededProjects);
  Storage.prototype.setItem = function setItem(storageKey, value) {
    if (storageKey !== key) originalSetItem.call(this, storageKey, value);
  };
  location.reload();
}, root);
await page.waitForSelector(".composer");
if (!(await page.locator(".context-status").textContent())?.includes("上下文")) throw new Error("context usage status was not visible in the desktop viewport");
if (await page.locator('[aria-label="压缩上下文"]').count() !== 1) throw new Error("context compact button was not visible in the desktop viewport");
if (await page.locator(".context-compaction").count() !== 1) throw new Error("compact history card was not visible in the desktop viewport");
if (!(await page.locator(".sidebar-version").textContent())?.startsWith("claude-cli-UI v")) throw new Error("UI version was not shown in the sidebar footer");
if (await page.locator('[aria-label="已置顶项目"]').count() !== 1 || await page.locator('[aria-label="已置顶会话"]').count() !== 1) {
  throw new Error("pinned project/conversation indicators were not rendered");
}
await page.screenshot({ path: resolve(artifacts, "conversation.png") });
if (!(await page.locator(".response-duration").textContent())?.includes("本次回答耗时 · 8 秒")) throw new Error("completed response duration was not rendered");
if ((await page.locator("[data-timeline-kind]").evaluateAll((items) => items.map((item) => item.getAttribute("data-timeline-kind")).join(","))) !== "text,activity,activity,text,activity,text") {
  throw new Error("visual fixture did not render assistant text and tools as one ordered timeline");
}
const editActivity = page.locator('[data-timeline-kind="activity"]', { hasText: "Edit" });
await editActivity.locator(".activity-row").click();
const activityDetailLayout = await editActivity.locator(".activity-detail").evaluate((element) => element.getBoundingClientRect().toJSON());
const assistantBodyLayout = await page.locator(".message.assistant .message-body").evaluate((element) => element.getBoundingClientRect().toJSON());
if (activityDetailLayout.left < assistantBodyLayout.left || activityDetailLayout.right > assistantBodyLayout.right) {
  throw new Error(`expanded tool diff escaped the assistant message: ${JSON.stringify({ activityDetailLayout, assistantBodyLayout })}`);
}
if (await editActivity.locator(".tool-diff-line.add").count() !== 2 || await editActivity.locator(".tool-diff-line.remove").count() !== 1 || !(await editActivity.textContent())?.includes("loading")) {
  throw new Error("expanded tool diff did not render red/green source changes");
}
await page.screenshot({ path: resolve(artifacts, "expanded-tool-diff.png") });
await editActivity.locator(".activity-row").click();
if (await page.locator(".composer-options select").count()) throw new Error("composer rendered native select controls");

await page.locator(".task-title-command").click();
await page.waitForSelector(".cli-command-popover");
const commandPopoverLayout = await page.locator(".cli-command-popover").evaluate((element) => element.getBoundingClientRect().toJSON());
if (commandPopoverLayout.left < 0 || commandPopoverLayout.top < 0 || commandPopoverLayout.right > 1320 || commandPopoverLayout.bottom > 860) {
  throw new Error(`CMD command popover escaped the desktop viewport: ${JSON.stringify(commandPopoverLayout)}`);
}
if (!(await page.locator(".cli-command-popover code").textContent())?.includes('claude --resume "11111111-1111-4111-8111-111111111111"')) {
  throw new Error("CMD command popover did not include the complete session resume command");
}
await page.screenshot({ path: resolve(artifacts, "cli-resume-command.png") });
await page.locator('[aria-label="关闭 CMD 命令"]').click();

await page.locator(".model-select .composer-select-trigger").click();
const modelMenuLayout = await page.locator(".model-select .composer-select-menu").evaluate((element) => element.getBoundingClientRect().toJSON());
if (modelMenuLayout.left < 0 || modelMenuLayout.top < 0 || modelMenuLayout.right > 1320 || modelMenuLayout.bottom > 860) {
  throw new Error(`model menu escaped the viewport: ${JSON.stringify(modelMenuLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "model-picker.png") });
await page.keyboard.press("Escape");

await page.locator(".permission-select .composer-select-trigger").click();
const permissionMenuLayout = await page.locator(".permission-select .composer-select-menu").evaluate((element) => element.getBoundingClientRect().toJSON());
if (permissionMenuLayout.left < 0 || permissionMenuLayout.top < 0 || permissionMenuLayout.right > 1320 || permissionMenuLayout.bottom > 860) {
  throw new Error(`permission menu escaped the viewport: ${JSON.stringify(permissionMenuLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "permission-picker.png") });
await page.keyboard.press("Escape");

const localDeleteRow = page.locator(".task-row", { hasText: "添加数据导出功能" });
await localDeleteRow.hover();
const conversationActionLayout = await localDeleteRow.locator(".task-pin, .task-rename, .task-delete").evaluateAll((elements) => (
  elements
    .filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => element.getBoundingClientRect().toJSON())
));
const localDeleteRowLayout = await localDeleteRow.evaluate((element) => element.getBoundingClientRect().toJSON());
if (conversationActionLayout.length !== 3) throw new Error("conversation pin/rename/delete actions were not all available on hover");
for (let index = 0; index < conversationActionLayout.length; index += 1) {
  const action = conversationActionLayout[index];
  if (action.left < localDeleteRowLayout.left || action.right > localDeleteRowLayout.right) {
    throw new Error(`conversation action escaped its row: ${JSON.stringify(conversationActionLayout)}`);
  }
  if (index > 0 && action.left < conversationActionLayout[index - 1].right) {
    throw new Error(`conversation actions overlap: ${JSON.stringify(conversationActionLayout)}`);
  }
}
await localDeleteRow.hover();
await localDeleteRow.locator(".task-delete").click();
await page.waitForSelector(".delete-confirm-dialog");
const deleteDialogLayout = await page.locator(".delete-confirm-dialog").evaluate((element) => element.getBoundingClientRect().toJSON());
if (deleteDialogLayout.left < 0 || deleteDialogLayout.top < 0 || deleteDialogLayout.right > 1320 || deleteDialogLayout.bottom > 860) {
  throw new Error(`delete confirmation escaped the viewport: ${JSON.stringify(deleteDialogLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "delete-confirm-dialog.png") });
await page.locator(".delete-confirm-button.secondary").click();
await page.waitForSelector(".delete-confirm-dialog", { state: "detached" });
await page.waitForFunction(() => document.activeElement?.matches(".composer textarea"));

const activeConversationBeforeCollapse = await page.locator(".task-row.active").getAttribute("data-conversation-id");
await page.locator(".composer textarea").fill("折叠项目时保留的草稿");
await page.locator(".project-toggle").click();
await page.waitForSelector(".project-conversations", { state: "detached" });
if (
  await page.locator(".composer textarea").inputValue() !== "折叠项目时保留的草稿" ||
  await page.locator(".project-empty-view").count() !== 0
) {
  throw new Error("collapsing the active project closed its conversation or discarded its draft");
}
await page.screenshot({ path: resolve(artifacts, "collapsed-project-active-conversation.png") });
await page.locator(".project-toggle").click();
await page.waitForSelector(`[data-conversation-id="${activeConversationBeforeCollapse}"]`);

await page.locator(".settings-trigger").click();
await page.waitForSelector(".settings-popover");
const settingsLayout = await page.evaluate(() => ({
  sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().toJSON(),
  popover: document.querySelector(".settings-popover")?.getBoundingClientRect().toJSON(),
}));
if (
  !settingsLayout.sidebar ||
  !settingsLayout.popover ||
  settingsLayout.popover.left < settingsLayout.sidebar.left ||
  settingsLayout.popover.right > settingsLayout.sidebar.right ||
  settingsLayout.popover.top < settingsLayout.sidebar.top
) throw new Error(`settings popover escaped the sidebar: ${JSON.stringify(settingsLayout)}`);
await page.screenshot({ path: resolve(artifacts, "settings-popover.png") });
await page.locator(".setting-update-button").click();
await page.waitForSelector(".update-dialog");
const updateDialogText = await page.locator(".update-dialog").textContent();
if (!updateDialogText?.includes("更新内容") || !updateDialogText.includes("修复 & 优化 Portable 更新") || updateDialogText.includes("<h2>")) {
  throw new Error("GitHub release notes were not converted to readable text");
}
if (await page.locator(".update-ignore-button").count() !== 1) throw new Error("update dialog did not show the per-version suppression action");
const updateDialogLayout = await page.locator(".update-dialog").evaluate((element) => element.getBoundingClientRect().toJSON());
if (updateDialogLayout.left < 0 || updateDialogLayout.top < 0 || updateDialogLayout.right > 1320 || updateDialogLayout.bottom > 860) {
  throw new Error(`update dialog escaped the viewport: ${JSON.stringify(updateDialogLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "update-dialog.png") });
await page.locator(".update-later-button").click();
await page.locator(".settings-trigger").click();

const branchAction = page.locator('[aria-label="从这里分叉"]');
if (await branchAction.count() !== 1) throw new Error("completed assistant message did not expose a branch action");
await page.evaluate(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});
await page.locator(".composer").hover({ position: { x: 12, y: 12 } });
await page.waitForFunction(() => {
  const action = document.querySelector('[aria-label="从这里分叉"]');
  return action?.parentElement && Number(getComputedStyle(action.parentElement).opacity) < 0.05;
});
if (Number(await branchAction.evaluate((element) => getComputedStyle(element.parentElement).opacity)) >= 0.05) {
  throw new Error("message branch action was visible before hover");
}
await page.locator(".message.assistant").hover();
await page.waitForFunction(() => {
  const action = document.querySelector('[aria-label="从这里分叉"]');
  return action?.parentElement && Number(getComputedStyle(action.parentElement).opacity) > 0.9;
});
if (Number(await branchAction.evaluate((element) => getComputedStyle(element.parentElement).opacity)) < 0.9) {
  throw new Error("message branch action was not visible on hover");
}
await page.screenshot({ path: resolve(artifacts, "message-branch-action.png") });

const visualUserMessage = page.locator(".message.user");
await visualUserMessage.hover();
await page.waitForFunction(() => {
  const actions = document.querySelector(".message.user .message-actions");
  return actions && Number(getComputedStyle(actions).opacity) > 0.9;
});
if (await visualUserMessage.locator('[aria-label="复制"]').count() !== 1) throw new Error("user message did not expose a copy action");
if (await visualUserMessage.locator('[aria-label="编辑并重新发送"]').count() !== 1) throw new Error("last user message did not expose an edit action");
await page.screenshot({ path: resolve(artifacts, "user-message-actions.png") });

const initialSidebarWidth = await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().width);
const resizeHandle = page.locator(".sidebar-resizer");
const resizeBox = await resizeHandle.boundingBox();
if (!resizeBox) throw new Error("sidebar resize handle was not rendered");
await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + 100);
await page.mouse.down();
await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 120, resizeBox.y + 100, { steps: 8 });
await page.mouse.up();
const resizedSidebarWidth = await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().width);
if (resizedSidebarWidth < initialSidebarWidth + 110) throw new Error("sidebar drag did not increase its width");
await page.waitForFunction((expectedWidth) => Number(localStorage.getItem("claude-desk.sidebar-width.v1")) === expectedWidth, resizedSidebarWidth);

await page.locator(".composer textarea").evaluate((textarea) => {
  const transfer = new DataTransfer();
  const binary = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av7sNwAAAABJRU5ErkJggg==");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  transfer.items.add(new File([bytes], "界面截图.png", { type: "image/png" }));
  transfer.items.add(new File(["visual attachment"], "需求说明与接口字段记录.txt", { type: "text/plain" }));
  textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
});
await page.waitForFunction(() => document.querySelectorAll(".attachment-item").length === 2);
await page.screenshot({ path: resolve(artifacts, "attachments.png") });
await page.locator('.attachment-open[aria-label="预览 界面截图.png"]').click();
const attachmentPreviewLayout = await page.locator(".attachment-preview-dialog").evaluate((element) => element.getBoundingClientRect().toJSON());
if (
  attachmentPreviewLayout.left < 0 ||
  attachmentPreviewLayout.top < 0 ||
  attachmentPreviewLayout.right > 1320 ||
  attachmentPreviewLayout.bottom > 860
) throw new Error(`attachment preview escaped the desktop viewport: ${JSON.stringify(attachmentPreviewLayout)}`);
await page.screenshot({ path: resolve(artifacts, "attachment-preview.png") });
await page.locator('[aria-label="关闭附件预览"]').click();

const layout = await page.evaluate(() => ({
  body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  composer: document.querySelector(".composer")?.getBoundingClientRect().toJSON(),
  attachmentList: document.querySelector(".attachment-list")?.getBoundingClientRect().toJSON(),
  header: document.querySelector(".task-header")?.getBoundingClientRect().toJSON(),
}));

await page.setViewportSize({ width: 900, height: 640 });
if (await page.locator('[aria-label="压缩上下文"]').count() !== 1) throw new Error("context compact button was not visible in the compact viewport");
await page.waitForTimeout(100);
await page.locator('.attachment-open[aria-label="预览 界面截图.png"]').click();
const compactAttachmentPreviewLayout = await page.locator(".attachment-preview-dialog").evaluate((element) => element.getBoundingClientRect().toJSON());
if (
  compactAttachmentPreviewLayout.left < 0 ||
  compactAttachmentPreviewLayout.top < 0 ||
  compactAttachmentPreviewLayout.right > 900 ||
  compactAttachmentPreviewLayout.bottom > 640
) throw new Error(`attachment preview escaped the compact viewport: ${JSON.stringify(compactAttachmentPreviewLayout)}`);
await page.screenshot({ path: resolve(artifacts, "attachment-preview-compact.png") });
await page.keyboard.press("Escape");
await editActivity.locator(".activity-row").click();
const compactActivityDetailLayout = await editActivity.locator(".activity-detail").evaluate((element) => element.getBoundingClientRect().toJSON());
if (compactActivityDetailLayout.left < 0 || compactActivityDetailLayout.right > 900 || compactActivityDetailLayout.width <= 0) {
  throw new Error(`expanded tool diff escaped the compact viewport: ${JSON.stringify(compactActivityDetailLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "expanded-tool-diff-compact.png") });
await editActivity.locator(".activity-row").click();
await page.locator(".task-title-command").click();
const compactCommandPopoverLayout = await page.locator(".cli-command-popover").evaluate((element) => element.getBoundingClientRect().toJSON());
if (compactCommandPopoverLayout.left < 0 || compactCommandPopoverLayout.top < 0 || compactCommandPopoverLayout.right > 900 || compactCommandPopoverLayout.bottom > 640) {
  throw new Error(`CMD command popover escaped the compact viewport: ${JSON.stringify(compactCommandPopoverLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "cli-resume-command-compact.png") });
await page.locator('[aria-label="关闭 CMD 命令"]').click();
const restingProjectActions = await page.locator(".project-row .project-action").evaluateAll((elements) => (
  elements.filter((element) => getComputedStyle(element).display !== "none").length
));
if (restingProjectActions !== 0) throw new Error("project actions were visible before hover");
if (Number(await page.locator(".project-drag-handle").evaluate((element) => getComputedStyle(element).opacity)) > 0.05) {
  throw new Error("project drag handle was visible before hover");
}
await page.locator(".project-row").hover();
const compactLayout = await page.evaluate(() => ({
  body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  projectRow: document.querySelector(".project-row")?.getBoundingClientRect().toJSON(),
  projectActions: [...document.querySelectorAll(".project-row .project-action")]
    .filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => element.getBoundingClientRect().toJSON()),
  projectDragHandle: document.querySelector(".project-drag-handle")?.getBoundingClientRect().toJSON(),
}));
await page.screenshot({ path: resolve(artifacts, "compact.png") });
if (compactLayout.body.width !== compactLayout.viewport.width || compactLayout.body.height !== compactLayout.viewport.height) {
  throw new Error(`compact layout overflow: ${JSON.stringify(compactLayout)}`);
}
if (compactLayout.projectActions.length !== 5) throw new Error("project actions were not all available on hover");
for (let index = 1; index < compactLayout.projectActions.length; index += 1) {
  if (compactLayout.projectActions[index].left < compactLayout.projectActions[index - 1].right) {
    throw new Error(`project actions overlap: ${JSON.stringify(compactLayout.projectActions)}`);
  }
}
if (
  !compactLayout.projectRow ||
  !compactLayout.projectDragHandle ||
  compactLayout.projectDragHandle.left < compactLayout.projectRow.left ||
  compactLayout.projectDragHandle.right > compactLayout.projectRow.right
) throw new Error(`project drag handle escaped its row: ${JSON.stringify(compactLayout)}`);

await page.locator(".model-select .composer-select-trigger").click();
const compactModelMenuLayout = await page.locator(".model-select .composer-select-menu").evaluate((element) => element.getBoundingClientRect().toJSON());
if (compactModelMenuLayout.left < 0 || compactModelMenuLayout.top < 0 || compactModelMenuLayout.right > 900 || compactModelMenuLayout.bottom > 640) {
  throw new Error(`compact model menu escaped the viewport: ${JSON.stringify(compactModelMenuLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "model-picker-compact.png") });
await page.keyboard.press("Escape");

await localDeleteRow.hover();
await localDeleteRow.locator(".task-delete").evaluate((button) => button.click());
const compactDeleteDialogLayout = await page.locator(".delete-confirm-dialog").evaluate((element) => element.getBoundingClientRect().toJSON());
if (compactDeleteDialogLayout.left < 0 || compactDeleteDialogLayout.top < 0 || compactDeleteDialogLayout.right > 900 || compactDeleteDialogLayout.bottom > 640) {
  throw new Error(`compact delete confirmation escaped the viewport: ${JSON.stringify(compactDeleteDialogLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "delete-confirm-dialog-compact.png") });
await page.locator(".delete-confirm-button.secondary").click();

await page.locator(".settings-trigger").click();
await page.locator(".setting-update-button").click();
await page.waitForSelector(".update-dialog");
if (await page.locator(".update-ignore-button").count() !== 1) throw new Error("compact update dialog hid the per-version suppression action");
const compactUpdateDialogLayout = await page.locator(".update-dialog").evaluate((element) => element.getBoundingClientRect().toJSON());
if (compactUpdateDialogLayout.left < 0 || compactUpdateDialogLayout.top < 0 || compactUpdateDialogLayout.right > 900 || compactUpdateDialogLayout.bottom > 640) {
  throw new Error(`compact update dialog escaped the viewport: ${JSON.stringify(compactUpdateDialogLayout)}`);
}
await page.screenshot({ path: resolve(artifacts, "update-dialog-compact.png") });
await page.locator(".update-later-button").click();

await page.locator(".composer textarea").fill("大量权限测试");
await page.locator(".composer textarea").press("Enter");
await page.waitForSelector(".permission-dialog");
const longPermissionLayout = await page.evaluate(() => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  dialog: document.querySelector(".permission-dialog")?.getBoundingClientRect().toJSON(),
  tools: (() => {
    const element = document.querySelector(".permission-tools");
    return element ? { ...element.getBoundingClientRect().toJSON(), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight } : null;
  })(),
  actions: document.querySelector(".permission-actions")?.getBoundingClientRect().toJSON(),
}));
if (
  !longPermissionLayout.dialog ||
  !longPermissionLayout.tools ||
  !longPermissionLayout.actions ||
  longPermissionLayout.dialog.top < 0 ||
  longPermissionLayout.dialog.bottom > longPermissionLayout.viewport.height ||
  longPermissionLayout.actions.bottom > longPermissionLayout.dialog.bottom ||
  longPermissionLayout.tools.scrollHeight <= longPermissionLayout.tools.clientHeight
) throw new Error(`long permission dialog did not keep its actions visible: ${JSON.stringify(longPermissionLayout)}`);
if (await page.locator(".permission-actions .permission-button").count() !== 3) throw new Error("long permission dialog hid an action button");
await page.screenshot({ path: resolve(artifacts, "permission-dialog-long-compact.png") });
await page.locator(".permission-deny").click();
await page.waitForSelector(".permission-dialog", { state: "detached" });

await page.locator(".composer textarea").fill("/plan");
await page.locator(".composer textarea").press("Enter");
await page.locator(".composer textarea").fill("计划交互问题测试");
await page.locator(".composer textarea").press("Enter");
await page.waitForSelector(".user-question-dialog");
const userQuestionLayout = await page.evaluate(() => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  dialog: document.querySelector(".user-question-dialog")?.getBoundingClientRect().toJSON(),
  actions: document.querySelector(".user-question-dialog .permission-actions")?.getBoundingClientRect().toJSON(),
}));
if (
  !userQuestionLayout.dialog || !userQuestionLayout.actions ||
  userQuestionLayout.dialog.top < 0 || userQuestionLayout.dialog.bottom > userQuestionLayout.viewport.height ||
  userQuestionLayout.actions.bottom > userQuestionLayout.dialog.bottom
) throw new Error(`user question dialog escaped the compact viewport: ${JSON.stringify(userQuestionLayout)}`);
await page.screenshot({ path: resolve(artifacts, "user-question-dialog-compact.png") });
await page.locator(".user-question-option", { hasText: "按章节拆分" }).click();
await page.locator(".user-question-dialog .permission-button.primary").click();
await page.waitForSelector(".user-question-dialog", { state: "detached" });

await page.locator(".composer textarea").fill("慢任务");
await page.locator(".composer textarea").press("Enter");
await page.waitForSelector('.message.assistant[data-status="running"]');
for (const prompt of ["紧凑队列第一条", "紧凑队列第二条", "紧凑队列第三条"]) {
  await page.locator(".composer textarea").fill(prompt);
  await page.locator(".send-button:not(.stop)").click();
}
await page.waitForFunction(() => document.querySelectorAll(".prompt-queue-item").length === 3);
const compactQueueLayout = await page.evaluate(() => ({
  body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  queue: document.querySelector(".prompt-queue")?.getBoundingClientRect().toJSON(),
  composer: document.querySelector(".composer")?.getBoundingClientRect().toJSON(),
}));
if (
  compactQueueLayout.body.width !== compactQueueLayout.viewport.width ||
  compactQueueLayout.body.height !== compactQueueLayout.viewport.height ||
  !compactQueueLayout.queue ||
  !compactQueueLayout.composer ||
  compactQueueLayout.queue.left < 0 ||
  compactQueueLayout.queue.right > compactQueueLayout.viewport.width ||
  compactQueueLayout.composer.bottom > compactQueueLayout.viewport.height
) throw new Error(`compact prompt queue overflow: ${JSON.stringify(compactQueueLayout)}`);
await page.screenshot({ path: resolve(artifacts, "prompt-queue-compact.png") });
await page.locator(".send-button.stop").click();

console.log(JSON.stringify({ errors, modelMenuLayout, permissionMenuLayout, compactModelMenuLayout, deleteDialogLayout, compactDeleteDialogLayout, updateDialogLayout, compactUpdateDialogLayout, settingsLayout, layout, compactLayout, compactQueueLayout, longPermissionLayout, userQuestionLayout }, null, 2));
await electronApp.close();

if (errors.length > 0) process.exitCode = 1;
} finally {
  await electronApp.close().catch(() => undefined);
}
