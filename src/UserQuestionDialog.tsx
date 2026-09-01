import { Check, MessageCircleQuestion, X } from "lucide-react";
import { useState } from "react";
import type { UserQuestion } from "./types";

interface UserQuestionDialogProps {
  questions: UserQuestion[];
  submitting: boolean;
  onSubmit(answers: Record<string, string>): void;
  onCancel(): void;
}

export default function UserQuestionDialog({ questions, submitting, onSubmit, onCancel }: UserQuestionDialogProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});

  const setSelection = (question: UserQuestion, label: string, checked: boolean) => {
    setSelections((current) => {
      const key = question.question;
      if (!question.multiSelect) return { ...current, [key]: [label] };
      const next = new Set(current[key] ?? []);
      if (checked) next.add(label); else next.delete(label);
      return { ...current, [key]: [...next] };
    });
  };

  const submit = () => {
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const selected = selections[question.question] ?? [];
      const other = otherValues[question.question]?.trim();
      const values = other ? [...selected.filter((item) => item !== "其他"), other] : selected;
      if (values.length === 0) return;
      answers[question.question] = values.join(", ");
    }
    onSubmit(answers);
  };

  return (
    <div className="permission-overlay" role="presentation">
      <section className="permission-dialog user-question-dialog" role="dialog" aria-modal="true" aria-labelledby="user-question-title">
        <div className="permission-heading">
          <span className="permission-icon"><MessageCircleQuestion size={19} /></span>
          <div>
            <h2 id="user-question-title">Claude 需要你的选择</h2>
            <p>回答后，计划会继续执行。</p>
          </div>
        </div>
        <div className="user-question-list">
          {questions.map((question) => {
            const selected = selections[question.question] ?? [];
            const otherSelected = selected.includes("其他");
            return (
              <fieldset className="user-question" key={question.question}>
                <legend>{question.header ? `${question.header}：` : ""}{question.question}</legend>
                <div className="user-question-options">
                  {question.options.map((option) => (
                    <label className="user-question-option" key={option.label}>
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        name={question.question}
                        checked={selected.includes(option.label)}
                        onChange={(event) => setSelection(question, option.label, event.target.checked)}
                      />
                      <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
                    </label>
                  ))}
                  <label className="user-question-option">
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={question.question}
                      checked={otherSelected}
                      onChange={(event) => setSelection(question, "其他", event.target.checked)}
                    />
                    <span><strong>其他</strong><small>输入自定义回答</small></span>
                  </label>
                </div>
                {otherSelected ? (
                  <input
                    className="user-question-other"
                    value={otherValues[question.question] ?? ""}
                    onChange={(event) => setOtherValues((current) => ({ ...current, [question.question]: event.target.value }))}
                    placeholder="请输入回答"
                    autoFocus
                  />
                ) : null}
              </fieldset>
            );
          })}
        </div>
        <div className="permission-actions">
          <button className="permission-button secondary" onClick={onCancel} disabled={submitting}><X size={15} />取消</button>
          <span className="permission-action-spacer" />
          <button className="permission-button primary" onClick={submit} disabled={submitting}><Check size={15} />提交回答</button>
        </div>
        {submitting ? <div className="permission-waiting"><span className="mini-spinner" />正在提交回答…</div> : null}
      </section>
    </div>
  );
}
