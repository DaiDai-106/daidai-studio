import {
  Color,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
} from "three";
import { isGeometryMesh } from "./bounds.ts";
import type { DisplayState } from "./types.ts";

interface Surface {
  mesh: Mesh;
  ancestors: string[];
  original: Material | Material[];
  temporary: Material[] | null;
}

// View-only overrides. Original materials can be shared by many CAD instances.
export function createAppearance() {
  let model: Object3D | null = null;
  let surfaces: Surface[] = [];
  const accent = new Color();
  function restore(surface: Surface) {
    surface.mesh.material = surface.original;
    for (const material of surface.temporary ?? []) material.dispose();
    surface.temporary = null;
  }
  function clear() {
    for (const surface of surfaces) restore(surface);
    surfaces = [];
    model = null;
  }
  function update(state: DisplayState, hoveredId: string | null, dark: boolean) {
    if (model !== (state.model ?? null)) {
      clear();
      model = state.model ?? null;
      model?.traverse((object) => {
        if (!isGeometryMesh(object)) return;
        const ancestors: string[] = [];
        for (let node: Object3D | null = object; node; node = node.parent) {
          if (typeof node.userData.objectId === "string") ancestors.push(node.userData.objectId);
        }
        surfaces.push({ mesh: object, ancestors, original: object.material, temporary: null });
      });
    }
    accent.set(dark ? "#8bbbd2" : "#57849f");
    for (const surface of surfaces) {
      const selected = !!state.selectedId && surface.ancestors.includes(state.selectedId);
      const hovered = !!hoveredId && surface.ancestors.includes(hoveredId);
      const owner = surface.ancestors.find((id) => state.transparency?.[id] !== undefined);
      const transparency = owner ? (state.transparency?.[owner] ?? 0) : 0;
      if (!selected && !hovered && !transparency) {
        if (surface.temporary) restore(surface);
        continue;
      }
      const originals = Array.isArray(surface.original) ? surface.original : [surface.original];
      if (!surface.temporary) {
        surface.temporary = originals.map((material) => material.clone());
        surface.mesh.material = Array.isArray(surface.original)
          ? surface.temporary
          : (surface.temporary[0] ?? surface.original);
      }
      for (const [index, material] of surface.temporary.entries()) {
        const original = originals[index];
        if (!original) continue;
        const tint = selected ? 0.42 : hovered ? 0.18 : 0;
        const minimum = selected ? 0.22 : hovered ? 0.1 : 0;
        material.opacity = Math.max(minimum, original.opacity * (1 - transparency));
        const transparent = original.transparent || material.opacity < 1;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        // Transparent surfaces must not obscure the surfaces behind them in the depth buffer.
        material.depthWrite = transparent ? false : original.depthWrite;
        if (
          (material instanceof MeshStandardMaterial && original instanceof MeshStandardMaterial) ||
          (material instanceof MeshBasicMaterial && original instanceof MeshBasicMaterial)
        )
          material.color.copy(original.color).lerp(accent, tint);
        if (material instanceof MeshStandardMaterial && original instanceof MeshStandardMaterial) {
          material.emissive.copy(original.emissive).lerp(accent, tint * 0.6);
          material.emissiveIntensity = tint
            ? Math.max(original.emissiveIntensity, 0.7)
            : original.emissiveIntensity;
        }
      }
    }
  }
  return { update, dispose: clear };
}
