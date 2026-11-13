import { memo, type ReactNode, useContext } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  formatFileReference,
  parseFileReference,
  resolveMarkdownFileReference,
} from "../../../shared/file_references.ts";
import { CodingOpenContext } from "../logic/coding_context.ts";
import { MermaidDiagram } from "./mermaid_diagram.tsx";
import "../styles/markdown.css";

function MarkdownLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const coding = useContext(CodingOpenContext);
  if (href?.startsWith("#dai-file=")) {
    const reference = parseFileReference(decodeURIComponent(href.slice(10)));
    return reference && coding ? (
      <button type="button" className="coding-file-link" onClick={() => coding.openFile(reference)}>
        {children}
      </button>
    ) : (
      <span>{children}</span>
    );
  }
  let previewable = false;
  try {
    const url = new URL(href ?? "");
    previewable =
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !url.username &&
      !url.password;
  } catch {
    // 非 URL 不提供工作区预览入口。
  }
  return href ? (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
      {previewable && coding && (
        <button
          type="button"
          className="markdown-preview-link"
          onClick={() => coding.openUrl(href)}
        >
          工作区预览
        </button>
      )}
    </>
  ) : (
    <span>{children}</span>
  );
}

function InlineCode({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string | undefined;
}) {
  const coding = useContext(CodingOpenContext);
  const text = String(children ?? "");
  const reference = !className && !text.includes("\n") ? parseFileReference(text) : null;
  return coding && reference ? (
    <button
      type="button"
      className="coding-file-link"
      title={`打开 ${text}`}
      onClick={() => coding.openFile(reference)}
    >
      <code>{children}</code>
    </button>
  ) : (
    <code className={className}>{children}</code>
  );
}

const plugins = [remarkGfm];
const components: Components = {
  code: InlineCode,
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code") {
      const classes = code.properties.className;
      if (Array.isArray(classes) && classes.includes("language-mermaid")) {
        const source = code.children
          .map((child) => (child.type === "text" ? child.value : ""))
          .join("");
        return <MermaidDiagram source={source} />;
      }
    }
    return <pre>{children}</pre>;
  },
  table: ({ children }) => (
    <section className="markdown-table" aria-label="表格">
      <table>{children}</table>
    </section>
  ),
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  // 图片查看是独立的桌面能力，Markdown 本身不获取图片。
  img: ({ alt }) => <span className="markdown-image-label">{alt || "图片"}</span>,
};

function safeUrl(url: string, sourcePath?: string) {
  try {
    const decoded = decodeURIComponent(url);
    const reference = resolveMarkdownFileReference(decoded, sourcePath);
    if (reference) return `#dai-file=${encodeURIComponent(formatFileReference(reference))}`;
  } catch {
    return "";
  }
  return /^https?:\/\//i.test(url) ? defaultUrlTransform(url) : "";
}
export const MarkdownText = memo(function MarkdownText({
  text,
  sourcePath,
}: {
  text: string;
  sourcePath?: string;
}) {
  return (
    <div className="message-text markdown">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        urlTransform={(url) => safeUrl(url, sourcePath)}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
