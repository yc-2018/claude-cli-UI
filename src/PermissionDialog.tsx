import { Check, ShieldQuestion, X } from "lucide-react";
import type { ToolPermissionRequest } from "./types";

interface PermissionDialogProps {
  requests: ToolPermissionRequest[];
  waitingForCli: boolean;
  onAllowOnce(): void;
  onAllowConversation(): void;
  onDeny(): void;
}

export default function PermissionDialog({
  requests,
  waitingForCli,
  onAllowOnce,
  onAllowConversation,
  onDeny,
}: PermissionDialogProps) {
  const toolNames = [...new Set(requests.map((request) => request.toolName))];

  return (
    <div className="permission-overlay" role="presentation">
      <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title">
        <div className="permission-heading">
          <span className="permission-icon"><ShieldQuestion size={19} /></span>
          <div>
            <h2 id="permission-title">Claude 请求使用工具</h2>
            <p>确认后，Claude 会自动继续刚才的操作。</p>
          </div>
        </div>

        <div className="permission-tools">
          {requests.map((request) => (
            <div className="permission-tool" key={request.toolUseId ?? `${request.toolName}-${request.summary}`}>
              <strong>{request.toolName}</strong>
              {request.summary ? <code>{request.summary}</code> : null}
            </div>
          ))}
        </div>

        <p className="permission-scope">
          “仅允许本次”只授权这次重试；“本对话始终允许”会在当前对话后续运行中允许 {toolNames.join("、")}。
        </p>

        <div className="permission-actions">
          <button className="permission-button secondary permission-deny" onClick={onDeny} disabled={waitingForCli}>
            <X size={15} />拒绝
          </button>
          <span className="permission-action-spacer" />
          <button className="permission-button secondary permission-allow-once" onClick={onAllowOnce} disabled={waitingForCli}>
            仅允许本次
          </button>
          <button className="permission-button primary permission-allow-conversation" onClick={onAllowConversation} disabled={waitingForCli} autoFocus>
            <Check size={15} />本对话始终允许
          </button>
        </div>
        {waitingForCli ? <div className="permission-waiting"><span className="mini-spinner" />正在等待 Claude CLI 结束当前回合…</div> : null}
      </section>
    </div>
  );
}
