import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  ConversationHistoryPage,
  ConversationView,
} from "../../../../contracts/application.ts";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";

type HistoryWindow = Omit<ConversationHistoryPage, "historyKey">;
type HistoryTarget = "older" | "newer" | { turnId: string };
export type ChatPosition = { turnId: string; offset: number; pinned: boolean };

function recent(view: ConversationView): HistoryWindow {
  return { start: view.history.start, messages: view.messages, nextTurnId: null };
}

function syncWindow(window: HistoryWindow, view: ConversationView): HistoryWindow | undefined {
  const { nextTurnId, messages, start } = window;
  if (nextTurnId) {
    const seam = view.messages.findIndex((message) => message.id === nextTurnId);
    if (seam >= 0)
      return { start, messages: [...messages, ...view.messages.slice(seam)], nextTurnId: null };
    return view.history.markers.some((marker) => marker.id === nextTurnId) ? window : undefined;
  }
  if (view.history.start <= start) return recent(view);
  // 较早的正文只在新的首轮仍属于这段原生父链时保留。
  const head = view.history.markers[view.history.start]?.id;
  const seam = messages.findIndex((message) => message.id === head);
  if (seam > 0) return { ...window, messages: [...messages.slice(0, seam), ...view.messages] };
}

function prepend(page: HistoryWindow, window: HistoryWindow): HistoryWindow {
  return { ...window, start: page.start, messages: [...page.messages, ...window.messages] };
}

function sourceOf(view: ConversationView) {
  return `${view.streamId}:${view.conversationId}`;
}

type Selection = {
  source: string;
  historyKey: ConversationView["historyKey"];
  page: HistoryWindow | undefined;
  scroll?: { anchor: ChatPosition | null };
};

function selectionFor(
  view: ConversationView,
  page: HistoryWindow | undefined,
  position?: ChatPosition | null,
): Selection {
  return {
    source: sourceOf(view),
    historyKey: view.historyKey,
    page,
    ...(position === undefined ? {} : { scroll: { anchor: position } }),
  };
}

export function useConversationHistory(
  stream: ConversationView | null,
  read: ApplicationBridge["readConversationHistory"],
) {
  const source = stream ? sourceOf(stream) : "";
  const [selection, setSelection] = useState<Selection>();
  const [status, setStatus] = useState<{ loading: boolean; error: string }>();
  const request = useRef<object | undefined>(undefined);
  const selected = selection?.source === source ? selection : undefined;
  const page = selected?.page;

  if (selection && !selected) setSelection(undefined);
  else if (stream && selected && page && selected.historyKey !== stream.historyKey)
    setSelection({ ...selected, historyKey: stream.historyKey, page: syncWindow(page, stream) });

  const current = useRef({ stream, selected });
  useLayoutEffect(() => {
    current.current = { stream, selected };
  }, [stream, selected]);

  const cancel = useCallback(() => {
    request.current = undefined;
    setStatus(undefined);
  }, []);
  useLayoutEffect(() => {
    if (!source) return;
    cancel();
    return () => {
      request.current = undefined;
    };
  }, [source, cancel]);

  const pause = useCallback(
    (options?: { keepWindow: boolean }) => {
      cancel();
      const { stream, selected } = current.current;
      setSelection(
        options?.keepWindow && stream && !selected?.page
          ? selectionFor(stream, recent(stream))
          : selected,
      );
    },
    [cancel],
  );

  function showRecent() {
    const { stream } = current.current;
    if (!stream) return;
    cancel();
    setSelection(selectionFor(stream, undefined, null));
  }

  function keepReading() {
    const { stream, selected } = current.current;
    if (!stream || selected?.page) return;
    // 只在用户离开底部时保留当前窗口，新消息滚入首屏时不会移除正在读的轮次。
    setSelection((previous) => (previous?.page ? previous : selectionFor(stream, recent(stream))));
  }

  async function load(target: HistoryTarget, capture: () => ChatPosition | undefined) {
    const { stream: origin, selected } = current.current;
    if (!origin) return;
    const previous = selected?.page ?? recent(origin);
    const jump = typeof target === "object";
    const turnId = jump
      ? target.turnId
      : target === "older"
        ? previous.start > 0 && origin.history.markers[previous.start]?.id
        : previous.nextTurnId;
    if (!turnId || (request.current && !jump)) return;
    const pending = {};
    request.current = pending;
    setStatus({ loading: true, error: "" });
    try {
      const { historyKey, ...incoming } = await read({
        id: origin.conversationId,
        turnId,
        ...(target === "older" ? { before: true } : {}),
      });
      const { stream: latest, selected: currentSelection } = current.current;
      if (request.current !== pending || !latest || sourceOf(latest) !== sourceOf(origin)) return;

      const base = currentSelection?.page ?? recent(latest);
      const stale = () => new Error("会话历史已更新，请重试。");
      let updated: HistoryWindow | undefined;
      if (target === "older") {
        if (incoming.nextTurnId !== turnId) throw stale();
        updated =
          latest.history.markers[base.start]?.id === turnId
            ? prepend(incoming, base)
            : syncWindow(prepend(incoming, previous), latest);
      } else {
        if (target === "newer" && base.nextTurnId !== turnId) return;
        if (!incoming.nextTurnId && historyKey !== latest.historyKey) throw stale();
        updated = syncWindow(target === "newer" ? prepend(base, incoming) : incoming, latest);
      }
      if (!updated) throw stale();
      setSelection(selectionFor(latest, updated, capture()));
    } catch (error) {
      if (request.current === pending)
        setStatus({
          loading: false,
          error: error instanceof Error ? error.message : "无法读取聊天历史。",
        });
    } finally {
      if (request.current === pending) {
        request.current = undefined;
        setStatus((status) => (status?.loading ? undefined : status));
      }
    }
  }

  function jump(turnId: string) {
    const { stream, selected } = current.current;
    if (!stream) return false;
    const window = selected?.page ?? recent(stream);
    const position = { turnId, offset: -14, pinned: true };
    const mounted = window.messages.some((message) => message.id === turnId);
    if (mounted || stream.messages.some((message) => message.id === turnId)) {
      // 连窗口和定位一起提交，覆盖已排队但尚未渲染的旧跳转。
      cancel();
      setSelection(selectionFor(stream, mounted ? window : recent(stream), position));
    } else {
      setSelection(selected);
      void load({ turnId }, () => position);
    }
    return mounted;
  }

  return {
    messages: page?.messages ?? stream?.messages,
    scroll: selected?.scroll,
    hasOlder: (page?.start ?? stream?.history.start ?? 0) > 0,
    hasNewer: !!page?.nextTurnId,
    status,
    load,
    jump,
    pause,
    keepReading,
    showRecent,
  };
}
