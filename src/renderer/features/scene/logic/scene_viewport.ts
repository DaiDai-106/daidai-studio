import {
  AmbientLight,
  AxesHelper,
  Box3,
  DirectionalLight,
  GridHelper,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { SceneJointPreview, SceneRobot } from "../../../../contracts/scene.ts";
import { createRobotModel } from "./robot_model.ts";

const axisLength = 1;
const worldAxes = [
  { name: "X", color: "#b74d48", direction: [1, 0, 0] },
  { name: "Y", color: "#2d7656", direction: [0, 1, 0] },
  { name: "Z", color: "#346fb7", direction: [0, 0, 1] },
] as const;

export type ViewportIssue = { message: string; blocked: boolean };

export function createSceneViewport(
  host: HTMLElement,
  readAsset: (id: string) => Promise<string>,
  onSelect: (id: string) => void,
  onIssue: (issue?: ViewportIssue) => void,
) {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  const { domElement: canvas } = renderer;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new Scene();
  const grid = new GridHelper(20, 20, 0x7e8389, 0x7e8389);
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true;
  grid.material.depthWrite = false;
  grid.material.opacity = 0.42;
  scene.add(grid, new AmbientLight(0xffffff, 1.6));

  const axes = new AxesHelper(axisLength).setColors(
    worldAxes[0].color,
    worldAxes[1].color,
    worldAxes[2].color,
  );
  const axisMaterials = [axes.material].flat();
  for (const material of axisMaterials) {
    material.depthTest = false;
    material.depthWrite = false;
    material.transparent = true;
  }
  axes.renderOrder = 1;
  scene.add(axes);
  const labels = new CSS2DRenderer();
  labels.domElement.className = "scene-axis-labels";
  labels.domElement.setAttribute("aria-hidden", "true");
  for (const { name, color, direction } of worldAxes) {
    const span = document.createElement("span");
    span.className = "scene-axis-label";
    span.textContent = name;
    span.style.backgroundColor = color;
    const label = new CSS2DObject(span);
    label.position.fromArray(direction).multiplyScalar(axisLength * 1.1);
    scene.add(label);
  }
  const originText = document.createElement("span");
  originText.className = "scene-axis-origin";
  originText.textContent = "0, 0, 0";
  const origin = new CSS2DObject(originText);
  origin.center.y = -0.4;
  scene.add(origin);

  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(4, -5, 7);
  scene.add(key);
  const camera = new PerspectiveCamera(42, 1, 0.01, 1000);
  camera.up.set(0, 0, 1);
  const orbit = new OrbitControls(camera, canvas);
  const raycaster = new Raycaster();
  let model: ReturnType<typeof createRobotModel> | undefined;
  let structure = "";
  let previousRobot: SceneRobot | undefined;
  let sized = false;
  let frame = 0;
  let lost = false;
  let missingMesh = false;
  let pointer: Vector2 | undefined;
  let disposed = false;
  let framingOrigin = false;

  function render() {
    if (frame || lost || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderer.render(scene, camera);
      labels.render(scene, camera);
    });
  }

  function frameView(center: Vector3, radius: number) {
    const lens = Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, camera.aspect);
    orbit.target.copy(center);
    camera.position
      .copy(center)
      .addScaledVector(new Vector3(1, -1.25, 0.85).normalize(), (radius * 1.4) / lens);
    camera.near = Math.max(0.00001, radius / 1000);
    camera.far = Math.max(100, camera.position.length() + radius * 100);
    camera.updateProjectionMatrix();
    orbit.update();
    render();
  }

  function fit() {
    framingOrigin = false;
    const bounds = new Box3();
    if (model) bounds.setFromObject(model.root);
    frameView(
      bounds.getCenter(new Vector3()),
      Math.max(0.1, bounds.getSize(new Vector3()).length() / 2),
    );
    orbit.saveState();
  }

  function focusOrigin() {
    framingOrigin = true;
    frameView(new Vector3(), axisLength * 1.2);
  }

  function resize() {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    labels.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!sized) {
      sized = true;
      if (framingOrigin) focusOrigin();
      else fit();
    }
    render();
  }
  function start(event: PointerEvent) {
    if (event.isPrimary && event.button === 0) pointer = new Vector2(event.clientX, event.clientY);
  }
  function select(event: PointerEvent) {
    const down = pointer;
    pointer = undefined;
    if (!event.isPrimary || event.button !== 0 || !down || !model || lost) return;
    if (down.distanceTo(new Vector2(event.clientX, event.clientY)) > 5) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const cursor = new Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      1 - ((event.clientY - bounds.top) / bounds.height) * 2,
    );
    raycaster.setFromCamera(cursor, camera);
    const hit = raycaster
      .intersectObject(model.root, true)
      .find((hit) => typeof hit.object.userData.linkId === "string");
    if (hit) onSelect(hit.object.userData.linkId);
  }
  function reportIssue() {
    if (lost) onIssue({ message: "3D 显示暂时中断。仍可在结构树中编辑模型。", blocked: true });
    else if (missingMesh) onIssue({ message: "有 STL 网格无法显示。", blocked: false });
    else onIssue();
  }

  function contextLost(event: Event) {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(frame);
    frame = 0;
    reportIssue();
  }
  function contextRestored() {
    lost = false;
    reportIssue();
    render();
  }

  const observer = new ResizeObserver(resize);
  canvas.setAttribute("aria-label", "机器人 3D 画布");
  host.append(canvas, labels.domElement);
  observer.observe(host);
  orbit.addEventListener("change", render);
  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointerup", select);
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);
  resize();

  return {
    fit,
    focusOrigin,
    update(robot: SceneRobot, selected: string | null, preview?: SceneJointPreview) {
      let needsFit = false;
      if (robot !== previousRobot) {
        previousRobot = robot;
        const next = JSON.stringify({
          root: robot.rootLinkId,
          links: robot.links.map(({ id, visuals }) => [id, visuals]),
          joints: robot.joints.map(({ position: _position, name: _name, ...joint }) => joint),
        });
        if (next !== structure) {
          structure = next;
          model?.dispose();
          missingMesh = false;
          reportIssue();
          const current = createRobotModel(robot, readAsset, render, () => {
            if (missingMesh) return;
            missingMesh = true;
            reportIssue();
          });
          model = current;
          scene.add(current.root);
          needsFit = true;
          void current.ready.then(() => {
            if (
              !disposed &&
              model === current &&
              !framingOrigin &&
              camera.position.equals(orbit.position0) &&
              orbit.target.equals(orbit.target0)
            )
              fit();
          });
        }
      }
      model?.pose(robot.joints, preview);
      model?.select(selected);
      if (needsFit) fit();
      else render();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      orbit.removeEventListener("change", render);
      orbit.dispose();
      canvas.removeEventListener("pointerdown", start);
      canvas.removeEventListener("pointerup", select);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      model?.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      axes.geometry.dispose();
      for (const material of axisMaterials) material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      labels.domElement.remove();
    },
  };
}
