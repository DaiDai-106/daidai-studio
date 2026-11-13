import { useId, useState } from "react";
import type { DiffKind } from "../logic/content_tabs.ts";

const labels: Record<DiffKind, string> = {
  staged: "已暂存：HEAD 与暂存区",
  unstaged: "未暂存：暂存区与工作目录",
  untracked: "未跟踪：新文件",
};

export function DiffView({
  patch,
  kind,
  path,
  conversationId,
  onAnnotate,
}: {
  patch: string;
  kind: DiffKind;
  path: string;
  conversationId?: string | undefined;
  onAnnotate: (text: string) => boolean;
}) {
  const commentId = useId();
  const [snapshot, setSnapshot] = useState(patch);
  const [changed, setChanged] = useState(false);
  const [selection, setSelection] = useState<{ first: number; last: number } | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  // 相同内容的刷新保留批注；差异变化后不复用旧的行选择。
  if (snapshot !== patch) {
    setSnapshot(patch);
    setChanged(Boolean(selection || comment));
    setSelection(null);
    setComment("");
    setError("");
  }
  const lines = patch.length > 200_000 ? [] : patch.split("\n");
  const large = patch.length > 200_000 || lines.length > 5000;
  const rows = large ? [] : lines.map((line, index) => ({ line, index, key: `line-${index}` }));
  const start = selection ? Math.min(selection.first, selection.last) : -1;
  const end = selection ? Math.max(selection.first, selection.last) : -1;

  function addComment() {
    if (!selection || !comment.trim()) return;
    const selected = lines.slice(start, end + 1).join("\n");
    if (end - start + 1 > 200 || selected.length > 32000) {
      setError("请选择不超过 200 行、32000 字符的差异。");
      return;
    }
    const ticks = Math.max(3, ...[...selected.matchAll(/`+/g)].map((match) => match[0].length + 1));
    const fence = "`".repeat(ticks);
    const text = `代码差异批注：${JSON.stringify(path)}（${labels[kind]}，差异第 ${start + 1}–${end + 1} 行）\n${comment.trim()}\n\n以下是选择时的差异快照：\n${fence}diff\n${selected}\n${fence}`;
    if (!onAnnotate(text)) {
      setError("草稿过长，请缩短批注或已有草稿。");
      return;
    }
    setSelection(null);
    setComment("");
    setError("");
  }

  return (
    <section className="coding-code-scroll" aria-label="文件差异">
      <div className="coding-diff-label">{labels[kind]}</div>
      {changed && (
        <p className="coding-notice" role="status">
          差异已变化，请重新选择需要批注的行。
        </p>
      )}
      {!patch ? (
        <p className="coding-notice">
          {kind === "untracked" ? "新文件为空。" : "当前基准下没有差异，请刷新变更列表。"}
        </p>
      ) : large ? (
        <>
          <p className="coding-highlight-notice">差异较大，已显示纯文本，暂不支持批注。</p>
          <pre className="coding-diff">{patch}</pre>
        </>
      ) : (
        <>
          <p className="coding-highlight-notice">点击选择差异行，按住 Shift 点击选择范围。</p>
          <pre className="coding-diff">
            {rows.map(({ line, index, key }) => (
              <button
                type="button"
                className={`coding-diff-line ${line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : line.startsWith("@@") ? "hunk" : ""}`}
                data-selected={index >= start && index <= end}
                aria-label={`选择差异第 ${index + 1} 行`}
                aria-pressed={index >= start && index <= end}
                key={key}
                onClick={(event) => {
                  setChanged(false);
                  const extend = event.shiftKey;
                  setSelection((previous) => ({
                    first: extend && previous ? previous.first : index,
                    last: index,
                  }));
                  setError("");
                }}
              >
                {line || " "}
              </button>
            ))}
          </pre>
          {selection && (
            <div className="coding-annotation">
              <label htmlFor={commentId}>
                批注差异第 {start + 1}–{end + 1} 行
              </label>
              <textarea
                id={commentId}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              {!conversationId && <p>请先选择一个会话。</p>}
              {error && <p role="alert">{error}</p>}
              <button
                type="button"
                disabled={!conversationId || !comment.trim()}
                onClick={addComment}
              >
                添加到聊天草稿
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
