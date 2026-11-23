import {
  type CSSProperties,
  lazy,
  type Ref,
  Suspense,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileReference } from "../../../shared/file_references.ts";
import { ChatPanel } from "../../features/chat/components/chat_panel.tsx";
import { ExtensionUiDialog } from "../../features/chat/components/extension_ui_dialog.tsx";
import { Welcome } from "../../features/chat/components/welcome.tsx";
import { useAttachmentDrafts } from "../../features/chat/logic/use_attachment_drafts.ts";
import { CodingWorkspace } from "../../features/coding/components/coding_workspace.tsx";
import { useCodingWorkspace } from "../../features/coding/logic/use_coding_workspace.ts";
import type { useSettings } from "../../features/settings/logic/use_settings.ts";
import { IconButton } from "../../shared/components/icon.tsx";
import { PaneSplitter } from "../../shared/components/pane_splitter.tsx";
import { CodingOpenContext } from "../../shared/logic/coding_context.ts";
import { useOverlayBlocked } from "../../shared/logic/overlay_context.tsx";
import type { ApplicationState } from "../logic/use_application.ts";
import type { useWorkbench } from "../logic/use_workbench.ts";

const SceneWorkspace = lazy(async () => ({
  default: (await import("../../features/scene/components/scene_workspace.tsx")).SceneWorkspace,
}));

function sceneWidth(projectId: string) {
  try {
    const width = Number(localStorage.getItem(`dai:scene:${projectId}`));
    if (width >= 30 && width <= 80) return width;
  } catch {
    // 布局仍可在本次运行内调整。
  }
  return 55;
}

export type ProjectWorkspaceHandle = { focusChat(): void };

