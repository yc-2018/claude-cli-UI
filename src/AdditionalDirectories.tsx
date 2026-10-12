import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Folder, FolderPlus, X } from "lucide-react";
import { pathName } from "./storage";

export interface AdditionalDirectoriesHandle {
  open(): void;
  /** 对应 /add-dir <路径>：直接加入一个路径；非法或重复时打开弹层并给出提示。 */
  add(directory: string): void;
}

interface Props {
  directories: string[];
  /** 当前项目目录：第一次打开选择框时从这里开始，而不是系统默认的「下载」。 */
  workspace?: string;
  disabled?: boolean;
  onChange(directories: string[]): void;
}

export const MAX_ADDITIONAL_DIRECTORIES = 20;

/** 只收绝对路径：CLI 以工作目录为基准解析相对路径，界面上说不清它最终会落到哪里。 */
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/**
 * 发送框底部的附加目录管理按钮：对应 CLI 的 --add-dir / /add-dir。
 * 列表存在会话上，每次启动 CLI 时由主进程逐个转成 --add-dir 参数。
 */
const AdditionalDirectories = forwardRef<AdditionalDirectoriesHandle, Props>(function AdditionalDirectories({
  directories,
  workspace,
  disabled = false,
  onChange,
}, forwardedRef) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);

  const closeMenu = () => {
    setOpen(false);
    setError("");
  };

  const openMenu = () => {
    setError("");
    setOpen(true);
  };

  const addDirectory = (directory: string) => {
    const candidate = directory.trim();
    if (!ABSOLUTE_PATH_PATTERN.test(candidate)) {
      setError("请输入绝对路径");
      setOpen(true);
      return;
    }
    if (directories.some((item) => item.toLowerCase() === candidate.toLowerCase())) {
      setError("该目录已在列表中");
      setOpen(true);
      return;
    }
    if (directories.length >= MAX_ADDITIONAL_DIRECTORIES) {
      setError(`最多添加 ${MAX_ADDITIONAL_DIRECTORIES} 个目录`);
      setOpen(true);
      return;
    }
    onChange([...directories, candidate]);
    setError("");
  };

  const pickDirectory = async () => {
    if (picking) return;
    setPicking(true);
    setError("");
    try {
      const picked = await window.claudeDesk.selectAddDirectory(workspace);
      if (typeof picked === "string" && picked) addDirectory(picked);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "选择目录失败");
    } finally {
      setPicking(false);
    }
  };

  useImperativeHandle(forwardedRef, () => ({
    open() {
      openMenu();
    },
    add(directory: string) {
      addDirectory(directory);
    },
  }));

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
    <div className={`add-dir ${open ? "open" : ""}`} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="管理附加目录"
        className="add-dir-button"
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        title="管理附加目录（对应 CLI 的 /add-dir）"
        type="button"
      >
        <FolderPlus size={15} />
        {directories.length > 0 ? <em className="add-dir-count">{directories.length}</em> : null}
      </button>
      {open ? (
        <div aria-label="附加目录" className="add-dir-menu" role="dialog">
          <div className="add-dir-heading">
            <strong>附加目录</strong>
            <span>{directories.length} / {MAX_ADDITIONAL_DIRECTORIES}</span>
          </div>
          {directories.length === 0 ? (
            <div className="add-dir-empty">还没有附加目录，Claude 只能访问项目目录。</div>
          ) : (
            <div className="add-dir-list">
              {directories.map((directory) => (
                <div className="add-dir-item" key={directory} title={directory}>
                  <Folder size={13} />
                  <span className="add-dir-item-copy">
                    <strong>{pathName(directory)}</strong>
                    <small>{directory}</small>
                  </span>
                  <button
                    aria-label={`移除 ${directory}`}
                    onClick={() => onChange(directories.filter((item) => item !== directory))}
                    title="移除"
                    type="button"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {error ? <div className="add-dir-error" role="alert">{error}</div> : null}
          <button
            className="add-dir-add"
            disabled={picking || directories.length >= MAX_ADDITIONAL_DIRECTORIES}
            onClick={() => { void pickDirectory(); }}
            type="button"
          >
            {picking ? <span className="mini-spinner" /> : <FolderPlus size={13} />}
            <span>添加目录</span>
          </button>
        </div>
      ) : null}
    </div>
  );
});

export default AdditionalDirectories;
