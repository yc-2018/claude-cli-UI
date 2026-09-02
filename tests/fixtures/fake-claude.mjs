import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("99.0.0 (Fake Claude CLI)\n");
  process.exit(0);
}

process.stdin.setEncoding("utf8");
let slowTaskActive = false;
const deferredInputs = [];
const pendingControlResponses = new Map();
const processPrompt = (input) => {
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
  if (slowTaskActive) {
    deferredInputs.push(input);
    return;
  }
  const resumeIndex = args.indexOf("--resume");
  const resumedSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
  const sessionId = resumedSessionId ?? (prompt.includes("第二个")
    ? "33333333-3333-4333-8333-333333333333"
    : prompt.includes("时间线排序测试")
      ? "66666666-6666-4666-8666-666666666666"
    : prompt.includes("后台托盘测试")
      ? "55555555-5555-4555-8555-555555555555"
      : "22222222-2222-4222-8222-222222222222");
  const modelIndex = args.indexOf("--model");
  const modelRole = modelIndex >= 0 ? args[modelIndex + 1] : "sonnet";
  const roleName = modelRole.charAt(0).toUpperCase() + modelRole.slice(1).toLowerCase();
  const testModels = JSON.parse(process.env.CLAUDE_DESK_TEST_MODELS ?? "{}");
  const model = testModels[roleName] ?? modelRole;
  const effortIndex = args.indexOf("--effort");
  const effort = effortIndex >= 0 ? args[effortIndex + 1] : undefined;
  if (prompt.includes("计划交互问题测试") && process.env.CLAUDE_DESK_TEST_EXPECT_EFFORT === "high" && effort !== "high") {
    process.stderr.write(`unexpected thinking effort: ${effort ?? "missing"}`);
    process.exitCode = 2;
    return;
  }
  const allowedToolsIndex = args.indexOf("--allowedTools");
  const allowedTools = allowedToolsIndex >= 0 ? args[allowedToolsIndex + 1].split(",") : [];
  const sessionNameIndex = args.indexOf("--name");
  const sessionName = sessionNameIndex >= 0 ? args[sessionNameIndex + 1] : undefined;
  const isResume = args.includes("--resume");
  if (prompt.includes("这是首次会话名称测试内容") && !args.includes("--dangerously-skip-permissions")) {
    process.stderr.write("dangerously skip permissions flag was not passed");
    process.exitCode = 2;
    return;
  }
  const send = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
  const slashCommandDescriptions = {
    "/story": "运行故事写作工作流",
    "/compact": "压缩当前对话上下文，保留关键内容",
  };
  if (prompt.includes("这是首次会话名称测试内容") && !isResume && sessionName !== "手动会话名") {
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
    setImmediate(() => process.exit(2));
    return;
  }
  if (prompt.trim() === "/compact") {
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"], slash_command_descriptions: slashCommandDescriptions });
    send({ type: "system", subtype: "context_usage", context_window: { used_tokens: 120000, context_window: 200000, used_percentage: 60, remaining_percentage: 40 }, session_id: sessionId });
    send({ type: "system", subtype: "compact_boundary", session_id: sessionId, compactMetadata: { trigger: "manual", preTokens: 120000, postTokens: 14000, durationMs: 25 } });
    send({ type: "user", isCompactSummary: true, message: { role: "user", content: [{ type: "text", text: "已保留项目目标、关键决策和未完成事项。" }] }, session_id: sessionId });
    send({ type: "result", subtype: "success", is_error: false, result: "上下文压缩完成。", session_id: sessionId });
    return;
  }
  if (prompt.includes("空响应")) {
    setImmediate(() => process.exit(0));
    return;
  }
  if (prompt.includes("结束事件缺失测试")) {
    const response = "最终总结已经输出，但 Claude CLI 不再发送 result 事件。";
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: response }], stop_reason: "end_turn" },
      session_id: sessionId,
    });
    return;
  }
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
    slowTaskActive = true;
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    setTimeout(() => {
      const response = "慢任务阶段完成。";
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: response }] }, session_id: sessionId });
      send({ type: "result", subtype: "success", is_error: false, result: response, session_id: sessionId });
      slowTaskActive = false;
      for (const deferredInput of deferredInputs.splice(0)) processPrompt(deferredInput);
    }, 8_000);
    return;
  }

  if (prompt.includes("大量权限测试")) {
    const permissionDenials = Array.from({ length: 30 }, (_, index) => ({
      tool_name: "Bash",
      tool_use_id: `tool-bash-${index}`,
      tool_input: { command: `curl -sL -o artifact-${index}.zip https://example.com/assets/${index}` },
    }));
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "需要授权批量工具调用。",
      session_id: sessionId,
      permission_denials: permissionDenials,
    });
    return;
  }

  if (prompt.includes("权限测试") && !allowedTools.includes("WebSearch")) {
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "我先保留这段阶段性说明，再申请搜索权限。" }] },
      session_id: sessionId,
    });
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

  if (prompt.includes("思考阶段测试")) {
    const thinking = "先分析问题，再开始输出结论。";
    const response = "已经进入回答阶段。";
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
      session_id: sessionId,
    });
    setTimeout(() => {
      send({
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: response } },
        session_id: sessionId,
      });
      send({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: response }] },
        session_id: sessionId,
      });
      setTimeout(() => {
        send({ type: "result", subtype: "success", is_error: false, result: response, session_id: sessionId });
      }, 1_200);
    }, 350);
    return;
  }

  if (prompt.includes("计划询问测试")) {
    const permissionModeIndex = args.indexOf("--permission-mode");
    if (permissionModeIndex < 0 || args[permissionModeIndex + 1] !== "plan") {
      process.stderr.write("plan permission mode was not passed");
      process.exitCode = 2;
      return;
    }
    const tool = {
      type: "tool_use",
      id: "tool-plan-question",
      name: "AskUserQuestion",
      input: {
        questions: [{
          question: "最终交付几份文稿？",
          header: "交付形式",
          multiSelect: false,
          options: [
            { label: "一份完整文稿", description: "将全部内容合并为一个文件。" },
            { label: "按章节拆分", description: "每章单独生成一个文件。", preview: "第 1 章\n第 2 章" },
          ],
        }],
      },
    };
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    send({ type: "assistant", message: { role: "assistant", content: [tool] }, session_id: sessionId });
    send({ type: "result", subtype: "success", is_error: false, result: "等待用户确认交付形式。", session_id: sessionId });
    return;
  }

  if (prompt.includes("计划交互问题测试")) {
    const permissionModeIndex = args.indexOf("--permission-mode");
    if (permissionModeIndex < 0 || args[permissionModeIndex + 1] !== "plan") {
      process.stderr.write("plan permission mode was not passed");
      process.exitCode = 2;
      return;
    }
    const requestId = "control-plan-question";
    const input = {
      questions: [{
        question: "最终交付几份文稿？",
        header: "交付形式",
        multiSelect: false,
        options: [
          { label: "一份完整文稿", description: "将全部内容合并为一个文件。" },
          { label: "按章节拆分", description: "每章单独生成一个文件。" },
        ],
      }],
    };
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tool-plan-question", name: "AskUserQuestion", input }] }, session_id: sessionId });
    send({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: "tool-plan-question", requires_user_interaction: true }, session_id: sessionId });
    pendingControlResponses.set(requestId, ({ response }) => {
      const answers = response?.response?.updatedInput?.answers;
      const answer = answers && typeof answers === "object" ? Object.values(answers)[0] : "";
      const result = typeof answer === "string" && answer ? `你选择了：${answer}` : "你没有选择任何选项（问题被跳过了）。";
      send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-plan-question", content: result }] }, session_id: sessionId });
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: result }] }, session_id: sessionId });
      send({ type: "result", subtype: "success", is_error: false, result, session_id: sessionId });
    });
    return;
  }

  if (prompt.includes("时间线排序测试")) {
    send({ type: "system", subtype: "init", session_id: sessionId, model, slash_commands: ["story", "compact"] });
    const phases = [
      {
        text: "先说明当前处理方案。",
        tool: {
          id: "tool-edit-order",
          name: "Edit",
          input: {
            file_path: "src/App.tsx",
            old_string: "const before = true;",
            new_string: "const after = true;\nconst checked = true;",
          },
        },
        result: {
          content: "Updated src/App.tsx",
          tool_use_result: {
            type: "update",
            filePath: "src/App.tsx",
            structuredPatch: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 2, lines: ["-const before = true;", "+const after = true;", "+const checked = true;"] }],
          },
        },
      },
      {
        text: "编辑已经完成，继续检查。",
        tool: { id: "tool-bash-order", name: "Bash", input: { command: "npm test" } },
        result: {
          content: "All tests passed.",
          tool_use_result: { stdout: "All tests passed.", stderr: "" },
        },
      },
    ];
    for (const phase of phases) {
      send({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        session_id: sessionId,
      });
      send({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: phase.text } },
        session_id: sessionId,
      });
      send({
        type: "stream_event",
        event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", ...phase.tool } },
        session_id: sessionId,
      });
      send({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: phase.text }, { type: "tool_use", ...phase.tool }] },
        session_id: sessionId,
      });
      send({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: phase.tool.id, content: phase.result.content }] },
        tool_use_result: phase.result.tool_use_result,
        session_id: sessionId,
      });
    }
    const summary = "最终总结已经完成。";
    send({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      session_id: sessionId,
    });
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: summary } },
      session_id: sessionId,
    });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: summary }] }, session_id: sessionId });
    send({ type: "result", subtype: "success", is_error: false, result: summary, session_id: sessionId });
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
    slash_command_descriptions: slashCommandDescriptions,
    context_window: { used_tokens: 8000, context_window: 200000, used_percentage: 4, remaining_percentage: 96 },
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
};

let lineBuffer = "";
process.stdin.on("data", (chunk) => {
  lineBuffer += chunk;
  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "control_response") {
        const requestId = parsed.response?.request_id;
        const handler = typeof requestId === "string" ? pendingControlResponses.get(requestId) : undefined;
        if (handler) {
          pendingControlResponses.delete(requestId);
          handler(parsed);
        }
        continue;
      }
      if (parsed.type === "control_request") continue;
    } catch {
      // The regular stream-input validation reports malformed user messages.
    }
    processPrompt(line);
  }
});
process.stdin.on("end", () => {
  if (lineBuffer.trim()) processPrompt(lineBuffer);
});
