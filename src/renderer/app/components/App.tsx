import { type CSSProperties, useRef, useState } from "react";
import { ChatPanel } from "../../features/chat/components/ChatPanel.tsx";
import { ExtensionUiDialog } from "../../features/chat/components/ExtensionUiDialog.tsx";
import { Welcome } from "../../features/chat/components/Welcome.tsx";
import { CreateProjectDialog } from "../../features/projects/components/CreateProjectDialog.tsx";
import { HiddenProjectsDialog } from "../../features/projects/components/HiddenProjectsDialog.tsx";
import { Sidebar } from "../../features/projects/components/Sidebar.tsx";
import { RobotPanel } from "../../features/robot/components/RobotPanel.tsx";
import { ProjectScene } from "../../features/scene/components/ProjectScene.tsx";
import { useProjectScene } from "../../features/scene/logic/useProjectScene.ts";
import {
  type SettingsPage,
  SettingsView,
} from "../../features/settings/components/SettingsView.tsx";
import { useSettings } from "../../features/settings/logic/useSettings.ts";
import { Dialog } from "../../shared/components/Dialog.tsx";
import { IconButton } from "../../shared/components/Icon.tsx";
import { shortcutLabel, useShortcuts } from "../logic/shortcuts.ts";
import { useApplication } from "../logic/useApplication.ts";
import { useDesktop } from "../logic/useDesktop.ts";
import { useWorkbench } from "../logic/useWorkbench.ts";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { ArchivesDialog, RenameDialog } from "./WorkbenchDialogs.tsx";

type WorkbenchDialog =
  | { type: "createProject" }
  | { type: "hiddenProjects" }
  | { type: "rename"; id: string }
  | { type: "archives"; projectId: string | null };

