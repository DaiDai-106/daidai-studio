import { memo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram.tsx";
import "../styles/markdown.css";

const plugins = [remarkGfm];
const components: Components = {
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
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // 图片查看是独立的桌面能力，Markdown 本身不获取图片。
  img: ({ alt }) => <span className="markdown-image-label">{alt || "图片"}</span>,
};

function safeUrl(url: string) {
  return /^https?:\/\//i.test(url) ? defaultUrlTransform(url) : "";
}
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="message-text markdown">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        urlTransform={safeUrl}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
