import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createAppearance } from "./appearance.ts";
import { isGeometryMesh, visibleGeometryBounds } from "./bounds.ts";
import { updateCameraClipping } from "./camera.ts";
import { captureTransition } from "./placementComparison.ts";
import type { CameraView, DisplayState } from "./types.ts";

const directions: Record<CameraView, [number, number, number]> = {
  isometric: [1, -1, 0.8],
  front: [1, 0, 0],
  right: [0, -1, 0],
  top: [0, 0, 1],
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0],
  "+Y": [0, 1, 0],
  "-Y": [0, -1, 0],
  "+Z": [0, 0, 1],
  "-Z": [0, 0, -1],
};

export function createViewport(host: HTMLDivElement, onPick: (id: string | null) => void) {
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
    const position = new THREE.Vector3().fromArray(state.placement?.translation ?? [0, 0, 0]);
    const rotation = new THREE.Quaternion().fromArray(state.placement?.rotation ?? [0, 0, 0, 1]);
    if (!group.position.equals(position) || !group.quaternion.equals(rotation)) {
      group.position.copy(position);
      group.quaternion.copy(rotation);
      fitted = false;
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
    // 每帧最多执行一次网格射线检测；旋转视角时不进行检测。
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
    const id = hit?.object.userData.sceneObjectId;
    onPick(typeof id === "string" ? id : null);
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
    updateWithComparison(next: DisplayState) {
      const frozen = camera.clone();

      function captureImage(snapshot: THREE.PerspectiveCamera) {
        if (
          !model ||
          document.hidden ||
          !canvas.clientWidth ||
          !canvas.clientHeight ||
          disposed ||
          renderer.getContext().isContextLost()
        )
          return null;
        renderer.render(scene, snapshot);
        const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
        return data && data.length <= 7_000_000 ? `data:image/jpeg;base64,${data}` : null;
      }
      try {
        return captureTransition(frozen, captureImage, () => update(next));
      } finally {
        requestRender();
      }
    },
    requestRender,
    capture(view: import("../../../../contracts/application.ts").CaptureView) {
      if (!model || document.hidden || !canvas.clientWidth || !canvas.clientHeight || disposed)
        return null;
      let captureCamera: THREE.Camera = camera;
      let position = camera.position;
      let up = camera.up;
      let target = controls.target;
      const cameraFor = (
        selected: Exclude<typeof view, "current" | "overview">,
        aspect = canvas.clientWidth / canvas.clientHeight,
        fitBox = false,
      ) => {
        const directions: Record<
          Exclude<typeof view, "current" | "overview">,
          [number, number, number]
        > = {
          isometric: [1, -1, 0.8],
          "+X": [1, 0, 0],
          "-X": [-1, 0, 0],
          "+Y": [0, 1, 0],
          "-Y": [0, -1, 0],
          "+Z": [0, 0, 1],
          "-Z": [0, 0, -1],
        };
        const box = visibleGeometryBounds(group);
        if (box.isEmpty()) return null;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 0.1);
        const height = radius * 1.2 * Math.max(1, 1 / aspect);
        const orthographic = new THREE.OrthographicCamera(
          -height * aspect,
          height * aspect,
          height,
          -height,
          0.01,
          radius * 10 + 1,
        );
        const target = sphere.center;
        if (selected === "+Z" || selected === "-Z") orthographic.up.set(0, 1, 0);
        else orthographic.up.set(0, 0, 1);
        orthographic.position
          .copy(target)
          .addScaledVector(
            new THREE.Vector3(...directions[selected]).normalize(),
            radius * 3 + 0.1,
          );
        orthographic.lookAt(target);
        orthographic.updateMatrixWorld();
        if (fitBox) {
          let horizontal = 0,
            vertical = 0;
          for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
              for (const z of [box.min.z, box.max.z]) {
                const point = new THREE.Vector3(x, y, z).applyMatrix4(
                  orthographic.matrixWorldInverse,
                );
                horizontal = Math.max(horizontal, Math.abs(point.x));
                vertical = Math.max(vertical, Math.abs(point.y));
              }
          const halfHeight = Math.max(vertical, horizontal / aspect, 0.1) * 1.1;
          orthographic.left = -halfHeight * aspect;
          orthographic.right = halfHeight * aspect;
          orthographic.top = halfHeight;
          orthographic.bottom = -halfHeight;
          orthographic.updateProjectionMatrix();
        }
        return { camera: orthographic, target };
      };
      if (view === "overview") {
        const views = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] as const;
        const sheet = document.createElement("canvas");
        const width = 600,
          height = 450,
          labelHeight = 28;
        sheet.width = width * 3;
        sheet.height = height * 2;
        const context = sheet.getContext("2d");
        if (!context) return null;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, sheet.width, sheet.height);
        context.fillStyle = "#222222";
        context.font = "bold 18px sans-serif";
        const imageRight = {
          "+X": "+Y",
          "-X": "-Y",
          "+Y": "-X",
          "-Y": "+X",
          "+Z": "+X",
          "-Z": "-X",
        } as const;
        const cameras: {
          view: (typeof views)[number];
          camera: {
            position: number[];
            target: number[];
            up: number[];
            projection: "orthographic";
          };
        }[] = [];
        const originalSize = renderer.getSize(new THREE.Vector2());
        const originalRatio = renderer.getPixelRatio();
        try {
          renderer.setPixelRatio(1);
          renderer.setSize(width, height - labelHeight, false);
          for (const [index, selected] of views.entries()) {
            const result = cameraFor(selected, width / (height - labelHeight), true);
            if (!result) return null;
            renderer.render(scene, result.camera);
            const x = (index % 3) * width,
              y = Math.floor(index / 3) * height;
            context.drawImage(canvas, x, y + labelHeight, width, height - labelHeight);
            const imageUp = selected === "+Z" || selected === "-Z" ? "+Y" : "+Z";
            context.fillText(
              `From ${selected}  |  Right ${imageRight[selected]}  |  Up ${imageUp}`,
              x + 12,
              y + 21,
            );
            cameras.push({
              view: selected,
              camera: {
                position: result.camera.position.toArray(),
                target: result.target.toArray(),
                up: result.camera.up.toArray(),
                projection: "orthographic",
              },
            });
          }
        } finally {
          renderer.setPixelRatio(originalRatio);
          renderer.setSize(originalSize.x, originalSize.y, false);
          requestRender();
        }
        const data = sheet.toDataURL("image/jpeg", 0.85).split(",")[1];
        const first = cameras[0];
        if (!first || !data || data.length > 7_000_000) return null;
        return {
          image: { mimeType: "image/jpeg" as const, data },
          camera: first.camera,
          views: cameras,
        };
      }
      if (view !== "current") {
        const result = cameraFor(view);
        if (!result) return null;
        captureCamera = result.camera;
        position = result.camera.position;
        up = result.camera.up;
        target = result.target;
      }
      renderer.render(scene, captureCamera);
      const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
      if (view !== "current") requestRender();
      if (!data || data.length > 7_000_000) return null;
      return {
        image: { mimeType: "image/jpeg" as const, data },
        camera: {
          position: position.toArray(),
          target: target.toArray(),
          up: up.toArray(),
          projection: view === "current" ? ("perspective" as const) : ("orthographic" as const),
        },
      };
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
      // 几何资源由模型加载器管理，视口只管理网格和坐标轴。
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
