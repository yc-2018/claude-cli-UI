import { useEffect, useRef, useState } from "react";
import { AlarmClock, Trash2 } from "lucide-react";
import { TIME_OF_DAY_PATTERN } from "./storage";
import type { ScheduledPrompt } from "./types";

interface Props {
  disabled?: boolean;
  /** 当前输入框里的内容：打开弹层时直接带过来，不用重新打一遍。 */
  draftPrompt: string;
  /** 本对话已排好的定时任务，弹层里直接能看、能撤。 */
  pending: ScheduledPrompt[];
  onSchedule(prompt: string, time: string): string | undefined;
  onCancel(id: string): void;
}

/** 默认填十分钟之后：多数定时发送都是「过一会儿再发」，省一次输入。 */
function defaultTime(from = Date.now()) {
  const target = new Date(from + 10 * 60 * 1000);
  return `${String(target.getHours()).padStart(2, "0")}:${String(target.getMinutes()).padStart(2, "0")}`;
}

function describeDueAt(dueAt: number) {
  const due = new Date(dueAt);
  const sameDay = new Date().toDateString() === due.toDateString();
  return sameDay ? "今天" : "明天";
}

/**
 * 发送框底部的定时发送按钮：配一句话和一个 HH:mm，到点由主界面把它发进这个对话。
 * 任务本身存在 App 里，这里只负责录入和撤销。
 */
export default function ScheduleSend({ disabled = false, draftPrompt, pending, onSchedule, onCancel }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(defaultTime);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");

  const closeMenu = () => {
    setOpen(false);
    setError("");
  };

  const openMenu = () => {
    setError("");
    setTime(defaultTime());
    setPrompt(draftPrompt);
    setOpen(true);
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const submit = () => {
    if (!prompt.trim()) {
      setError("请先写清要发送的内容");
      return;
    }
    if (!TIME_OF_DAY_PATTERN.test(time)) {
      setError("时间请按 HH:mm 填写");
      return;
    }
    const failure = onSchedule(prompt.trim(), time);
    if (failure) {
      setError(failure);
      return;
    }
    setPrompt("");
    setError("");
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) closeMenu();
  }, [disabled]);

  return (
    <div className={`schedule-send ${open ? "open" : ""}`} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="定时发送"
        className="schedule-send-button"
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        title="定时发送：到了指定时间再把这句话发出去"
        type="button"
      >
        <AlarmClock size={15} />
        {pending.length > 0 ? <em className="schedule-send-count">{pending.length}</em> : null}
      </button>
      {open ? (
        <div aria-label="定时发送" className="schedule-send-menu" role="dialog">
          <div className="schedule-send-heading">
            <strong>定时发送</strong>
            <span>只填 HH:mm</span>
          </div>
          <label className="schedule-send-time">
            <span>发送时间</span>
            <input
              aria-label="发送时间"
              onChange={(event) => setTime(event.target.value)}
              type="time"
              value={time}
            />
          </label>
          <textarea
            aria-label="定时发送的内容"
            className="schedule-send-prompt"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="到点要发给 Claude 的内容…"
            ref={promptRef}
            rows={3}
            value={prompt}
          />
          {error ? <div className="schedule-send-error" role="alert">{error}</div> : null}
          <button className="schedule-send-submit" onClick={submit} type="button">
            <AlarmClock size={13} />
            <span>加入定时任务</span>
          </button>
          {pending.length > 0 ? (
            <div className="schedule-send-list">
              {pending.map((item) => (
                <div className="schedule-send-item" key={item.id} title={item.prompt}>
                  <strong>{item.time}</strong>
                  <span className="schedule-send-item-copy">
                    <small>{describeDueAt(item.dueAt)}</small>
                    <em>{item.prompt}</em>
                  </span>
                  <button aria-label="取消这个定时任务" onClick={() => onCancel(item.id)} title="取消" type="button">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
