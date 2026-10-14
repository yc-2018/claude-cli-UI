import { Check, MessageSquareText, ShieldQuestion, X } from "lucide-react";
import type { ToolPermissionRequest } from "./types";

interface PermissionDialogProps {
  requests: ToolPermissionRequest[];
  conversationTitle: string;
  projectName?: string;
  waitingForCli: boolean;
  onAllowOnce(): void;
  onAllowConversation(): void;
  onDeny(): void;
}

export default function PermissionDialog({
  requests,
  conversationTitle,
  projectName,
  waitingForCli,
  onAllowOnce,
  onAllowConversation,
  onDeny,
}: PermissionDialogProps) {
  const toolNames = [...new Set(requests.map((request) => request.toolName))];
  // 弹窗是整个窗口共用的：请求可能来自后台某个对话，用户此刻正看着别的对话，所以要写明是谁在问。
  const sourceLabel = projectName ? `${projectName} · ${conversationTitle}` : conversationTitle;
  const formatInput = (request: ToolPermissionRequest) => {
    if (typeof request.toolInput?.command === "string") return request.toolInput.command;
    if (request.toolInput) {
      try {
        return JSON.stringify(request.toolInput, null, 2);
      } catch {
        return request.summary;
      }
    }
    return request.summary;
  };

  return (
    <div className="permission-overlay" role="presentation">
      <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title">
        <div className="permission-heading">
          <span className="permission-icon"><ShieldQuestion size={19} /></span>
          <div className="permission-heading-text">
            <h2 id="permission-title">Claude 请求使用工具</h2>
            <p>确认后，Claude 会自动继续刚才的操作。</p>
            <p className="permission-source" title={`来自 ${sourceLabel}`} data-conversation-title={conversationTitle}>
              <MessageSquareText size={12} />
              <span>来自 {projectName ? `${projectName} · ` : ""}<strong>{conversationTitle}</strong></span>
            </p>
          </div>
        </div>

        <div className="permission-tools">
          {requests.map((request) => (
            <div className="permission-tool" key={request.toolUseId ?? `${request.toolName}-${request.summary}`}>
              <strong>{request.toolName}</strong>
              {formatInput(request) ? <pre className="permission-input"><code>{formatInput(request)}</code></pre> : null}
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
