import { useCallback, useEffect, useMemo, useState } from "react";
import { type Content, type TabsAction, tabsReducer } from "./content_tabs.ts";
import {
  loadCodingWorkspace,
  MAX_SAVED_TABS,
  saveCodingWorkspace,
  type WorkspaceState,
} from "./workspace_storage.ts";

function restore(projectId: string) {
  const { error, ...state } = loadCodingWorkspace(projectId);
  return { projectId, state, error };
}

/** 单一入口管理布局和标签；项目切换时恢复文件，网页实例不跨项目重放。 */
export function useCodingWorkspace(projectId: string) {
  const [workspace, setWorkspace] = useState(() => restore(projectId));
  const [saveError, setSaveError] = useState({ state: workspace.state, error: "" });

  // 在新项目的子组件提交前重置状态，避免旧标签先出现在新项目中。
  if (workspace.projectId !== projectId) setWorkspace(restore(projectId));

  useEffect(() => {
    if (!workspace.projectId) return;
    setSaveError({
      state: workspace.state,
      error: saveCodingWorkspace(workspace.projectId, workspace.state),
    });
  }, [workspace.projectId, workspace.state]);

  const update = useCallback(
    (change: Partial<WorkspaceState> | ((state: WorkspaceState) => WorkspaceState)) => {
      setWorkspace((previous) => {
        if (previous.projectId !== projectId || !projectId) return previous;
        const state =
          typeof change === "function" ? change(previous.state) : { ...previous.state, ...change };
        return { ...previous, state };
      });
    },
    [projectId],
  );

  function dispatchTabs(action: TabsAction) {
    update((state) => ({ ...state, tabs: tabsReducer(state.tabs, action) }));
  }

  const open = useCallback(
    (content: Content) => {
      const id = crypto.randomUUID();
      update((state) => ({
        ...state,
        open: true,
        tabs: tabsReducer(state.tabs, { type: "open", tab: { id, content } }),
      }));
    },
    [update],
  );

  const notice = useMemo(
    () =>
      workspace.state.tabs.items.filter((tab) => tab.content.type !== "preview").length >
      MAX_SAVED_TABS
        ? `重启时最多恢复 ${MAX_SAVED_TABS} 个文件和差异标签，优先保留当前活动项，其余保留最近打开的标签。`
        : "",
    [workspace.state.tabs.items],
  );

  return {
    notice,
    state: workspace.state,
    error: workspace.error || (saveError.state === workspace.state ? saveError.error : ""),
    update,
    dispatchTabs,
    open,
  };
}
