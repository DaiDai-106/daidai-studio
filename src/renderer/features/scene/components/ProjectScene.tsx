import { useEffect, useRef, useState } from "react";
import { Group, Mesh, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { SceneView } from "../../../../contracts/application.ts";
import { IconButton } from "../../../shared/components/Icon.tsx";
import type { ViewportHandle } from "../logic/types.ts";
import { applySceneVisibility } from "../logic/visibility.ts";
import { SceneJoints } from "./SceneJoints.tsx";
import { ScenePythonSetup } from "./ScenePythonSetup.tsx";
import { SceneViewport } from "./SceneViewport.tsx";

// 场景的 GLB 资源来自受控协议，显示前验证内容与持久化清单一致。
async function loadScene(scene: SceneView, signal: AbortSignal): Promise<Group> {
  const root = new Group();
  try {
    for (const model of scene.models) {
      const response = await fetch(model.resource.url, { signal });
      if (!response.ok) throw new Error("无法读取场景显示资源。");
      const data = await response.arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", data);
      const hex = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (data.byteLength !== model.resource.byteLength || hex !== model.resource.sha256)
        throw new Error("场景显示资源校验失败。");
      signal.throwIfAborted();
      const gltf = await new GLTFLoader().parseAsync(data, "");
      applySceneVisibility(gltf, model.objects);
      const transforms = new Map(
        model.objects
          .filter((item) => item.gltfNode !== undefined && item.transform)
          .map((item) => [item.gltfNode, item.transform]),
      );
      gltf.scene.traverse((object) => {
        const index = gltf.parser.associations.get(object)?.nodes;
        const transform = index === undefined ? undefined : transforms.get(index);
        if (transform) {
          object.position.fromArray(transform.position);
          object.quaternion.fromArray(transform.rotation);
        }
      });
      const nodes = new Map(
        model.objects
          .filter((item) => !item.deleted && item.gltfNode !== undefined)
          .map((item) => [item.gltfNode, `${model.id}:${item.id}`]),
      );
      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        for (let owner: Object3D | null = object; owner; owner = owner.parent) {
          const index = gltf.parser.associations.get(owner)?.nodes;
          const id = index === undefined ? undefined : nodes.get(index);
          if (id) {
            object.userData.sceneObjectId = id;
            break;
          }
        }
      });
      // STEP 使用 Z-up，GLB 为符合 glTF 标准转换成 Y-up；显示时恢复 Z-up。
      const zUp = new Group();
      zUp.rotation.x = Math.PI / 2;
      zUp.add(gltf.scene);
      root.add(zUp);
      signal.throwIfAborted();
    }
    return root;
  } catch (error) {
    disposeScene(root);
    throw error;
  }
}

function disposeScene(root: Object3D) {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      material.dispose();
  });
  root.removeFromParent();
}

