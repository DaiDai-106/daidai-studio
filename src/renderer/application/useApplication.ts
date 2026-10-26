import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConversationInfo,
  ConversationView,
  ProjectInfo,
  WorkspaceInfo,
} from "../../shared/application.ts";

// One projection merge for fresh snapshots and older history pages.
function mergeConversations(
  previous: readonly ConversationInfo[],
  incoming: readonly ConversationInfo[],
  projects: readonly ProjectInfo[],
) {
  const visible = new Set(projects.map((project) => project.id));
  const records = new Map(
    [...previous, ...incoming]
      .filter((item) => visible.has(item.projectId))
      .map((item) => [item.id, item]),
  );
  return [...records.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

export function useApplication() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [view, setView] = useState<ConversationView | null>(null);
  const [error, setError] = useState("");
  const api = window.desktop.application;
  const selected = useRef("");
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const value = await api.getWorkspace();
    if (request === revision.current)
      setWorkspace((previous) => ({
        ...value,
        conversations: mergeConversations(
          previous?.conversations ?? [],
          value.conversations,
          value.projects,
        ),
      }));
    return value;
  }, [api]);
  const report = useCallback(
    (error: unknown) => setError(error instanceof Error ? error.message : "操作失败，请重试。"),
    [],
  );
  const acceptView = useCallback((value: ConversationView) => {
    if (value.conversationId !== selected.current) return;
    setView((previous) =>
      previous?.streamId === value.streamId && previous.sequence > value.sequence
        ? previous
        : value,
    );
  }, []);
  const forgetConversation = useCallback((id: string) => {
    ++revision.current;
    setWorkspace((previous) =>
      previous
        ? {
            ...previous,
            conversations: previous.conversations.filter((item) => item.id !== id),
          }
        : previous,
    );
    if (selected.current === id) {
      selected.current = "";
      setView(null);
    }
  }, []);
  useEffect(() => {
    let active = true;
    const unsubscribe = api.subscribe((event) => {
      if (!active) return;
      if (event.type === "workspace") void refresh().catch(report);
      else if (event.type === "conversationDeleted") forgetConversation(event.id);
      else if (event.type === "conversation") acceptView(event.view);
    });
    void refresh().catch(report);
    return () => {
      active = false;
      ++revision.current;
      unsubscribe();
    };
  }, [api, refresh, report, acceptView, forgetConversation]);
  async function activate(id: string) {
    selected.current = id;
    setView(null);
    if (id) acceptView(await api.watchConversation(id));
  }
  async function updateConversation(change: Parameters<typeof api.updateConversation>[0]) {
    const value = await api.updateConversation(change);
    // A modified older conversation may be outside the latest history page.
    setWorkspace((previous) =>
      previous
        ? {
            ...previous,
            conversations: previous.conversations.map((item) =>
              item.id === value.id ? value : item,
            ),
          }
        : previous,
    );
    return value;
  }
  async function deleteConversation(id: string) {
    await api.deleteConversation(id);
    // Invalidate pending snapshots and remove paged-in copies of this record.
    forgetConversation(id);
  }
  async function run<T>(action: () => Promise<T>) {
    setError("");
    try {
      return await action();
    } catch (error) {
      report(error);
      return undefined;
    }
  }
  async function loadMore(cursor = workspace?.nextCursor) {
    if (!cursor) return;
    const request = revision.current;
    const page = await api.getWorkspace(cursor);
    if (request !== revision.current) return;
    setWorkspace((previous) => {
      if (!previous) return page;
      return {
        ...previous,
        conversations: mergeConversations(
          previous.conversations,
          page.conversations,
          previous.projects,
        ),
        nextCursor: page.nextCursor,
      };
    });
    return page;
  }
  return {
    api,
    workspace,
    view,
    error,
    report,
    run,
    refresh,
    activate,
    updateConversation,
    deleteConversation,
    loadMore,
    clearError: () => setError(""),
  };
}
export type ApplicationState = ReturnType<typeof useApplication>;
