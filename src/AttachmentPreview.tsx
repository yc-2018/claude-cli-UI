import { useEffect } from "react";
import { X } from "lucide-react";
import type { Attachment } from "./types";

export function attachmentUrl(attachment: Attachment) {
  return `claude-desk-attachment://local/${encodeURIComponent(attachment.storedName)}`;
}

export async function openAttachmentFile(attachment: Attachment) {
  try {
    const result = await window.claudeDesk.openAttachment(attachment.storedName);
    if (!result.opened) window.alert(result.error ?? "无法打开附件");
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "无法打开附件");
  }
}

export default function AttachmentPreview({ attachment, onClose }: { attachment: Attachment | null; onClose(): void }) {
  useEffect(() => {
    if (!attachment) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [attachment, onClose]);

  if (!attachment) return null;
  return (
    <div className="attachment-preview-backdrop" onMouseDown={onClose}>
      <div
        aria-label={`预览 ${attachment.name}`}
        aria-modal="true"
        className="attachment-preview-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <strong title={attachment.name}>{attachment.name}</strong>
          <button aria-label="关闭附件预览" onClick={onClose} title="关闭" type="button">
            <X size={16} />
          </button>
        </header>
        <div className="attachment-preview-content">
          <img alt={attachment.name} src={attachmentUrl(attachment)} />
        </div>
      </div>
    </div>
  );
}
