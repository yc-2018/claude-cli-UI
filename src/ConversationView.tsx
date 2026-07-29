import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrainCircuit, Check, ChevronRight, Code2, Copy, FileCode2, GitFork, Pencil, Search, Sparkles, TerminalSquare, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Activity, ChatMessage } from "./types";

function getToolIcon(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read") || normalized.includes("file")) return FileCode2;
  if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("glob")) return Search;
  if (normalized.includes("bash") || normalized.includes("terminal")) return TerminalSquare;
  if (normalized.includes("edit") || normalized.includes("write")) return Code2;
  return Wrench;
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        code: ({ className, children, ...props }) => <code className={className} {...props}>{children}</code>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function ActivityList({ activities, running }: { activities: Activity[]; running: boolean }) {
  if (activities.length === 0) return null;
  return (
    <div className="activity-list">
      {activities.map((activity, index) => {
        const Icon = getToolIcon(activity.name);
        const isCurrent = running && index === activities.length - 1;
        return (
          <div className="activity-row" key={activity.id}>
            <span className={`activity-icon ${isCurrent ? "working" : ""}`}>
              {isCurrent ? <span className="mini-spinner" /> : <Icon size={14} />}
            </span>
            <span className="activity-name">{activity.name}</span>
            {activity.summary ? <span className="activity-summary">{activity.summary}</span> : null}
            {!isCurrent ? <Check className="activity-check" size={13} /> : null}
          </div>
        );
      })}
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
          <img src={`claude-desk-attachment://local/${encodeURIComponent(attachment.storedName)}`} alt={attachment.name} />
          <figcaption title={attachment.name}>{attachment.name}</figcaption>
        </figure>
      ) : (
        <div className="sent-file" key={attachment.id} title={attachment.name}>
          <FileCode2 size={16} />
          <span>{attachment.name}</span>
        </div>
      ))}
    </div>
  ) : null;

  if (editing) {
    return (
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
    );
  }

  const showActions = Boolean(message.content) || canEdit;
  return (
    <>
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

interface ConversationViewProps {
  messages: ChatMessage[];
  loadingHistory?: boolean;
  branchDisabled?: boolean;
  editDisabled?: boolean;
  onBranch?(userTurn: number): void;
  onEditResend?(messageId: string, content: string): void;
}

export default function ConversationView({ messages, loadingHistory = false, branchDisabled = false, editDisabled = false, onBranch, onEditResend }: ConversationViewProps) {
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
  }, [messages.length, latest?.id, latest?.content.length, latest?.thinking?.length, latest?.activities?.length, latest?.error, latest?.status]);

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
        {messages.map((message) => {
          if (message.role === "user") userTurn += 1;
          const messageUserTurn = userTurn;
          const canBranch = message.role === "assistant" && messageUserTurn > 0 && (message.status === "done" || message.status === undefined);
          const canEdit = message.role === "user" && message.id === lastUserMessageId && !editDisabled;
          const hasActions = message.role === "user"
            ? Boolean(message.content) || canEdit
            : Boolean(message.content) || (canBranch && onBranch);
          return (
            <article
              className={`message ${message.role} ${canBranch && onBranch ? "branchable" : ""} ${hasActions ? "has-actions" : ""}`}
              data-status={message.status}
              key={message.id}
            >
              {message.role === "assistant" ? <div className="assistant-avatar"><Sparkles size={14} /></div> : null}
              <div className="message-body">
                {message.role === "user" ? (
                  <UserMessage canEdit={canEdit} message={message} onEditResend={onEditResend} />
                ) : (
                  <>
                    {message.thinking ? <ThinkingBlock content={message.thinking} running={message.status === "running"} /> : null}
                    <ActivityList activities={message.activities ?? []} running={message.status === "running"} />
                    {message.content ? <div className="markdown"><MarkdownMessage content={message.content} /></div> : null}
                    {message.status === "running" && !message.content && !message.thinking && (message.activities?.length ?? 0) === 0
                      ? <div className="thinking"><span className="spinner" />Claude 正在思考</div>
                      : null}
                    {message.error ? <div className="message-error">{message.error}</div> : null}
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
          );
        })}
      </div>
    </div>
  );
}
