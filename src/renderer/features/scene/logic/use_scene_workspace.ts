import { useCallback, useEffect, useRef, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type {
  SceneImportFormat,
  SceneOperation,
  SceneSnapshot,
} from "../../../../contracts/scene.ts";
import { errorMessage } from "../../../shared/logic/error_message.ts";

export function useSceneWorkspace(projectId: string, api: ApplicationBridge) {
  const [snapshot, setSnapshot] = useState<SceneSnapshot>();
  const [modelRevision, setModelRevision] = useState(0);
  const [error, setError] = useState("");
  const [exported, setExported] = useState<{ path: string; revision: number }>();
  const [operation, setOperation] = useState<"step" | "other">();
  const pending = useRef(false);
  const revision = snapshot?.document.revision;

  const accept = useCallback((next: SceneSnapshot, replaced = false) => {
    if (replaced) setModelRevision((revision) => Math.max(revision, next.document.revision));
    setSnapshot((previous) =>
      !previous || next.document.revision > previous.document.revision ? next : previous,
    );
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "scene.document" && event.projectId === projectId)
        accept(event.snapshot, event.replaced);
    });
    void api.getScene(projectId).then(
      (value) => {
        if (active) accept(value);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept, api, projectId]);

  async function run<T>(mutate: () => Promise<T>, kind: "step" | "other" = "other") {
    if (pending.current) return;
    pending.current = true;
    setOperation(kind);
    setError("");
    setExported(undefined);
    try {
      return await mutate();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setOperation(undefined);
    }
  }

  async function apply(operation: SceneOperation, expectedRevision = revision) {
    if (expectedRevision === undefined) return false;
    const value = await run(() => api.applyScene({ projectId, expectedRevision, operation }));
    if (value) accept(value);
    return Boolean(value);
  }

  async function importModel(format: SceneImportFormat) {
    if (revision === undefined) return;
    const value = await run(
      () => api.importScene(projectId, revision, format),
      format === "urdf" ? "other" : "step",
    );
    if (value) accept(value, format !== "step-source");
  }

  async function cancelStep() {
    try {
      await api.cancelStep(projectId);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function exportUrdf() {
    if (revision === undefined) return;
    const value = await run(() => api.exportUrdf(projectId, revision));
    if (value) setExported({ path: value.path, revision });
  }

  return {
    snapshot,
    error,
    exportPath: exported?.revision === revision ? exported?.path : undefined,
    modelRevision,
    busy: operation !== undefined,
    stepImporting: operation === "step",
    apply,
    importModel,
    cancelStep,
    exportUrdf,
  };
}
