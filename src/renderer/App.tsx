import { type CSSProperties, useRef, useState } from "react";
import { useApplication } from "./application/useApplication.ts";
import { useDesktop } from "./application/useDesktop.ts";
import { IconButton } from "./components/Icon.tsx";
import { type SettingsPage, SettingsView } from "./settings/SettingsView.tsx";
import { useSettings } from "./settings/useSettings.ts";
import { ChatPanel } from "./workbench/ChatPanel.tsx";
import { ScenePanel } from "./workbench/ScenePanel.tsx";
import { Sidebar } from "./workbench/Sidebar.tsx";
import { shortcutLabel, useShortcuts } from "./workbench/shortcuts.ts";
import { useWorkbench } from "./workbench/useWorkbench.ts";
import { Welcome } from "./workbench/Welcome.tsx";
import { ArchivesDialog, FilesDialog, RenameDialog } from "./workbench/WorkbenchDialogs.tsx";

type WorkbenchDialog =
  | { type: "files" }
  | { type: "rename"; id: string }
  | { type: "archives"; projectId: string | null };

export function App() {
  const application = useApplication();
  const configuration = useSettings(application);
  const { theme, models } = configuration;
  const { info, error: desktopError } = useDesktop(theme);
  const workbench = useWorkbench(application);
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const [dialog, setDialog] = useState<WorkbenchDialog | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [chatWidth, setChatWidth] = useState(410);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const { active, project, mobileTab, setMobileTab } = workbench;
  const isScene = active?.mode === "scene";
  const paneStyle: CSSProperties & { "--chat-width": string } = {
    "--chat-width": `${chatWidth}px`,
  };

  function send() {
    if (!active?.draft.trim()) return;
    if (!active || !models.some((model) => model.id === active.modelId)) {
      setSettings("ai");
      return;
    }
    workbench.send();
  }
  function resize(clientX: number) {
    setChatWidth(Math.max(320, Math.min(600, window.innerWidth - clientX)));
  }
  const renamed =
    dialog?.type === "rename"
      ? workbench.conversations.find((item) => item.id === dialog.id)
      : undefined;

  useShortcuts(
    {
      newChat: () => {
        setSettings(null);
        workbench.create();
      },
      openProject: () => {
        setSettings(null);
        workbench.openProject();
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
    dialog === null,
  );

  return (
    <>
      <div className="app-layout" hidden={settings !== null}>
        {sidebar && (
          <Sidebar
            projects={workbench.projects}
            conversations={workbench.conversations}
            activeId={active?.id ?? ""}
            version={info?.version ?? "…"}
            onSelect={(id) => {
              workbench.select(id);
              setMobileTab("scene");
            }}
            onCreate={workbench.create}
            onOpen={() => workbench.openProject()}
            onRemove={workbench.removeProject}
            onSettings={setSettings}
            onRename={(id) => setDialog({ type: "rename", id })}
            onArchive={workbench.archive}
            onDelete={(id) => void workbench.deleteConversation(id)}
            onArchives={(projectId) => setDialog({ type: "archives", projectId })}
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
            </div>
            <div className="topbar-actions">
              <IconButton
                icon="new-chat"
                label="在当前项目新建对话"
                shortcut={shortcutLabel("newChat")}
                onClick={() => workbench.create()}
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
          {application.workspace?.nextCursor && (
            <button
              type="button"
              className="text-button"
              onClick={() => void application.run(() => application.loadMore())}
            >
              加载更多历史对话
            </button>
          )}
          {isScene && (
            <div className="mobile-tabs" role="tablist" aria-label="工作区视图">
              <button
                type="button"
                role="tab"
                aria-selected={mobileTab === "scene"}
                onClick={() => setMobileTab("scene")}
              >
                场景
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobileTab === "chat"}
                onClick={() => setMobileTab("chat")}
              >
                聊天
              </button>
            </div>
          )}
          {active && project ? (
            <div
              className={`workspace ${isScene ? "scene-mode" : ""}`}
              data-mobile-tab={mobileTab}
              style={paneStyle}
            >
              {(isScene || active.source) && (
                <ScenePanel
                  key={`${project.id}:${workbench.step}`}
                  concealed={!isScene}
                  step={workbench.step}
                  conversationId={active.id}
                  sourceId={active.source?.id ?? ""}
                />
              )}
              {isScene && (
                <hr
                  className="splitter"
                  tabIndex={0}
                  aria-label="调整场景与聊天宽度"
                  aria-orientation="vertical"
                  aria-valuemin={320}
                  aria-valuemax={600}
                  aria-valuenow={chatWidth}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resize(event.clientX);
                  }}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      resize(event.clientX);
                  }}
                  onPointerUp={(event) =>
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      event.preventDefault();
                      setChatWidth((width) =>
                        Math.max(
                          320,
                          Math.min(600, width + (event.key === "ArrowLeft" ? 20 : -20)),
                        ),
                      );
                    }
                  }}
                />
              )}
              <ChatPanel
                inputRef={messageInput}
                conversation={active}
                compact={isScene}
                models={models}
                onDraft={(draft) => workbench.update({ draft })}
                onMode={workbench.setMode}
                onModel={(modelId) => workbench.update({ modelId })}
                onSend={send}
                onFiles={() => setDialog({ type: "files" })}
                step={workbench.step}
                onClearStep={() => workbench.selectStep("")}
                onConfigure={() => setSettings("ai")}
                stream={application.view}
                onStop={() => {
                  if (active)
                    void application.run(() => application.api.stopConversation(active.id));
                }}
              />
            </div>
          ) : (
            <Welcome>
              <button
                type="button"
                onClick={() => (project ? workbench.create() : workbench.openProject())}
              >
                {project ? "新建对话" : "打开项目"}
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
          providers={configuration.providers}
          defaultModel={configuration.defaultModel}
          onProviders={configuration.updateProviders}
          onDefault={configuration.setDefaultModel}
          servers={configuration.servers}
          skills={configuration.skills}
          onServers={configuration.setServers}
          onSkills={configuration.setSkills}
          onInspect={configuration.inspectServer}
          onCancelInspection={configuration.cancelInspection}
          project={project}
          projects={workbench.projects}
          onArchives={() => setDialog({ type: "archives", projectId: null })}
        />
      )}
      {dialog?.type === "files" && project && (
        <FilesDialog
          project={project}
          selected={workbench.step}
          onSelect={workbench.selectStep}
          onClose={() => setDialog(null)}
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
