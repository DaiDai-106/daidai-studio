import { useEffect, useState } from "react";
import type { ProjectInfo } from "../../../../contracts/application.ts";
import { Dialog } from "../../../shared/components/dialog.tsx";

export function HiddenProjectsDialog({
  onClose,
  onRestore,
}: {
  onClose: () => void;
  onRestore: () => Promise<void>;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void window.desktop.application
      .listHiddenProjects()
      .then((items) => {
        if (active) setProjects(items);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取隐藏项目。");
      });
    return () => {
      active = false;
    };
  }, []);

  async function restore(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await window.desktop.application.restoreProject(id);
      await onRestore();
      setProjects((items) => items.filter((item) => item.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复项目失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="已隐藏项目" onClose={onClose}>
      <p>隐藏只从项目列表移除，项目文件和聊天仍会保留。</p>
      {error && <p role="alert">{error}</p>}
      {!projects.length && !error && <p>暂无隐藏项目。</p>}
      {projects.map((project) => (
        <div className="setting-row" key={project.id}>
          <div>
            <strong>{project.name}</strong>
            <p>{project.path}</p>
          </div>
          <button type="button" disabled={busy} onClick={() => void restore(project.id)}>
            恢复
          </button>
        </div>
      ))}
    </Dialog>
  );
}
