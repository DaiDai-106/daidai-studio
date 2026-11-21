import { Icon } from "../../../shared/components/icon.tsx";
import type { useCodingWorkspace } from "../logic/use_coding_workspace.ts";
import { ChangesList } from "./changes_list.tsx";
import { FileSearch } from "./file_search.tsx";
import { FileTree } from "./file_tree.tsx";
import { TextContentPanel } from "./text_content_panel.tsx";
import { WebPreview } from "./web_preview.tsx";
import "../styles/coding.css";

export function CodingWorkspace({
  projectId,
  staticPreviewAvailable,
  hidden,
  onToggle,
  previewEnabled,
  workspace,
  conversationId,
  onAnnotate,
}: {
  projectId: string;
  staticPreviewAvailable: boolean;
  hidden: boolean;
  onToggle: () => void;
  previewEnabled: boolean;
  workspace: ReturnType<typeof useCodingWorkspace>;
  conversationId?: string | undefined;
  onAnnotate: (text: string) => boolean;
}) {
  const { state, update, dispatchTabs: dispatch, open } = workspace;
  const { tabs, navigation } = state;
  const panel = navigation ?? "files";
  const navigationOpen = navigation !== null;

  return (
    <section
      id="coding-workspace"
      className="coding-workspace"
      aria-label="代码工作区"
      hidden={hidden}
    >
      <header className="coding-toolbar">
        <div className="coding-tabs" role="tablist" aria-label="代码导航">
          <button
            type="button"
            role="tab"
            aria-selected={navigationOpen && panel === "files"}
            aria-expanded={navigationOpen && panel === "files"}
            onClick={() => {
              update({ navigation: navigation === "files" ? null : "files" });
            }}
          >
            文件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={navigationOpen && panel === "changes"}
            aria-expanded={navigationOpen && panel === "changes"}
            onClick={() => {
              update({ navigation: navigation === "changes" ? null : "changes" });
            }}
          >
            变更
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="收起代码工作区"
          title="收起代码工作区"
          aria-expanded={true}
          aria-controls="coding-workspace"
          onClick={onToggle}
        >
          <Icon name="panel" />
        </button>
      </header>
      {workspace.notice && (
        <p className="coding-notice" role="status">
          {workspace.notice}
        </p>
      )}
      <div className="coding-body" data-navigation={navigationOpen}>
        <div className="coding-editor">
          <div className="content-tab-bar">
            <div className="content-tab-list" role="tablist" aria-label="已打开的内容">
              {tabs.items.map((tab) => (
                <div
                  className={`content-tab ${tabs.activeId === tab.id ? "active" : ""}`}
                  key={tab.id}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`content-tab-${tab.id}`}
                    aria-controls={`content-panel-${tab.id}`}
                    aria-selected={tabs.activeId === tab.id}
                    title={tab.content.type === "preview" ? "网页预览" : tab.content.path}
                    onClick={() => dispatch({ type: "select", id: tab.id })}
                  >
                    {tab.content.type === "preview"
                      ? tab.content.file
                        ? `${tab.content.file.split("/").pop()} · 预览`
                        : "网页预览"
                      : tab.content.path.split("/").pop()}
                    {tab.content.type === "diff"
                      ? ` · ${tab.content.kind === "staged" ? "已暂存" : tab.content.kind === "unstaged" ? "未暂存" : "未跟踪"}`
                      : ""}
                  </button>
                  <button
                    type="button"
                    className="content-tab-close"
                    aria-label={
                      tab.content.type === "preview"
                        ? "关闭网页预览"
                        : `关闭 ${tab.content.path}${tab.content.type === "diff" ? ` ${tab.content.kind}` : ""}`
                    }
                    onClick={() => dispatch({ type: "close", id: tab.id })}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="content-open-preview"
              onClick={() => open({ type: "preview", url: "" })}
            >
              ＋ 网页预览
            </button>
          </div>
          {tabs.items.map((tab) =>
            tab.content.type === "preview" ? (
              <section
                key={tab.id}
                className="coding-tab-panel"
                role="tabpanel"
                id={`content-panel-${tab.id}`}
                aria-labelledby={`content-tab-${tab.id}`}
                hidden={tabs.activeId !== tab.id}
              >
                <WebPreview
                  projectId={projectId}
                  tabId={tab.id}
                  initialUrl={tab.content.url}
                  {...(tab.content.file ? { initialFile: tab.content.file } : {})}
                  active={tabs.activeId === tab.id}
                  enabled={previewEnabled}
                />
              </section>
            ) : (
              <TextContentPanel
                key={tab.id}
                projectId={projectId}
                id={tab.id}
                conversationId={conversationId}
                onAnnotate={onAnnotate}
                content={tab.content}
                active={tabs.activeId === tab.id}
              />
            ),
          )}
          {!tabs.items.length && <p className="coding-notice">选择项目文件或 Git 变更查看内容。</p>}
        </div>
        <aside className="coding-tree" aria-label="项目文件与变更" hidden={!navigationOpen}>
          <div hidden={panel !== "files"}>
            <FileSearch projectId={projectId} onSelect={(path) => open({ type: "file", path })}>
              <FileTree
                projectId={projectId}
                path=""
                onOpen={(path) => open({ type: "file", path })}
                onPreview={
                  staticPreviewAvailable
                    ? (path) => open({ type: "preview", url: "", file: path })
                    : undefined
                }
              />
            </FileSearch>
          </div>
          {panel === "changes" && !hidden && (
            <ChangesList
              projectId={projectId}
              onOpen={(path, kind) => open({ type: "diff", path, kind })}
            />
          )}
        </aside>
      </div>
    </section>
  );
}
