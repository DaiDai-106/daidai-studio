import { useState } from "react";
import { ActionMenu } from "../../shared/components/ActionMenu.tsx";
import { Dialog, Field } from "../../shared/components/Dialog.tsx";
import { Icon } from "../../shared/components/Icon.tsx";
import type { Conversation, Project } from "../../shared/logic/types.ts";

export function RenameDialog({
  conversation,
  onSave,
  onClose,
}: {
  conversation: Conversation;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(conversation.title);
  return (
    <Dialog title="重命名对话" onClose={onClose} protectChanges>
      <Field label="对话名称">
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} />
      </Field>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          disabled={!title.trim()}
          onClick={() => {
            onSave(title.trim());
            onClose();
          }}
        >
          保存名称
        </button>
      </div>
    </Dialog>
  );
}

export function FilesDialog({
  project,
  selected,
  error,
  onSelect,
  onClose,
}: {
  project: Project;
  selected: string;
  error: string;
  onSelect: (file: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const files = project.files.filter((file) => file.toLowerCase().includes(filter.toLowerCase()));

  async function select(file: string) {
    if (!file.trim() || submitting) return;
    setSubmitting(true);
    try {
      if (await onSelect(file)) onClose();
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog title="选择项目 STEP" onClose={onClose}>
      <div className="file-project">
        <Icon name="folder" />
        <strong>{project.name}</strong>
        <span className="small muted">{project.path}</span>
      </div>
      <Field label="筛选文件">
        <input
          value={filter}
          placeholder="搜索相对路径…"
          onChange={(event) => setFilter(event.target.value)}
        />
      </Field>
      {!project.filesComplete && (
        <>
          <p className="small muted" role="status">
            当前 STEP 清单不完整。可输入项目内文件的完整相对路径来选择未列出的文件。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void select(relativePath);
            }}
          >
            <Field label="STEP 相对路径">
              <input
                value={relativePath}
                maxLength={4096}
                placeholder="例如 models/part.step"
                onChange={(event) => setRelativePath(event.target.value)}
              />
            </Field>
            <div className="dialog-actions">
              <button
                type="submit"
                className="primary"
                disabled={!relativePath.trim() || submitting}
              >
                {submitting ? "正在选择…" : "选择此路径"}
              </button>
            </div>
          </form>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="file-list">
        {files.map((file) => (
          <button
            type="button"
            key={file}
            aria-pressed={selected === file}
            disabled={submitting}
            onClick={() => void select(file)}
          >
            <Icon name="file" />
            <span>
              {file}
              <small>项目内 STEP</small>
            </span>
            <Icon name={selected === file ? "check" : "chevron"} size={15} />
          </button>
        ))}
        {!files.length && (
          <p className="empty-list">
            没有匹配的 STEP。请先将文件放入项目目录，再重新打开项目刷新清单。
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function ArchivesDialog({
  conversations,
  projects,
  projectId,
  error,
  onRestore,
  onDelete,
  onClose,
}: {
  conversations: Conversation[];
  projects: Project[];
  projectId: string | null;
  error: string;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const archived = conversations.filter(
    (item) => item.archived && (!projectId || item.projectId === projectId),
  );
  return (
    <Dialog title="已归档对话" onClose={onClose}>
      <p className="muted">
        归档可恢复，删除后无法从应用恢复。项目文件和共享场景保留；底层历史暂留，不释放磁盘空间。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {archived.map((item) => (
        <div className="archive-row" key={item.id}>
          <Icon name="chat" />
          <div>
            <strong>{item.title}</strong>
            <small>{projects.find((project) => project.id === item.projectId)?.name}</small>
          </div>
          <ActionMenu
            label={`${item.title} 归档操作`}
            actions={[
              { label: "恢复", icon: "refresh", onSelect: () => onRestore(item.id) },
              {
                label: "删除",
                icon: "close",
                danger: true,
                confirmLabel: "确认删除",
                onSelect: () => onDelete(item.id),
              },
            ]}
          />
        </div>
      ))}
      {!archived.length && <p className="empty-list">没有已归档对话。</p>}
    </Dialog>
  );
}
