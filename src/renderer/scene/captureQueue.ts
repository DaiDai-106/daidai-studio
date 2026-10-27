import type { ApplicationEvent, ViewportCapture } from "../../shared/application.ts";

type CaptureRequest = Extract<ApplicationEvent, { type: "viewport.capture" }>;
export interface CaptureDisplay {
  concealed: boolean;
  status: "empty" | "loading" | "ready" | "error";
  importId: string | undefined;
  revision: number;
}

// Keep a request until React has applied its requested model and placement to the viewport.
// The host has a slightly longer timeout; cancellation disposes of the request immediately.
export function createCaptureQueue(
  capture: (request: CaptureRequest) => ViewportCapture | null,
  respond: (id: string, result: ViewportCapture | null) => void,
  timeoutMs = 8_000,
) {
  let state: CaptureDisplay = {
    concealed: true,
    status: "empty",
    importId: undefined,
    revision: 0,
  };
  let pending: { request: CaptureRequest; timer: ReturnType<typeof setTimeout> } | undefined;

  function clear() {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
  }
  function finish(result: ViewportCapture | null) {
    const id = pending?.request.id;
    clear();
    if (id) respond(id, result);
  }
  function attempt() {
    const request = pending?.request;
    if (!request) return;
    if (state.concealed || state.status === "error") {
      finish(null);
      return;
    }
    if (state.status !== "ready" || state.importId !== request.importId) return;
    if (state.revision > request.revision) {
      finish(null);
      return;
    }
    if (state.revision !== request.revision) return;
    try {
      finish(capture(request));
    } catch {
      // A lost graphics context cannot produce a usable view.
      finish(null);
    }
  }
  return {
    request(request: CaptureRequest) {
      // The backend allows only one request at a time. Fail the displaced request
      // defensively rather than letting it wait for the host timeout.
      if (pending) finish(null);
      pending = { request, timer: setTimeout(() => finish(null), timeoutMs) };
      attempt();
    },
    update(next: CaptureDisplay) {
      state = next;
      attempt();
    },
    cancel(id: string) {
      if (pending?.request.id === id) clear();
    },
    dispose() {
      clear();
    },
  };
}
