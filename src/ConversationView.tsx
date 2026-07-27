import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrainCircuit, Check, ChevronRight, Code2, FileCode2, GitFork, Search, Sparkles, TerminalSquare, Wrench } from "lucide-react";
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

interface ConversationViewProps {
  messages: ChatMessage[];
  loadingHistory?: boolean;
  branchDisabled?: boolean;
  onBranch?(userTurn: number): void;
}

export default function ConversationView({ messages, loadingHistory = false, branchDisabled = false, onBranch }: ConversationViewProps) {
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
          return (
            <article className={`message ${message.role} ${canBranch && onBranch ? "branchable" : ""}`} data-status={message.status} key={message.id}>
              {message.role === "assistant" ? <div className="assistant-avatar"><Sparkles size={14} /></div> : null}
              <div className="message-body">
                {message.role === "user" ? (
                  <div className="user-bubble">
                    {(message.attachments?.length ?? 0) > 0 ? (
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
                    ) : null}
                    {message.content ? <div className="user-message-text">{message.content}</div> : null}
                  </div>
                ) : (
                  <>
                    {message.thinking ? <ThinkingBlock content={message.thinking} running={message.status === "running"} /> : null}
                    <ActivityList activities={message.activities ?? []} running={message.status === "running"} />
                    {message.content ? <div className="markdown"><MarkdownMessage content={message.content} /></div> : null}
                    {message.status === "running" && !message.content && !message.thinking && (message.activities?.length ?? 0) === 0
                      ? <div className="thinking"><span className="spinner" />Claude 正在思考</div>
                      : null}
                    {message.error ? <div className="message-error">{message.error}</div> : null}
                    {canBranch && onBranch ? (
                      <div className="message-actions">
                        <button
                          aria-label="从这里分叉"
                          disabled={branchDisabled}
                          onClick={() => onBranch(messageUserTurn)}
                          title="从这里分叉"
                          type="button"
                        >
                          <GitFork size={14} />
                        </button>
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
