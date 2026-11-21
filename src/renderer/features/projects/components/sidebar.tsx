import { useState } from "react";
import type {
  ConversationInfo,
  ProjectInfo as Project,
} from "../../../../contracts/application.ts";
import { productName } from "../../../../shared/app_metadata.ts";
import { shortcutLabel } from "../../../app/logic/shortcuts.ts";
import { ActionMenu } from "../../../shared/components/action_menu.tsx";
import { BrandIcon } from "../../../shared/components/brand_icon.tsx";
import { Icon, IconButton } from "../../../shared/components/icon.tsx";
import { Tooltip } from "../../../shared/components/tooltip.tsx";

interface Props {
  projects: Project[];
  activeProjectId: string;
  pendingProjectIds: string[];
  conversations: ConversationInfo[];
  activeConversationId: string;
  busyConversationIds: string[];
  onSelectConversation: (id: string) => void;
  onCreateConversation: (projectId: string) => void;
  onRename: (id: string) => void;
  onFork: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onArchives: (projectId: string | null) => void;
  onHome: () => void;
  version: string;
  onOpen: () => void;
  onRemove: (id: string) => void;
  onSettings: (page: "general" | "tools" | "about") => void;
  onHiddenProjects: () => void;
  onCollapse: () => void;
}

export function Sidebar(props: Props) {
  const [collapsedProjects, setCollapsedProjects] = useState(() => new Set<string>());

  function toggleProject(id: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  return (
    <aside className="sidebar" aria-label="项目侧栏">
      <div className="brand">
        <BrandIcon />
        <strong>{productName}</strong>
        <IconButton icon="panel" label="收起项目栏" onClick={props.onCollapse} />
      </div>
      <div className="sidebar-actions">
        <button type="button" className="nav-action" onClick={props.onHome}>
          <Icon name="home" />
          项目主页
        </button>
        <button type="button" className="nav-action" aria-label="新建项目" onClick={props.onOpen}>
          <Icon name="folder" />
          新建项目
          <kbd>{shortcutLabel("openProject")}</kbd>
        </button>
      </div>
      <div className="section-caption">项目</div>
      <nav className="project-list" aria-label="项目">
        {props.projects.map((project) => (
          <div key={project.id} className="project-group">
            <div
              className={`project-row ${project.id === props.activeProjectId && !props.activeConversationId ? "selected" : ""}`}
            >
              <button
                type="button"
                className="project-title"
                aria-expanded={!collapsedProjects.has(project.id)}
                aria-controls={`project-conversations-${project.id}`}
                onClick={() => toggleProject(project.id)}
              >
                <Icon name="folder" size={16} />
                <span>{project.name}</span>
                <Icon
                  name={collapsedProjects.has(project.id) ? "chevron" : "chevron-down"}
                  size={12}
                />
              </button>
              {props.pendingProjectIds.includes(project.id) && (
                <span role="status" aria-label="扩展等待回复" className="extension-pending">
                  ●
                </span>
              )}
              <IconButton
                icon="new-chat"
                label={`${project.name} 新建对话`}
                onClick={() => props.onCreateConversation(project.id)}
              />
              <ActionMenu
                label={`${project.name} 项目操作`}
                actions={[
                  {
                    label: "已归档对话",
                    icon: "archive",
                    onSelect: () => props.onArchives(project.id),
                  },
                  {
                    label: "移除项目",
                    icon: "close",
                    description: "保留文件和聊天，可从已隐藏项目恢复",
                    onSelect: () => props.onRemove(project.id),
                  },
                ]}
              />
            </div>
            <div
              className="conversation-list"
              id={`project-conversations-${project.id}`}
              hidden={collapsedProjects.has(project.id)}
            >
              {props.conversations
                .filter(
                  (conversation) => conversation.projectId === project.id && !conversation.archived,
                )
                .map((conversation) => (
                  <div
                    className={`conversation-row ${conversation.id === props.activeConversationId ? "selected" : ""}`}
                    key={conversation.id}
                  >
                    <button
                      type="button"
                      className="conversation-title"
                      aria-current={
                        conversation.id === props.activeConversationId ? "page" : undefined
                      }
                      title={conversation.title}
                      onClick={() => props.onSelectConversation(conversation.id)}
                    >
                      {props.busyConversationIds.includes(conversation.id) ? (
                        <span role="status" aria-label="正在回复" className="conversation-loading">
                          <Icon name="loading" size={14} />
                        </span>
                      ) : (
                        <Icon name="chat" size={13} />
                      )}
                      <span>{conversation.title}</span>
                    </button>
                    <ActionMenu
                      label={`${conversation.title} 对话操作`}
                      actions={[
                        {
                          label: "重命名",
                          icon: "edit",
                          onSelect: () => props.onRename(conversation.id),
                        },
                        {
                          label: "分叉对话",
                          icon: "new-chat",
                          onSelect: () => props.onFork(conversation.id),
                        },
                        {
                          label: "归档对话",
                          icon: "archive",
                          onSelect: () => props.onArchive(conversation.id),
                        },
                        {
                          label: "删除",
                          icon: "close",
                          danger: true,
                          confirmLabel: "确认删除",
                          onSelect: () => props.onDelete(conversation.id),
                        },
                      ]}
                    />
                  </div>
                ))}
            </div>
          </div>
        ))}
      </nav>
      <footer className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <IconButton
            icon="settings"
            label="设置"
            shortcut={shortcutLabel("settings")}
            onClick={() => props.onSettings("general")}
          />
          <IconButton icon="tool" label="插件与技能" onClick={() => props.onSettings("tools")} />
          <IconButton icon="folder" label="已隐藏项目" onClick={props.onHiddenProjects} />
          <IconButton icon="archive" label="已归档对话" onClick={() => props.onArchives(null)} />
        </div>
        <Tooltip label="应用信息">
          <button
            type="button"
            className="sidebar-version"
            aria-label={`应用信息，版本 ${props.version}`}
            onClick={() => props.onSettings("about")}
          >
            v{props.version}
          </button>
        </Tooltip>
      </footer>
    </aside>
  );
}
