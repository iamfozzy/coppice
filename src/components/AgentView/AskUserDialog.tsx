import { useState } from "react";
import type { AgentPendingQuestion } from "../../lib/types";

interface Props {
  pending: AgentPendingQuestion;
  onSubmit: (answers: Record<string, string>) => void;
}

export function AskUserDialog({ pending, onSubmit }: Props) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});

  const handleSelect = (question: string, label: string) => {
    setSelections((prev) => ({ ...prev, [question]: label }));
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    for (const q of pending.questions) {
      const custom = customText[q.question]?.trim();
      if (custom) {
        answers[q.question] = custom;
      } else {
        answers[q.question] = selections[q.question] || q.options[0]?.label || "";
      }
    }
    onSubmit(answers);
  };

  return (
    <div className="mx-4 mb-3 border border-accent/30 bg-accent/5 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border-b border-accent/20">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" className="text-accent" />
          <path d="M5 5.5a2 2 0 013.5 1.5c0 1-1.5 1.2-1.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="text-accent" />
          <circle cx="7" cy="10.5" r="0.7" fill="currentColor" className="text-accent" />
        </svg>
        <span className="text-xs font-medium text-accent">Claude has a question</span>
      </div>

      <div className="px-3 py-2 space-y-3">
        {pending.questions.map((q) => (
          <div key={q.question} className="space-y-1.5">
            <div className="text-xs text-text-primary font-medium">{q.question}</div>
            <div className="space-y-1">
              {q.options.map((opt) => (
                <label
                  key={opt.label}
                  className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    selections[q.question] === opt.label
                      ? "bg-accent/10 border border-accent/30"
                      : "bg-bg-tertiary border border-border-primary hover:bg-bg-hover"
                  }`}
                >
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={q.question}
                    className="mt-0.5 accent-accent"
                    checked={selections[q.question] === opt.label}
                    onChange={() => handleSelect(q.question, opt.label)}
                  />
                  <div>
                    <div className="text-xs text-text-primary">{opt.label}</div>
                    {opt.description && (
                      <div className="text-[10px] text-text-tertiary">{opt.description}</div>
                    )}
                  </div>
                </label>
              ))}
              {/* Free text option */}
              <div className="mt-1">
                <input
                  type="text"
                  className="w-full px-2 py-1 text-xs bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
                  placeholder="Or type your own answer..."
                  value={customText[q.question] || ""}
                  onChange={(e) =>
                    setCustomText((prev) => ({ ...prev, [q.question]: e.target.value }))
                  }
                />
              </div>
            </div>
          </div>
        ))}

        <button
          className="px-3 py-1 text-xs rounded bg-accent hover:bg-accent-hover text-white transition-colors"
          onClick={handleSubmit}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
