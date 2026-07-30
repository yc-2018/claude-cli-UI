import { _electron as electron } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const profile = resolve(root, "artifacts", `verify-notify-${Date.now()}`);
const claudeConfig = resolve(profile, "claude-config");
const cliSessions = resolve(claudeConfig, "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
const fakeCli = resolve(root, "tests", "fixtures", "fake-claude.mjs");
await mkdir(cliSessions, { recursive: true });

const electronApp = await electron.launch({
  args: ["--no-sandbox", "--disable-gpu", root],
  cwd: root,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_DESK_USER_DATA_DIR: profile,
    CLAUDE_DESK_TEST_WORKSPACE: root,
    CLAUDE_DESK_FAKE_SESSIONS_DIR: cliSessions,
    CLAUDE_DESK_DISABLE_NOTIFICATIONS: "1",
    CLAUDE_DESK_TEST_MODELS: JSON.stringify({ Sonnet: "ThirdParty-A" }),
    CLAUDE_DESK_CLAUDE_EXECUTABLE: process.execPath,
    CLAUDE_DESK_CLAUDE_PREFIX_ARGS: JSON.stringify([fakeCli]),
  },
});

const send = async (page, text) => {
  await page.locator(".composer textarea").fill(text);
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(() => document.querySelector(".message.assistant:last-of-type")?.getAttribute("data-status") === "done");
};

try {
  const page = await electronApp.firstWindow();
  await page.waitForSelector(".sidebar-brand");
  await page.click(".new-task-button");
  await page.waitForSelector(".composer");

  await page.evaluate(() => {
    const original = window.claudeDesk.notifyCompletion;
    window.__calls = [];
    window.claudeDesk.notifyCompletion = (conversationId, title) => {
      window.__calls.push({ conversationId, title });
      return original(conversationId, title);
    };
  });

  await send(page, "前台运行完成测试");
  await page.waitForTimeout(300);
  if (await page.evaluate(() => window.__calls.length) !== 0) throw new Error("focused active run triggered a notification");
  console.log("ok: focused + active conversation stays silent");

  await page.evaluate(() => { document.hasFocus = () => false; });
  await send(page, "失焦运行完成测试");
  await page.waitForFunction(() => window.__calls.length === 1);
  const call = await page.evaluate(() => window.__calls[0]);
  if (!call.title) throw new Error("notification call missing title");
  if (await page.locator(".completion-toast").count() !== 0) throw new Error("toast shown while window was unfocused");
  console.log("ok: visible-but-unfocused window triggers a Windows notification (no toast)");

  await page.evaluate(() => { delete document.hasFocus; });
  console.log("ALL CHECKS PASSED");
} finally {
  await electronApp.close().catch(() => undefined);
}
