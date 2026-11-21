import {
  type CSSProperties,
  type Ref,
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
import { CodingWorkspace } from "../../features/coding/components/coding_workspace.tsx";
import { useCodingWorkspace } from "../../features/coding/logic/use_coding_workspace.ts";
import type { useSettings } from "../../features/settings/logic/use_settings.ts";
import { IconButton } from "../../shared/components/icon.tsx";
import { CodingOpenContext } from "../../shared/logic/coding_context.ts";
import { useOverlayBlocked } from "../../shared/logic/overlay_context.tsx";
import type { ApplicationState } from "../logic/use_application.ts";
import type { useWorkbench } from "../logic/use_workbench.ts";
import { PaneSplitter } from "./pane_splitter.tsx";

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
  const [mobileTab, setMobileTab] = useState<"code" | "chat">("chat");
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const overlayBlocked = useOverlayBlocked();
  const extensionRequest = application.workspace?.extensionUiRequests?.find(
    (item) => item.conversationId === active?.id,
  );
  const coding = useCodingWorkspace(project?.id ?? "");
  const codingPanel = coding.state;
  const workspaceTab = !codingPanel.open ? "chat" : mobileTab;
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
  function showCodingPanel(open: boolean) {
    coding.update({ open });
    setMobileTab(open ? "code" : "chat");
  }
  const paneStyle: CSSProperties & { "--coding-width": string } = {
    "--coding-width": `calc(${codingPanel.width}% - ${(codingPanel.width / 100) * 5}px)`,
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
    <CodingOpenContext.Provider value={openContent}>
      {coding.error && (
        <p className="bridge-error" role="alert">
          {coding.error}
        </p>
      )}
      <div className="mobile-tabs" role="tablist" aria-label="工作区视图">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "code"}
          onClick={() => showCodingPanel(true)}
        >
          代码
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
        className="workspace coding-mode"
        data-mobile-tab={workspaceTab}
        data-coding-open={codingPanel.open}
        style={paneStyle}
      >
        <div className="assistant-workspace">
          <div className="assistant-navigation">
            <strong>{active?.title ?? "AI 助手"}</strong>
            <IconButton icon="new-chat" label="新建对话" onClick={() => workbench.create()} />
            {!codingPanel.open && (
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
              isNewConversation={workbench.isNewConversation}
              compact={codingPanel.open}
              projectId={project.id}
              models={models}
              onDraft={(draft) => workbench.update({ draft })}
              onModel={(modelId) => workbench.update({ modelId })}
              onThinking={(thinkingLevel) => workbench.update({ thinkingLevel })}
              onAccessMode={(accessMode) => workbench.update({ accessMode })}
              accessPending={workbench.accessPending}
              onSend={async (images) => {
                if (!models.some((model) => model.id === active.modelId)) {
                  onConfigure();
                  return false;
                }
                return workbench.send(images);
              }}
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
        {codingPanel.open && (
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
        <CodingWorkspace
          key={project.id}
          projectId={project.id}
          staticPreviewAvailable={staticPreviewAvailable}
          hidden={!codingPanel.open}
          onToggle={() => showCodingPanel(!codingPanel.open)}
          previewEnabled={
            codingPanel.open && !hidden && !blocked && !extensionRequest && !overlayBlocked
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