export function ProjectWorkspace({
  ref,
  application,
  workbench,
  configuration,
  staticPreviewAvailable,
  onConfigure,
  hidden,
  blocked,
}: {
  ref: Ref<ProjectWorkspaceHandle>;
  application: ApplicationState;
  workbench: ReturnType<typeof useWorkbench>;
  configuration: ReturnType<typeof useSettings>;
  staticPreviewAvailable: boolean;
  onConfigure(): void;
  hidden: boolean;
  blocked: boolean;
}) {
  const { active, project } = workbench;
  const { models } = configuration;
  const activeModel = models.find((model) => model.id === active?.modelId);
  const attachments = useAttachmentDrafts(
    application.api,
    active?.id,
    activeModel?.supportsImages ?? false,
    active?.mode === "scene",
    async (images, step) => {
      if (!activeModel) {
        onConfigure();
        return false;
      }
      return workbench.send(images, step);
    },
  );
  const [mobileTab, setMobileTab] = useState<"code" | "chat">("chat");
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const overlayBlocked = useOverlayBlocked();
  const extensionRequest = application.workspace?.extensionUiRequests?.find(
    (item) => item.conversationId === active?.id,
  );
  const scene = project?.mode === "scene";
  const sceneId = scene ? project.id : "";
  const [scenePane, setScenePane] = useState({ id: sceneId, width: sceneWidth(sceneId) });
  if (scenePane.id !== sceneId) setScenePane({ id: sceneId, width: sceneWidth(sceneId) });
  const coding = useCodingWorkspace(!scene ? (project?.id ?? "") : "");
  const panelOpen = scene || coding.state.open;
  const panelWidth = scene ? scenePane.width : coding.state.width;
  const workspaceTab = panelOpen ? mobileTab : "chat";

  useEffect(() => {
    if (!scenePane.id) return;
    try {
      localStorage.setItem(`dai:scene:${scenePane.id}`, String(scenePane.width));
    } catch {
      // 存储不可用时仍保留本次的布局。
    }
  }, [scenePane]);
  const activeId = active?.id;
  useEffect(() => {
    if (activeId) setMobileTab("chat");
  }, [activeId]);
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
  function showWorkspacePanel(open: boolean) {
    if (!scene) coding.update({ open });
    setMobileTab(open ? "code" : "chat");
  }
  const paneStyle: CSSProperties & { "--workspace-width": string } = {
    "--workspace-width": `calc(${panelWidth}% - ${(panelWidth / 100) * 5}px)`,
  };
  const openContent = useMemo(
    () => ({
      openUrl: (url: string) => {
        coding.open({ type: "preview", url });
        setMobileTab("code");
      },
      openFile: (reference: FileReference) => {
        coding.open({ type: "file", ...reference });
        setMobileTab("code");
      },
    }),
    [coding.open],
  );
  if (!project) return null;
  return (
    <CodingOpenContext.Provider value={scene ? null : openContent}>
      {!scene && coding.error && (
        <p className="bridge-error" role="alert">
          {coding.error}
        </p>
      )}
      <div className="mobile-tabs" role="tablist" aria-label="工作区视图">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "code"}
          onClick={() => showWorkspacePanel(true)}
        >
          {scene ? "场景" : "代码"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "chat"}
          onClick={() => setMobileTab("chat")}
        >
          聊天
        </button>
      </div>
      <div
        className={scene ? "workspace scene-mode" : "workspace coding-mode"}
        data-mobile-tab={workspaceTab}
        data-coding-open={panelOpen}
        style={paneStyle}
      >
        <div className="assistant-workspace">
          <div className="assistant-navigation">
            <strong>{active?.title ?? "AI 助手"}</strong>
            <IconButton icon="new-chat" label="新建对话" onClick={() => workbench.create()} />
            {!panelOpen && (
              <IconButton
                icon="panel"
                label="展开代码工作区"
                expanded={false}
                controls="coding-workspace"
                onClick={() => showWorkspacePanel(true)}
              />
            )}
          </div>
          {active ? (
            <ChatPanel
              inputRef={messageInput}
              conversation={active}
              isNewConversation={workbench.isNewConversation}
              compact={panelOpen}
              projectId={project.id}
              models={models}
              activeModel={activeModel}
              attachments={attachments}
              onDraft={(draft) => workbench.update({ draft })}
              onModel={(modelId) => workbench.update({ modelId })}
              onThinking={(thinkingLevel) => workbench.update({ thinkingLevel })}
              onAccessMode={(accessMode) => workbench.update({ accessMode })}
              accessPending={workbench.accessPending}
              onCancelQueued={(messageId) =>
                void application.run(() =>
                  application.api.cancelQueuedMessage(active.id, messageId),
                )
              }
              onPromoteQueued={(messageId) =>
                void application.run(() =>
                  application.api.promoteQueuedMessage(active.id, messageId),
                )
              }
              onResumeQueue={() =>
                void application.run(() => application.api.resumeConversationQueue(active.id))
              }
              onConfigure={onConfigure}
              stream={workbench.activeView}
              readHistory={application.api.readConversationHistory}
              shellApproval={application.workspace?.shellApproval ?? null}
              onShellApproval={(id, approved) =>
                void application.run(() => application.api.respondShell(id, approved))
              }
              showThinking={configuration.showThinking}
              onStop={() => void application.run(() => application.api.stopConversation(active.id))}
            />
          ) : (
            <Welcome>
              <button type="button" onClick={() => workbench.create()}>
                新建对话
              </button>
            </Welcome>
          )}
        </div>
        {panelOpen && (
          <PaneSplitter
            label={scene ? "调整聊天与场景工作区宽度" : "调整聊天与代码工作区宽度"}
            width={panelWidth}
            min={scene ? 30 : 20}
            max={80}
            onWidth={(change) => {
              const width = typeof change === "function" ? change(panelWidth) : change;
              if (scene) setScenePane({ id: sceneId, width });
              else coding.update({ width });
            }}
            unit="percent"
          />
        )}
        {scene ? (
          <Suspense
            fallback={
              <p className="scene-workspace notice" role="status">
                正在加载场景工作区…
              </p>
            }
          >
            <SceneWorkspace key={project.id} projectId={project.id} api={application.api} />
          </Suspense>
        ) : (
          <CodingWorkspace
            key={project.id}
            projectId={project.id}
            staticPreviewAvailable={staticPreviewAvailable}
            hidden={!panelOpen}
            onToggle={() => showWorkspacePanel(!panelOpen)}
            previewEnabled={
              panelOpen && !hidden && !blocked && !extensionRequest && !overlayBlocked
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
      </div>
      {extensionRequest && !hidden && !blocked && (
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