export function ProjectScene({
  scene,
  error,
  busy,
  importing,
  cancelling,
  onImport,
  onCancelImport,
  onRetry,
  onRelocateSource,
  onTransform,
  onDelete,
  onConfirmJoint,
  onRemoveJoint,
}: {
  scene: SceneView | null;
  error: string;
  busy: boolean;
  importing: boolean;
  cancelling: boolean;
  onImport: (operation: "append" | "replace") => void;
  onCancelImport: () => void;
  onRetry: () => void;
  onRelocateSource: (modelId: string) => void;
  onTransform: (
    modelId: string,
    objectId: string,
    transform: { position: [number, number, number]; rotation: [number, number, number, number] },
  ) => void;
  onDelete: (modelId: string, objectId: string) => void;
  onConfirmJoint: (candidateId: string) => void;
  onRemoveJoint: (candidateId: string, confirmed: boolean) => void;
}) {
  const viewport = useRef<ViewportHandle>(null);
  const [model, setModel] = useState<Group | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const selectedObject = scene?.models
    .flatMap((item) =>
      item.objects.filter((object) => !object.deleted).map((object) => ({ model: item, object })),
    )
    .find(({ model: item, object }) => selected === `${item.id}:${object.id}`);

  useEffect(() => {
    if (!scene) return;
    const controller = new AbortController();
    let loaded: Group | null = null;
    setModel(null);
    setLoadError("");
    void loadScene(scene, controller.signal)
      .then((root) => {
        if (controller.signal.aborted) disposeScene(root);
        else {
          loaded = root;
          setModel(root);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(cause instanceof Error ? cause.message : "场景加载失败。");
      });
    return () => {
      controller.abort();
      if (loaded) disposeScene(loaded);
    };
  }, [scene]);

  return (
    <section className="scene-panel" aria-label="场景工作区">
      <header className="scene-heading">
        <span>场景视图</span>
        <span className="muted">世界坐标 · Z ↑ · 米</span>
      </header>
      <ScenePythonSetup />
      {scene && (
        <SceneJoints
          scene={scene}
          busy={busy}
          onConfirm={onConfirmJoint}
          onRemove={onRemoveJoint}
        />
      )}
      <div className="scene-toolbar">
        <IconButton icon="fit" label="适应视图" onClick={() => viewport.current?.fit()} />
        <button
          type="button"
          onClick={() => onImport(scene?.models.length ? "append" : "replace")}
          disabled={!scene || busy}
        >
          添加 STEP
        </button>
        {scene && scene.models.length > 0 && (
          <button type="button" disabled={busy} onClick={() => onImport("replace")}>
            替换场景
          </button>
        )}
        {importing && (
          <button type="button" disabled={cancelling} onClick={onCancelImport}>
            {cancelling ? "正在取消…" : "取消导入"}
          </button>
        )}
      </div>
      {(error || loadError) && (
        <div role="alert">
          <p>{error || loadError}</p>
          <button type="button" onClick={onRetry}>
            重试加载场景
          </button>
        </div>
      )}
      <div
        className="scene-stage"
        data-scene-loaded={scene && model && scene.models.length ? "true" : "false"}
      >
        <SceneViewport
          ref={viewport}
          showGrid
          showAxes
          model={model}
          selectedId={selected}
          onPick={setSelected}
        />
        {scene && scene.models.length > 0 && (
          <aside className="scene-object-panel project-scene-objects" aria-label="对象列表">
            {scene.models.map((item) => (
              <div key={item.id}>
                <strong title={item.sourcePath}>{item.sourcePath.split(/[\\/]/u).pop()}</strong>
                {item.sourceStatus === "changed" && <p>源 STEP 已变化，当前显示上次保存的场景。</p>}
                {item.sourceStatus === "missing" && <p>源 STEP 不可用，当前显示上次保存的场景。</p>}
                {item.sourceStatus === "unknown" && (
                  <p>无法检查源 STEP，当前显示上次保存的场景。</p>
                )}
                {item.sourceStatus !== "available" && (
                  <button type="button" disabled={busy} onClick={() => onRelocateSource(item.id)}>
                    重新定位源 STEP
                  </button>
                )}
                {!item.complete && <p>场景解析存在限制，请查看提示</p>}
                {item.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
                {item.objects
                  .filter((object) => !object.deleted)
                  .map((object) => (
                    <button
                      key={object.id}
                      type="button"
                      className="text-button"
                      aria-pressed={selected === `${item.id}:${object.id}`}
                      onClick={() => setSelected(`${item.id}:${object.id}`)}
                    >
                      {object.name || "未命名对象"}
                    </button>
                  ))}
              </div>
            ))}
            {selectedObject &&
              (selectedObject.object.transform || selectedObject.object.baseTransform) && (
                <TransformEditor
                  key={`${selectedObject.model.id}:${selectedObject.object.id}:${scene.revision}`}
                  initial={
                    selectedObject.object.transform ??
                    selectedObject.object.baseTransform ?? {
                      position: [0, 0, 0],
                      rotation: [0, 0, 0, 1],
                    }
                  }
                  busy={busy}
                  onSave={(transform) =>
                    onTransform(selectedObject.model.id, selectedObject.object.id, transform)
                  }
                />
              )}
            {selectedObject && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(selectedObject.model.id, selectedObject.object.id)}
              >
                删除所选对象
              </button>
            )}
          </aside>
        )}
        {!scene && !error && (
          <div className="scene-loading" role="status">
            正在加载项目场景…
          </div>
        )}
        {scene && !scene.models.length && (
          <div className="scene-empty-hint">
            <h2>场景从这里开始</h2>
            <p>选择 STEP 文件后即可开始搭建。</p>
          </div>
        )}
      </div>
    </section>
  );
}

function TransformEditor({
  initial,
  busy,
  onSave,
}: {
  initial: { position: [number, number, number]; rotation: [number, number, number, number] };
  busy: boolean;
  onSave: (value: {
    position: [number, number, number];
    rotation: [number, number, number, number];
  }) => void;
}) {
  const [position, setPosition] = useState(initial.position);
  const [rotation, setRotation] = useState(initial.rotation);
  const magnitude = Math.hypot(...rotation);
  return (
    <form
      className="scene-object-properties project-transform"
      onSubmit={(event) => {
        event.preventDefault();
        if (!Number.isFinite(magnitude) || magnitude < 1e-8) return;
        onSave({
          position,
          rotation: rotation.map((value) => value / magnitude) as [number, number, number, number],
        });
      }}
    >
      <strong>局部变换</strong>
      <p>位置（米）</p>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis}>
          {axis}
          <input
            type="number"
            step="any"
            value={position[index]}
            onChange={(event) =>
              setPosition(
                (previous) =>
                  previous.map((value, i) =>
                    i === index ? event.target.valueAsNumber : value,
                  ) as [number, number, number],
              )
            }
          />
        </label>
      ))}
      <p>旋转（四元数）</p>
      {(["X", "Y", "Z", "W"] as const).map((axis, index) => (
        <label key={axis}>
          {axis}
          <input
            type="number"
            step="any"
            value={rotation[index]}
            onChange={(event) =>
              setRotation(
                (previous) =>
                  previous.map((value, i) =>
                    i === index ? event.target.valueAsNumber : value,
                  ) as [number, number, number, number],
              )
            }
          />
        </label>
      ))}
      <button
        type="submit"
        disabled={
          busy ||
          !position.every(Number.isFinite) ||
          !rotation.every(Number.isFinite) ||
          magnitude < 1e-8
        }
      >
        保存变换
      </button>
    </form>
  );
}
