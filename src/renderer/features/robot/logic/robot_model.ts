import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  type Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type { SceneRobot, SceneVisual, SceneVisualOpacities } from "../../../../contracts/scene.ts";
import { robotFrames, setOrigin } from "../../../../shared/scene/frames.ts";
import { subtreeLinkIds } from "../../../../shared/scene/tree.ts";

function primitive(shape: Exclude<SceneVisual["geometry"], { type: "mesh" }>) {
  switch (shape.type) {
    case "box":
      return new BoxGeometry(...shape.size);
    case "sphere":
      return new SphereGeometry(shape.radius, 24, 16);
    case "cylinder":
      return new CylinderGeometry(shape.radius, shape.radius, shape.length, 32).rotateX(
        Math.PI / 2,
      );
  }
}

export function createRobotModel(
  robot: SceneRobot,
  readAsset: (id: string) => Promise<string>,
  onChange: () => void,
  onAssetError: () => void,
) {
  const frames = robotFrames(robot);
  const geometries = new Set<BufferGeometry>();
  const meshVisuals = new Map<
    string,
    { linkId: string; group: Group; visual: SceneVisual; index: number }[]
  >();
  const loader = new STLLoader();
  const visuals: Array<{
    linkId: string;
    mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
    alpha: number;
    index: number;
  }> = [];
  let opacities: SceneVisualOpacities = new Map();
  let disposed = false;
  let selected: string | null = null;
  let selectedLinks = new Set<string>();
  const selectionColor = 0x23476c;

  function attach(
    linkId: string,
    group: Group,
    visual: SceneVisual,
    index: number,
    geometry: BufferGeometry,
  ) {
    const opacity = opacities.get(linkId)?.[index] ?? 1;
    const [r, g, b, alpha] = visual.color ?? [0.64, 0.72, 0.78, 1];
    const material = new MeshStandardMaterial({
      color: new Color(r, g, b),
      opacity: alpha * opacity,
      transparent: alpha * opacity < 1,
      depthWrite: opacity === 1 || alpha * opacity === 1,
      roughness: 0.75,
    });
    if (selectedLinks.has(linkId)) material.emissive.setHex(selectionColor);
    const mesh = new Mesh(geometry, material);
    mesh.userData.linkId = linkId;
    if (visual.geometry.type === "mesh") mesh.scale.fromArray(visual.geometry.scale);
    setOrigin(mesh, visual.origin);
    group.add(mesh);
    visuals.push({ linkId, mesh, alpha, index });
  }

  for (const link of robot.links) {
    const group = frames.links.get(link.id);
    if (!group) continue;
    for (const [index, visual] of link.visuals.entries()) {
      if (visual.geometry.type === "mesh") {
        const asset = visual.geometry.asset;
        const instances = meshVisuals.get(asset) ?? [];
        instances.push({ linkId: link.id, group, visual, index });
        meshVisuals.set(asset, instances);
      } else {
        const geometry = primitive(visual.geometry);
        geometries.add(geometry);
        attach(link.id, group, visual, index, geometry);
      }
    }
  }
  // 大装配只保留少量正在传输的 STL，同一网格的实例共用解析结果。
  const remaining = meshVisuals.entries();
  async function loadMeshes() {
    for (const [asset, instances] of remaining) {
      if (disposed) return;
      try {
        const base64 = await readAsset(asset);
        if (disposed) return;
        const bytes = atob(base64);
        const data = new Uint8Array(bytes.length);
        for (let index = 0; index < bytes.length; index++) data[index] = bytes.charCodeAt(index);
        const geometry = loader.parse(data.buffer);
        if (!geometry.getAttribute("position")?.count) {
          geometry.dispose();
          throw new Error("STL 不包含可显示的几何体。");
        }
        geometries.add(geometry);
        for (const { linkId, group, visual, index } of instances)
          attach(linkId, group, visual, index, geometry);
        onChange();
      } catch {
        if (!disposed) onAssetError();
      }
    }
  }
  return {
    root: frames.root,
    pose: frames.pose,
    ready: Promise.all(Array.from({ length: Math.min(4, meshVisuals.size) }, loadMeshes)),
    setOpacity(value: SceneVisualOpacities) {
      opacities = value;
      for (const { linkId, mesh, alpha, index } of visuals) {
        const opacity = opacities.get(linkId)?.[index] ?? 1;
        const material = mesh.material;
        material.opacity = alpha * opacity;
        const transparent = material.opacity < 1;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        material.depthWrite = opacity === 1 || !transparent;
      }
    },
    select(id: string | null) {
      if (selected === id) return;
      selected = id;
      selectedLinks = subtreeLinkIds(robot, id ? [id] : []);
      for (const { linkId, mesh } of visuals)
        mesh.material.emissive.setHex(selectedLinks.has(linkId) ? selectionColor : 0);
    },
    dispose() {
      disposed = true;
      for (const geometry of geometries) geometry.dispose();
      for (const { mesh } of visuals) mesh.material.dispose();
      frames.root.removeFromParent();
    },
  };
}
