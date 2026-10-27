import { memo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

const plugins = [remarkGfm];
const components: Components = {
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
  // Image observation is a separate desktop capability; Markdown never fetches images.
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
