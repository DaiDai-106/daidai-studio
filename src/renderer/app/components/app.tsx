import { useCallback, useRef, useState } from "react";
import { ExtensionNotifications } from "../../features/chat/components/extension_notifications.tsx";
import { CreateProjectDialog } from "../../features/projects/components/create_project_dialog.tsx";
import { HiddenProjectsDialog } from "../../features/projects/components/hidden_projects_dialog.tsx";
import { ProjectHome } from "../../features/projects/components/project_home.tsx";
import { Sidebar } from "../../features/projects/components/sidebar.tsx";
import {
  type SettingsPage,
  SettingsView,
} from "../../features/settings/components/settings_view.tsx";
import { useSettings } from "../../features/settings/logic/use_settings.ts";
import { IconButton } from "../../shared/components/icon.tsx";
import { shortcutLabel, useShortcuts } from "../logic/shortcuts.ts";
import { useApplication } from "../logic/use_application.ts";
import { useDesktop } from "../logic/use_desktop.ts";
import { useWorkbench } from "../logic/use_workbench.ts";
import { ProjectWorkspace, type ProjectWorkspaceHandle } from "./project_workspace.tsx";
import { StartupIntro } from "./startup_intro.tsx";
import { ArchivesDialog, RenameDialog } from "./workbench_dialogs.tsx";

type WorkbenchDialog =
  | { type: "createProject" }
  | { type: "hiddenProjects" }
  | { type: "rename"; id: string }
  | { type: "archives"; projectId: string | null };

