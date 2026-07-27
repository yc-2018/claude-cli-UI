import { _electron as electron } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const profile = resolve(artifacts, `visual-profile-${Date.now()}`);
await mkdir(artifacts, { recursive: true });

const electronApp = await electron.launch({
  args: [root],
  cwd: root,
  env: {
    ...process.env,
    CLAUDE_DESK_USER_DATA_DIR: profile,
    CLAUDE_DESK_DISABLE_PROJECT_DISCOVERY: "1",
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

await page.evaluate(() => {
  const now = Date.now();
  const key = "claude-desk.projects.v2";
  const originalSetItem = Storage.prototype.setItem;
  const seededProjects = [{
    id: "visual-project",
    name: "sample-dashboard",
    workspace: "C:\\Projects\\sample-dashboard",
    createdAt: now,
    updatedAt: now,
    conversations: [{
      id: "visual-conversation",
      title: "检查登录流程并修复会话恢复",
      createdAt: now,
      updatedAt: now,
      sessionId: "11111111-1111-4111-8111-111111111111",
      gitBranch: "feature/auth-session-refresh",
      resolvedModel: "LongCat-2.0",
      permissionMode: "acceptEdits",
      slashCommands: ["/story", "/compact"],
      messages: [
        { id: "u1", role: "user", content: "检查登录流程，找出刷新后会退出的问题并修复。", createdAt: now - 2000 },
        {
          id: "a1",
          role: "assistant",
          content: "问题出在会话初始化顺序：页面在令牌恢复完成前就触发了未登录跳转。\n\n我调整了初始化状态，并补充了回归测试：\n\n```ts\nif (session.status === 'loading') return;\n```\n\n现在刷新页面会等待会话恢复后再判断路由。",
          createdAt: now - 1000,
          status: "done",
          activities: [
            { id: "t1", name: "Grep", summary: "session status" },
            { id: "t2", name: "Read", summary: "src/auth/session.ts" },
            { id: "t3", name: "Edit", summary: "src/router/guard.ts" }
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
});
await page.waitForSelector(".composer");
await page.screenshot({ path: resolve(artifacts, "conversation.png") });

const branchAction = page.locator('[aria-label="从这里分叉"]');
if (await branchAction.count() !== 1) throw new Error("completed assistant message did not expose a branch action");
if (await branchAction.evaluate((element) => getComputedStyle(element.parentElement).opacity) !== "0") {
  throw new Error("message branch action was visible before hover");
}
await page.locator(".message.assistant").hover();
await page.waitForTimeout(150);
if (Number(await branchAction.evaluate((element) => getComputedStyle(element.parentElement).opacity)) < 0.9) {
  throw new Error("message branch action was not visible on hover");
}
await page.screenshot({ path: resolve(artifacts, "message-branch-action.png") });

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

const layout = await page.evaluate(() => ({
  body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  composer: document.querySelector(".composer")?.getBoundingClientRect().toJSON(),
  attachmentList: document.querySelector(".attachment-list")?.getBoundingClientRect().toJSON(),
  header: document.querySelector(".task-header")?.getBoundingClientRect().toJSON(),
}));

await page.setViewportSize({ width: 900, height: 640 });
await page.waitForTimeout(100);
const restingProjectActions = await page.locator(".project-row .project-action").evaluateAll((elements) => (
  elements.filter((element) => getComputedStyle(element).display !== "none").length
));
if (restingProjectActions !== 0) throw new Error("project actions were visible before hover");
await page.locator(".project-row").hover();
const compactLayout = await page.evaluate(() => ({
  body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  projectRow: document.querySelector(".project-row")?.getBoundingClientRect().toJSON(),
  projectActions: [...document.querySelectorAll(".project-row .project-action")]
    .filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => element.getBoundingClientRect().toJSON()),
}));
await page.screenshot({ path: resolve(artifacts, "compact.png") });
if (compactLayout.body.width !== compactLayout.viewport.width || compactLayout.body.height !== compactLayout.viewport.height) {
  throw new Error(`compact layout overflow: ${JSON.stringify(compactLayout)}`);
}
if (compactLayout.projectActions.length !== 4) throw new Error("project actions were not all available on hover");
for (let index = 1; index < compactLayout.projectActions.length; index += 1) {
  if (compactLayout.projectActions[index].left < compactLayout.projectActions[index - 1].right) {
    throw new Error(`project actions overlap: ${JSON.stringify(compactLayout.projectActions)}`);
  }
}

console.log(JSON.stringify({ errors, layout, compactLayout }, null, 2));
await electronApp.close();

if (errors.length > 0) process.exitCode = 1;
} finally {
  await electronApp.close().catch(() => undefined);
}
