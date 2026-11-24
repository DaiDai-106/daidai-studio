import assert from "node:assert/strict";
import { test } from "node:test";
import { editScene, validateScene } from "../../../src/backend/module/scene/document.ts";
import { parseUrdf, writeUrdf } from "../../../src/backend/module/scene/urdf.ts";
import type { SceneDocument } from "../../../src/contracts/scene.ts";
import { resolveSceneRobot } from "../../../src/shared/scene/geometry.ts";
import {
  sceneVisualOpacities,
  selectionTransparency,
  transparencyTargets,
} from "../../../src/shared/scene/transparency.ts";

function fixture() {
  const { robot: sourceRobot } = parseUrdf(`<robot name="cad">
    <link name="root"/>
    <link name="a"><visual><geometry><box size="1 1 1"/></geometry></visual><visual><geometry><sphere radius="1"/></geometry></visual></link>
    <link name="b"><visual><geometry><box size="1 1 1"/></geometry></visual></link>
    <joint name="a_joint" type="fixed"><parent link="root"/><child link="a"/></joint>
    <joint name="b_joint" type="fixed"><parent link="root"/><child link="b"/></joint>
  </robot>`);
  const sourceIds = sourceRobot.links.filter((link) => link.visuals.length).map((link) => link.id);
  const initial: SceneDocument = {
    schemaVersion: 1,
    revision: 0,
    warnings: [],
    sourceRobot,
    robot: {
      name: "built",
      rootLinkId: "base",
      links: [{ id: "base", name: "base_link", visuals: [] }],
      joints: [],
    },
  };
  const built = editScene(initial, {
    op: "createSourceLink",
    sourceIds,
    parentId: "base",
    linkName: "arm",
    jointName: "joint",
    jointType: "fixed",
  });
  const linkId = built.robot?.links[1]?.id;
  const a = sourceIds[0];
  const b = sourceIds[1];
  assert.ok(linkId && a && b);
  return { built, a, b, linkId };
}

test("默认透明度为零并拒绝旧全局设置；CAD 与 URDF 导出不被显示设置改写", () => {
  const { built, a, b, linkId } = fixture();
  assert.throws(() => validateScene({ ...built, transparency: 70 }), /格式无效/);
  assert.deepEqual(sceneVisualOpacities(built, false).get(linkId), [1, 1, 1]);
  assert.deepEqual(sceneVisualOpacities(built, true).get(a), [1, 1]);
  assert.deepEqual(selectionTransparency(built, transparencyTargets(built, "link", [linkId])), {
    value: 0,
    mixed: false,
  });
  const before = resolveSceneRobot(built);
  assert.ok(before);
  const xml = writeUrdf(before);
  const changed = editScene(built, {
    op: "setTransparency",
    entity: "source",
    ids: [a],
    value: 60,
  });
  validateScene(changed);
  assert.deepEqual(changed.sourceRobot, built.sourceRobot);
  assert.deepEqual(changed.robot, built.robot);
  assert.deepEqual(sceneVisualOpacities(changed, true).get(a), [0.4, 0.4]);
  assert.deepEqual(sceneVisualOpacities(changed, true).get(b), [1]);
  assert.deepEqual(sceneVisualOpacities(changed, false).get(linkId), [0.4, 0.4, 1]);
  const after = resolveSceneRobot(changed);
  assert.ok(after);
  assert.equal(writeUrdf(after), xml);
});

test("单零件、多选、装配和构建子树仅影响目标几何；混合值可统一，归组和解绑保留零件设置", () => {
  const { built, a, b, linkId } = fixture();
  let document = editScene(built, { op: "setTransparency", entity: "source", ids: [a], value: 50 });
  const targets = transparencyTargets(document, "link", [linkId]);
  assert.deepEqual(selectionTransparency(document, targets), { value: 0, mixed: true });
  document = editScene(document, {
    op: "setTransparency",
    entity: "link",
    ids: ["base"],
    value: 30,
  });
  assert.deepEqual(sceneVisualOpacities(document, false).get(linkId), [0.7, 0.7, 0.7]);
  assert.equal(
    selectionTransparency(document, transparencyTargets(document, "source", [a, b])).value,
    30,
  );
  document = editScene(document, { op: "setTransparency", entity: "source", ids: [a], value: 0 });
  assert.deepEqual(sceneVisualOpacities(document, false).get(linkId), [1, 1, 0.7]);
  assert.equal(
    editScene(document, { op: "setTransparency", entity: "source", ids: [a], value: 0 }),
    document,
  );
  document = editScene(document, { op: "unassignSource", sourceIds: [a] });
  assert.deepEqual(sceneVisualOpacities(document, false).get(linkId), [0.7]);
  document = editScene(document, { op: "assignSource", sourceIds: [a], linkId });
  assert.deepEqual(sceneVisualOpacities(document, false).get(linkId), [0.7, 1, 1]);
  assert.ok(document.sourceRobot);
  document = editScene(document, {
    op: "setTransparency",
    entity: "source",
    ids: [document.sourceRobot.rootLinkId],
    value: 0,
  });
  assert.deepEqual(document.transparencies, []);
});

test("原生 URDF 的连杆透明度独立；删除子树清理设置，无效目标/范围与重复记录拒绝保存", () => {
  const { built, a, linkId } = fixture();
  assert.ok(built.robot && built.sourceRobot?.links[1]?.visuals[0]);
  built.robot.links[0]?.visuals.push(structuredClone(built.sourceRobot.links[1].visuals[0]));
  built.robot.links[1]?.visuals.push(structuredClone(built.sourceRobot.links[1].visuals[0]));
  const document = editScene(built, {
    op: "setTransparency",
    entity: "link",
    ids: [linkId],
    value: 80,
  });
  assert.deepEqual(sceneVisualOpacities(document, false).get("base"), [1]);
  const all = editScene(document, {
    op: "setTransparency",
    entity: "link",
    ids: ["base"],
    value: 40,
  });
  assert.deepEqual(sceneVisualOpacities(all, false).get("base"), [0.6]);
  assert.deepEqual(sceneVisualOpacities(all, false).get(linkId), [0.6, 0.6, 0.6, 0.6]);
  const renamed = editScene(all, { op: "rename", entity: "link", id: linkId, name: "forearm" });
  assert.equal(renamed.transparencies, all.transparencies);
  const removed = editScene(renamed, { op: "removeSubtree", linkId });
  validateScene(removed);
  assert.ok(
    !removed.transparencies?.some((setting) => setting.entity === "link" && setting.id === linkId),
  );
  assert.throws(
    () =>
      editScene(document, { op: "setTransparency", entity: "source", ids: ["missing"], value: 50 }),
    /不存在/,
  );
  assert.throws(
    () =>
      editScene(document, { op: "setTransparency", entity: "link", ids: ["missing"], value: 50 }),
    /不存在/,
  );
  assert.throws(
    () =>
      validateScene(
        editScene(document, { op: "setTransparency", entity: "source", ids: [a], value: -1 }),
      ),
    /格式无效/,
  );
  assert.throws(
    () =>
      validateScene({
        ...document,
        transparencies: [
          { entity: "source", id: a, value: 50 },
          { entity: "source", id: a, value: 20 },
        ],
      }),
    /重复/,
  );
  assert.throws(
    () =>
      validateScene({
        ...document,
        transparencies: [{ entity: "source", id: "missing", value: 50 }],
      }),
    /不存在/,
  );
});
