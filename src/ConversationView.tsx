import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrainCircuit, Check, ChevronRight, Code2, Copy, FileCode2, GitFork, List, Pencil, Search, Sparkles, TerminalSquare, Wrench } from "lucide-react";
import AttachmentPreview, { attachmentUrl, openAttachmentFile } from "./AttachmentPreview";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Activity, ActivityDetail, ActivityDiffLine, Attachment, ChatMessage, ContextCompaction, ResponseTimelineItem } from "./types";

function getToolIcon(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read") || normalized.includes("file")) return FileCode2;
  if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("glob")) return Search;
  if (normalized.includes("bash") || normalized.includes("terminal")) return TerminalSquare;
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("update")) return Code2;
  return Wrench;
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        code: ({ className, children, ...props }) => <code className={className} {...props}>{children}</code>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function fallbackDiffLines(detail: ActivityDetail): ActivityDiffLine[] {
  if (detail.oldText === undefined && detail.newText === undefined) return [];
  const oldLines = (detail.oldText ?? "").split("\n");
  const newLines = (detail.newText ?? "").split("\n");
  if (detail.oldText === "") oldLines.length = 0;
  if (detail.newText === "") newLines.length = 0;
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const lines: ActivityDiffLine[] = [];
  const prefixStart = Math.max(0, prefix - 3);
  for (let index = prefixStart; index < prefix; index += 1) {
    lines.push({ type: "context", text: oldLines[index], oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    lines.push({ type: "remove", text: oldLines[index], oldLine: index + 1 });
  }
  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    lines.push({ type: "add", text: newLines[index], newLine: index + 1 });
  }
  for (let offset = 0; offset < Math.min(3, suffix); offset += 1) {
    const oldIndex = oldLines.length - suffix + offset;
    const newIndex = newLines.length - suffix + offset;
    lines.push({ type: "context", text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }
  return lines.slice(0, 4_000);
}

function ActivityDetails({ detail }: { detail: ActivityDetail }) {
  const diff = detail.diff ?? fallbackDiffLines(detail);
  const additions = diff.filter((line) => line.type === "add").length;
  const removals = diff.filter((line) => line.type === "remove").length;
  return (
    <div className="activity-detail">
      {detail.path ? <div className="activity-detail-path"><FileCode2 size={13} /><span>{detail.path}</span></div> : null}
      {diff.length > 0 ? (
        <div className="tool-diff">
          <div className="tool-diff-summary">
            {additions > 0 ? <span className="diff-added">+{additions}</span> : null}
            {removals > 0 ? <span className="diff-removed">-{removals}</span> : null}
          </div>
          <div className="tool-diff-lines">
            {diff.map((line, index) => (
              <div className={`tool-diff-line ${line.type}`} key={`${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}>
                <span className="diff-old-line">{line.oldLine ?? ""}</span>
                <span className="diff-new-line">{line.newLine ?? ""}</span>
                <span className="diff-marker">{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span>
                <code>{line.text || " "}</code>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {detail.command ? (
        <div className="activity-detail-section">
          <span>命令</span>
          <pre><code>{detail.command}</code></pre>
        </div>
      ) : null}
      {detail.output ? (
        <div className="activity-detail-section">
          <span>输出</span>
          <pre><code>{detail.output}</code></pre>
        </div>
      ) : null}
      {detail.questions?.map((question, index) => (
        <section className="activity-question" key={`${question.header ?? "question"}-${index}`}>
          {question.header ? <span className="activity-question-header">{question.header}</span> : null}
          <strong>{question.question}</strong>
          {question.options.length > 0 ? (
            <div className="activity-question-options">
              {question.options.map((option, optionIndex) => (
                <div className="activity-question-option" key={`${option.label}-${optionIndex}`}>
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                  {option.preview ? <pre>{option.preview}</pre> : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function ActivityRow({ activity, working }: { activity: Activity; working: boolean }) {
  const [open, setOpen] = useState(Boolean(activity.detail?.questions?.length));
  const entryRef = useRef<HTMLDivElement>(null);
  const Icon = getToolIcon(activity.name);
  const expandable = Boolean(activity.detail && (
    activity.detail.path || activity.detail.command || activity.detail.output || activity.detail.diff?.length ||
    activity.detail.oldText !== undefined || activity.detail.newText !== undefined || activity.detail.questions?.length
  ));
  const rowContent = (
    <>
      <span className={`activity-icon ${working ? "working" : ""}`}>
        {working ? <span className="mini-spinner" /> : <Icon size={14} />}
      </span>
      <span className="activity-name">{activity.name}</span>
      {activity.summary ? <span className="activity-summary">{activity.summary}</span> : null}
      {!working ? <Check className="activity-check" size={13} /> : null}
      {expandable ? <ChevronRight className="activity-chevron" size={13} /> : null}
    </>
  );

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => entryRef.current?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [activity.detail?.diff?.length, activity.detail?.output, open]);

  return (
    <div className={`activity-entry ${open ? "open" : ""}`} data-timeline-kind="activity" ref={entryRef}>
      {expandable ? (
        <button className="activity-row" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {rowContent}
        </button>
      ) : <div className="activity-row">{rowContent}</div>}
      {open && activity.detail ? <ActivityDetails detail={activity.detail} /> : null}
    </div>
  );
}

function ActivityList({ activities, running }: { activities: Activity[]; running: boolean }) {
  if (activities.length === 0) return null;
  return (
    <div className="activity-list">
      {activities.map((activity, index) => {
        const isCurrent = running && index === activities.length - 1;
        return <ActivityRow activity={activity} key={activity.id} working={isCurrent} />;
      })}
    </div>
  );
}

function ResponseTimeline({ activeActivityId, items, running, showActivities }: { activeActivityId?: string; items: ResponseTimelineItem[]; running: boolean; showActivities: boolean }) {
  const lastTextIndex = items.reduce((lastIndex, item, index) => item.type === "text" && item.content ? index : lastIndex, -1);
  return (
    <div className="response-timeline">
      {items.map((item, index) => item.type === "text" ? (
        !showActivities && index !== lastTextIndex ? null : (
        item.content ? (
          <div className="markdown response-text-block" data-timeline-kind="text" key={item.id}>
            <MarkdownMessage content={item.content} />
          </div>
        ) : null
        )
      ) : showActivities ? (
        <ActivityRow
          activity={item.activity}
          key={item.id}
          working={running && activeActivityId === item.activity.id}
        />
      ) : null)}
    </div>
  );
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${remainingSeconds.toString().padStart(2, "0")} 秒` : `${remainingSeconds} 秒`;
}

function ResponseDuration({ running, startedAt, durationMs }: { running: boolean; startedAt?: number; durationMs?: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  const elapsedMs = durationMs ?? (running && startedAt ? Math.max(0, now - startedAt) : undefined);
  const elapsedSeconds = elapsedMs === undefined ? undefined : Math.floor(elapsedMs / 1000);
  if (elapsedSeconds === undefined) return null;

  return (
    <div className="response-duration" data-elapsed-seconds={elapsedSeconds}>
      {running ? <span className="mini-spinner" /> : null}
      {running ? "正在回答" : "本次回答耗时"} · {formatElapsed(elapsedSeconds)}
    </div>
  );
}

function ThinkingBlock({ content, running }: { content: string; running: boolean }) {
  const [open, setOpen] = useState(running);

  useEffect(() => {
    setOpen(running);
  }, [running]);

  return (
    <div className={`thinking-block ${open ? "open" : ""}`}>
      <button className="thinking-toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {running ? <span className="mini-spinner" /> : <BrainCircuit size={14} />}
        <span>{running ? "正在思考" : "思考过程"}</span>
        <ChevronRight className="thinking-chevron" size={14} />
      </button>
      {open ? <div className="thinking-content markdown"><MarkdownMessage content={content} /></div> : null}
    </div>
  );
}

function AssistantResponse({ message }: { message: ChatMessage }) {
  const [showActivities, setShowActivities] = useState(true);
  const activityCount = message.timeline
    ? message.timeline.filter((item) => item.type === "activity").length
    : (message.activities?.length ?? 0);
  return (
    <>
      <ResponseDuration
        durationMs={message.responseDurationMs}
        running={message.status === "running"}
        startedAt={message.responseStartedAt}
      />
      {message.thinking ? (
        <ThinkingBlock
          content={message.thinking}
          running={message.status === "running" && !(
            message.content ||
            (message.activities?.length ?? 0) > 0 ||
            message.timeline?.some((item) => item.type === "activity" || Boolean(item.content))
          )}
        />
      ) : null}
      {activityCount > 0 ? (
        <button
          className="tool-collapse-toggle"
          type="button"
          aria-expanded={showActivities}
          onClick={() => setShowActivities((value) => !value)}
        >
          <List size={13} />
          {showActivities ? "收起工具调用" : `展开工具调用（${activityCount}）`}
        </button>
      ) : null}
      {message.timeline ? (
        <ResponseTimeline
          activeActivityId={message.activeActivityId}
          items={message.timeline}
          running={message.status === "running"}
          showActivities={showActivities}
        />
      ) : (
        <>
          {showActivities ? <ActivityList activities={message.activities ?? []} running={message.status === "running"} /> : null}
          {message.content ? <div className="markdown"><MarkdownMessage content={message.content} /></div> : null}
        </>
      )}
      {message.status === "running" && !message.content && !message.thinking && (message.activities?.length ?? 0) === 0
        ? <div className="thinking"><span className="spinner" />Claude 正在准备回答</div>
        : null}
      {/* 排队中的轮次还没轮到自己，只提示位置，不显示计时也不显示转圈。 */}
      {message.status === "queued"
        ? <div className="queued-hint">排队中 · 等上一条回答结束后开始</div>
        : null}
      {message.error ? <div className="message-error">{message.error}</div> : null}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      aria-label={copied ? "已复制" : "复制"}
      onClick={() => { void copy(); }}
      title={copied ? "已复制" : "复制"}
      type="button"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

interface UserMessageProps {
  message: ChatMessage;
  canEdit: boolean;
  onEditResend?(messageId: string, content: string): void;
}

function UserMessage({ message, canEdit, onEditResend }: UserMessageProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;
  const attachmentCount = message.attachments?.length ?? 0;
  const canSubmit = editing && (draft.trim().length > 0 || attachmentCount > 0);

  useEffect(() => {
    if (!editing || !textareaRef.current) return;
    const textarea = textareaRef.current;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  const submitEdit = () => {
    if (!canSubmit || !onEditResend || draft === null) return;
    const value = draft.trim();
    setDraft(null);
    onEditResend(message.id, value);
  };

  const attachments = attachmentCount > 0 ? (
    <div className="sent-attachments">
      {message.attachments?.map((attachment) => attachment.kind === "image" ? (
        <figure className="sent-image" key={attachment.id}>
          <button aria-label={`预览 ${attachment.name}`} onClick={() => setPreviewAttachment(attachment)} title="预览图片" type="button">
            <img src={attachmentUrl(attachment)} alt={attachment.name} />
            <figcaption title={attachment.name}>{attachment.name}</figcaption>
          </button>
        </figure>
      ) : (
        <button className="sent-file" key={attachment.id} onClick={() => { void openAttachmentFile(attachment); }} title="打开文件" type="button">
          <FileCode2 size={16} />
          <span>{attachment.name}</span>
        </button>
      ))}
    </div>
  ) : null;

  if (editing) {
    return (
      <>
        <AttachmentPreview attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
        <div className="user-bubble editing">
          {attachments}
          <textarea
            ref={textareaRef}
            aria-label="编辑消息"
            onChange={(event) => {
              setDraft(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 220)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitEdit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
            placeholder="编辑消息后重新发送…"
            rows={1}
            value={draft}
          />
          <div className="user-edit-actions">
            <button onClick={() => setDraft(null)} type="button">取消</button>
            <button className="primary" disabled={!canSubmit} onClick={submitEdit} type="button">重新发送</button>
          </div>
        </div>
      </>
    );
  }

  const showActions = Boolean(message.content) || canEdit;
  return (
    <>
      <AttachmentPreview attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
      <div className="user-bubble">
        {attachments}
        {message.content ? <div className="user-message-text">{message.content}</div> : null}
      </div>
      {showActions ? (
        <div className="message-actions user">
          {message.content ? <CopyButton text={message.content} /> : null}
          {canEdit && onEditResend ? (
            <button
              aria-label="编辑并重新发送"
              onClick={() => setDraft(message.content)}
              title="编辑并重新发送"
              type="button"
            >
              <Pencil size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function CompactionCard({ compaction }: { compaction: ContextCompaction }) {
  return (
    <div className={`context-compaction ${compaction.status}`} data-compaction-id={compaction.id}>
      <span className="context-compaction-icon"><BrainCircuit size={14} /></span>
      <span className="context-compaction-copy">
        <strong>{compaction.status === "running" ? "正在压缩上下文" : compaction.status === "error" ? "上下文压缩失败" : "上下文已压缩"}</strong>
        <small>
          {compaction.status === "done" && compaction.preTokens !== undefined && compaction.postTokens !== undefined
            ? `${compaction.trigger === "auto" ? "自动" : "手动"} · ${compaction.preTokens.toLocaleString()} → ${compaction.postTokens.toLocaleString()} tokens`
            : compaction.error ?? "Claude 正在整理较早的对话内容"}
        </small>
      </span>
      {compaction.summary ? <details><summary>查看摘要</summary><div className="context-compaction-summary"><MarkdownMessage content={compaction.summary} /></div></details> : null}
    </div>
  );
}

interface ConversationViewProps {
  messages: ChatMessage[];
  contextCompactions?: ContextCompaction[];
  loadingHistory?: boolean;
  branchDisabled?: boolean;
  editDisabled?: boolean;
  onBranch?(userTurn: number): void;
  onEditResend?(messageId: string, content: string): void;
}

export default function ConversationView({ messages, contextCompactions = [], loadingHistory = false, branchDisabled = false, editDisabled = false, onBranch, onEditResend }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const latest = messages.at(-1);
  useLayoutEffect(() => {
    const newMessageWasAdded = messages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    if (newMessageWasAdded) stickToBottomRef.current = true;
    if (!stickToBottomRef.current) return;
    const scrollToBottom = () => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    };
    scrollToBottom();
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
  }, [messages.length, contextCompactions.length, latest?.id, latest?.content.length, latest?.thinking?.length, latest?.activities?.length, latest?.error, latest?.status]);

  if (loadingHistory) {
    return (
      <div className="conversation-intro history-loading">
        <span className="spinner" />
        <h1>正在载入历史记录</h1>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="conversation-intro">
        <div className="intro-mark"><Sparkles size={20} /></div>
        <h1>开始新对话</h1>
      </div>
    );
  }

  let userTurn = 0;
  let lastUserMessageId: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserMessageId = messages[index].id;
      break;
    }
  }
  // 压缩卡片挂在触发它的那条消息后面；没有锚点（或锚点消息已经不在了）的旧记录仍然显示在顶部。
  const messageIds = new Set(messages.map((message) => message.id));
  const anchoredCompactions = new Map<string, ContextCompaction[]>();
  const orphanCompactions: ContextCompaction[] = [];
  for (const compaction of contextCompactions) {
    const anchorId = compaction.anchorMessageId;
    if (!anchorId || !messageIds.has(anchorId)) {
      orphanCompactions.push(compaction);
      continue;
    }
    const anchored = anchoredCompactions.get(anchorId);
    if (anchored) anchored.push(compaction);
    else anchoredCompactions.set(anchorId, [compaction]);
  }
  return (
    <div
      className="conversation-scroll"
      ref={scrollRef}
      onScroll={(event) => {
        const container = event.currentTarget;
        stickToBottomRef.current = container.scrollHeight - container.clientHeight - container.scrollTop <= 48;
      }}
    >
      <div className="conversation">
        {orphanCompactions.map((compaction) => <CompactionCard compaction={compaction} key={compaction.id} />)}
        {messages.map((message) => {
          if (message.role === "user") userTurn += 1;
          const messageUserTurn = userTurn;
          const canBranch = message.role === "assistant" && messageUserTurn > 0 && (message.status === "done" || message.status === undefined);
          const canEdit = message.role === "user" && message.id === lastUserMessageId && !editDisabled;
          const hasActions = message.role === "user"
            ? Boolean(message.content) || canEdit
            : Boolean(message.content) || (canBranch && onBranch);
          return (
            <Fragment key={message.id}>
              <article
                className={`message ${message.role} ${canBranch && onBranch ? "branchable" : ""} ${hasActions ? "has-actions" : ""}`}
                data-status={message.status}
              >
                {message.role === "assistant" ? <div className="assistant-avatar"><Sparkles size={14} /></div> : null}
                <div className="message-body">
                  {message.role === "user" ? (
                    <UserMessage canEdit={canEdit} message={message} onEditResend={onEditResend} />
                  ) : (
                    <>
                      <AssistantResponse message={message} />
                      {hasActions ? (
                        <div className="message-actions">
                          {message.content ? <CopyButton text={message.content} /> : null}
                          {canBranch && onBranch ? (
                            <button
                              aria-label="从这里分叉"
                              disabled={branchDisabled}
                              onClick={() => onBranch(messageUserTurn)}
                              title="从这里分叉"
                              type="button"
                            >
                              <GitFork size={14} />
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
              {anchoredCompactions.get(message.id)?.map((compaction) => <CompactionCard compaction={compaction} key={compaction.id} />)}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
