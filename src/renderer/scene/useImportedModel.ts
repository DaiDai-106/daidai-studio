import { useEffect, useRef, useState } from "react";
import type { ImportedModel } from "../../shared/display.ts";
import { loadDisplay } from "./model.ts";
import type { LoadedModel, ModelViewState } from "./types.ts";

export function useImportedModel(conversationId: string, sourceId: string) {
  const api = window.desktop.application;
  const [state, setState] = useState<ModelViewState>({ status: "empty", loaded: null, error: "" });
  const [sourceStatus, setSourceStatus] = useState<ImportedModel["sourceStatus"]>();
  const current = useRef<LoadedModel | null>(null);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let revision = 0;
    let controller: AbortController | undefined;
    async function refresh(force = false) {
      const version = ++revision;
      try {
        const model = await api.getDisplay(conversationId);
        if (!active || version !== revision) return;
        setSourceStatus(model?.sourceStatus);
        if (!model) return;
        // Same-source chat changes and duplicate notifications retain the GPU model.
        if (current.current?.importId === model.importId && !force) {
          setState({ status: "ready", loaded: current.current, error: "" });
          return;
        }
        controller?.abort();
        controller = new AbortController();
        const signal = controller.signal;
        setState((previous) => ({ ...previous, status: "loading", error: "" }));
        const loaded = await loadDisplay(model, signal);
        if (!active || version !== revision || signal.aborted) {
          loaded.dispose();
          return;
        }
        current.current?.dispose();
        current.current = loaded;
        setState({ status: "ready", loaded, error: "" });
      } catch (error) {
        if (!active || version !== revision || controller?.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          status: "error",
          error: error instanceof Error ? error.message : "显示资源加载失败。",
        }));
      }
    }
    retry.current = () => {
      void refresh(true);
    };
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "display.changed" && event.sourceId === sourceId) void refresh();
    });
    void refresh();
    return () => {
      active = false;
      controller?.abort();
      unsubscribe();
    };
  }, [api, conversationId, sourceId]);
  useEffect(
    () => () => {
      current.current?.dispose();
      current.current = null;
    },
    [],
  );
  return { ...state, sourceStatus, reload: () => retry.current() };
}
