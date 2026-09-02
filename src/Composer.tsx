import { useEffect, useMemo, useRef, useState } from "react";
import { CircleStop, CornerDownRight, FileText, GripVertical, Paperclip, Pencil, Send, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import AttachmentPreview, { attachmentUrl, openAttachmentFile } from "./AttachmentPreview";
import ComposerSelect, { type ComposerSelectHandle } from "./ComposerSelect";
import { LOCAL_SLASH_COMMANDS } from "./commands";
import type { Attachment, AttachmentUpload, ComposerDraft, Conversation, ModelConfig, PermissionMode, QueuedPrompt, ReorderPosition, SlashCommand } from "./types";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;

const permissionOptions: { value: PermissionMode; label: string }[] = [
  { value: "acceptEdits", label: "自动接受编辑" },
  { value: "default", label: "默认权限" },
  { value: "plan", label: "计划模式" },
  { value: "dontAsk", label: "拒绝未授权" },
  { value: "bypassPermissions", label: "完全访问权限" },
];

interface Props {
  conversation: Conversation;
  modelConfig: ModelConfig;
  running: boolean;
  queuedPrompts: QueuedPrompt[];
  loadingHistory?: boolean;
  focusRequest?: number;
  draft: ComposerDraft;
  onSend(prompt: string, attachments: Attachment[]): void;
  onQueue(prompt: string, attachments: Attachment[]): void;
  onGuideQueuedPrompt(promptId: string): void;
  onStop(): void;
  onDeleteQueuedPrompt(promptId: string): void;
  onEditQueuedPrompt(promptId: string): void;
  onReorderQueuedPrompt(sourceId: string, targetId: string, position: ReorderPosition): void;
  onDraftChange(update: (current: ComposerDraft) => ComposerDraft): void;
  onModelChange(model: string): void;
  onLocalCommand(command: string): boolean;
  onPermissionChange(mode: PermissionMode): void;
}

export default function Composer({
  conversation,
  modelConfig,
  running,
  queuedPrompts,
  loadingHistory = false,
  focusRequest = 0,
  draft,
  onSend,
  onQueue,
  onGuideQueuedPrompt,
  onStop,
  onDeleteQueuedPrompt,
  onEditQueuedPrompt,
  onReorderQueuedPrompt,
  onDraftChange,
  onModelChange,
  onLocalCommand,
  onPermissionChange,
}: Props) {
  const [attachmentError, setAttachmentError] = useState("");
  const [stagingAttachments, setStagingAttachments] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [draggedPromptId, setDraggedPromptId] = useState<string | null>(null);
  const [promptDropTarget, setPromptDropTarget] = useState<{ id: string; position: ReorderPosition } | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectRef = useRef<ComposerSelectHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prompt = draft.prompt;
  const attachments = draft.attachments;
  const matchedModel = modelConfig.options.find((option) => option.value === conversation.selectedModel)
    ?? modelConfig.options.find((option) => option.actualModel === conversation.selectedModel)
    ?? modelConfig.options[0];
  const slashSuggestions = useMemo(() => {
    if (attachments.length > 0 || !prompt.startsWith("/") || /\s/.test(prompt)) return [];
    const external = conversation.slashCommands ?? [];
    const seen = new Set<string>();
    const commands: SlashCommand[] = [...LOCAL_SLASH_COMMANDS, ...external];
    return commands
      .filter((command) => {
        const key = command.name.toLowerCase();
        if (seen.has(key) || !key.startsWith(prompt.toLowerCase())) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  }, [attachments.length, prompt, conversation.slashCommands]);

  useEffect(() => setActiveSuggestion(0), [prompt]);

  useEffect(() => {
    if (loadingHistory) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [conversation.id, focusRequest, loadingHistory]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [conversation.id, prompt]);

  const setPrompt = (value: string) => {
    onDraftChange((current) => ({ ...current, prompt: value }));
  };

  const setAttachments = (update: (current: Attachment[]) => Attachment[]) => {
    onDraftChange((current) => ({ ...current, attachments: update(current.attachments) }));
  };

  const resetPrompt = () => {
    setPrompt("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const fileToUpload = (file: File) => new Promise<AttachmentUpload>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) return reject(new Error(`无法读取附件：${file.name}`));
      resolve({
        name: file.name || `粘贴的附件-${Date.now()}`,
        mediaType: file.type || "application/octet-stream",
        dataBase64: result.slice(separator + 1),
      });
    };
    reader.readAsDataURL(file);
  });

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || stagingAttachments || loadingHistory) return;
    setAttachmentError("");
    if (attachments.length + files.length > 10) {
      setAttachmentError("一次最多添加 10 个附件");
      return;
    }
    if (files.some((file) => file.size === 0 || file.size > MAX_ATTACHMENT_BYTES)) {
      setAttachmentError("单个附件必须小于 20 MB");
      return;
    }
    const totalSize = attachments.reduce((total, attachment) => total + attachment.size, 0)
      + files.reduce((total, file) => total + file.size, 0);
    if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) {
      setAttachmentError("附件总大小不能超过 40 MB");
      return;
    }

    setStagingAttachments(true);
    try {
      const uploads = await Promise.all(files.map(fileToUpload));
      const staged = await window.claudeDesk.stageAttachments(uploads);
      setAttachments((current) => [...current, ...staged]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "添加附件失败");
    } finally {
      setStagingAttachments(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAttachment = (attachment: Attachment) => {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    void window.claudeDesk.deleteAttachment(attachment.storedName);
  };

  const openModelPicker = () => {
    modelSelectRef.current?.open();
  };

  const submit = () => {
    if ((!prompt.trim() && attachments.length === 0) || loadingHistory || stagingAttachments) return;
    const value = prompt.trim();
    if (!running && attachments.length === 0 && value === "/model") {
      resetPrompt();
      openModelPicker();
      return;
    }
    if (!running && attachments.length === 0 && onLocalCommand(value)) {
      resetPrompt();
      return;
    }
    if (running) onQueue(value, attachments);
    else onSend(value, attachments);
    setAttachments(() => []);
    setAttachmentError("");
    resetPrompt();
  };

  const applySuggestion = (name: string) => {
    setPrompt(`${name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="composer-wrap">
      {queuedPrompts.length > 0 ? (
        <section className="prompt-queue" aria-label="待发送队列">
          <div className="prompt-queue-heading">
            <strong>待发送</strong>
            <span>{queuedPrompts.length} 条</span>
          </div>
          <div className="prompt-queue-list">
            {queuedPrompts.map((queuedPrompt, index) => {
              const dropPosition = promptDropTarget?.id === queuedPrompt.id ? promptDropTarget.position : null;
              return (
                <div
                  className={`prompt-queue-item ${draggedPromptId === queuedPrompt.id ? "dragging" : ""} ${dropPosition ? `drop-${dropPosition}` : ""}`}
                  data-queue-id={queuedPrompt.id}
                  draggable
                  key={queuedPrompt.id}
                  onDragEnd={() => {
                    setDraggedPromptId(null);
                    setPromptDropTarget(null);
                  }}
                  onDragOver={(event) => {
                    if (!draggedPromptId || draggedPromptId === queuedPrompt.id) return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setPromptDropTarget({
                      id: queuedPrompt.id,
                      position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
                    });
                  }}
                  onDragStart={(event) => {
                    setDraggedPromptId(queuedPrompt.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", queuedPrompt.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedPromptId && dropPosition) onReorderQueuedPrompt(draggedPromptId, queuedPrompt.id, dropPosition);
                    setDraggedPromptId(null);
                    setPromptDropTarget(null);
                  }}
                >
                  <span className="prompt-queue-handle" title="拖动排序"><GripVertical size={14} /></span>
                  <span className="prompt-queue-index">{index + 1}</span>
                  <span className="prompt-queue-content">
                    <strong>{queuedPrompt.prompt || "查看附件"}</strong>
                    {queuedPrompt.attachments.length > 0 ? <small>{queuedPrompt.attachments.length} 个附件</small> : null}
                  </span>
                  <span className="prompt-queue-actions">
                    {running ? <button className="guide-prompt" type="button" onClick={() => onGuideQueuedPrompt(queuedPrompt.id)} title="提交，但不中断当前任务" aria-label="引导当前任务"><CornerDownRight size={14} /><span>引导</span></button> : null}
                    <button type="button" onClick={() => onEditQueuedPrompt(queuedPrompt.id)} title="移回输入框编辑" aria-label="移回输入框编辑"><Pencil size={13} /></button>
                    <button type="button" onClick={() => onDeleteQueuedPrompt(queuedPrompt.id)} title="从队列删除" aria-label="从队列删除"><Trash2 size={13} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <div
        className={`composer ${dragActive ? "drag-active" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          void addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {slashSuggestions.length > 0 ? (
          <div className="command-menu" role="listbox" aria-label="斜杠命令">
            {slashSuggestions.map((command, index) => (
              <button
                className={`command-option ${index === activeSuggestion ? "active" : ""}`}
                key={command.name}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySuggestion(command.name);
                }}
                role="option"
                aria-selected={index === activeSuggestion}
              >
                <strong>{command.name}</strong>
                <span>{command.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="attachment-list" aria-label="待发送附件">
            {attachments.map((attachment) => (
              <div className={`attachment-item ${attachment.kind}`} key={attachment.id}>
                <button
                  aria-label={attachment.kind === "image" ? `预览 ${attachment.name}` : `打开 ${attachment.name}`}
                  className="attachment-open"
                  onClick={() => {
                    if (attachment.kind === "image") setPreviewAttachment(attachment);
                    else void openAttachmentFile(attachment);
                  }}
                  title={attachment.kind === "image" ? "预览图片" : "打开文件"}
                  type="button"
                >
                  {attachment.kind === "image"
                    ? <img src={attachmentUrl(attachment)} alt={attachment.name} />
                    : <span className="attachment-file-icon"><FileText size={18} /></span>}
                  <span className="attachment-meta">
                    <strong title={attachment.name}>{attachment.name}</strong>
                    <small>{attachment.size < 1024 * 1024 ? `${Math.ceil(attachment.size / 1024)} KB` : `${(attachment.size / 1024 / 1024).toFixed(1)} MB`}</small>
                  </span>
                </button>
                <button className="attachment-remove" type="button" onClick={() => removeAttachment(attachment)} title="移除附件" aria-label={`移除 ${attachment.name}`}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <AttachmentPreview attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onPaste={(event) => {
            const directFiles = Array.from(event.clipboardData.files);
            const files = directFiles.length > 0
              ? directFiles
              : Array.from(event.clipboardData.items).flatMap((item) => item.kind === "file" && item.getAsFile() ? [item.getAsFile() as File] : []);
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(event) => {
            if (slashSuggestions.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              setActiveSuggestion((index) => (index + 1) % slashSuggestions.length);
              return;
            }
            if (slashSuggestions.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSuggestion((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
              return;
            }
            if (slashSuggestions.length > 0 && event.key === "Tab") {
              event.preventDefault();
              applySuggestion(slashSuggestions[activeSuggestion].name);
              return;
            }
            if (event.key === "Escape" && slashSuggestions.length > 0) {
              event.preventDefault();
              resetPrompt();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && slashSuggestions.length > 0 && prompt !== slashSuggestions[activeSuggestion].name) {
              event.preventDefault();
              applySuggestion(slashSuggestions[activeSuggestion].name);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={loadingHistory ? "正在载入历史记录…" : (running ? "继续输入，发送后加入队列…" : "给 Claude 分配任务…")}
          rows={1}
          disabled={loadingHistory}
        />
        {attachmentError ? <div className="attachment-error" role="alert">{attachmentError}</div> : null}
        <div className="composer-toolbar">
          <div className="composer-options">
            <button
              className="attach-button"
              type="button"
              title="添加图片或文件"
              onClick={() => fileInputRef.current?.click()}
              disabled={loadingHistory || stagingAttachments}
            >
              {stagingAttachments ? <span className="mini-spinner" /> : <Paperclip size={15} />}
            </button>
            <input
              ref={fileInputRef}
              className="attachment-input"
              type="file"
              multiple
              tabIndex={-1}
              onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); }}
            />
            <ComposerSelect
              ariaLabel="选择模型"
              className="model-select"
              disabled={loadingHistory || modelConfig.options.length === 0}
              icon={<Sparkles size={14} />}
              onChange={onModelChange}
              options={modelConfig.options.map((option) => ({ value: option.value, label: option.role, detail: option.actualModel }))}
              ref={modelSelectRef}
              title="选择模型"
              value={matchedModel?.value ?? ""}
            />
            <ComposerSelect
              ariaLabel="选择权限模式"
              className="permission-select"
              disabled={loadingHistory}
              icon={<ShieldCheck size={14} />}
              onChange={(value) => onPermissionChange(value as PermissionMode)}
              options={permissionOptions}
              title="权限模式"
              value={conversation.permissionMode}
            />
          </div>
          <div className="composer-actions">
            {running ? <button className="send-button stop" onClick={onStop} title="停止运行"><CircleStop size={17} /></button> : null}
            <button
              className="send-button"
              onClick={submit}
              disabled={(!prompt.trim() && attachments.length === 0) || loadingHistory || stagingAttachments}
              title={running ? "加入待发送队列" : "发送"}
            >
              <Send size={17} />
            </button>
          </div>
        </div>
      </div>
      <div className="composer-note">Claude 可能会犯错，请检查重要改动。</div>
    </div>
  );
}
