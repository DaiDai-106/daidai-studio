import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { visibleGeometryBounds } from "../../../src/renderer/scene/bounds.ts";

test("camera bounds exclude hidden descendants and transient overlays, including children of a visible mesh", () => {
  const geometry = new BoxGeometry(2, 4, 6),
    material = new MeshBasicMaterial();
  const root = new Group(),
    visible = new Mesh(geometry, material);
  visible.position.set(10, 20, 30);
  root.add(visible);
  const hidden = new Mesh(geometry, material);
  hidden.position.x = 1000;
  hidden.visible = false;
  const overlay = new Mesh(geometry, material);
  overlay.position.y = -1000;
  overlay.userData.overlay = true;
  visible.add(hidden, overlay);
  try {
    const bounds = visibleGeometryBounds(root);
    assert.deepEqual(bounds.min.toArray(), [9, 18, 27]);
    assert.deepEqual(bounds.max.toArray(), [11, 22, 33]);
    visible.position.x = -10;
    const moved = visibleGeometryBounds(root);
    assert.deepEqual(moved.min.toArray(), [-11, 18, 27]);
    assert.deepEqual(moved.max.toArray(), [-9, 22, 33]);
    root.visible = false;
    assert.equal(visibleGeometryBounds(root).isEmpty(), true);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
