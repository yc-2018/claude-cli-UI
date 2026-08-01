import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface ComposerSelectOption {
  value: string;
  label: string;
  detail?: string;
}

export interface ComposerSelectHandle {
  open(): void;
}

interface ComposerSelectProps {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  options: ComposerSelectOption[];
  title: string;
  value: string;
  onChange(value: string): void;
}

const ComposerSelect = forwardRef<ComposerSelectHandle, ComposerSelectProps>(function ComposerSelect({
  ariaLabel,
  className = "",
  disabled = false,
  icon,
  options,
  title,
  value,
  onChange,
}, forwardedRef) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = useMemo(() => Math.max(0, options.findIndex((option) => option.value === value)), [options, value]);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex];

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        const activeElement = document.activeElement;
        if (activeElement !== document.body && !rootRef.current?.contains(activeElement)) return;
        triggerRef.current?.focus();
      });
    }
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  };

  useImperativeHandle(forwardedRef, () => ({
    open() {
      triggerRef.current?.focus();
      openMenu();
    },
  }));

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      className={`composer-select ${className} ${open ? "open" : ""}`}
      onKeyDown={(event) => {
        if (disabled || options.length === 0) return;
        if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          openMenu();
          return;
        }
        if (!open) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % options.length);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((index) => (index - 1 + options.length) % options.length);
        } else if (event.key === "Home") {
          event.preventDefault();
          setActiveIndex(0);
        } else if (event.key === "End") {
          event.preventDefault();
          setActiveIndex(options.length - 1);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose(activeIndex);
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeMenu(true);
        } else if (event.key === "Tab") {
          setOpen(false);
        }
      }}
      ref={rootRef}
    >
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="composer-select-trigger"
        disabled={disabled}
        onClick={() => open ? closeMenu(false) : openMenu()}
        ref={triggerRef}
        title={title}
        type="button"
      >
        {icon}
        <span className="composer-select-value">
          {selected ? selected.label : "暂无选项"}
          {selected?.detail ? <small>· {selected.detail}</small> : null}
        </span>
        <ChevronDown className="composer-select-chevron" size={13} />
      </button>
      {open ? (
        <div className="composer-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              aria-selected={option.value === value}
              className={`composer-select-option ${index === activeIndex ? "active" : ""}`}
              data-value={option.value}
              key={option.value}
              onClick={() => choose(index)}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
            >
              <span>
                <strong>{option.label}</strong>
                {option.detail ? <small>{option.detail}</small> : null}
              </span>
              {option.value === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export default ComposerSelect;
