import { useState } from "react";
import type { ProjectInfo as Project } from "../../../contracts/application.ts";
import type { Conversation } from "../../features/chat/logic/types.ts";
import { ActionMenu } from "../../shared/components/action_menu.tsx";
import { Dialog, Field } from "../../shared/components/dialog.tsx";
import { Icon } from "../../shared/components/icon.tsx";

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
