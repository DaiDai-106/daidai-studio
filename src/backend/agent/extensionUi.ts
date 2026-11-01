import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ApplicationEvent, ExtensionUiRequest } from "../../contracts/application.ts";

type Pending = {
  request: ExtensionUiRequest;
  resolve(value: string | undefined): void;
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

  function remove(item: Pending, value?: string) {
    const queue = queues.get(item.request.conversationId);
    const index = queue?.indexOf(item) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    if (!queue.length) queues.delete(item.request.conversationId);
    item.signal?.removeEventListener("abort", item.abort);
    if (item.timer) clearTimeout(item.timer);
    item.resolve(value);
    if (index === 0) {
      publish({
        type: "extension.ui.dismissed",
        requestId: item.request.requestId,
        conversationId: item.request.conversationId,
      });
      visible(item.request.conversationId);
    }
  }

  function ask(
    request: Omit<ExtensionUiRequest, "requestId">,
    options?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
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

  function cancelConversation(conversationId: string) {
    cancelled.add(conversationId);
    const queue = queues.get(conversationId);
    if (!queue) return;
    queues.delete(conversationId);
    for (const item of queue) {
      item.signal?.removeEventListener("abort", item.abort);
      if (item.timer) clearTimeout(item.timer);
      item.resolve(undefined);
    }
    const first = queue[0];
    if (first)
      publish({
        type: "extension.ui.dismissed",
        requestId: first.request.requestId,
        conversationId,
      });
    publish({ type: "workspace" });
  }

  function context(conversationId: string): ExtensionUIContext {
    const unsupported = () => {
      throw new Error("当前桌面不支持此终端扩展界面。");
    };

    return {
      select: (title, options, opts) =>
        ask({ conversationId, kind: "select", title, options }, opts),
      confirm: async (title, message, opts) =>
        (await ask({ conversationId, kind: "confirm", title, message }, opts)) === "true",
      input: (title, placeholder, opts) =>
        ask(
          {
            conversationId,
            kind: "input",
            title,
            ...(placeholder === undefined ? {} : { placeholder }),
          },
          opts,
        ),
      notify: () => {},
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
    beginConversation(conversationId: string) {
      cancelled.delete(conversationId);
    },

    pending(): ExtensionUiRequest[] {
      return [...queues.values()].flatMap((queue) => (queue[0] ? [queue[0].request] : []));
    },

    respond(input: { requestId: string; cancelled: boolean; value?: string }) {
      const item = [...queues.values()]
        .map((queue) => queue[0])
        .find((entry) => entry?.request.requestId === input.requestId);
      if (!item) throw new Error("扩展交互请求已失效。");
      if (!input.cancelled) {
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
