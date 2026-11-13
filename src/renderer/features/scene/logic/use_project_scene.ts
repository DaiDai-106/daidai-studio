import { useEffect, useRef, useState } from "react";
import type { SceneTransform, SceneView } from "../../../../contracts/application.ts";

type ProjectOperation = {
  kind: "import" | "mutation";
  cancelling: boolean;
  cancelRequested: boolean;
};
type OperationView = Pick<ProjectOperation, "kind" | "cancelling">;

// 场景只在选中项目后加载；各项目的导入和变更互不阻塞。
export function useProjectScene(projectId: string) {
  const [state, setState] = useState<{ projectId: string; scene: SceneView | null; error: string }>(
    {
      projectId: "",
      scene: null,
      error: "",
    },
  );
  const [operations, setOperations] = useState<Record<string, OperationView>>({});
  const activeOperations = useRef(new Map<string, ProjectOperation>());
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    let sequence = 0;
    setState({ projectId, scene: null, error: "" });
    const api = window.desktop.application;
    const refresh = (force = false) => {
      const request = ++sequence;
      void api
        .getProjectScene(projectId)
        .then((scene) => {
          if (!active || request !== sequence) return;
          setState((previous) => {
            if (previous.projectId !== projectId) return previous;
            if (
              !previous.scene ||
              scene.revision > previous.scene.revision ||
              (force && scene.revision === previous.scene.revision)
            )
              return { projectId, scene, error: "" };
            return previous.error ? { ...previous, error: "" } : previous;
          });
        })
        .catch((error: unknown) => {
          if (active && request === sequence)
            setState((previous) =>
              previous.projectId === projectId
                ? { ...previous, error: error instanceof Error ? error.message : "场景加载失败。" }
                : previous,
            );
        });
    };
    retryRef.current = () => refresh(true);
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "scene.changed" && event.projectId === projectId) refresh();
    });
    refresh();
    return () => {
      active = false;
      retryRef.current = () => {};
      unsubscribe();
    };
  }, [projectId]);

  const current = state.projectId === projectId ? state : { projectId, scene: null, error: "" };
  const operation = operations[projectId];
  const busy = !!operation;

  // 用对象身份判断完成回调，避免较早操作的 finally 清掉后续操作的状态。
  function publish(id: string, value: ProjectOperation) {
    setOperations((previous) => ({
      ...previous,
      [id]: { kind: value.kind, cancelling: value.cancelling },
    }));
  }

  function begin(id: string, kind: ProjectOperation["kind"]) {
    if (!id || activeOperations.current.has(id)) return null;
    const value: ProjectOperation = { kind, cancelling: false, cancelRequested: false };
    activeOperations.current.set(id, value);
    publish(id, value);
    return value;
  }

  function finish(id: string, value: ProjectOperation) {
    if (activeOperations.current.get(id) !== value) return;
    activeOperations.current.delete(id);
    setOperations((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }

  function applyScene(id: string, scene: SceneView) {
    setState((previous) =>
      previous.projectId === id && (!previous.scene || scene.revision > previous.scene.revision)
        ? { projectId: id, scene, error: "" }
        : previous,
    );
  }

  function report(id: string, error: unknown, fallback: string) {
    setState((previous) =>
      previous.projectId === id
        ? { ...previous, error: error instanceof Error ? error.message : fallback }
        : previous,
    );
  }

  async function mutate(action: (revision: number) => Promise<SceneView>, fallback: string) {
    if (!current.scene) return;
    const token = begin(projectId, "mutation");
    if (!token) return;
    try {
      applyScene(projectId, await action(current.scene.revision));
    } catch (error) {
      report(projectId, error, fallback);
    } finally {
      finish(projectId, token);
    }
  }

  async function importStep(mode: "replace" | "append", file?: File, confirmed = false) {
    if (!current.scene || busy) return;
    if (
      !confirmed &&
      mode === "replace" &&
      current.scene.models.length &&
      !window.confirm("替换当前场景？已保存的场景将被新模型替换。")
    )
      return;
    const token = begin(projectId, "import");
    if (!token) return;
    try {
      const input = { projectId, operation: mode, revision: current.scene.revision };
      const scene = file
        ? await window.desktop.application.importDroppedStep(file, input)
        : await window.desktop.application.importStep(input);
      if (scene) applyScene(projectId, scene);
    } catch (error) {
      if (!token.cancelRequested) report(projectId, error, "STEP 导入失败。");
    } finally {
      finish(projectId, token);
    }
  }

  async function cancelImport() {
    const token = activeOperations.current.get(projectId);
    if (token?.kind !== "import" || token.cancelling) return;
    token.cancelRequested = true;
    token.cancelling = true;
    publish(projectId, token);
    try {
      await window.desktop.application.cancelSceneImport(projectId);
    } catch (error) {
      if (activeOperations.current.get(projectId) === token) {
        token.cancelRequested = false;
        report(projectId, error, "取消导入失败。");
      }
    } finally {
      if (activeOperations.current.get(projectId) === token) {
        token.cancelling = false;
        publish(projectId, token);
      }
    }
  }

  async function relocateSource(modelId: string) {
    if (!current.scene) return;
    const token = begin(projectId, "mutation");
    if (!token) return;
    try {
      const scene = await window.desktop.application.relocateSceneSource({
        projectId,
        modelId,
        revision: current.scene.revision,
      });
      if (scene) applyScene(projectId, scene);
    } catch (error) {
      report(projectId, error, "源文件重定位失败。");
    } finally {
      finish(projectId, token);
    }
  }

  async function setTransform(modelId: string, objectId: string, transform: SceneTransform) {
    await mutate(
      (revision) =>
        window.desktop.application.setSceneTransform({
          projectId,
          modelId,
          objectId,
          revision,
          transform,
        }),
      "对象变换保存失败。",
    );
  }

  async function deleteObject(modelId: string, objectId: string) {
    if (
      !current.scene ||
      busy ||
      !window.confirm(
        "删除所选对象将隐藏其所有子对象，当前无法撤销。STEP 源文件不会改变。是否继续？",
      )
    )
      return;
    await mutate(
      (revision) =>
        window.desktop.application.deleteSceneObject({ projectId, modelId, objectId, revision }),
      "删除对象失败。",
    );
  }

  async function confirmJoint(candidateId: string) {
    if (!current.scene || busy || !window.confirm("确认这个关节候选？轴向仍需核验，限位未知。"))
      return;
    await mutate(
      (revision) =>
        window.desktop.application.confirmSceneJoint({ projectId, candidateId, revision }),
      "确认关节失败。",
    );
  }

  async function removeJoint(candidateId: string, confirmed: boolean) {
    const prompt = confirmed
      ? "移除此已确认关节？此操作无法撤销，不会修改 STEP 源文件。"
      : "放弃这个关节草稿？已确认关节和 STEP 源文件不会改变。";
    if (!current.scene || busy || !window.confirm(prompt)) return;
    await mutate((revision) => {
      const input = { projectId, candidateId, revision };
      return confirmed
        ? window.desktop.application.removeConfirmedSceneJoint(input)
        : window.desktop.application.discardSceneJointDraft(input);
    }, "移除关节失败。");
  }
  return {
    ...current,
    busy,
    importing: operation?.kind === "import",
    cancelling: operation?.cancelling ?? false,
    retry: () => retryRef.current(),
    importStep,
    cancelImport,
    relocateSource,
    setTransform,
    deleteObject,
    confirmJoint,
    removeJoint,
  };
}
