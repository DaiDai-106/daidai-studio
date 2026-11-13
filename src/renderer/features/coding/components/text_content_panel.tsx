import { useEffect, useState } from "react";
import { IconButton } from "../../../shared/components/icon.tsx";
import { MarkdownText } from "../../../shared/components/markdown_text.tsx";
import type { TextContent } from "../logic/content_tabs.ts";
import { highlightLimitExceeded } from "../logic/syntax_highlighting.ts";
import { CodeView } from "./code_view.tsx";
import { DiffView } from "./diff_view.tsx";

export function TextContentPanel({
  projectId,
  id,
  content,
  active,
  conversationId,
  onAnnotate,
}: {
  projectId: string;
  id: string;
  content: TextContent;
  active: boolean;
  conversationId?: string | undefined;
  onAnnotate: (text: string) => boolean;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const markdown = content.type === "file" && /\.(?:md|markdown)$/iu.test(content.path);
  useEffect(() => {
    if (content.type === "file" && content.startLine) setPreview(false);
  }, [content]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    // 刷新计数只触发重读，不是后端请求参数。
    void revision;
    setLoading(true);
    setError("");
    const read =
      content.type === "file"
        ? window.desktop.application
            .readCodingFile(projectId, content.path)
            .then((result) => result.content)
        : window.desktop.application
            .readCodingDiff(projectId, content.path, content.kind)
            .then((result) => result.patch);
    void read.then(
      (text) => {
        if (live) {
          setValue(text);
          setLoading(false);
        }
      },
      (cause: unknown) => {
        if (live) {
          setError(cause instanceof Error ? cause.message : "读取失败。");
          setLoading(false);
        }
      },
    );
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [projectId, content, revision, active]);
  return (
    <section
      className="coding-tab-panel"
      role="tabpanel"
      id={`content-panel-${id}`}
      aria-labelledby={`content-tab-${id}`}
      hidden={!active}
    >
      <div className="coding-heading">
        <span className="coding-path" title={content.path}>
          {content.path}
        </span>
        <div className="coding-heading-actions">
          {markdown && (
            <fieldset className="coding-view-toggle" aria-label="Markdown 显示方式">
              <button
                type="button"
                aria-label="查看源码"
                aria-pressed={!preview}
                onClick={() => setPreview(false)}
              >
                源码
              </button>
              <button
                type="button"
                aria-label="预览 Markdown"
                aria-pressed={preview}
                onClick={() => setPreview(true)}
              >
                预览
              </button>
            </fieldset>
          )}
          <IconButton
            icon="refresh"
            label="刷新"
            onClick={() => setRevision((value) => value + 1)}
          />
        </div>
      </div>
      {error && (
        <p className="coding-notice" role="alert">
          {error}
        </p>
      )}
      {loading && value !== null && (
        <p className="coding-notice" role="status">
          正在刷新…
        </p>
      )}
      {value === null ? (
        <p className="coding-notice">{loading ? "正在读取…" : "暂无内容。"}</p>
      ) : content.type === "file" && markdown && preview && !highlightLimitExceeded(value) ? (
        <section className="coding-code-scroll coding-markdown-preview" aria-label="Markdown 预览">
          <MarkdownText text={value} sourcePath={content.path} />
        </section>
      ) : content.type === "file" ? (
        <>
          {markdown && preview && (
            <p className="coding-notice" role="status">
              Markdown 内容较大，已显示源码。
            </p>
          )}
          <CodeView
            path={content.path}
            content={value}
            startLine={content.startLine}
            endLine={content.endLine}
            active={active}
          />
        </>
      ) : (
        <DiffView
          key={`${content.path}:${content.kind}:${conversationId ?? ""}`}
          patch={value}
          kind={content.kind}
          path={content.path}
          conversationId={conversationId}
          onAnnotate={onAnnotate}
        />
      )}
    </section>
  );
}
