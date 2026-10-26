import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { createAppearance } from "../../../src/renderer/scene/appearance.ts";

function fixture() {
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial({ color: "#333333", metalness: 0.6, roughness: 0.4 });
  const root = new Group();
  root.userData.objectId = "assembly";
  const first = new Mesh(geometry, material);
  first.userData.objectId = "first";
  const second = new Mesh(geometry, material);
  second.userData.objectId = "second";
  root.add(first, second);
  const appearance = createAppearance();
  const state = { model: root, showGrid: true, showAxes: true };
  return { geometry, material, root, first, second, appearance, state };
}

test("surface selection isolates shared instance materials, reuses clones and restores originals", () => {
  const { geometry, material, first, second, appearance, state } = fixture();
  const color = material.color.clone();
  let originalDisposals = 0;
  material.addEventListener("dispose", () => originalDisposals++);
  try {
    appearance.update({ ...state, selectedId: "first" }, null, false);
    const highlighted = first.material;
    assert.notEqual(highlighted, material);
    assert.equal(second.material, material);
    assert.ok(!highlighted.color.equals(color));
    assert.ok(material.color.equals(color));
    assert.equal(highlighted.metalness, material.metalness);
    let disposals = 0;
    highlighted.addEventListener("dispose", () => disposals++);
    appearance.update({ ...state, selectedId: "first" }, null, true);
    assert.equal(first.material, highlighted, "palette changes must reuse the temporary material");
    appearance.update({ ...state, selectedId: "second" }, null, true);
    assert.equal(first.material, material);
    assert.equal(disposals, 1);
    assert.notEqual(second.material, material);
    appearance.update(state, null, false);
    assert.equal(second.material, material);
    assert.equal(originalDisposals, 0);
  } finally {
    appearance.dispose();
    geometry.dispose();
    material.dispose();
  }
});

test("assembly transparency is inherited, child overrides are independent and tint never accumulates", () => {
  const { geometry, material, first, second, appearance, state } = fixture();
  try {
    appearance.update({ ...state, transparency: { assembly: 0.75 } }, null, false);
    assert.equal(first.material.opacity, 0.25);
    assert.equal(second.material.opacity, 0.25);
    assert.equal(first.material.transparent, true);
    assert.equal(first.material.depthWrite, false);
    const tinted = first.material;
    appearance.update({ ...state, transparency: { assembly: 0.75, first: 0 } }, null, false);
    assert.equal(first.material, material);
    assert.equal(second.material.opacity, 0.25);
    let disposals = 0;
    second.material.addEventListener("dispose", () => disposals++);
    const selected = { ...state, selectedId: "assembly", transparency: { assembly: 1 } };
    appearance.update(selected, "second", false);
    assert.equal(first.material.opacity, 0.22, "selection remains visible at full transparency");
    assert.equal(second.material.opacity, 0.22);
    const color = first.material.color.clone();
    appearance.update(selected, "second", false);
    assert.ok(first.material.color.equals(color));
    appearance.update({ ...state, transparency: { first: 0.5 } }, null, false);
    assert.equal(first.material.opacity, 0.5);
    assert.ok(
      first.material.color.equals(material.color),
      "removing selection restores the base color",
    );
    assert.equal(second.material, material);
    assert.equal(disposals, 1);
    assert.notEqual(first.material, tinted);
    assert.equal(material.opacity, 1);
    assert.equal(material.transparent, false);
    assert.equal(material.depthWrite, true);
  } finally {
    appearance.dispose();
    geometry.dispose();
    material.dispose();
  }
});

test("hover is weaker than selection; multi-material surfaces restore and release on model replacement", () => {
  const { geometry, material, root, appearance, state } = fixture();
  const basic = new MeshBasicMaterial({ color: "#ffffff", opacity: 0.8, transparent: true });
  const originals = [material, basic];
  const mesh = new Mesh(geometry, originals);
  mesh.userData.objectId = "multiple";
  root.add(mesh);
  try {
    appearance.update(state, "multiple", false);
    const temporary = mesh.material;
    assert.notEqual(temporary, originals);
    assert.notEqual(temporary[0], material);
    assert.notEqual(temporary[1], basic);
    const hoverColor = temporary[0]?.color.clone();
    assert.ok(hoverColor);
    appearance.update(
      { ...state, selectedId: "multiple", transparency: { multiple: 0.5 } },
      "multiple",
      false,
    );
    assert.equal(mesh.material, temporary);
    assert.ok(!temporary[0]?.color.equals(hoverColor));
    assert.equal(temporary[1]?.opacity, 0.4);
    let disposals = 0;
    for (const cloned of temporary) cloned.addEventListener("dispose", () => disposals++);
    appearance.update({ ...state, model: new Group() }, null, false);
    assert.equal(mesh.material, originals);
    assert.equal(disposals, 2);
    appearance.dispose();
    appearance.dispose();
    assert.equal(disposals, 2, "releasing a detached model must not dispose clones twice");
  } finally {
    appearance.dispose();
    geometry.dispose();
    material.dispose();
    basic.dispose();
  }
});
