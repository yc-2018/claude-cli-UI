import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { BrainCircuit, Check, ChevronDown, ChevronRight, Code2, Copy, FileCode2, GitFork, List, Pencil, Search, Sparkles, TerminalSquare, Wrench } from "lucide-react";
import AttachmentPreview, { attachmentUrl, openAttachmentFile } from "./AttachmentPreview";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Activity, ActivityDetail, ActivityDiffLine, ApiRetryState, Attachment, ChatMessage, CompactionPhase, ContextCompaction, ResponseTimelineItem } from "./types";

/** CLI 正在重试这一轮的 API 请求。不显示的话界面只会一直停在「正在准备回答」。 */
function RetryNotice({ retry }: { retry: ApiRetryState }) {
  const attempt = retry.maxRetries ? `第 ${retry.attempt}/${retry.maxRetries} 次` : `第 ${retry.attempt} 次`;
  const delay = retry.delayMs ? ` · 约 ${formatDuration(retry.delayMs)} 后重试` : "";
  // 子代理卡住时主对话看不出任何动静，不点名是哪个子代理就会以为整个界面死了。
  const scope = retry.agentType ? `子代理 ${retry.agentType} 的 API 请求失败` : "API 请求失败";
  const reason = [retry.message, retry.waitedMs ? `已等待 ${formatDuration(retry.waitedMs)} 仍未收到响应` : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="retry-notice">
      <span className="spinner" />
      <span>
        {scope}，正在重试（{attempt}）{delay}
        {retry.status !== undefined ? ` · HTTP ${retry.status}` : ""}
      </span>
      {reason ? <small className="retry-reason">{reason}</small> : null}
    </div>
  );
}

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
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes.toString().padStart(2, "0")} 分 ${remainingSeconds.toString().padStart(2, "0")} 秒`;
  return minutes > 0 ? `${minutes} 分 ${remainingSeconds.toString().padStart(2, "0")} 秒` : `${remainingSeconds} 秒`;
}

/** 当天只显示时刻，跨天补上日期，长任务隔夜跑完也能看出是哪天结束的。 */
function formatCompletedAt(completedAt: number) {
  const completed = new Date(completedAt);
  if (Number.isNaN(completed.getTime())) return undefined;
  const clock = `${completed.getHours().toString().padStart(2, "0")}:${completed.getMinutes().toString().padStart(2, "0")}:${completed.getSeconds().toString().padStart(2, "0")}`;
  const now = new Date();
  const sameDay = completed.getFullYear() === now.getFullYear()
    && completed.getMonth() === now.getMonth()
    && completed.getDate() === now.getDate();
  return sameDay ? clock : `${completed.getMonth() + 1} 月 ${completed.getDate()} 日 ${clock}`;
}

interface ResponseDurationProps {
  running: boolean;
  startedAt?: number;
  durationMs?: number;
  completedAt?: number;
}

function ResponseDuration({ running, startedAt, durationMs, completedAt }: ResponseDurationProps) {
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
  const completedText = running || completedAt === undefined ? undefined : formatCompletedAt(completedAt);

  return (
    <div className="response-duration" data-completed-at={completedAt} data-elapsed-seconds={elapsedSeconds}>
      {running ? <span className="mini-spinner" /> : null}
      {running ? "正在回答" : "本次回答耗时"} · {formatElapsed(elapsedSeconds)}
      {completedText ? ` · 完成于 ${completedText}` : ""}
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
        completedAt={message.responseCompletedAt}
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
      {message.status === "running" && message.retry ? <RetryNotice retry={message.retry} /> : null}
      {message.status === "running" && !message.retry && !message.content && !message.thinking && (message.activities?.length ?? 0) === 0
        ? <div className="thinking"><span className="spinner" />Claude 正在准备回答</div>
        : null}
      {/* 等待的原因有两种，处置也不同：引导进去的提示已经交给 Claude 了，界面排队的还没启动进程。 */}
      {message.status === "queued"
        ? (
          <div className={`queued-hint ${message.appended ? "appended" : ""}`}>
            {message.appended
              ? "已插入当前任务 · Claude 处理完手上这一步就接着答"
              : "排队中 · 等上一条回答结束后开始"}
          </div>
        )
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
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const editing = draft !== null;
  const attachmentCount = message.attachments?.length ?? 0;
  const canSubmit = editing && (draft.trim().length > 0 || attachmentCount > 0);

  // 粘贴整段日志或需求的提问会把回答挤出屏幕，默认只露出开头几行。行数必须按渲染结果量，
  // 不能数换行符：一段没有换行的长文本同样会折成很多行。折叠态下测量，所以永远量得到真实溢出。
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || editing || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight - element.clientHeight > 2);
    measure();
    // 窗口变窄后同样的文字会占更多行，展开按钮要跟着出现。
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [editing, expanded, message.content]);

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
        {message.content ? (
          <div className={`user-message-text ${expanded ? "" : "collapsed"}`} ref={textRef}>{message.content}</div>
        ) : null}
        {overflowing ? (
          <button
            aria-expanded={expanded}
            className="user-message-fold"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <ChevronDown size={13} />
            <span>{expanded ? "收起" : "展开全部"}</span>
          </button>
        ) : null}
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

const COMPACTION_PHASE_LABELS: Record<CompactionPhase, string> = {
  pre_hooks: "正在执行压缩前钩子",
  compacting: "正在总结较早的对话",
  post_hooks: "正在执行压缩后钩子",
  session_start: "正在重新载入会话上下文",
};

function formatDuration(ms: number) {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`;
}

