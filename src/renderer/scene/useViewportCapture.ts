import { type RefObject, useEffect, useMemo } from "react";
import { type CaptureDisplay, createCaptureQueue } from "./captureQueue.ts";
import type { ViewportHandle } from "./types.ts";

export function useViewportCapture(
  conversationId: string,
  viewport: RefObject<ViewportHandle | null>,
  display: CaptureDisplay,
) {
  const { concealed, status, importId, revision } = display;
  const queue = useMemo(
    () =>
      createCaptureQueue(
        (request) => viewport.current?.capture(request.view) ?? null,
        (id, capture) => {
          void window.desktop.application.respondViewport(id, capture).catch(() => {});
        },
      ),
    [viewport],
  );
  // Child viewport effects apply model and placement before this parent effect runs.
  useEffect(() => {
    queue.update({ concealed, status, importId, revision });
  }, [queue, concealed, status, importId, revision]);
  useEffect(() => {
    const unsubscribe = window.desktop.application.subscribe((event) => {
      if (event.type === "viewport.capture.cancel") queue.cancel(event.id);
      if (event.type === "viewport.capture" && event.conversationId === conversationId)
        queue.request(event);
    });
    return () => {
      unsubscribe();
      queue.dispose();
    };
  }, [conversationId, queue]);
}
