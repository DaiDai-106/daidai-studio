import { useState } from "react";
import type { CreateProjectInput } from "../../../../contracts/bridge.ts";
import { Dialog, Field } from "../../../shared/components/dialog.tsx";
import "../styles/create_project.css";

// 工作目录的选择交给主进程，界面不会自行提交未授权的绝对路径。
export function CreateProjectDialog({
  error,
  onCreate,
  onClose,
}: {
  error: string;
  onCreate: (draft: CreateProjectInput) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<{ token: string; path: string } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function chooseDirectory() {
    if (selecting || submitting) return;
    setSelecting(true);
    setSelectionError("");
    try {
      const selection = await window.desktop.application.chooseProjectDirectory();
      if (selection) setDirectory(selection);
    } catch (cause) {
      setSelectionError(cause instanceof Error ? cause.message : "无法选择项目文件夹。");
    } finally {
      setSelecting(false);
    }
  }

  async function submit() {
    if (!name.trim() || submitting || selecting) return;
    setSubmitting(true);
    try {
      if (
        await onCreate({
          name: name.trim(),
          mode: "coding",
          ...(directory ? { directoryToken: directory.token } : {}),
        })
      )
        onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="新建项目" onClose={onClose} protectChanges>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="项目名称">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
        </Field>
        <div className="project-directory-choice">
          <span className="project-directory-label">项目文件夹</span>
          <div className="project-directory-row">
            <span className="project-directory-path" title={directory?.path}>
              {directory?.path ?? "默认在文稿/Dai 中创建"}
            </span>
            {directory && (
              <button
                type="button"
                disabled={submitting || selecting}
                onClick={() => setDirectory(null)}
              >
                使用默认
              </button>
            )}
            <button
              type="button"
              disabled={submitting || selecting}
              onClick={() => void chooseDirectory()}
            >
              选择文件夹
            </button>
          </div>
        </div>
        {selectionError && (
          <p className="error" role="alert">
            {selectionError}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting || selecting}>
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!name.trim() || submitting || selecting}
          >
            {submitting ? "正在创建…" : "创建项目"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
