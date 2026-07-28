import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("99.0.0 (Fake Claude CLI)\n");
  process.exit(0);
}

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const usesStreamInput = args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json";
  let streamContent = [];
  let prompt = input;
  if (usesStreamInput) {
    try {
      const message = JSON.parse(input.trim());
      if (message.type !== "user" || message.message?.role !== "user" || !Array.isArray(message.message.content)) {
        throw new Error("invalid user message");
      }
      streamContent = message.message.content;
      prompt = streamContent
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    } catch (error) {
      process.stderr.write(`invalid stream-json input: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
      return;
    }
  }
  const resumeIndex = args.indexOf("--resume");
  const resumedSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
  const sessionId = resumedSessionId ?? (prompt.includes("第二个")
    ? "33333333-3333-4333-8333-333333333333"
    : prompt.includes("后台托盘测试")
      ? "55555555-5555-4555-8555-555555555555"
      : "22222222-2222-4222-8222-222222222222");
  const modelIndex = args.indexOf("--model");
  const modelRole = modelIndex >= 0 ? args[modelIndex + 1] : "sonnet";
  const roleName = modelRole.charAt(0).toUpperCase() + modelRole.slice(1).toLowerCase();
  const testModels = JSON.parse(process.env.CLAUDE_DESK_TEST_MODELS ?? "{}");
  const model = testModels[roleName] ?? modelRole;
  const allowedToolsIndex = args.indexOf("--allowedTools");
  const allowedTools = allowedToolsIndex >= 0 ? args[allowedToolsIndex + 1].split(",") : [];
  const sessionNameIndex = args.indexOf("--name");
  const sessionName = sessionNameIndex >= 0 ? args[sessionNameIndex + 1] : undefined;
  const isResume = args.includes("--resume");
  const send = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
  if (prompt.includes("这是首次会话名称测试内容") && sessionName !== "手动会话名") {
    process.stderr.write(`unexpected session name: ${sessionName ?? "missing"}`);
    process.exitCode = 2;
    return;
  }
  if (isResume && sessionName) {
    process.stderr.write("resumed session was renamed");
    process.exitCode = 2;
    return;
  }
  if (prompt.includes("附件回归测试")) {
    const attachmentPaths = prompt.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    const textPath = attachmentPaths.find((path) => path.endsWith(".txt"));
    const imageBlock = streamContent.find((block) => block?.type === "image");
    const addDirectoryIndex = args.indexOf("--add-dir");
    if (!usesStreamInput || addDirectoryIndex < 0 || attachmentPaths.length !== 1 || !textPath || !existsSync(textPath) || !imageBlock) {
      process.stderr.write("attachments were not passed to the CLI");
      process.exitCode = 2;
      return;
    }
    const image = Buffer.from(imageBlock.source?.data ?? "", "base64");
    if (
      imageBlock.source?.type !== "base64" || imageBlock.source?.media_type !== "image/png" ||
      image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      readFileSync(textPath, "utf8") !== "attachment text fixture"
    ) {
      process.stderr.write("attachment contents were corrupted");
      process.exitCode = 2;
      return;
    }
  }
  const sessionsDirectory = process.env.CLAUDE_DESK_FAKE_SESSIONS_DIR ?? process.env.CLAUDE_DESK_TEST_SESSIONS_DIR;
  const persistTestPrompt = prompt.includes("这是首次会话名称测试内容") || prompt.includes("分支继续测试");
  if (sessionsDirectory && persistTestPrompt) {
    mkdirSync(sessionsDirectory, { recursive: true });
    const records = [
      ...(sessionName ? [{ type: "custom-title", customTitle: sessionName, sessionId }] : []),
      {
        type: "user",
        uuid: `${sessionId}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        sessionId,
        permissionMode: "acceptEdits",
        promptSource: "sdk",
        entrypoint: "sdk-cli",
        message: { role: "user", content: prompt.trim() },
      },
    ];
    appendFileSync(resolve(sessionsDirectory, `${sessionId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  }
  if (prompt.includes("模拟失败")) {
    process.stderr.write("模拟 CLI 错误");
    process.exitCode = 2;
    return;
  }
  if (prompt.includes("空响应")) return;
  if (prompt.includes("后台提醒测试") || prompt.includes("后台托盘测试")) {
    const response = prompt.includes("后台提醒测试") ? "后台会话提醒测试完成。" : "托盘后台运行测试完成。";
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    setTimeout(() => {
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: response }] }, session_id: sessionId });
      send({ type: "result", subtype: "success", is_error: false, result: response, session_id: sessionId });
    }, 450);
    return;
  }
  if (prompt.includes("慢任务")) {
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    setTimeout(() => undefined, 10_000);
    return;
  }

  if (prompt.includes("权限测试") && !allowedTools.includes("WebSearch")) {
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tool-web-search", name: "WebSearch", input: { query: "LongCat-2.0 发布公司" } }] },
      session_id: sessionId,
    });
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "需要你授权网络搜索后才能继续。" }] },
      session_id: sessionId,
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "需要你授权网络搜索后才能继续。",
      session_id: sessionId,
      permission_denials: [{ tool_name: "WebSearch", tool_use_id: "tool-web-search", tool_input: { query: "LongCat-2.0 发布公司" } }],
    });
    return;
  }

  if (prompt.includes("滚动锁定测试")) {
    const thinking = "持续输出思考内容，用于验证用户上滑后页面不会跳回底部。".repeat(50);
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    let offset = 0;
    const timer = setInterval(() => {
      const chunk = thinking.slice(offset, offset + 12);
      offset += chunk.length;
      if (chunk) {
        send({
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: chunk } },
          session_id: sessionId,
        });
      }
      if (offset < thinking.length) return;
      clearInterval(timer);
      const response = "滚动锁定测试完成。";
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: response }] }, session_id: sessionId });
      send({ type: "result", subtype: "success", is_error: false, result: response, session_id: sessionId });
    }, 20);
    return;
  }

  const response = `测试通过：${prompt.trim()}。` + "流式输出稳定。".repeat(180);
  const thinking = "先理解用户要求，再检查上下文，最后组织清晰的回答。";

  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    slash_commands: ["story", "compact"],
    permissionMode: "acceptEdits",
  });

  for (const text of thinking) {
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } },
      session_id: sessionId,
    });
  }

  for (const text of response) {
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
      session_id: sessionId,
    });
  }

  send({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: response }] },
    session_id: sessionId,
  });
  if (sessionsDirectory && persistTestPrompt) {
    appendFileSync(resolve(sessionsDirectory, `${sessionId}.jsonl`), `${JSON.stringify({
      type: "assistant",
      uuid: `${sessionId}-assistant-${Date.now()}`,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      sessionId,
      message: {
        id: `${sessionId}-response`,
        role: "assistant",
        model,
        content: [{ type: "thinking", thinking }, { type: "text", text: response }],
      },
    })}\n`, "utf8");
  }
  send({ type: "result", subtype: "success", is_error: false, result: response, session_id: sessionId });
});
