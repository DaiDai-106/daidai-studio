import assert from "node:assert/strict";
import { test } from "node:test";
import { Box3, PerspectiveCamera, Sphere, Vector3 } from "three";
import { updateCameraClipping } from "../../../src/renderer/features/scene/logic/camera.ts";

test("camera clipping retains the grid at different orbit angles and pan targets", () => {
  const camera = new PerspectiveCamera(45, 1, 0.01, 100);
  camera.up.set(0, 0, 1);
  const bounds = new Box3(new Vector3(-6, -6, 0), new Vector3(6, 6, 1.5)).getBoundingSphere(
    new Sphere(),
  );
  for (const position of [
    [4, -4, 3.2],
    [-4, 4, 3.2],
    [0.2, -0.2, 8],
    [40, -40, 32],
  ]) {
    for (const target of [new Vector3(), new Vector3(3, 2, 0)]) {
      camera.position.fromArray(position);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      updateCameraClipping(camera, bounds);
      const forward = camera.getWorldDirection(new Vector3());
      for (let x = -6; x <= 6; x += 0.5)
        for (let y = -6; y <= 6; y += 0.5) {
          const depth = new Vector3(x, y, 0).sub(camera.position).dot(forward);
          if (depth > 0.001) assert.ok(depth >= camera.near && depth <= camera.far);
        }
    }
  }
});
