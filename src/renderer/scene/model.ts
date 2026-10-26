import {
  type BufferGeometry,
  Group,
  type Material,
  Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Value } from "typebox/value";
import { CadManifestSchema } from "../../../resources/mcp/cad/contract.ts";
import type { DisplayResource, ImportedModel } from "../../shared/display.ts";
import type { LoadedModel } from "./types.ts";

async function fetchResource(resource: DisplayResource, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(resource.url, { signal });
  } catch {
    signal.throwIfAborted();
    throw new Error("无法读取已保存的显示资源，请重新加载。");
  }
  if (!response.ok) throw new Error("无法读取已保存的显示资源。");
  const data = await response.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  if (data.byteLength !== resource.byteLength || hex !== resource.sha256)
    throw new Error("显示资源校验失败，请重新生成显示资源。");
  return data;
}

function modelDisposer(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      materials.add(material);
  });
  // Capture originals before the viewport applies temporary material overrides.
  return () => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    geometries.clear();
    materials.clear();
    root.removeFromParent();
  };
}

// Load the CAD output directly; its hierarchy, instances and materials remain authoritative.
export async function loadDisplay(model: ImportedModel, signal: AbortSignal): Promise<LoadedModel> {
  const manifest: unknown = JSON.parse(
    new TextDecoder().decode(await fetchResource(model.manifest, signal)),
  );
  if (
    !Value.Check(CadManifestSchema, manifest) ||
    manifest.source.sourceHash !== model.sourceHash ||
    manifest.source.importFingerprint !== model.importFingerprint ||
    (!manifest.complete && manifest.omittedFaceCount === undefined)
  )
    throw new Error("保存的显示清单无效。");
  const descriptor = model.resources.find((resource) => resource.mediaType === "model/gltf-binary");
  if (!descriptor) throw new Error("显示清单缺少 GLB 模型。");
  const data = await fetchResource(descriptor, signal);
  signal.throwIfAborted();
  const gltf = await new GLTFLoader().parseAsync(data, "");
  const root = new Group();
  root.add(gltf.scene);
  const dispose = modelDisposer(root);
  try {
    signal.throwIfAborted();
    const transform = manifest.displayToScene;
    root.position.fromArray(transform.translation);
    root.quaternion.copy(new Quaternion().fromArray(transform.rotation));
    root.scale.copy(new Vector3().fromArray(transform.scale));
    const objects = new Set(manifest.objects.map((object) => object.objectId));
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      let owner: Object3D | null = object;
      while (owner && typeof owner.userData.objectId !== "string") owner = owner.parent;
      const id = owner?.userData.objectId;
      const association = gltf.parser.associations.get(object);
      if (typeof id !== "string" || !objects.has(id))
        throw new Error("网格没有有效的 CAD 对象映射。");
      object.userData.sceneObjectId = id;
      if (association?.meshes !== undefined && association.primitives !== undefined)
        object.userData.cadPrimitive = {
          meshIndex: association.meshes,
          primitiveIndex: association.primitives,
        };
    });
    root.updateMatrixWorld(true);
    return { importId: model.importId, root, manifest, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