// 应用入口负责组合工作台与设置页面，并连接应用级交互。
export function App() {
  const [showStartup, setShowStartup] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const finishStartup = useCallback(() => setShowStartup(false), []);
  const application = useApplication();
  const configuration = useSettings(application);
  const { theme } = configuration;
  const desktop = useDesktop(theme, configuration.desktopTheme);
  const { info, error: desktopError } = desktop;
  const workbench = useWorkbench(application);

  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const [dialog, setDialog] = useState<WorkbenchDialog | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const projectWorkspace = useRef<ProjectWorkspaceHandle>(null);
  const { active, project } = workbench;
  const extensionRequests = application.workspace?.extensionUiRequests ?? [];
  const extensionRequest = extensionRequests.find((item) => item.conversationId === active?.id);

  async function goHome() {
    if (await workbench.home()) {
      setSettings(null);
      setDialog(null);
    }
  }

  const renamed =
    dialog?.type === "rename"
      ? workbench.conversations.find((item) => item.id === dialog.id)
      : undefined;

  useShortcuts(
    {
      newChat: () => {
        setSettings(null);
        if (project) workbench.create();
        else setDialog({ type: "createProject" });
      },
      openProject: () => {
        setSettings(null);
        setDialog({ type: "createProject" });
      },
      settings: () => setSettings("general"),
      toggleSidebar: () => {
        if (!settings) setSidebar((value) => !value);
      },
      focusChat: () => {
        setSettings(null);
        projectWorkspace.current?.focusChat();
      },
      shortcuts: () => setSettings("shortcuts"),
    },
    !showStartup && dialog === null && !extensionRequest,
  );

  return (
    <>
      <ExtensionNotifications />
      <div className="app-layout" hidden={settings !== null} inert={showStartup}>
        {sidebar && (
          <Sidebar
            projects={workbench.projects}
            activeProjectId={project?.id ?? ""}
            conversations={workbench.conversations}
            activeConversationId={active?.id ?? ""}
            busyConversationIds={application.workspace?.busyConversationIds ?? []}
            onSelectConversation={workbench.select}
            onCreateConversation={(id) => workbench.create(id)}
            onRename={(id) => setDialog({ type: "rename", id })}
            onFork={workbench.fork}
            onArchive={workbench.archive}
            onDelete={(id) => void workbench.deleteConversation(id)}
            onArchives={(id) => setDialog({ type: "archives", projectId: id })}
            onHome={() => void goHome()}
            pendingProjectIds={workbench.conversations
              .filter((item) =>
                extensionRequests.some((request) => request.conversationId === item.id),
              )
              .map((item) => item.projectId)}
            version={info?.version ?? "…"}
            onOpen={() => setDialog({ type: "createProject" })}
            onRemove={workbench.removeProject}
            onSettings={setSettings}
            onHiddenProjects={() => setDialog({ type: "hiddenProjects" })}
            onCollapse={() => setSidebar(false)}
          />
        )}
        <main className="workbench">
          <header className="topbar">
            {!sidebar && (
              <IconButton icon="panel" label="展开项目栏" onClick={() => setSidebar(true)} />
            )}
            <div className="workbench-title">
              <span>{project?.name ?? "工作台"}</span>
            </div>
            <div className="topbar-actions">
              <IconButton icon="home" label="返回项目主页" onClick={() => void goHome()} />
              <IconButton
                icon="new-chat"
                label="在当前项目新建对话"
                shortcut={shortcutLabel("newChat")}
                onClick={() =>
                  project ? workbench.create() : setDialog({ type: "createProject" })
                }
              />
              <IconButton
                icon="settings"
                label="打开设置"
                shortcut={shortcutLabel("settings")}
                onClick={() => setSettings("general")}
              />
            </div>
          </header>
          {(desktopError || application.error) && (
            <p className="bridge-error" role="alert">
              {desktopError || application.error}
            </p>
          )}
          {project?.available === false && (
            <p className="bridge-error" role="alert">
              项目文件夹不可用。已保存的聊天仍可查看，使用文件工具前请恢复项目文件夹。
            </p>
          )}
          {application.workspace?.nextCursor && (
            <button
              type="button"
              className="text-button"
              onClick={() => void application.run(() => application.loadMore())}
            >
              加载更多历史对话
            </button>
          )}
          <ProjectWorkspace
            ref={projectWorkspace}
            application={application}
            workbench={workbench}
            configuration={configuration}
            staticPreviewAvailable={info?.staticPreviewAvailable ?? false}
            onConfigure={() => setSettings("ai")}
            hidden={settings !== null}
            blocked={dialog !== null}
          />
          {!project && (
            <ProjectHome
              projects={workbench.projects}
              onCreate={() => setDialog({ type: "createProject" })}
              onSelect={workbench.selectProject}
            />
          )}
        </main>
      </div>
      {settings && (
        <SettingsView
          page={settings}
          onPage={setSettings}
          onBack={() => setSettings(null)}
          onHome={() => void goHome()}
          info={info}
          theme={configuration.theme}
          onTheme={configuration.setTheme}
          desktopTheme={configuration.desktopTheme}
          desktopThemes={desktop.themes}
          desktopThemeErrors={desktop.themeErrors}
          desktopThemeError={desktop.themeNotice}
          onDesktopTheme={configuration.setDesktopTheme}
          showThinking={configuration.showThinking}
          onShowThinking={configuration.setShowThinking}
          providers={configuration.providers}
          defaultModel={configuration.defaultModel}
          onProviders={configuration.updateProviders}
          onDefault={configuration.setDefaultModel}
          loadUsage={application.api.getUsageDashboard}
          onArchives={() => setDialog({ type: "archives", projectId: null })}
        />
      )}
      {dialog?.type === "createProject" && (
        <CreateProjectDialog
          error={application.error}
          onCreate={workbench.createProject}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "hiddenProjects" && (
        <HiddenProjectsDialog
          onClose={() => setDialog(null)}
          onRestore={async () => {
            await application.refresh();
          }}
        />
      )}
      {renamed && (
        <RenameDialog
          conversation={renamed}
          onSave={(title) => workbench.rename(renamed.id, title)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "archives" && (
        <ArchivesDialog
          conversations={workbench.conversations}
          projects={workbench.projects}
          projectId={dialog.projectId}
          error={application.error}
          onRestore={workbench.restore}
          onDelete={(id) => void workbench.deleteConversation(id)}
          onClose={() => setDialog(null)}
        />
      )}
      {showStartup && <StartupIntro onComplete={finishStartup} />}
    </>
  );
}
