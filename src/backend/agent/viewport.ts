import { randomUUID } from "node:crypto";
import type { Static } from "typebox";
import type {
  CaptureInputSchema,
  ViewportCapture,
} from "../../../resources/mcp/viewport/contract.ts";
import type { ApplicationEvent } from "../../shared/application.ts";
import type { Artifacts } from "../artifacts/store.ts";
import type { Placements } from "../projects/placements.ts";
import { getSceneContext } from "./scene.ts";
import type { RunContext } from "./types.ts";

// Host capability for viewport-mcp. The renderer owns the actual image and camera.
export function createViewportCapture(
  target: () => RunContext,
  artifacts: Artifacts,
  placements: Placements,
  publish: (event: ApplicationEvent) => void,
) {
  let pending: { id: string; resolve: (value: ViewportCapture | null) => void } | undefined;
  return {
    async capture(args: Static<typeof CaptureInputSchema>, signal: AbortSignal) {
      const run = target();
      const scene = await getSceneContext(run, artifacts, placements);
      if (signal.aborted) throw signal.reason ?? new Error("截图已取消。");
      if (
        scene.currentDisplay?.importId !== args.importId ||
        scene.currentDisplay.placement.revision !== args.revision
      )
        throw new Error("场景或定位版本已变化，请使用最新场景状态。");
      if (pending) throw new Error("已有截图请求。");
      const id = randomUUID();
      const capture = await new Promise<ViewportCapture | null>((resolve, reject) => {
        const finish = (value: ViewportCapture | null) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          pending = undefined;
          resolve(value);
        };
        const abort = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          pending = undefined;
          publish({ type: "viewport.capture.cancel", id });
          reject(signal.reason ?? new Error("截图已取消。"));
        };
        const timeout = setTimeout(() => {
          publish({ type: "viewport.capture.cancel", id });
          finish(null);
        }, 10_000);
        pending = { id, resolve: finish };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else
          publish({
            type: "viewport.capture",
            id,
            conversationId: run.conversationId,
            importId: args.importId,
            revision: args.revision,
            view: args.view ?? "current",
          });
      });
      const current = await getSceneContext(run, artifacts, placements);
      if (signal.aborted) throw signal.reason ?? new Error("截图已取消。");
      if (
        current.currentDisplay?.importId !== args.importId ||
        current.currentDisplay.placement.revision !== args.revision
      )
        throw new Error("截图期间场景版本已变化。");
      if (!capture) throw new Error("当前视口不可用，或等待场景渲染超时。请检查场景视图后重试。");
      return capture;
    },
    respond(id: string, capture: ViewportCapture | null) {
      if (pending?.id === id) pending.resolve(capture);
    },
  };
}