/** post_tokens 在 wire 上是可选的，只有一半读数时也要把它说出来，不能整段退回一句没有信息量的提示。 */
function compactionDetail(compaction: ContextCompaction) {
  if (compaction.status === "error") return compaction.error ?? "上下文压缩失败";
  if (compaction.status === "running") {
    return compaction.phase ? COMPACTION_PHASE_LABELS[compaction.phase] : "Claude 正在整理较早的对话内容";
  }
  const parts: string[] = [];
  if (compaction.trigger !== "unknown") parts.push(compaction.trigger === "auto" ? "自动" : "手动");
  if (compaction.preTokens !== undefined && compaction.postTokens !== undefined) {
    parts.push(`${compaction.preTokens.toLocaleString()} → ${compaction.postTokens.toLocaleString()} tokens`);
  } else if (compaction.preTokens !== undefined) {
    parts.push(`压缩前 ${compaction.preTokens.toLocaleString()} tokens`);
  } else if (compaction.postTokens !== undefined) {
    parts.push(`压缩后 ${compaction.postTokens.toLocaleString()} tokens`);
  }
  if (compaction.droppedTokens) parts.push(`累计压掉 ${compaction.droppedTokens.toLocaleString()}`);
  if (compaction.durationMs) parts.push(`耗时 ${formatDuration(compaction.durationMs)}`);
  return parts.length > 0 ? parts.join(" · ") : "Claude 已整理较早的对话内容";
}

function CompactionCard({ compaction }: { compaction: ContextCompaction }) {
  return (
    <div className={`context-compaction ${compaction.status}`} data-compaction-id={compaction.id} data-compaction-phase={compaction.phase ?? ""}>
      <span className="context-compaction-icon">
        {compaction.status === "running" ? <span className="spinner" /> : <BrainCircuit size={14} />}
      </span>
      <span className="context-compaction-copy">
        <strong>{compaction.status === "running" ? "正在压缩上下文" : compaction.status === "error" ? "上下文压缩失败" : "上下文已压缩"}</strong>
        <small>{compactionDetail(compaction)}</small>
        {compaction.hint ? <small className="context-compaction-hint">{compaction.hint}</small> : null}
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

/** 提问少于这个条数时整段对话翻一下就看完了，导航线只是干扰。 */
const MARKER_MIN_MESSAGES = 4;

interface MarkerItem {
  id: string;
  text: string;
  /** 这条消息在全部内容里的纵向位置，0 到 1。 */
  ratio: number;
}

/** 消息在滚动内容里的纵向偏移。offsetTop 取决于最近的定位祖先，这里按视口差值算，不受布局影响。 */
function contentOffsetOf(container: HTMLElement, element: HTMLElement) {
  return element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

/** 对话右缘的提问导航：平时是一列短横线，鼠标移上去摊开成提问列表，点击跳到对应消息。 */
function ConversationMarkers({ messages, scrollRef }: { messages: ChatMessage[]; scrollRef: RefObject<HTMLDivElement | null> }) {
  const [items, setItems] = useState<MarkerItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const userMessages = messages.filter((message) => message.role === "user" && message.content.trim().length > 0);
  const signature = userMessages.map((message) => `${message.id}:${message.content.length}`).join(",");

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || userMessages.length < MARKER_MIN_MESSAGES) {
      setItems([]);
      return;
    }
    const measure = () => {
      const total = container.scrollHeight;
      if (total <= 0) return;
      const next = userMessages.flatMap((message) => {
        const element = container.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
        if (!element) return [];
        const ratio = contentOffsetOf(container, element) / total;
        return [{ id: message.id, text: message.content.replace(/\s+/g, " ").trim(), ratio: Math.min(1, Math.max(0, ratio)) }];
      });
      // 回答流式输出时高度每几十毫秒就变一次。位置没有实际挪动就不要换掉数组，
      // 否则这里的重渲染会和主进程推过来的事件抢渲染线程。
      setItems((current) => current.length === next.length && current.every((item, index) => (
        item.id === next[index].id && item.text === next[index].text && Math.abs(item.ratio - next[index].ratio) < 0.002
      )) ? current : next);
    };
    measure();
    // 回答还在流式输出、或者长消息被展开时内容高度一直在变，位置必须跟着重算。多次变化合并成一帧。
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    });
    observer.observe(container);
    const content = container.firstElementChild;
    if (content) observer.observe(content);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // userMessages 每次渲染都是新数组，用 id 串做依赖，避免 effect 无限重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, signature]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || items.length === 0) return;
    const update = () => {
      // 探测点放在视口上方四分之一处：那里是读者正在看的位置，而不是屏幕最顶端。
      const probe = container.scrollTop + container.clientHeight * 0.25;
      const total = container.scrollHeight;
      let current = items[0].id;
      for (const item of items) {
        if (item.ratio * total > probe) break;
        current = item.id;
      }
      setActiveId(current);
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [scrollRef, items]);

  if (items.length === 0) return null;
  return (
    <nav aria-label="提问导航" className="conversation-markers">
      {items.map((item) => (
        <button
          className={`conversation-marker ${activeId === item.id ? "active" : ""}`}
          key={item.id}
          onClick={() => {
            const container = scrollRef.current;
            const element = container?.querySelector<HTMLElement>(`[data-message-id="${item.id}"]`);
            if (!container || !element) return;
            container.scrollTo({ top: Math.max(0, contentOffsetOf(container, element) - 20), behavior: "smooth" });
          }}
          style={{ top: `${item.ratio * 100}%` }}
          title={item.text}
          type="button"
        >
          <span className="conversation-marker-label">{item.text}</span>
        </button>
      ))}
    </nav>
  );
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
    <div className="conversation-area">
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
                  data-message-id={message.id}
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
      <ConversationMarkers messages={messages} scrollRef={scrollRef} />
    </div>
  );
}
