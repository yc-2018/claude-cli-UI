import { useEffect } from "react";
import { Trash2, X } from "lucide-react";

interface DeleteConfirmDialogProps {
  title: string;
  description: string;
  detail?: string;
  error?: string;
  deleting: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export default function DeleteConfirmDialog({
  title,
  description,
  detail,
  error,
  deleting,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || deleting) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleting, onCancel]);

  return (
    <div className="permission-overlay" role="presentation">
      <section className="delete-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description">
        <div className="delete-confirm-heading">
          <span className="delete-confirm-icon"><Trash2 size={18} /></span>
          <div>
            <h2 id="delete-confirm-title">{title}</h2>
            <p id="delete-confirm-description">{description}</p>
          </div>
        </div>
        {detail ? <p className="delete-confirm-detail">{detail}</p> : null}
        {error ? <p className="delete-confirm-error" role="alert">{error}</p> : null}
        <div className="delete-confirm-actions">
          <button className="delete-confirm-button secondary" onClick={onCancel} disabled={deleting} autoFocus>
            <X size={15} />取消
          </button>
          <button className="delete-confirm-button danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? <span className="mini-spinner" /> : <Trash2 size={15} />}
            {deleting ? "正在删除" : "确认删除"}
          </button>
        </div>
      </section>
    </div>
  );
}
