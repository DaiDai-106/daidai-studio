import type {
  ApplicationEvent,
  ConversationInfo,
  ConversationProgress,
  ConversationView,
  WorkspaceInfo,
} from "../../../contracts/application.ts";
import type { ApplicationBridge } from "../../../contracts/bridge.ts";
import { mergeConversations } from "./conversation_list.ts";

/** 同一客户端拥有快照、局部事件和写入的版本；React 只订阅结果。 */
export function createApplicationClient(api: ApplicationBridge) {
  let state: { workspace: WorkspaceInfo | null; view: ConversationView | null; error: string } = {
    workspace: null,
    view: null,
    error: "",
  };
  const listeners = new Set<() => void>();
  const deleted = new Set<string>();
  let revision = 0;
  let refreshId = 0;
  let pendingSelection: { id: string; view: ConversationView | null } | undefined;
  let generation = 0;
  let writes = Promise.resolve();
  let pageRequest: { cursor: string; promise: Promise<WorkspaceInfo | undefined> } | undefined;

  function patch(change: Partial<typeof state>) {
    state = { ...state, ...change };
    for (const notify of listeners) notify();
  }

  function report(error: unknown) {
    patch({ error: error instanceof Error ? error.message : "操作失败，请重试。" });
  }

  function merge(
    previous: ConversationInfo[],
    incoming: ConversationInfo[],
    projects: WorkspaceInfo["projects"],
  ) {
    return mergeConversations(previous, incoming, projects).filter((item) => !deleted.has(item.id));
  }

  async function refresh() {
    const request = ++refreshId;
    const life = generation;
    for (;;) {
      // 工作区事件可能先于写入响应到达；先等写入提交，避免旧元数据回写。
      await writes;
      if (request !== refreshId || life !== generation) return state.workspace ?? undefined;
      const version = revision;
      let value: WorkspaceInfo;
      try {
        value = await api.getWorkspace();
      } catch (error) {
        if (request !== refreshId || life !== generation) return state.workspace ?? undefined;
        throw error;
      }
      if (request !== refreshId || life !== generation) return value;
      if (version !== revision) continue;
      patch({
        workspace: {
          ...value,
          conversations: merge(
            state.workspace?.conversations ?? [],
            value.conversations,
            value.projects,
          ),
        },
      });
      return value;
    }
  }

  function mergeView(
    previous: ConversationView | null,
    value: ConversationView | ConversationProgress,
  ) {
    if (previous?.streamId === value.streamId && previous.sequence > value.sequence)
      return previous;
    if ("messages" in value) return value;
    if (
      previous?.streamId === value.streamId &&
      value.historyKey &&
      previous.historyKey === value.historyKey
    )
      return { ...value, messages: previous.messages, history: previous.history };
    // 不把新分支的增量拼到旧历史；后续完整快照或 watch 会恢复该分支。
    return previous;
  }

  function acceptView(value: ConversationView | ConversationProgress) {
    if (deleted.has(value.conversationId)) return;
    if (pendingSelection?.id === value.conversationId)
      pendingSelection.view = mergeView(pendingSelection.view, value);
    if (value.conversationId !== state.view?.conversationId) return;
    const view = mergeView(state.view, value);
    if (view !== state.view) patch({ view });
  }

  function forgetConversation(id: string) {
    ++revision;
    deleted.add(id);
    const workspace = state.workspace;
    patch({
      workspace: workspace
        ? { ...workspace, conversations: workspace.conversations.filter((item) => item.id !== id) }
        : null,
      view: state.view?.conversationId === id ? null : state.view,
    });
  }

  function receive(event: ApplicationEvent) {
    if (event.type === "workspace") void refresh().catch(report);
    else if (event.type === "conversation" || event.type === "conversation.progress")
      acceptView(event.view);
    else if (event.type === "conversationDeleted") forgetConversation(event.id);
    else if (
      event.type === "extension.ui.request" ||
      event.type === "extension.ui.dismissed" ||
      event.type === "shell.approval"
    ) {
      ++revision;
      const workspace = state.workspace;
      if (workspace) {
        if (event.type === "shell.approval")
          patch({ workspace: { ...workspace, shellApproval: event.approval } });
        else {
          const requests = (workspace.extensionUiRequests ?? []).filter(
            (item) =>
              item.requestId !==
              (event.type === "extension.ui.request" ? event.request.requestId : event.requestId),
          );
          patch({
            workspace: {
              ...workspace,
              extensionUiRequests:
                event.type === "extension.ui.request" ? [...requests, event.request] : requests,
            },
          });
        }
      }
      // 初始快照尚未建立时，局部事件也会使其失效并重新读取。
      void refresh().catch(report);
    }
  }

  async function activate(id: string, isCurrent = () => true) {
    if (!id) {
      pendingSelection = undefined;
      patch({ view: null });
      return;
    }
    const target = { id, view: id === state.view?.conversationId ? state.view : null };
    pendingSelection = target;
    try {
      const value = await api.watchConversation(id);
      if (pendingSelection !== target || !isCurrent()) return;
      if (deleted.has(id)) throw new Error("会话不存在。");
      if (value.conversationId !== id) throw new Error("读取到的会话与当前选择不一致。");
      patch({ view: mergeView(target.view, value) });
    } catch (error) {
      if (pendingSelection === target && isCurrent()) throw error;
    } finally {
      if (pendingSelection === target) pendingSelection = undefined;
    }
  }

  function write<T>(action: () => Promise<T>) {
    ++revision;
    const result = writes.then(action);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function updateConversation(change: Parameters<ApplicationBridge["updateConversation"]>[0]) {
    return write(async () => {
      if (deleted.has(change.id)) throw new Error("会话不存在。");
      const value = await api.updateConversation(change);
      ++revision;
      if (!deleted.has(value.id) && state.workspace)
        patch({
          workspace: {
            ...state.workspace,
            conversations: state.workspace.conversations.map((item) =>
              item.id === value.id ? value : item,
            ),
          },
        });
      return value;
    });
  }

  function deleteConversation(id: string) {
    return write(async () => {
      await api.deleteConversation(id);
      forgetConversation(id);
    });
  }

  async function run<T>(action: () => Promise<T>) {
    patch({ error: "" });
    try {
      return await action();
    } catch (error) {
      report(error);
      return undefined;
    }
  }

  function loadMore(cursor = state.workspace?.nextCursor): Promise<WorkspaceInfo | undefined> {
    if (!cursor || !state.workspace) return Promise.resolve(undefined);
    if (pageRequest?.cursor === cursor) return pageRequest.promise;
    const request = refreshId;
    const life = generation;
    const promise = writes
      .then(async () => {
        const version = revision;
        const current = () =>
          state.workspace &&
          request === refreshId &&
          version === revision &&
          life === generation &&
          state.workspace.nextCursor === cursor;
        if (!current()) return undefined;
        let page: WorkspaceInfo;
        try {
          page = await api.getWorkspace(cursor);
        } catch (error) {
          if (!current()) return undefined;
          throw error;
        }
        const workspace = state.workspace;
        if (!workspace || !current()) return undefined;
        patch({
          workspace: {
            ...workspace,
            conversations: merge(workspace.conversations, page.conversations, workspace.projects),
            nextCursor: page.nextCursor,
          },
        });
        return page;
      })
      .finally(() => {
        if (pageRequest?.promise === promise) pageRequest = undefined;
      });
    pageRequest = { cursor, promise };
    return promise;
  }

  return {
    api,
    refresh,
    report,
    activate,
    updateConversation,
    deleteConversation,
    run,
    loadMore,
    getSnapshot: () => state,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    connect() {
      const life = ++generation;
      const unsubscribe = api.subscribe((event) => {
        if (life === generation) receive(event);
      });
      void refresh().catch((error) => {
        if (life === generation) report(error);
      });
      return () => {
        ++generation;
        ++refreshId;
        pendingSelection = undefined;
        unsubscribe();
      };
    },
  };
}
