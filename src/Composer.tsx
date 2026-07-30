import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleStop, FileText, Paperclip, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import type { Attachment, AttachmentUpload, Conversation, ModelConfig, PermissionMode } from "./types";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;

const permissionOptions: { value: PermissionMode; label: string }[] = [
  { value: "acceptEdits", label: "自动接受编辑" },
  { value: "default", label: "默认权限" },
  { value: "plan", label: "计划模式" },
  { value: "dontAsk", label: "拒绝未授权" },
];

const localSlashCommands = [
  { name: "/model", description: "选择当前对话使用的模型" },
  { name: "/new", description: "在当前项目中新建对话" },
  { name: "/project", description: "新建项目" },
  { name: "/clear", description: "清空当前对话" },
  { name: "/plan", description: "切换到计划模式" },
  { name: "/edit", description: "允许 Claude 编辑文件" },
];

interface Props {
  conversation: Conversation;
  modelConfig: ModelConfig;
  running: boolean;
  loadingHistory?: boolean;
  onSend(prompt: string, attachments: Attachment[]): void;
  onStop(): void;
  onModelChange(model: string): void;
  onLocalCommand(command: string): boolean;
  onPermissionChange(mode: PermissionMode): void;
}

export default function Composer({
  conversation,
  modelConfig,
  running,
  loadingHistory = false,
  onSend,
  onStop,
  onModelChange,
  onLocalCommand,
  onPermissionChange,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [stagingAttachments, setStagingAttachments] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const matchedModel = modelConfig.options.find((option) => option.value === conversation.selectedModel)
    ?? modelConfig.options.find((option) => option.actualModel === conversation.selectedModel)
    ?? modelConfig.options[0];
  const slashSuggestions = useMemo(() => {
    if (attachments.length > 0 || !prompt.startsWith("/") || /\s/.test(prompt)) return [];
    const external = (conversation.slashCommands ?? []).map((name) => ({ name, description: "Claude 命令" }));
    const seen = new Set<string>();
    return [...localSlashCommands, ...external]
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
    if (running || loadingHistory) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [conversation.id, loadingHistory]);

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
    if (files.length === 0 || stagingAttachments || running || loadingHistory) return;
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
    modelSelectRef.current?.focus();
    try {
      modelSelectRef.current?.showPicker();
    } catch {
      // Focusing the select remains a usable fallback.
    }
  };

  const submit = () => {
    if ((!prompt.trim() && attachments.length === 0) || running || loadingHistory || stagingAttachments) return;
    const value = prompt.trim();
    if (attachments.length === 0 && value === "/model") {
      resetPrompt();
      openModelPicker();
      return;
    }
    if (attachments.length === 0 && onLocalCommand(value)) {
      resetPrompt();
      return;
    }
    onSend(value, attachments);
    setAttachments([]);
    setAttachmentError("");
    resetPrompt();
  };

  const applySuggestion = (name: string) => {
    setPrompt(`${name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="composer-wrap">
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
                {attachment.kind === "image"
                  ? <img src={`claude-desk-attachment://local/${encodeURIComponent(attachment.storedName)}`} alt={attachment.name} />
                  : <span className="attachment-file-icon"><FileText size={18} /></span>}
                <span className="attachment-meta">
                  <strong title={attachment.name}>{attachment.name}</strong>
                  <small>{attachment.size < 1024 * 1024 ? `${Math.ceil(attachment.size / 1024)} KB` : `${(attachment.size / 1024 / 1024).toFixed(1)} MB`}</small>
                </span>
                <button type="button" onClick={() => removeAttachment(attachment)} title="移除附件" aria-label={`移除 ${attachment.name}`}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
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
          placeholder={loadingHistory ? "正在载入历史记录…" : "给 Claude 分配任务…"}
          rows={1}
          disabled={running || loadingHistory}
        />
        {attachmentError ? <div className="attachment-error" role="alert">{attachmentError}</div> : null}
        <div className="composer-toolbar">
          <div className="composer-options">
            <button
              className="attach-button"
              type="button"
              title="添加图片或文件"
              onClick={() => fileInputRef.current?.click()}
              disabled={running || loadingHistory || stagingAttachments}
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
            <label className="select-control model-control" title="选择模型">
              <Sparkles size={14} />
              <select
                ref={modelSelectRef}
                className="model-select"
                value={matchedModel?.value ?? ""}
                onChange={(event) => onModelChange(event.target.value)}
                disabled={running || loadingHistory || modelConfig.options.length === 0}
              >
                {modelConfig.options.length === 0 ? <option value="">正在读取模型…</option> : null}
                {modelConfig.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.role} · {option.actualModel}</option>
                ))}
              </select>
              <ChevronDown size={13} />
            </label>
            <label className="select-control" title="权限模式">
              <ShieldCheck size={14} />
              <select value={conversation.permissionMode} onChange={(event) => onPermissionChange(event.target.value as PermissionMode)} disabled={running || loadingHistory}>
                {permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <ChevronDown size={13} />
            </label>
          </div>
          {running
            ? <button className="send-button stop" onClick={onStop} title="停止运行"><CircleStop size={17} /></button>
            : <button className="send-button" onClick={submit} disabled={(!prompt.trim() && attachments.length === 0) || loadingHistory || stagingAttachments} title="发送"><Send size={17} /></button>}
        </div>
      </div>
      <div className="composer-note">Claude 可能会犯错，请检查重要改动。</div>
    </div>
  );
}
