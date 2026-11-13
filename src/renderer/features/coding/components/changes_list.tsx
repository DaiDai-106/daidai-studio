import { useEffect, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { DiffKind } from "../logic/content_tabs.ts";

type Changes = Awaited<ReturnType<ApplicationBridge["listCodingChanges"]>>;

export function ChangesList({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (path: string, kind: DiffKind) => void;
}) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    // 用户点击刷新时重新读取同一项目的状态。
    void revision;
    let active = true;
    setChanges(null);
    setError("");
    void window.desktop.application.listCodingChanges(projectId).then(
      (value) => {
        if (active) setChanges(value);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "读取 Git 变更失败。");
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, revision]);
  return (
    <div className="coding-changes">
      <div className="coding-changes-heading">
        <span>Git 变更</span>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          刷新
        </button>
      </div>
      {error && (
        <p className="coding-notice" role="alert">
          {error}
        </p>
      )}
      {!changes && !error && <p className="coding-notice">正在读取变更…</p>}
      {changes && !changes.entries.length && (
        <p className="coding-notice">当前项目没有 Git 变更。</p>
      )}
      {changes?.entries.map((entry) => (
        <div className="coding-change" key={entry.path}>
          <span className="coding-change-path" title={entry.path}>
            {entry.path}
          </span>
          <div className="coding-change-actions">
            {entry.staged && (
              <button type="button" onClick={() => onOpen(entry.path, "staged")}>
                已暂存
              </button>
            )}
            {entry.unstaged && (
              <button type="button" onClick={() => onOpen(entry.path, "unstaged")}>
                未暂存
              </button>
            )}
            {entry.untracked && (
              <button type="button" onClick={() => onOpen(entry.path, "untracked")}>
                未跟踪
              </button>
            )}
          </div>
        </div>
      ))}
      {changes?.truncated && <p className="coding-notice">仅显示前 200 个变更文件。</p>}
    </div>
  );
}