// 应用入口负责组合工作台与设置页面，并连接应用级交互。
export function App() {
  const application = useApplication();
  const configuration = useSettings(application);
  const { theme, models } = configuration;
  const { info, error: desktopError } = useDesktop(theme);
  const workbench = useWorkbench(application);

  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const [dialog, setDialog] = useState<WorkbenchDialog | null>(null);
  const [stepChoice, setStepChoice] = useState<{ file?: File } | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [chatWidth, setChatWidth] = useState(410);
  const [robotWidth, setRobotWidth] = useState(360);
  const messageInput = useRef<HTMLTextAreaElement>(null);

  const { active, project, mobileTab, setMobileTab } = workbench;
  const extensionRequests = application.workspace?.extensionUiRequests ?? [];
  const extensionRequest = extensionRequests.find((item) => item.conversationId === active?.id);
  const projectSceneMode = project?.mode === "scene";
  const projectScene = useProjectScene(projectSceneMode ? project.id : "");
  const isScene = projectSceneMode;
  const isRobot = project?.mode === "robot";
  const paneStyle: CSSProperties & { "--chat-width": string; "--robot-width": string } = {
    "--chat-width": `${chatWidth}px`,
    "--robot-width": `${robotWidth}px`,
  };

  async function send(images: import("../../../contracts/application.ts").ChatImage[]) {
    if (projectSceneMode && projectScene.busy) return false;
    if (!active || !models.some((model) => model.id === active.modelId)) {
      setSettings("ai");
      return false;
    }
    return workbench.send(images);
  }

  function respondShell(id: string, approved: boolean) {
    void application.run(() => application.api.respondShell(id, approved));
  }

  function selectStep(file?: File) {
    if (!projectScene.scene || projectScene.busy) return;
    if (projectScene.scene.models.length) setStepChoice(file ? { file } : {});
    else void projectScene.importStep("replace", file);
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
        setMobileTab("chat");
        requestAnimationFrame(() => messageInput.current?.focus());
      },
      shortcuts: () => setSettings("shortcuts"),
    },
    dialog === null && stepChoice === null && !extensionRequest,
  );

  return (
    <>
      <div className="app-layout" hidden={settings !== null}>
        {sidebar && (
          <Sidebar
            projects={workbench.projects}
            conversations={workbench.conversations}
            activeId={active?.id ?? ""}
            pendingExtensionIds={extensionRequests.map((item) => item.conversationId)}
            version={info?.version ?? "…"}
            onSelect={(id) => {
              workbench.select(id);
            }}
            onSelectProject={workbench.selectProject}
            onCreate={(id) =>
              id || project ? workbench.create(id) : setDialog({ type: "createProject" })
            }
            onOpen={() => setDialog({ type: "createProject" })}
            onRemove={workbench.removeProject}
            onSettings={setSettings}
            onRename={(id) => setDialog({ type: "rename", id })}
            onArchive={workbench.archive}
            onFork={workbench.fork}
            onDelete={(id) => void workbench.deleteConversation(id)}
            onArchives={(projectId) => setDialog({ type: "archives", projectId })}
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
              <span>{active?.title ?? project?.name ?? "工作台"}</span>
              {isScene && <span className="title-breadcrumb">/ 场景搭建</span>}
              {isRobot && <span className="title-breadcrumb">/ Dai Robotics</span>}
            </div>
            <div className="topbar-actions">
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
              项目文件夹不可用。已保存的聊天和场景仍可查看，使用文件工具前请恢复项目文件夹。
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
          {(isScene || isRobot) && (
            <div className="mobile-tabs" role="tablist" aria-label="工作区视图">
              {isRobot && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobileTab === "chat"}
                  onClick={() => setMobileTab("chat")}
                >
                  聊天
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={mobileTab === "scene"}
                onClick={() => setMobileTab("scene")}
              >
                {isRobot ? "设备" : "场景"}
              </button>
              {isScene && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobileTab === "chat"}
                  onClick={() => setMobileTab("chat")}
                >
                  聊天
                </button>
              )}
            </div>
          )}
          {project && (active || projectSceneMode) ? (
            <div
              className={`workspace ${isScene ? "scene-mode" : isRobot ? "robot-mode" : ""}`}
              data-mobile-tab={mobileTab}
              style={paneStyle}
            >
              {projectSceneMode && (
                <ProjectScene
                  key={project.id}
                  scene={projectScene.scene}
                  error={projectScene.error}
                  busy={projectScene.busy}
                  importing={projectScene.importing}
                  cancelling={projectScene.cancelling}
                  onTransform={(modelId, objectId, transform) =>
                    void projectScene.setTransform(modelId, objectId, transform)
                  }
                  onDelete={(modelId, objectId) =>
                    void projectScene.deleteObject(modelId, objectId)
                  }
                  onConfirmJoint={(candidateId) => void projectScene.confirmJoint(candidateId)}
                  onRemoveJoint={(candidateId, confirmed) =>
                    void projectScene.removeJoint(candidateId, confirmed)
                  }
                  onImport={(operation) => void projectScene.importStep(operation)}
                  onCancelImport={() => void projectScene.cancelImport()}
                  onRetry={projectScene.retry}
                  onRelocateSource={(modelId) => void projectScene.relocateSource(modelId)}
                />
              )}
              {isScene && (
                <PaneSplitter
                  label="调整场景与聊天宽度"
                  width={chatWidth}
                  min={320}
                  max={600}
                  onWidth={setChatWidth}
                />
              )}
              {active ? (
                <ChatPanel
                  inputRef={messageInput}
                  conversation={active}
                  compact={isScene}
                  projectScene={projectSceneMode}
                  sceneBusy={projectSceneMode && projectScene.busy}
                  {...(projectSceneMode
                    ? {
                        onStepDrop: (file: File) => selectStep(file),
                      }
                    : {})}
                  models={models}
                  onDraft={(draft) => workbench.update({ draft })}
                  onModel={(modelId) => workbench.update({ modelId })}
                  onThinking={(thinkingLevel) => workbench.update({ thinkingLevel })}
                  onAccessMode={(accessMode) => workbench.update({ accessMode })}
                  accessPending={workbench.accessPending}
                  onSend={send}
                  onFiles={() => {
                    if (projectSceneMode) selectStep();
                  }}
                  sceneReference={workbench.sceneReference}
                  referenceStorageAvailable={workbench.referenceStorageAvailable}
                  onClearSceneReference={() => workbench.setSceneReference(null)}
                  onConfigure={() => setSettings("ai")}
                  stream={application.view}
                  shellApproval={application.workspace?.shellApproval ?? null}
                  onShellApproval={respondShell}
                  showThinking={configuration.showThinking}
                  onStop={() => {
                    if (active)
                      void application.run(() => application.api.stopConversation(active.id));
                  }}
                />
              ) : (
                <Welcome>
                  <button type="button" onClick={() => workbench.create()}>
                    新建对话
                  </button>
                </Welcome>
              )}
              {isRobot && (
                <>
                  <PaneSplitter
                    className="robot-splitter"
                    label="调整聊天与设备面板宽度"
                    width={robotWidth}
                    min={300}
                    max={500}
                    onWidth={setRobotWidth}
                  />
                  <RobotPanel />
                </>
              )}
            </div>
          ) : (
            <Welcome>
              <button
                type="button"
                onClick={() =>
                  project ? workbench.create() : setDialog({ type: "createProject" })
                }
              >
                {project ? "新建对话" : "新建项目"}
              </button>
              <button type="button" className="text-button" onClick={() => setSettings("ai")}>
                配置 AI 服务
              </button>
            </Welcome>
          )}
        </main>
      </div>
      {settings && (
        <SettingsView
          page={settings}
          onPage={setSettings}
          onBack={() => setSettings(null)}
          info={info}
          theme={configuration.theme}
          onTheme={configuration.setTheme}
          showThinking={configuration.showThinking}
          onShowThinking={configuration.setShowThinking}
          providers={configuration.providers}
          defaultModel={configuration.defaultModel}
          onProviders={configuration.updateProviders}
          onDefault={configuration.setDefaultModel}
          project={project}
          projects={workbench.projects}
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
      {stepChoice && (
        <Dialog title="导入 STEP" onClose={() => setStepChoice(null)}>
          <p>当前项目已有场景。请选择将模型添加到场景，还是替换现有场景。</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setStepChoice(null)}>
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                const file = stepChoice.file;
                setStepChoice(null);
                void projectScene.importStep("replace", file, true);
              }}
            >
              替换场景
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const file = stepChoice.file;
                setStepChoice(null);
                void projectScene.importStep("append", file, true);
              }}
            >
              添加到场景
            </button>
          </div>
        </Dialog>
      )}
      {extensionRequest && !settings && !dialog && !stepChoice && (
        <ExtensionUiDialog
          key={extensionRequest.requestId}
          request={extensionRequest}
          onRespond={application.api.respondExtensionUi}
          onStop={() => application.api.stopConversation(extensionRequest.conversationId)}
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
    </>
  );
}
