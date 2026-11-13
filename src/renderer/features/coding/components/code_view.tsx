import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ThemedToken } from "shiki/types";
import {
  highlightCode,
  highlightLimitExceeded,
  languageForPath,
} from "../logic/syntax_highlighting.ts";

function subscribeTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

export function CodeView({
  path,
  content,
  startLine,
  endLine,
  active,
}: {
  path: string;
  content: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  active?: boolean;
}) {
  const region = useRef<HTMLElement>(null);
  const lines = content.split("\n");
  const lastLine = endLine ?? startLine;
  const validPosition = !!startLine && !!lastLine && lastLine <= lines.length;
  const dark = useSyncExternalStore(subscribeTheme, isDark);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [highlightFailed, setHighlightFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setTokens(null);
    setHighlightFailed(false);
    void highlightCode(path, content, dark).then(
      (value) => {
        if (active) setTokens(value);
      },
      () => {
        if (active) setHighlightFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [path, content, dark]);
  useEffect(() => {
    if (active && validPosition && startLine)
      region.current
        ?.querySelector(tokens ? `[data-file-line="${startLine}"]` : "mark")
        ?.scrollIntoView({ block: "center" });
  }, [active, validPosition, startLine, tokens]);
  const limited = highlightLimitExceeded(content);
  const rows = tokens?.map((line, index) => ({ line, number: index + 1, key: `line-${index}` }));
  return (
    <section ref={region} className="coding-code-scroll" aria-label="文件内容">
      {startLine && !validPosition && (
        <p role="status">引用行范围超出当前文件，请刷新或重新选择。</p>
      )}
      {(highlightFailed || (limited && languageForPath(path))) && (
        <p className="coding-highlight-notice" role="status">
          {highlightFailed ? "语法高亮不可用，已显示原文。" : "文件较大或单行过长，已显示纯文本。"}
        </p>
      )}
      {rows ? (
        <pre className="coding-content">
          {rows.map((row) => (
            <Fragment key={row.key}>
              <span
                className="coding-line"
                data-file-line={row.number}
                data-selected={
                  validPosition && row.number >= (startLine ?? 0) && row.number <= (lastLine ?? 0)
                }
              >
                <span className="coding-line-number" data-line={row.number} aria-hidden="true" />
                <span className="coding-line-text">
                  {row.line.map((token) => (
                    <span key={token.offset} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
                </span>
              </span>
              {row.number < rows.length ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      ) : (
        <pre className="coding-content">
          {validPosition && startLine && lastLine ? (
            <>
              {lines.slice(0, startLine - 1).join("\n")}
              {startLine > 1 ? "\n" : null}
              <mark data-selected="true">{lines.slice(startLine - 1, lastLine).join("\n")}</mark>
              {lastLine < lines.length ? "\n" : null}
              {lines.slice(lastLine).join("\n")}
            </>
          ) : (
            content
          )}
        </pre>
      )}
    </section>
  );
}
