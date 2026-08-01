import { useEffect } from "react";
import { BellOff, Download, ExternalLink, RefreshCw, Rocket, X } from "lucide-react";
import type { AppUpdateState } from "./types";

interface UpdateDialogProps {
  state: AppUpdateState;
  actionError?: string;
  onDismiss(): void;
  onDownload(): void;
  onIgnoreVersion(): void;
  onInstall(): void;
  onOpenRelease(): void;
}

function formatBytes(value?: number) {
  if (!value || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export default function UpdateDialog({
  state,
  actionError,
  onDismiss,
  onDownload,
  onIgnoreVersion,
  onInstall,
  onOpenRelease,
}: UpdateDialogProps) {
  const downloading = state.phase === "downloading";
  const ready = state.phase === "ready";
  const downloadError = state.phase === "error" && state.errorContext === "download";
  const progress = Math.max(0, Math.min(100, state.percent ?? 0));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  const title = ready
    ? "新版已经准备好"
    : downloading
      ? "正在下载更新"
      : downloadError
        ? "更新没有完成"
        : `发现新版本 v${state.latestVersion ?? ""}`;

  return (
    <div className="permission-overlay update-overlay" role="presentation">
      <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <div className="update-heading">
          <span className="update-icon"><Rocket size={19} /></span>
          <div>
            <h2 id="update-dialog-title">{title}</h2>
            <p>
              当前版本 v{state.currentVersion}
              {state.latestVersion ? ` · 最新版本 v${state.latestVersion}` : ""}
            </p>
          </div>
          <button className="update-close" onClick={onDismiss} aria-label="关闭更新提示" type="button"><X size={16} /></button>
        </div>

        {downloading ? (
          <div className="update-progress-section">
            <div className="update-progress-label">
              <span>{progress > 0 ? `${progress.toFixed(0)}%` : "正在连接 GitHub…"}</span>
              <small>
                {formatBytes(state.transferred)}
                {state.total ? ` / ${formatBytes(state.total)}` : ""}
                {state.bytesPerSecond ? ` · ${formatBytes(state.bytesPerSecond)}/s` : ""}
              </small>
            </div>
            <div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : null}

        {!downloading && !downloadError && state.releaseNotes ? (
          <div className="update-release-notes">
            <strong>本次更新</strong>
            <p>{state.releaseNotes}</p>
          </div>
        ) : null}

        <p className="update-mode-note">
          {state.portable
            ? "Portable 版会把新版下载到当前程序旁边。启动新版后，旧版文件会移入 Windows 回收站。"
            : "安装版下载完成后会退出应用、安装新版并自动重新打开。"}
        </p>

        {state.error ? <p className="update-error" role="alert">{state.error}</p> : null}
        {actionError ? <p className="update-error" role="alert">{actionError}</p> : null}

        <div className="update-actions">
          <button className="update-button secondary" onClick={onOpenRelease} type="button">
            <ExternalLink size={14} />发布页面
          </button>
          {!downloading && !ready ? (
            <button className="update-button quiet update-ignore-button" onClick={onIgnoreVersion} type="button">
              <BellOff size={14} />此版本不再提醒
            </button>
          ) : null}
          <span className="update-action-spacer" />
          <button className="update-button secondary update-later-button" onClick={onDismiss} type="button">
            {downloading ? "后台下载" : ready ? "稍后重启" : "稍后"}
          </button>
          {ready ? (
            <button className="update-button primary update-install-button" onClick={onInstall} type="button" autoFocus>
              <RefreshCw size={14} />重启并更新
            </button>
          ) : downloading ? null : state.downloadAvailable !== false ? (
            <button className="update-button primary update-download-button" onClick={onDownload} type="button" autoFocus>
              {downloadError ? <RefreshCw size={14} /> : <Download size={14} />}
              {downloadError ? "重新下载" : "下载更新"}
            </button>
          ) : (
            <button className="update-button primary" onClick={onOpenRelease} type="button" autoFocus>
              <ExternalLink size={14} />前往下载
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
