import type { AgentMessage } from "../../lib/types";
import { ToolCallCard } from "./ToolCallCard";

interface Props {
  message: AgentMessage;
}

export function MessageBubble({ message }: Props) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] bg-accent/10 border border-accent/20 rounded-lg px-3 py-2 text-sm text-text-primary whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="max-w-[90%]">
          {message.thinkingText && (
            <details className="mb-1">
              <summary className="text-[10px] text-text-tertiary cursor-pointer hover:text-text-secondary">
                Thinking...
              </summary>
              <div className="text-xs text-text-tertiary italic mt-1 pl-2 border-l border-border-primary whitespace-pre-wrap">
                {message.thinkingText}
              </div>
            </details>
          )}
          <div className="text-sm text-text-primary whitespace-pre-wrap break-words">
            {renderContent(message.content || "")}
          </div>
        </div>
      );

    case "tool_call":
      return (
        <div className="max-w-[90%]">
          <ToolCallCard
            toolName={message.toolName || "Unknown"}
            toolInput={message.toolInput}
            isActive={!message.toolOutput}
          />
        </div>
      );

    case "tool_result":
      return (
        <div className="max-w-[90%]">
          <ToolCallCard
            toolName={message.toolName || "Tool"}
            toolOutput={message.toolOutput || message.content}
            isError={message.isError}
          />
        </div>
      );

    case "system":
      return (
        <div className="text-center">
          <span className="text-[10px] text-text-tertiary">
            {message.content}
          </span>
        </div>
      );

    case "error":
      return (
        <div className="bg-error/10 border border-error/30 rounded-lg px-3 py-2 text-sm text-error">
          {message.content}
        </div>
      );

    default:
      return null;
  }
}

/** Render text content with basic code block formatting. */
function renderContent(text: string): React.ReactNode {
  // Split on fenced code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const inner = part.slice(3, -3);
      // Remove optional language specifier from first line
      const newlineIdx = inner.indexOf("\n");
      const code = newlineIdx >= 0 ? inner.slice(newlineIdx + 1) : inner;
      return (
        <pre key={i} className="my-1 bg-bg-tertiary border border-border-primary rounded px-2 py-1.5 text-xs font-mono overflow-x-auto">
          {code}
        </pre>
      );
    }
    // Render inline code
    return renderInlineCode(part, i);
  });
}

function renderInlineCode(text: string, key: number): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  if (parts.length === 1) return <span key={key}>{text}</span>;
  return (
    <span key={key}>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="bg-bg-tertiary border border-border-primary rounded px-1 py-0.5 text-xs font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}
