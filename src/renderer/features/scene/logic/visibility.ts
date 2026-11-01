import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

// 对节点实例而非共享几何应用隐藏，避免影响其他装配实例。
export function applySceneVisibility(
  gltf: Pick<GLTF, "scene" | "parser">,
  objects: readonly { gltfNode?: number; deleted?: boolean }[],
) {
  const deletedNodes = new Set(
    objects.filter((object) => object.deleted).map((object) => object.gltfNode),
  );
  gltf.scene.traverse((object) => {
    const index = gltf.parser.associations.get(object)?.nodes;
    if (index !== undefined && deletedNodes.has(index)) object.visible = false;
  });
}
