import {
  type CSSProperties,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatPanel } from "../../features/chat/components/chat_panel.tsx";
import { ExtensionUiDialog } from "../../features/chat/components/extension_ui_dialog.tsx";
import { Welcome } from "../../features/chat/components/welcome.tsx";
import { CodingWorkspace } from "../../features/coding/components/coding_workspace.tsx";
import { useCodingWorkspace } from "../../features/coding/logic/use_coding_workspace.ts";
import { RobotPanel } from "../../features/robot/robot_panel.tsx";
import { ProjectScene } from "../../features/scene/components/project_scene.tsx";
import { useProjectScene } from "../../features/scene/logic/use_project_scene.ts";
import type { useSettings } from "../../features/settings/logic/use_settings.ts";
import { Dialog } from "../../shared/components/dialog.tsx";
import { IconButton } from "../../shared/components/icon.tsx";
import { CodingOpenContext } from "../../shared/logic/coding_context.ts";
import { useOverlayBlocked } from "../../shared/logic/overlay_context.tsx";
import type { ApplicationState } from "../logic/use_application.ts";
import type { useWorkbench } from "../logic/use_workbench.ts";
import { PaneSplitter } from "./pane_splitter.tsx";

export type ProjectWorkspaceHandle = { focusChat(): void };

// 项目面板拥有布局、场景导入及内容标签；应用入口只协调全局页面。
export function ProjectWorkspace({
  ref,
  application,
  workbench,
  configuration,
  onConfigure,
  hidden,
  blocked,
}: {
  ref: Ref<ProjectWorkspaceHandle>;
  application: ApplicationState;
  workbench: ReturnType<typeof useWorkbench>;
  configuration: ReturnType<typeof useSettings>;
  onConfigure(): void;
  hidden: boolean;
  blocked: boolean;
}) {
  const { active, project } = workbench;
  const projectId = project?.id;
  const { models } = configuration;
  const [mobileTab, setMobileTab] = useState<"scene" | "chat">("scene");
  const [choice, setChoice] = useState<{ projectId: string; file?: File } | null>(null);
  const stepChoice = choice?.projectId === project?.id ? choice : null;
  function setStepChoice(value: { file?: File } | null) {
    setChoice(value && project ? { ...value, projectId: project.id } : null);
  }
  useEffect(() => {
    setChoice((current) => (current?.projectId === projectId ? current : null));
  }, [projectId]);
  const [chatWidth, setChatWidth] = useState(410);
  const [robotWidth, setRobotWidth] = useState(360);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const overlayBlocked = useOverlayBlocked();
  const extensionRequest = application.workspace?.extensionUiRequests?.find(
    (item) => item.conversationId === active?.id,
  );
  const projectSceneMode = project?.mode === "scene";
  const isScene = projectSceneMode;
  const isRobot = project?.mode === "robot";
  const isCoding = project?.mode === "coding";
  const projectScene = useProjectScene(projectSceneMode ? project.id : "");
  const coding = useCodingWorkspace(isCoding ? project.id : "");
  const codingPanel = coding.state;
  const workspaceTab = isCoding && !codingPanel.open ? "chat" : mobileTab;

  const activeId = active?.id;
  const activeMode = active?.mode;
  useEffect(() => {
    if (activeId) setMobileTab(activeMode === "scene" ? "scene" : "chat");
  }, [activeId, activeMode]);

  useImperativeHandle(
    ref,
    () => ({
      focusChat() {
        setMobileTab("chat");
        requestAnimationFrame(() => messageInput.current?.focus());
      },
    }),
    [],
  );

  function showCodingPanel(open: boolean) {
    coding.update({ open });
    setMobileTab(open ? "scene" : "chat");
  }

  const paneStyle: CSSProperties & {
    "--chat-width": string;
    "--robot-width": string;
    "--coding-width": string;
  } = {
    "--chat-width": `${chatWidth}px`,
    "--robot-width": `${robotWidth}px`,
    "--coding-width": `calc(${codingPanel.width}% - ${(codingPanel.width / 100) * 5}px)`,
  };

  async function send(images: import("../../../contracts/application.ts").ChatImage[]) {
    if (projectSceneMode && projectScene.busy) return false;
    if (!active || !models.some((model) => model.id === active.modelId)) {
      onConfigure();
      return false;
    }
    return workbench.send(images);
  }

  function selectStep(file?: File) {
    if (!projectScene.scene || projectScene.busy) return;
    if (projectScene.scene.models.length) setStepChoice(file ? { file } : {});
    else void projectScene.importStep("replace", file);
  }

  function respondShell(id: string, approved: boolean) {
    void application.run(() => application.api.respondShell(id, approved));
  }

  const openContent = useMemo(
    () =>
      isCoding
        ? {
            openUrl: (url: string) => {
              coding.open({ type: "preview", url });
              setMobileTab("scene");
            },
            openFile: (reference: import("../../../shared/file_references.ts").FileReference) => {
              coding.open({ type: "file", ...reference });
              setMobileTab("scene");
            },
          }
        : null,
    [isCoding, coding.open],
  );

  if (!project) return null;
  return (
    <CodingOpenContext.Provider value={openContent}>
      {isCoding && coding.error && (
        <p className="bridge-error" role="alert">
          {coding.error}
        </p>
      )}
      {(isScene || isRobot || isCoding) && (
        <div className="mobile-tabs" role="tablist" aria-label="工作区视图">
          {isRobot && (
            <button
              type="button"
              role="tab"
              aria-selected={workspaceTab === "chat"}
              onClick={() => setMobileTab("chat")}
            >
              聊天
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={workspaceTab === "scene"}
            onClick={() => (isCoding ? showCodingPanel(true) : setMobileTab("scene"))}
          >
            {isRobot ? "设备" : isCoding ? "代码" : "场景"}
          </button>
          {(isScene || isCoding) && (
            <button
              type="button"
              role="tab"
              aria-selected={workspaceTab === "chat"}
              onClick={() => setMobileTab("chat")}
            >
              聊天
            </button>
          )}
        </div>
      )}
      <div
        className={`workspace ${isScene ? "scene-mode" : isRobot ? "robot-mode" : "coding-mode"}`}
        data-mobile-tab={workspaceTab}
        data-coding-open={codingPanel.open}
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
            onDelete={(modelId, objectId) => void projectScene.deleteObject(modelId, objectId)}
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
        <div className="assistant-workspace">
          <div className="assistant-navigation">
            <strong>{active?.title ?? "AI 助手"}</strong>
            <IconButton icon="new-chat" label="新建对话" onClick={() => workbench.create()} />
            {isCoding && !codingPanel.open && (
              <IconButton
                icon="panel"
                label="展开代码工作区"
                expanded={false}
                controls="coding-workspace"
                onClick={() => showCodingPanel(true)}
              />
            )}
          </div>
          {active ? (
            <ChatPanel
              inputRef={messageInput}
              conversation={active}
              compact={isScene || (isCoding && codingPanel.open)}
              projectScene={projectSceneMode}
              {...(isCoding ? { codingProjectId: project.id } : {})}
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
              onConfigure={onConfigure}
              stream={application.view}
              shellApproval={application.workspace?.shellApproval ?? null}
              onShellApproval={respondShell}
              showThinking={configuration.showThinking}
              onStop={() => {
                if (active) void application.run(() => application.api.stopConversation(active.id));
              }}
            />
          ) : (
            <Welcome>
              <button type="button" onClick={() => workbench.create()}>
                新建对话
              </button>
            </Welcome>
          )}
        </div>
        {isCoding && codingPanel.open && (
          <PaneSplitter
            label="调整聊天与代码工作区宽度"
            width={codingPanel.width}
            min={20}
            max={80}
            onWidth={(change) =>
              coding.update({
                width: typeof change === "function" ? change(codingPanel.width) : change,
              })
            }
            unit="percent"
          />
        )}
        {isCoding && (
          <CodingWorkspace
            key={project.id}
            projectId={project.id}
            hidden={!codingPanel.open}
            onToggle={() => showCodingPanel(!codingPanel.open)}
            previewEnabled={
              codingPanel.open &&
              !hidden &&
              !blocked &&
              !stepChoice &&
              !extensionRequest &&
              !overlayBlocked
            }
            workspace={coding}
            conversationId={active?.id}
            onAnnotate={(text) => {
              if (!active) return false;
              const draft = [active.draft, text].filter(Boolean).join("\n\n");
              if (draft.length > 100_000) return false;
              workbench.update({ draft });
              setMobileTab("chat");
              requestAnimationFrame(() => messageInput.current?.focus());
              return true;
            }}
          />
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
      {extensionRequest && !hidden && !blocked && !stepChoice && (
        <ExtensionUiDialog
          key={extensionRequest.requestId}
          request={extensionRequest}
          onRespond={application.api.respondExtensionUi}
          onStop={() => application.api.stopConversation(extensionRequest.conversationId)}
        />
      )}
    </CodingOpenContext.Provider>
  );
}
