import { type PerspectiveCamera, type Sphere, Vector3 } from "three";

// Clip against all visible content, including helpers outside the model bounds.
export function updateCameraClipping(camera: PerspectiveCamera, bounds: Sphere) {
  const forward = camera.getWorldDirection(new Vector3());
  const depth = bounds.center.clone().sub(camera.position).dot(forward);
  const margin = Math.max(bounds.radius * 1.05, 0.1);
  camera.near = Math.max(0.001, depth - margin);
  camera.far = Math.max(camera.near + 1, depth + margin);
  camera.updateProjectionMatrix();
}
