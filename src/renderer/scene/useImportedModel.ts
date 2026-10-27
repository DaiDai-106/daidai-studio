import { useEffect, useRef, useState } from "react";
import type { ImportedModel } from "../../shared/display.ts";
import { loadDisplay } from "./model.ts";
import type { LoadedModel, ModelViewState } from "./types.ts";

const empty = (owner: string): ModelViewState & { sourceId: string } => ({
  sourceId: owner,
  status: "empty",
  loaded: null,
  error: "",
  placement: null,
});

export function useImportedModel(conversationId: string, sourceId: string) {
  const api = window.desktop.application;
  const [state, setState] = useState(() => empty(sourceId));
  const [sourceStatus, setSourceStatus] = useState<{
    sourceId: string;
    value: ImportedModel["sourceStatus"];
  }>();
  const current = useRef<LoadedModel | null>(null);
  const currentSource = useRef(sourceId);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let revision = 0;
    let controller: AbortController | undefined;
    if (currentSource.current !== sourceId) {
      current.current?.dispose();
      current.current = null;
      currentSource.current = sourceId;
      setState(empty(sourceId));
    }
    async function refresh(force = false) {
      const version = ++revision;
      try {
        const model = await api.getDisplay(conversationId);
        if (!active || version !== revision) return;
        setSourceStatus({ sourceId, value: model?.sourceStatus });
        if (!model) {
          controller?.abort();
          current.current?.dispose();
          current.current = null;
          setState(empty(sourceId));
          return;
        }
        // Same-source chat changes and duplicate notifications retain the GPU model.
        if (current.current?.importId === model.importId && !force) {
          setState({
            sourceId,
            status: "ready",
            loaded: current.current,
            error: "",
            placement: model.placement ?? null,
          });
          return;
        }
        controller?.abort();
        controller = new AbortController();
        const signal = controller.signal;
        setState((previous) => ({
          ...(previous.sourceId === sourceId ? previous : empty(sourceId)),
          status: "loading",
          error: "",
        }));
        const loaded = await loadDisplay(model, signal);
        if (!active || version !== revision || signal.aborted) {
          loaded.dispose();
          return;
        }
        current.current?.dispose();
        current.current = loaded;
        setState({
          sourceId,
          status: "ready",
          loaded,
          error: "",
          placement: model.placement ?? null,
        });
      } catch (error) {
        if (!active || version !== revision || controller?.signal.aborted) return;
        setState((previous) => ({
          ...(previous.sourceId === sourceId ? previous : empty(sourceId)),
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
  // Hide a previous source immediately, before the source-change effect can run.
  return {
    ...(state.sourceId === sourceId ? state : empty(sourceId)),
    sourceStatus: sourceStatus?.sourceId === sourceId ? sourceStatus.value : undefined,
    reload: () => retry.current(),
  };
}
