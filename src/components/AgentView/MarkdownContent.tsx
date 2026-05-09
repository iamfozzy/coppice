import { Children, cloneElement, isValidElement, useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema, type Options as RehypeSanitizeOptions } from "rehype-sanitize";
import type { PluggableList } from "unified";
import * as commands from "../../lib/commands";
import { Tooltip } from "../ui/Tooltip";

interface MarkdownContentProps {
  text: string;
  /** Worktree root used for opening relative file references emitted by agents. */
  worktreePath?: string;
}

const allowedClassNames = [
  "contains-task-list",
  "task-list-item",
  /^language-[\w-]+$/,
];

const sanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "input"],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-[\w-]+$/]],
    li: [...(defaultSchema.attributes?.li ?? []), ["className", ...allowedClassNames]],
    ul: [...(defaultSchema.attributes?.ul ?? []), ["className", ...allowedClassNames]],
    input: [
      ["type", "checkbox"],
      "checked",
      "disabled",
    ],
  },
};

const rehypePlugins: PluggableList = [[rehypeSanitize, sanitizeSchema]];

export function MarkdownContent({ text, worktreePath }: MarkdownContentProps) {
  const components = useMemo(() => createMarkdownComponents(worktreePath), [worktreePath]);

  if (!text.trim()) return null;

  return (
    <div className="text-[13px] text-text-primary break-words leading-relaxed space-y-2.5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function createMarkdownComponents(worktreePath?: string): Components {
  return {
    h1: ({ children }) => (
      <h3 className="text-[15px] font-bold text-text-primary pt-1">
        {linkifyChildren(children, worktreePath)}
      </h3>
    ),
    h2: ({ children }) => (
      <h4 className="text-[14px] font-semibold text-text-primary pt-0.5">
        {linkifyChildren(children, worktreePath)}
      </h4>
    ),
    h3: ({ children }) => (
      <h5 className="text-[13px] font-semibold text-text-secondary">
        {linkifyChildren(children, worktreePath)}
      </h5>
    ),
    h4: ({ children }) => (
      <h5 className="text-[13px] font-semibold text-text-secondary">
        {linkifyChildren(children, worktreePath)}
      </h5>
    ),
    h5: ({ children }) => (
      <h5 className="text-[12px] font-semibold text-text-secondary">
        {linkifyChildren(children, worktreePath)}
      </h5>
    ),
    h6: ({ children }) => (
      <h6 className="text-[12px] font-semibold text-text-tertiary uppercase tracking-wide">
        {linkifyChildren(children, worktreePath)}
      </h6>
    ),
    p: ({ children }) => (
      <p className="whitespace-pre-wrap">
        {linkifyChildren(children, worktreePath)}
      </p>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-text-primary">
        {linkifyChildren(children, worktreePath)}
      </strong>
    ),
    em: ({ children }) => (
      <em className="italic">{linkifyChildren(children, worktreePath)}</em>
    ),
    del: ({ children }) => (
      <del className="text-text-tertiary">{linkifyChildren(children, worktreePath)}</del>
    ),
    a: ({ href, children }) => <MarkdownLink href={href} worktreePath={worktreePath}>{children}</MarkdownLink>,
    ul: ({ className, children }) => {
      const isTaskList = typeof className === "string" && className.includes("contains-task-list");
      return (
        <ul className={`${isTaskList ? "pl-1" : "pl-5 list-disc marker:text-text-tertiary"} space-y-0.5`}>
          {children}
        </ul>
      );
    },
    ol: ({ start, children }) => (
      <ol start={start} className="pl-5 list-decimal marker:text-text-tertiary marker:font-mono marker:text-[12px] space-y-0.5">
        {children}
      </ol>
    ),
    li: ({ className, children }) => {
      const isTaskItem = typeof className === "string" && className.includes("task-list-item");
      return (
        <li className={isTaskItem ? "list-none flex items-start gap-2" : "pl-1"}>
          {linkifyChildren(children, worktreePath)}
        </li>
      );
    },
    input: ({ checked, disabled, type }) => (
      <input
        type={type}
        checked={checked}
        disabled={disabled}
        readOnly
        className="mt-[3px] h-3 w-3 rounded border-border-primary accent-accent shrink-0"
      />
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-accent/40 pl-3 text-text-secondary italic space-y-1">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="border-border-primary my-1" />,
    table: ({ children }) => (
      <div className="overflow-x-auto rounded-lg border border-border-primary">
        <table className="w-full text-[12px] border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-bg-secondary/60">{children}</thead>,
    th: ({ align, children }) => (
      <th
        className="px-3 py-1.5 font-semibold text-text-primary border-b border-border-primary text-left"
        style={{ textAlign: toTextAlign(align) }}
      >
        {linkifyChildren(children, worktreePath)}
      </th>
    ),
    tr: ({ children }) => <tr className="even:bg-bg-secondary/30">{children}</tr>,
    td: ({ align, children }) => (
      <td
        className="px-3 py-1.5 text-text-secondary border-b border-border-primary/50 align-top"
        style={{ textAlign: toTextAlign(align) }}
      >
        {linkifyChildren(children, worktreePath)}
      </td>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const raw = String(children).replace(/\n$/, "");
      const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
      const isBlock = Boolean(language) || String(children).endsWith("\n");
      if (isBlock) return <CodeBlock lang={language} content={raw} />;
      return <InlineCode>{children}</InlineCode>;
    },
    img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  };
}

function toTextAlign(align: string | undefined) {
  return align === "center" || align === "right" || align === "justify" ? align : "left";
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="bg-bg-tertiary text-accent/90 border border-border-primary rounded px-1 py-px text-[12px] font-mono">
      {children}
    </code>
  );
}

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
      <div className="flex items-center justify-between px-3 py-1 bg-bg-secondary/60 border-b border-border-primary">
        <span className="text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
          {lang || "text"}
        </span>
        <Tooltip text="Copy to clipboard" side="top" align="right">
          <button
            type="button"
            onClick={handleCopy}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1"
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
        </Tooltip>
      </div>
      <pre className="px-3 py-2.5 text-[12px] font-mono text-text-secondary overflow-x-auto leading-relaxed whitespace-pre">
        {content}
      </pre>
    </div>
  );
}

