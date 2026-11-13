import { useEffect, useRef, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";

type Entry = Awaited<ReturnType<ApplicationBridge["listCodingFiles"]>>["entries"][number];

export function FileTree({
  projectId,
  path,
  onOpen,
  onPreview,
}: {
  projectId: string;
  path: string;
  onOpen: (path: string) => void;
  onPreview: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [request, setRequest] = useState({ offset: 0, revision: 0 });
  const snapshot = useRef<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string[]>([]);
  function refresh() {
    snapshot.current = undefined;
    setEntries([]);
    setNextOffset(null);
    setRequest((previous) => ({ offset: 0, revision: previous.revision + 1 }));
  }

  useEffect(() => {
    const { offset } = request;
    let active = true;
    setError("");
    void window.desktop.application.listCodingFiles(projectId, path, offset, snapshot.current).then(
      (result) => {
        if (!active) return;
        setEntries((previous) =>
          offset === 0 ? result.entries : [...previous, ...result.entries],
        );
        snapshot.current = result.snapshot;
        setNextOffset(result.nextOffset);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "读取目录失败。");
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, path, request]);
  return (
    <ul className="coding-tree-list">
      {!path && (
        <li>
          <button type="button" className="text-button" aria-label="刷新文件树" onClick={refresh}>
            刷新文件树
          </button>
        </li>
      )}
      {entries.map((entry) => {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const expanded = open.includes(entry.name);
        return (
          <li key={entry.name}>
            <div className="coding-file-row">
              <button
                type="button"
                className="coding-tree-item"
                onClick={() => {
                  if (!entry.directory) onOpen(child);
                  else
                    setOpen((items) =>
                      expanded
                        ? items.filter((name) => name !== entry.name)
                        : [...items, entry.name],
                    );
                }}
              >
                {entry.directory ? (expanded ? "▾ " : "▸ ") : "  "}
                {entry.name}
              </button>
              {!entry.directory && /\.html?$/i.test(entry.name) && (
                <button
                  type="button"
                  className="coding-file-preview"
                  aria-label={`预览 ${child}`}
                  onClick={() => onPreview(child)}
                >
                  预览
                </button>
              )}
            </div>
            {entry.directory && expanded && (
              <FileTree projectId={projectId} path={child} onOpen={onOpen} onPreview={onPreview} />
            )}
          </li>
        );
      })}
      {nextOffset !== null && (
        <li>
          <button
            type="button"
            onClick={() => setRequest((previous) => ({ ...previous, offset: nextOffset }))}
          >
            加载更多
          </button>
        </li>
      )}
      {error && (
        <li className="coding-notice" role="alert">
          {error}
          <button type="button" onClick={refresh}>
            重试目录
          </button>
        </li>
      )}
    </ul>
  );
}
