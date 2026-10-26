import { useState } from "react";
import { ActionMenu } from "../components/ActionMenu.tsx";
import { Dialog, Field } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import type { Conversation, Project } from "../types.ts";

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
  onSelect,
  onClose,
}: {
  project: Project;
  selected: string;
  onSelect: (file: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [stepOnly, setStepOnly] = useState(true);
  const files = project.files.filter(
    (file) =>
      file.toLowerCase().includes(filter.toLowerCase()) &&
      (!stepOnly || /\.(step|stp)$/i.test(file)),
  );
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
      <label className="check-row">
        <input
          type="checkbox"
          checked={stepOnly}
          onChange={(event) => setStepOnly(event.target.checked)}
        />
        只显示 .step / .stp
      </label>
      <div className="file-list">
        {files.map((file) => (
          <button
            type="button"
            key={file}
            aria-pressed={selected === file}
            disabled={!/\.(step|stp)$/i.test(file)}
            onClick={() => {
              onSelect(file);
              onClose();
            }}
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
