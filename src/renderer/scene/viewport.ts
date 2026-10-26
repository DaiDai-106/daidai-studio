import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createAppearance } from "./appearance.ts";
import { isGeometryMesh, visibleGeometryBounds } from "./bounds.ts";
import { updateCameraClipping } from "./camera.ts";
import type { CameraView, DisplayState } from "./types.ts";

const directions: Record<CameraView, [number, number, number]> = {
  isometric: [1, -1, 0.8],
  front: [1, 0, 0],
  right: [0, -1, 0],
  top: [0, 0, 1],
};

export function createViewport(
  host: HTMLDivElement,
  onPick: (id: string | null, face?: import("./types.ts").MeshPick) => void,
) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  const canvas = renderer.domElement;
  canvas.className = "scene-canvas";
  canvas.setAttribute("aria-label", "三维场景视图");
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.up.set(0, 0, 1);
  camera.position.set(4, -4, 3.2);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = 0.1;
  controls.maxDistance = 100;
  const group = new THREE.Group();
  const appearance = createAppearance();
  let state: DisplayState = { showGrid: true, showAxes: true };
  let hoveredId: string | null = null;
  let hoverPoint: { x: number; y: number } | null = null;
  let dark = false;
  let model: THREE.Object3D | null = null;
  const grid = new THREE.GridHelper(12, 24);
  grid.rotation.x = Math.PI / 2;
  const axes = new THREE.AxesHelper(1.5);
  axes.setColors(0xb85852, 0x4b8b64, 0x547fb8);
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.position.set(3, -4, 6);
  scene.add(group, grid, axes, key, new THREE.HemisphereLight(0xffffff, 0x62666b, 2));
  let frame = 0;
  let disposed = false;
  let fitted = false;
  let radius = 2;
  const clipBounds = new THREE.Sphere(new THREE.Vector3(), 10);

  function requestRender() {
    if (!disposed && !frame && !document.hidden && canvas.clientWidth && canvas.clientHeight)
      frame = requestAnimationFrame(render);
  }
  function render() {
    frame = 0;
    const moving = controls.update();
    if (hoverPoint) {
      const point = hoverPoint;
      hoverPoint = null;
      setHovered(hitAt(point.x, point.y)?.object.userData.sceneObjectId ?? null);
    }
    renderer.render(scene, camera);
    if (moving) requestRender();
  }
  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!fitted && model) {
      fit();
      fitted = true;
    }
    requestRender();
  }
  function setPalette() {
    const style = getComputedStyle(canvas);
    scene.background = new THREE.Color(style.getPropertyValue("--subtle").trim());
    const material = grid.material as THREE.LineBasicMaterial;
    material.color.set(style.getPropertyValue("--muted").trim());
    material.transparent = true;
    material.opacity = 0.18;
    dark = document.documentElement.dataset.theme === "dark";
    appearance.update(state, hoveredId, dark);
    requestRender();
  }
  function updateClip() {
    updateCameraClipping(camera, clipBounds);
    requestRender();
  }
  function updateClipBounds() {
    const box = visibleGeometryBounds(group);
    for (const object of [grid, axes]) {
      if (object.visible) {
        object.updateWorldMatrix(true, true);
        box.expandByObject(object);
      }
    }
    if (box.isEmpty()) clipBounds.set(controls.target, 1);
    else box.getBoundingSphere(clipBounds);
    updateClip();
  }
  function fit() {
    const box = visibleGeometryBounds(group);
    const sphere = box.isEmpty()
      ? new THREE.Sphere(new THREE.Vector3(), 2)
      : box.getBoundingSphere(new THREE.Sphere());
    radius = Math.max(sphere.radius, 0.1);
    const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.15;
    const direction = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    controls.minDistance = radius * 0.05;
    controls.maxDistance = Math.max(100, distance * 10);
    controls.update();
    updateClip();
  }
  function setView(view: CameraView) {
    const distance = camera.position.distanceTo(controls.target);
    const direction = new THREE.Vector3(...directions[view]).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    camera.lookAt(controls.target);
    controls.update();
    requestRender();
  }
  function update(next: DisplayState) {
    state = next;
    if (model !== (next.model ?? null)) {
      if (model) group.remove(model);
      model = next.model ?? null;
      if (model) group.add(model);
      fitted = false;
      hoveredId = null;
      hoverPoint = null;
      canvas.style.cursor = "";
    }
    appearance.update(state, hoveredId, dark);
    grid.visible = state.showGrid;
    axes.visible = state.showAxes;
    updateClipBounds();
    if (!fitted && model && canvas.clientWidth && canvas.clientHeight) {
      fit();
      fitted = true;
    }
    requestRender();
  }
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let press: { x: number; y: number; id: number } | null = null;
  function setHovered(id: string | null) {
    if (hoveredId === id) return;
    hoveredId = id;
    appearance.update(state, hoveredId, dark);
    canvas.style.cursor = id ? "pointer" : "";
    requestRender();
  }
  function clearHover() {
    hoverPoint = null;
    setHovered(null);
  }
  function hitAt(x: number, y: number) {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    pointer.set(
      ((x - bounds.left) / bounds.width) * 2 - 1,
      -((y - bounds.top) / bounds.height) * 2 + 1,
    );
    camera.updateMatrixWorld();
    group.updateWorldMatrix(true, true);
    raycaster.setFromCamera(pointer, camera);
    const visible: THREE.Object3D[] = [];
    group.traverseVisible((object) => {
      if (!isGeometryMesh(object) || object.userData.pickable === false) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((material) => material.visible && material.opacity > 0))
        visible.push(object);
    });
    return raycaster.intersectObjects(visible, false)[0];
  }
  function onDown(event: PointerEvent) {
    clearHover();
    press = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  }
  function onMove(event: PointerEvent) {
    if (event.buttons) {
      clearHover();
      return;
    }
    // At most one mesh raycast per animation frame; never raycast during orbit dragging.
    hoverPoint = { x: event.clientX, y: event.clientY };
    requestRender();
  }
  function onCancel() {
    press = null;
    clearHover();
  }
  function onUp(event: PointerEvent) {
    const start = press;
    press = null;
    if (
      !start ||
      event.pointerId !== start.id ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
    )
      return;
    const hit = hitAt(event.clientX, event.clientY);
    const association = hit?.object.userData.cadPrimitive;
    const face =
      association && hit?.faceIndex != null
        ? { ...association, triangleIndex: hit.faceIndex }
        : undefined;
    const id = hit?.object.userData.sceneObjectId;
    onPick(typeof id === "string" ? id : null, face);
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", clearHover);
  canvas.addEventListener("pointercancel", onCancel);
  controls.addEventListener("start", clearHover);
  controls.addEventListener("change", updateClip);
  document.addEventListener("visibilitychange", requestRender);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  const palette = new MutationObserver(setPalette);
  palette.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  setPalette();
  resize();

  return {
    canvas,
    fit,
    setView,
    update,
    invalidate: updateClipBounds,
    requestRender,
    zoom(factor: number) {
      const offset = camera.position.clone().sub(controls.target);
      const distance = THREE.MathUtils.clamp(
        offset.length() / factor,
        controls.minDistance,
        controls.maxDistance,
      );
      camera.position.copy(controls.target).add(offset.setLength(distance));
      controls.update();
      updateClip();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      palette.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", clearHover);
      canvas.removeEventListener("pointercancel", onCancel);
      controls.removeEventListener("start", clearHover);
      document.removeEventListener("visibilitychange", requestRender);
      controls.removeEventListener("change", updateClip);
      controls.dispose();
      appearance.dispose();
      // The model loader owns geometry; the viewport owns its grid and axes.
      if (model) group.remove(model);
      model = null;
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