function MarkdownLink({ href, worktreePath, children }: { href?: string; worktreePath?: string; children: ReactNode }) {
  const safeExternalUrl = getSafeExternalUrl(href);
  if (safeExternalUrl) {
    return (
      <a
        className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"
        href={safeExternalUrl}
        onClick={(event) => {
          event.preventDefault();
          void shellOpen(safeExternalUrl);
        }}
      >
        {children}
      </a>
    );
  }

  const filePath = normalizeRelativeFilePath(href);
  if (worktreePath && filePath) {
    return <FileReferenceLink filePath={filePath} label={children} worktreePath={worktreePath} />;
  }

  if (href?.startsWith("#")) {
    return <a className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent" href={href}>{children}</a>;
  }

  return <span title={href ? `Unsafe or unsupported link: ${href}` : undefined}>{children}</span>;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const safeExternalUrl = getSafeExternalUrl(src);
  if (!safeExternalUrl) return <span className="text-text-tertiary">{alt || "Image"}</span>;

  return (
    <button
      type="button"
      className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"
      onClick={() => void shellOpen(safeExternalUrl)}
      title={safeExternalUrl}
    >
      {alt || "Open image"}
    </button>
  );
}

function getSafeExternalUrl(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) return parsed.toString();
  } catch {
    return null;
  }
  return null;
}

function normalizeRelativeFilePath(path: string | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\")) return null;

  const withoutAnchor = trimmed.split("#", 1)[0].split("?", 1)[0];
  const withoutLineSuffix = withoutAnchor.replace(/:(\d+)(?::\d+)?$/, "");
  const normalized = withoutLineSuffix.replace(/^\.\//, "").replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

const fileRefPattern = /(^|[\s([{<])((?:\.\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?::\d+)?)?(?=$|[\s)\]}>.,;:!?])/g;

function linkifyChildren(children: ReactNode, worktreePath?: string): ReactNode {
  return Children.toArray(children).flatMap((child, childIndex) => linkifyNode(child, worktreePath, `md-${childIndex}`));
}

function linkifyNode(node: ReactNode, worktreePath: string | undefined, keyPrefix: string): ReactNode[] {
  if (typeof node === "string") return linkifyText(node, worktreePath, keyPrefix);

  if (isValidElement<{ children?: ReactNode }>(node) && shouldSkipNestedLinking(node)) {
    return [node];
  }

  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children) {
    return [
      cloneElement(node as ReactElement<{ children?: ReactNode }>, {
        children: linkifyChildren(node.props.children, worktreePath),
      }),
    ];
  }

  return [node];
}

function shouldSkipNestedLinking(node: ReactElement) {
  return (
    node.type === "a" ||
    node.type === "button" ||
    node.type === "code" ||
    node.type === InlineCode ||
    node.type === CodeBlock ||
    node.type === MarkdownLink ||
    node.type === FileReferenceLink
  );
}

function linkifyText(text: string, worktreePath: string | undefined, keyPrefix: string): ReactNode[] {
  if (!worktreePath) return [text];

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  fileRefPattern.lastIndex = 0;

  while ((match = fileRefPattern.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const filePath = normalizeRelativeFilePath(match[2]);
    if (!filePath) continue;

    const label = `${match[2]}${match[3] ? `:${match[3]}` : ""}`;
    const linkStart = match.index + prefix.length;
    if (linkStart > lastIndex) nodes.push(text.slice(lastIndex, linkStart));
    nodes.push(
      <FileReferenceLink
        key={`${keyPrefix}-file-${key++}`}
        filePath={filePath}
        label={label}
        line={match[3]}
        worktreePath={worktreePath}
      />
    );
    lastIndex = linkStart + label.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length ? nodes : [text];
}

function FileReferenceLink({
  filePath,
  label,
  line,
  worktreePath,
}: {
  filePath: string;
  label: ReactNode;
  line?: string;
  worktreePath: string;
}) {
  const title = line ? `Open ${filePath} (line ${line})` : `Open ${filePath}`;
  return (
    <button
      type="button"
      title={title}
      className="font-mono text-accent underline underline-offset-2 decoration-accent/30 hover:decoration-accent"
      onClick={() => void commands.openWorktreeFileInEditor(worktreePath, filePath)}
    >
      {label}
    </button>
  );
}
