import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ApplicationEvent, ExtensionUiRequest } from "../../contracts/application.ts";
import type { PlanningSelection, PlanningSource } from "../../contracts/planning.ts";

type Answer = string | PlanningSelection;
type Pending = {
  request: ExtensionUiRequest;
  resolve(value: Answer | undefined): void;
  signal?: AbortSignal;
  abort(): void;
  timer?: ReturnType<typeof setTimeout>;
};

/** 每个会话独立排队；停止会话或关闭应用时取消全部等待。 */
export function createExtensionUi(publish: (event: ApplicationEvent) => void) {
  const queues = new Map<string, Pending[]>();
  const cancelled = new Set<string>();
  let closed = false;

  function visible(conversationId: string) {
    const first = queues.get(conversationId)?.[0];
    if (first) publish({ type: "extension.ui.request", request: first.request });
    publish({ type: "workspace" });
  }

  function settle(item: Pending, value?: Answer) {
    item.signal?.removeEventListener("abort", item.abort);
    if (item.timer) clearTimeout(item.timer);
    item.resolve(value);
  }

  function dismiss({ requestId, conversationId }: ExtensionUiRequest) {
    publish({ type: "extension.ui.dismissed", requestId, conversationId });
    visible(conversationId);
  }

  function remove(item: Pending, value?: Answer) {
    const queue = queues.get(item.request.conversationId);
    const index = queue?.indexOf(item) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    if (!queue.length) queues.delete(item.request.conversationId);
    settle(item, value);
    if (index === 0) dismiss(item.request);
  }

  function ask(
    request: Omit<ExtensionUiRequest, "requestId">,
    options?: ExtensionUIDialogOptions,
  ): Promise<Answer | undefined> {
    if (closed || cancelled.has(request.conversationId) || options?.signal?.aborted)
      return Promise.resolve(undefined);
    if (
      request.title.length > 1000 ||
      (request.message?.length ?? 0) > 8000 ||
      (request.placeholder?.length ?? 0) > 1000 ||
      (request.options?.length ?? 0) > 100 ||
      request.options?.some((item) => item.length > 2000)
    )
      throw new Error("扩展交互内容超过限制。");

    const queue = queues.get(request.conversationId) ?? [];
    if (!queues.has(request.conversationId) && queues.size >= 100)
      throw new Error("扩展交互会话过多。");
    if (queue.length >= 100) throw new Error("扩展交互请求过多。");

    return new Promise((resolve) => {
      const item: Pending = {
        request: { ...request, requestId: randomUUID() },
        resolve,
        ...(options?.signal ? { signal: options.signal } : {}),
        abort: () => remove(item),
      };
      if (options?.timeout !== undefined && Number.isFinite(options.timeout)) {
        item.timer = setTimeout(item.abort, Math.max(0, Math.min(options.timeout, 3_600_000)));
        item.timer.unref();
      }
      queue.push(item);
      queues.set(request.conversationId, queue);
      item.signal?.addEventListener("abort", item.abort, { once: true });
      if (item.signal?.aborted) item.abort();
      else if (queue.length === 1) visible(request.conversationId);
    });
  }

  async function askText(
    request: Omit<ExtensionUiRequest, "requestId">,
    options?: ExtensionUIDialogOptions,
  ) {
    const answer = await ask(request, options);
    return typeof answer === "string" ? answer : undefined;
  }

  function findRequest(requestId: string) {
    for (const [item] of queues.values()) {
      if (item?.request.requestId === requestId) return item;
    }
    throw new Error("扩展交互请求已失效。");
  }

  function planningRequest(requestId: string, kind: PlanningSource) {
    const item = findRequest(requestId);
    if (
      item.request.kind !== "planning-source" ||
      (item.request.planningKind && item.request.planningKind !== kind)
    )
      throw new Error("规划场景选择请求无效。");
    return item;
  }

  function cancelConversation(conversationId: string) {
    cancelled.add(conversationId);
    const queue = queues.get(conversationId);
    const first = queue?.[0];
    if (!first) return;
    queues.delete(conversationId);
    for (const item of queue) settle(item);
    dismiss(first.request);
  }

  function context(conversationId: string): ExtensionUIContext {
    const unsupported = () => {
      throw new Error("当前桌面不支持此终端扩展界面。");
    };

    return {
      select: (title, options, opts) =>
        askText({ conversationId, kind: "select", title, options }, opts),
      confirm: async (title, message, opts) =>
        (await ask({ conversationId, kind: "confirm", title, message }, opts)) === "true",
      input: (title, placeholder, opts) =>
        askText(
          {
            conversationId,
            kind: "input",
            title,
            ...(placeholder === undefined ? {} : { placeholder }),
          },
          opts,
        ),
      notify: (message, level = "info") =>
        publish({
          type: "extension.ui.notification",
          conversationId,
          message: message.slice(0, 4000),
          level,
        }),
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => unsupported(),
      pasteToEditor: unsupported,
      setEditorText: unsupported,
      getEditorText: () => "",
      editor: async () => unsupported(),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: new Proxy({}, { get: unsupported }) as unknown as ExtensionUIContext["theme"],
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "桌面不支持终端主题切换。" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  return {
    context,
    async choosePlanningSource(
      conversationId: string,
      kind?: PlanningSource,
      signal?: AbortSignal,
    ) {
      const answer = await ask(
        {
          conversationId,
          kind: "planning-source",
          title: "选择规划场景",
          ...(kind ? { planningKind: kind } : {}),
        },
        signal ? { signal } : undefined,
      );
      return typeof answer === "object" ? answer : undefined;
    },
    checkPlanningSource(requestId: string, kind: PlanningSource) {
      planningRequest(requestId, kind);
    },
    respondPlanningSource(requestId: string, kind: PlanningSource, path?: string) {
      remove(planningRequest(requestId, kind), path === undefined ? undefined : { kind, path });
    },
    beginConversation(conversationId: string) {
      cancelled.delete(conversationId);
    },

    pending(): ExtensionUiRequest[] {
      return [...queues.values()].flatMap((queue) => (queue[0] ? [queue[0].request] : []));
    },

    respond(input: { requestId: string; cancelled: boolean; value?: string }) {
      const item = findRequest(input.requestId);
      if (!input.cancelled) {
        if (item.request.kind === "planning-source") throw new Error("请选择本地规划场景。");
        if (item.request.kind === "confirm" && input.value !== "true" && input.value !== "false")
          throw new Error("确认结果无效。");
        if (
          item.request.kind === "select" &&
          (input.value === undefined || !item.request.options?.includes(input.value))
        )
          throw new Error("选择结果无效。");
        if (item.request.kind === "input" && input.value === undefined)
          throw new Error("输入结果无效。");
      }
      remove(item, input.cancelled ? undefined : input.value);
    },

    cancelConversation,
    close() {
      closed = true;
      for (const id of [...queues.keys()]) cancelConversation(id);
    },
  };
}
