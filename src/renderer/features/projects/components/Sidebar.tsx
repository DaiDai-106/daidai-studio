import { useState } from "react";
import { shortcutLabel } from "../../../app/logic/shortcuts.ts";
import { ActionMenu } from "../../../shared/components/ActionMenu.tsx";
import { BrandIcon } from "../../../shared/components/BrandIcon.tsx";
import { Icon, IconButton } from "../../../shared/components/Icon.tsx";
import { Tooltip } from "../../../shared/components/Tooltip.tsx";
import type { Conversation, Project } from "../../../shared/logic/types.ts";

interface Props {
  projects: Project[];
  conversations: Conversation[];
  activeId: string;
  pendingExtensionIds: string[];
  version: string;
  onSelect: (id: string) => void;
  onSelectProject: (id: string) => void;
  onCreate: (project?: string) => void;
  onOpen: () => void;
  onRemove: (id: string) => void;
  onSettings: (page: "general" | "tools" | "about") => void;
  onRename: (id: string) => void;
  onArchive: (id: string) => void;
  onFork: (id: string) => void;
  onDelete: (id: string) => void;
  onArchives: (project: string | null) => void;
  onHiddenProjects: () => void;
  onCollapse: () => void;
}

// 展示项目和会话导航；展开状态仅保留在当前界面。
export function Sidebar(props: Props) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  return (
    <aside className="sidebar" aria-label="项目侧栏">
      <div className="brand">
        <BrandIcon />
        <strong>Dai</strong>
        <IconButton icon="panel" label="收起项目栏" onClick={props.onCollapse} />
      </div>
      <div className="sidebar-actions">
        <div className="section-caption">会话</div>
        <button
          type="button"
          className="nav-action"
          aria-label="新建对话"
          onClick={() => props.onCreate()}
        >
          <Icon name="new-chat" />
          新建对话
          <kbd>{shortcutLabel("newChat")}</kbd>
        </button>
        <button type="button" className="nav-action" aria-label="新建项目" onClick={props.onOpen}>
          <Icon name="folder" />
          新建项目
          <kbd>{shortcutLabel("openProject")}</kbd>
        </button>
      </div>
      <div className="section-caption">项目</div>
      <nav className="project-list" aria-label="项目和对话">
        {props.projects.map((project) => (
          <div key={project.id} className="project-group">
            <div className="project-row">
              <button
                type="button"
                className="project-collapse"
                aria-label={`${collapsed.includes(project.id) ? "展开" : "收起"}${project.name}对话`}
                aria-expanded={!collapsed.includes(project.id)}
                onClick={() => {
                  setCollapsed((items) =>
                    items.includes(project.id)
                      ? items.filter((id) => id !== project.id)
                      : [...items, project.id],
                  );
                }}
              >
                <span className={collapsed.includes(project.id) ? "" : "expanded"}>
                  <Icon name="chevron" size={13} />
                </span>
              </button>
              <button
                type="button"
                className="project-title"
                onClick={() => {
                  props.onSelectProject(project.id);
                  setCollapsed((items) => items.filter((id) => id !== project.id));
                }}
              >
                <Icon name="folder" size={16} />
                <span>{project.name}</span>
              </button>
              <ActionMenu
                label={`${project.name} 项目操作`}
                actions={[
                  {
                    label: "新建对话",
                    icon: "new-chat",
                    onSelect: () => props.onCreate(project.id),
                  },
                  {
                    label: "已归档对话",
                    icon: "archive",
                    onSelect: () => props.onArchives(project.id),
                  },
                  {
                    label: "移除项目",
                    icon: "close",
                    description: "保留文件、聊天和场景，可从已隐藏项目恢复",
                    onSelect: () => props.onRemove(project.id),
                  },
                ]}
              />
            </div>
            {!collapsed.includes(project.id) && (
              <div className="conversation-list">
                {props.conversations
                  .filter((item) => item.projectId === project.id && !item.archived)
                  .map((item) => (
                    <div
                      className={`conversation-row ${item.id === props.activeId ? "selected" : ""}`}
                      key={item.id}
                    >
                      <button
                        type="button"
                        className="conversation-title"
                        aria-current={item.id === props.activeId ? "page" : undefined}
                        onClick={() => props.onSelect(item.id)}
                      >
                        <span className="conversation-dot" />
                        <span>{item.title}</span>
                      </button>
                      {props.pendingExtensionIds.includes(item.id) && (
                        <span role="status" aria-label="扩展等待回复" className="extension-pending">
                          ●
                        </span>
                      )}
                      <ActionMenu
                        label={`${item.title} 对话操作`}
                        actions={[
                          {
                            label: "分叉对话",
                            icon: "new-chat",
                            onSelect: () => props.onFork(item.id),
                          },
                          {
                            label: "重命名",
                            icon: "edit",
                            onSelect: () => props.onRename(item.id),
                          },
                          {
                            label: "归档对话",
                            icon: "archive",
                            onSelect: () => props.onArchive(item.id),
                          },
                          {
                            label: "删除",
                            icon: "close",
                            danger: true,
                            confirmLabel: "确认删除",
                            onSelect: () => props.onDelete(item.id),
                          },
                        ]}
                      />
                    </div>
                  ))}
                {!props.conversations.some(
                  (item) => item.projectId === project.id && !item.archived,
                ) && <p className="sidebar-empty">暂无对话</p>}
              </div>
            )}
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
          <IconButton icon="tool" label="工具与技能" onClick={() => props.onSettings("tools")} />
          <IconButton icon="archive" label="已归档对话" onClick={() => props.onArchives(null)} />
          <IconButton icon="folder" label="已隐藏项目" onClick={props.onHiddenProjects} />
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
