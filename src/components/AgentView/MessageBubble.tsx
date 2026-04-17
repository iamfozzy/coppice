import { useMemo, useState, useCallback } from "react";
import type { AgentMessage } from "../../lib/types";

interface Props {
  message: AgentMessage;
}

export function MessageBubble({ message }: Props) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end pl-12">
          <div className="bg-accent/10 border border-accent/20 rounded-xl rounded-br-sm px-3.5 py-2 text-sm text-text-primary whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="pr-8">
          {message.thinkingText && <ThinkingBlock text={message.thinkingText} />}
          {message.content && <MarkdownContent text={message.content} />}
        </div>
      );

    case "system":
      return (
        <div className="flex items-center gap-2 py-0.5">
          <div className="flex-1 h-px bg-border-primary" />
          <span className="text-[10px] text-text-tertiary shrink-0">{message.content}</span>
          <div className="flex-1 h-px bg-border-primary" />
        </div>
      );

    case "error":
      return (
        <div className="flex items-start gap-2 bg-error/8 border border-error/20 rounded-lg px-3 py-2.5 text-sm text-error">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="mt-0.5 shrink-0">
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7 4v3.5M7 9.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span className="break-words">{message.content}</span>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Thinking block
// ---------------------------------------------------------------------------
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").length;
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Thinking
        <span className="text-text-tertiary/60">({lines} {lines === 1 ? "line" : "lines"})</span>
      </button>
      {open && (
        <div className="mt-1.5 pl-3 border-l-2 border-border-primary text-xs text-text-tertiary/80 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lightweight Markdown renderer
// ---------------------------------------------------------------------------

type Block =
  | { type: "heading"; level: number; content: string }
  | { type: "code"; lang: string; content: string }
  | { type: "hr" }
  | { type: "blockquote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "paragraph"; content: string };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, content: headingMatch[2] });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bqLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", lines: bqLines });
      continue;
    }

    // Unordered list (-, *, +)
    if (/^[\-\*\+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\-\*\+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\-\*\+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\d+[\.\)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[\.\)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[\.\)]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — collect contiguous non-blank, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^(---|\*\*\*|___)\s*$/) &&
      !lines[i].match(/^>\s?/) &&
      !lines[i].match(/^[\-\*\+]\s/) &&
      !lines[i].match(/^\d+[\.\)]\s/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", content: paraLines.join("\n") });
    }
  }

  return blocks;
}

/** Render inline markdown: bold, italic, bold+italic, inline code, links, strikethrough. */
function renderInline(text: string): React.ReactNode[] {
  // Order: bold+italic first, then bold, italic, code, link, strikethrough
  const inlineRegex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|~~(.+?)~~)/g;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[2] != null) {
      // ***bold italic***
      nodes.push(<strong key={key++} className="font-semibold italic">{match[2]}</strong>);
    } else if (match[3] != null) {
      // **bold**
      nodes.push(<strong key={key++} className="font-semibold text-text-primary">{match[3]}</strong>);
    } else if (match[4] != null) {
      // *italic*
      nodes.push(<em key={key++} className="italic">{match[4]}</em>);
    } else if (match[5] != null) {
      // `code`
      nodes.push(
        <code key={key++} className="bg-bg-tertiary text-accent/90 border border-border-primary rounded px-1 py-px text-[12px] font-mono">
          {match[5]}
        </code>
      );
    } else if (match[6] != null && match[7] != null) {
      // [text](url)
      nodes.push(
        <a key={key++} className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent" href={match[7]} target="_blank" rel="noopener noreferrer">
          {match[6]}
        </a>
      );
    } else if (match[8] != null) {
      // ~~strikethrough~~
      nodes.push(<del key={key++} className="text-text-tertiary">{match[8]}</del>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

// ---------------------------------------------------------------------------
// Code block with language label + copy button
// ---------------------------------------------------------------------------
function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [content]);

  return (
    <div className="rounded-lg border border-border-primary bg-bg-tertiary overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-bg-secondary/60 border-b border-border-primary">
        <span className="text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
          {lang || "text"}
        </span>
        <button
          onClick={handleCopy}
          className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5.5l2 2 4-4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="3" y="3" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="0.9" />
                <path d="M7 3V2a1 1 0 00-1-1H2a1 1 0 00-1 1v4a1 1 0 001 1h1" stroke="currentColor" strokeWidth="0.9" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="px-3 py-2.5 text-[12px] font-mono text-text-secondary overflow-x-auto leading-relaxed">
        {content}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarkdownContent — the main rendered output
// ---------------------------------------------------------------------------
export function MarkdownContent({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  if (blocks.length === 0) return null;

  return (
    <div className="text-[13px] text-text-primary break-words leading-relaxed space-y-2.5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading": {
            if (block.level === 1)
              return <h3 key={i} className="text-[15px] font-bold text-text-primary pt-1">{renderInline(block.content)}</h3>;
            if (block.level === 2)
              return <h4 key={i} className="text-[14px] font-semibold text-text-primary pt-0.5">{renderInline(block.content)}</h4>;
            return <h5 key={i} className="text-[13px] font-semibold text-text-secondary">{renderInline(block.content)}</h5>;
          }
          case "code":
            return <CodeBlock key={i} lang={block.lang} content={block.content} />;
          case "hr":
            return <hr key={i} className="border-border-primary my-1" />;
          case "blockquote":
            return (
              <blockquote key={i} className="border-l-2 border-accent/40 pl-3 text-text-secondary italic">
                {block.lines.map((line, j) => (
                  <p key={j}>{renderInline(line)}</p>
                ))}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={i} className="pl-4 space-y-0.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex items-start gap-2">
                    <span className="mt-[7px] w-1 h-1 rounded-full bg-text-tertiary shrink-0" />
                    <span>{renderInline(item)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="pl-4 space-y-0.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex items-start gap-2">
                    <span className="text-text-tertiary text-[12px] font-mono w-4 shrink-0 text-right">{j + 1}.</span>
                    <span>{renderInline(item)}</span>
                  </li>
                ))}
              </ol>
            );
          case "paragraph":
            return (
              <p key={i} className="whitespace-pre-wrap">
                {renderInline(block.content)}
              </p>
            );
        }
      })}
    </div>
  );
}
