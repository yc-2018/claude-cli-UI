import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleStop, Send, ShieldCheck, Sparkles } from "lucide-react";
import type { Conversation, ModelConfig, PermissionMode } from "./types";

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
  onSend(prompt: string): void;
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
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const matchedModel = modelConfig.options.find((option) => option.value === conversation.selectedModel)
    ?? modelConfig.options.find((option) => option.actualModel === conversation.selectedModel)
    ?? modelConfig.options[0];
  const slashSuggestions = useMemo(() => {
    if (!prompt.startsWith("/") || /\s/.test(prompt)) return [];
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
  }, [prompt, conversation.slashCommands]);

  useEffect(() => setActiveSuggestion(0), [prompt]);

  const resetPrompt = () => {
    setPrompt("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
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
    if (!prompt.trim() || running || loadingHistory) return;
    const value = prompt.trim();
    if (value === "/model") {
      resetPrompt();
      openModelPicker();
      return;
    }
    if (onLocalCommand(value)) {
      resetPrompt();
      return;
    }
    onSend(value);
    resetPrompt();
  };

  const applySuggestion = (name: string) => {
    setPrompt(`${name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
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
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
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
        <div className="composer-toolbar">
          <div className="composer-options">
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
            : <button className="send-button" onClick={submit} disabled={!prompt.trim() || loadingHistory} title="发送"><Send size={17} /></button>}
        </div>
      </div>
      <div className="composer-note">Claude 可能会犯错，请检查重要改动。</div>
    </div>
  );
}
