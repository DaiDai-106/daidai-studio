import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { editScene, validateScene } from "../../../src/backend/module/scene/document.ts";
import { parseUrdf, writeUrdf } from "../../../src/backend/module/scene/urdf.ts";
import type { SceneDocument, SceneOperation, SceneRobot } from "../../../src/contracts/scene.ts";
import { robotFrames } from "../../../src/shared/scene/frames.ts";
import {
  originMatrix,
  resolveSceneRobot,
  sourcePartIds,
} from "../../../src/shared/scene/geometry.ts";
import { zeroOrigin } from "../../../src/shared/scene/robot.ts";
import { stepWorkerAvailable, writeStepFixture } from "../../support/step_fixture.ts";

function fixture(): SceneDocument {
  const { robot: sourceRobot } = parseUrdf(`<robot name="cad">
    <link name="source_root"/><link name="assembly"/>
    <link name="one"><visual><origin xyz="0.1 0.2 0.3" rpy="0.3 0.2 0.1"/><geometry><box size="1 2 3"/></geometry></visual></link>
    <link name="two"><visual><geometry><sphere radius="0.5"/></geometry></visual></link>
    <joint name="group" type="fixed"><parent link="source_root"/><child link="assembly"/><origin xyz="1 2 3" rpy="0.3 0.4 0.5"/></joint>
    <joint name="first" type="fixed"><parent link="assembly"/><child link="one"/><origin xyz="4 5 6" rpy="0.5 -0.2 1.2"/></joint>
    <joint name="second" type="fixed"><parent link="assembly"/><child link="two"/><origin xyz="-3 2 1" rpy="-0.4 0.6 0.8"/></joint>
  </robot>`);
  return {
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
}
function apply(document: SceneDocument, operation: Exclude<SceneOperation, { op: "undo" }>) {
  const next = editScene(document, operation);
  validateScene(next);
  return next;
}
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function visualFrames(robot: SceneRobot) {
  const frames = robotFrames(robot);
  frames.root.updateMatrixWorld(true);
  return robot.links.flatMap((link) =>
    link.visuals.map(
      (visual) =>
        required(frames.links.get(link.id))
          .matrixWorld.clone()
          .multiply(originMatrix(visual.origin)).elements,
    ),
  );
}
function near(actual: number[], expected: number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - required(expected[index])) < 1e-10,
      `${value} != ${expected[index]}`,
    );
  });
}

test("CAD 装配多选归组保留旋转、位置和几何；关节修改不会改写源数据或绑定偏移", () => {
  const initial = fixture();
  const frozen = JSON.stringify(initial);
  const source = required(initial.sourceRobot);
  const assembly = required(source.links.find((link) => link.name === "assembly"));
  const one = required(source.links.find((link) => link.name === "one"));
  assert.deepEqual(
    sourcePartIds(source, [assembly.id, one.id, assembly.id]),
    source.links.slice(2).map((link) => link.id),
  );
  const created = apply(initial, {
    op: "createSourceLink",
    sourceIds: [assembly.id, one.id],
    parentId: "base",
    linkName: "arm",
    jointName: "hinge",
    jointType: "revolute",
  });
  const built = required(resolveSceneRobot(created));
  assert.equal(built.links.length, 2);
  assert.equal(built.links[1]?.visuals.length, 2);
  const originals = visualFrames(source);
  visualFrames(built).forEach((frame, index) => {
    near(frame, required(originals[index]));
  });
  assert.equal(JSON.stringify(initial), frozen);
  assert.deepEqual(created.sourceRobot, source);
  const joint = required(created.robot?.joints[0]);
  const parts = created.robot?.links[1]?.sourceParts;
  const modified = apply(created, {
    op: "updateJoint",
    jointId: joint.id,
    name: "updated",
    parentId: "base",
    jointType: "prismatic",
    origin: { xyz: [3, 4, 5], rpy: [0.2, 0.4, 0.8] },
    axis: [1, 0, 0],
    limit: { lower: -2, upper: 2, effort: 10, velocity: 2 },
  });
  assert.deepEqual(modified.robot?.links[1]?.sourceParts, parts);
  assert.notDeepEqual(visualFrames(required(resolveSceneRobot(modified))), originals);
  assert.deepEqual(modified.sourceRobot, source);
  assert.equal(
    apply(modified, { op: "assignSource", sourceIds: [one.id], linkId: joint.childId }),
    modified,
  );
  const roundtrip = parseUrdf(writeUrdf(required(resolveSceneRobot(modified))));
  validateScene({ ...modified, robot: roundtrip.robot });
  assert.equal(roundtrip.robot.links[1]?.visuals.length, 2);
  assert.equal(roundtrip.robot.joints[0]?.name, "updated");
});

test("向有旋转父级的 Link 分配零件、重新分配与解除均不丢失手工几何", () => {
  let document = fixture();
  const source = required(document.sourceRobot);
  const sourceIds = source.links.slice(2).map((link) => link.id);
  document = apply(document, {
    op: "addChildLink",
    parentId: "base",
    linkName: "parent",
    jointName: "parent_joint",
    jointType: "fixed",
  });
  const parent = required(document.robot?.links[1]);
  const parentJoint = required(document.robot?.joints[0]);
  document = apply(document, {
    op: "updateJoint",
    jointId: parentJoint.id,
    name: parentJoint.name,
    parentId: "base",
    jointType: "fixed",
    origin: { xyz: [7, 8, 9], rpy: [0.5, 0.8, -1.5] },
    axis: [0, 0, 1],
  });
  document = apply(document, {
    op: "createSourceLink",
    sourceIds: [required(sourceIds[0])],
    parentId: parent.id,
    linkName: "child",
    jointName: "child_joint",
    jointType: "fixed",
  });
  const child = required(document.robot?.links[2]);
  near(
    required(visualFrames(required(resolveSceneRobot(document)))[0]),
    required(visualFrames(source)[0]),
  );
  document = apply(document, { op: "assignSource", sourceIds, linkId: parent.id });
  assert.equal(document.robot?.links[2]?.sourceParts?.length, 0);
  visualFrames(required(resolveSceneRobot(document))).forEach((frame, index) => {
    near(frame, required(visualFrames(source)[index]));
  });
  // Existing URDF visuals are independent from CAD assignments.
  parent.visuals.push(required(source.links[2]?.visuals[0]));
  document = {
    ...document,
    robot: {
      ...required(document.robot),
      links: required(document.robot).links.map((link) =>
        link.id === parent.id ? { ...link, visuals: parent.visuals } : link,
      ),
    },
  };
  document = apply(document, { op: "unassignSource", sourceIds });
  assert.equal(resolveSceneRobot(document)?.links[1]?.visuals.length, 1);
  document = apply(document, { op: "assignSource", sourceIds, linkId: child.id });
  document = apply(document, { op: "removeSubtree", linkId: child.id });
  assert.ok(!document.robot?.links.some((link) => link.sourceParts?.length));
  assert.deepEqual(document.sourceRobot, source);
});

test("非法绑定、环、零轴、颠倒限位和无效透明度在保存前被拒绝", () => {
  const initial = fixture();
  const sourceId = required(initial.sourceRobot?.links[2]?.id);
  let document = apply(initial, {
    op: "createSourceLink",
    sourceIds: [sourceId],
    parentId: "base",
    linkName: "child",
    jointName: "joint",
    jointType: "fixed",
  });
  const joint = required(document.robot?.joints[0]);
  const update: Extract<SceneOperation, { op: "updateJoint" }> = {
    op: "updateJoint",
    jointId: joint.id,
    name: joint.name,
    parentId: "base",
    jointType: "revolute",
    origin: zeroOrigin(),
    axis: [1, 0, 0],
    limit: { lower: -1, upper: 1, effort: 1, velocity: 1 },
  };
  assert.throws(() => apply(document, { ...update, parentId: joint.childId }), /循环/);
  assert.throws(() => apply(document, { ...update, axis: [0, 0, 0] }), /轴向/);
  assert.throws(
    () => apply(document, { ...update, limit: { ...required(update.limit), lower: 2 } }),
    /限位/,
  );
  assert.throws(
    () => apply(document, { op: "assignSource", sourceIds: ["missing"], linkId: "base" }),
    /不存在/,
  );
  assert.throws(
    () => apply(document, { op: "assignSource", sourceIds: [sourceId], linkId: "missing" }),
    /不存在/,
  );
  assert.throws(
    () => apply(document, { op: "setTransparency", entity: "source", ids: [sourceId], value: 101 }),
    /格式无效/,
  );
  const broken = structuredClone(document);
  required(broken.robot?.links[0]).sourceParts = [{ sourceId, origin: zeroOrigin() }];
  assert.throws(() => validateScene(broken), /只能属于一个/);
  delete broken.sourceRobot;
  assert.throws(() => validateScene(broken), /不存在/);
  document = apply(document, { ...update });
  document = apply(document, { op: "setJointPosition", jointId: joint.id, position: 0.5 });
  const limit = required(update.limit);
  const narrowed = apply(document, { ...update, limit: { ...limit, upper: 0.1 } });
  assert.equal(narrowed.robot?.joints[0]?.position, 0.1);
  const shifted = apply(document, { ...update, limit: { ...limit, lower: 2, upper: 3 } });
  assert.equal(shifted.robot?.joints[0]?.position, 2);
  const linear = apply(document, { ...update, jointType: "prismatic" });
  assert.equal(linear.robot?.joints[0]?.position, 0);
  const { limit: _limit, ...fixed } = update;
  document = apply(document, { ...fixed, jointType: "fixed" });
  assert.equal(document.robot?.joints[0]?.position, 0);
});

test("绑定多个 CAD 几何到同一 Link 的 URDF 可回读（超过旧的 32 visual 限制）", () => {
  const document = fixture();
  const source = required(document.sourceRobot);
  const part = required(source.links[2]);
  part.visuals = Array.from({ length: 40 }, () => structuredClone(required(part.visuals[0])));
  const assigned = apply(document, { op: "assignSource", sourceIds: [part.id], linkId: "base" });
  const robot = parseUrdf(writeUrdf(required(resolveSceneRobot(assigned)))).robot;
  validateScene({ schemaVersion: 1, revision: 1, robot, warnings: [] });
  assert.equal(robot.links[0]?.visuals.length, 40);
});

test("真实 STEP 搭建经版本校验、撤销、重启保存与独立 URDF/网格导出", {
  skip: !stepWorkerAvailable && "先运行 npm run build:scene",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dai-builder-"));
  const dataRoot = join(root, "data");
  let app = await openApplication({ dataRoot, publish: () => {} });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const { id: projectId } = await app.request("project.create", {
    name: "搭建",
    path: root,
    mode: "scene",
  });
  const path = join(root, "model.step");
  await writeStepFixture(path);
  let snapshot = await app.request("scene.importStep", { projectId, path, expectedRevision: 0 });
  const source = required(snapshot.document.sourceRobot);
  const sourceIds = source.links
    .filter((link) => link.visuals.length)
    .slice(0, 2)
    .map((link) => link.id);
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: 1,
    operation: {
      op: "createSourceLink",
      sourceIds,
      parentId: required(snapshot.document.robot).rootLinkId,
      linkName: "moving_link",
      jointName: "moving_joint",
      jointType: "revolute",
    },
  });
  const assembled: unknown = JSON.parse(JSON.stringify(snapshot.document.robot));
  await assert.rejects(
    app.request("scene.importStep", {
      projectId,
      expectedRevision: snapshot.document.revision,
      path: join(root, "missing.step"),
      sourceOnly: true,
    }),
    /已有零件绑定/,
  );
  await assert.rejects(
    app.request("scene.apply", {
      projectId,
      expectedRevision: 1,
      operation: { op: "setTransparency", entity: "source", ids: sourceIds, value: 30 },
    }),
    /场景已更新/,
  );
  const joint = required(snapshot.document.robot?.joints[0]);
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: 2,
    operation: {
      op: "updateJoint",
      jointId: joint.id,
      name: "configured",
      parentId: joint.parentId,
      jointType: "revolute",
      origin: joint.origin,
      axis: [1, 0, 0],
      limit: { lower: -2, upper: 2, effort: 10, velocity: 3 },
    },
  });
  assert.equal(snapshot.document.robot?.joints[0]?.name, "configured");
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: 3,
    operation: { op: "undo" },
  });
  assert.deepEqual(snapshot.document.robot, assembled);
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: 4,
    operation: { op: "setTransparency", entity: "source", ids: sourceIds, value: 30 },
  });
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: snapshot.document.revision,
    operation: { op: "undo" },
  });
  assert.equal(snapshot.document.transparencies?.length ?? 0, 0);
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: snapshot.document.revision,
    operation: { op: "setTransparency", entity: "source", ids: sourceIds, value: 30 },
  });
  await app.close();
  app = await openApplication({ dataRoot, publish: () => {} });
  snapshot = await app.request("scene.get", { projectId });
  assert.deepEqual(
    snapshot.document.transparencies?.map((setting) => setting.value),
    sourceIds.map(() => 30),
  );
  assert.deepEqual(snapshot.document.robot, assembled);
  assert.deepEqual(snapshot.document.sourceRobot, source);
  assert.equal(snapshot.canUndo, false);
  const output = await app.request("scene.export", {
    projectId,
    directory: root,
    expectedRevision: snapshot.document.revision,
  });
  const exported = parseUrdf(await readFile(output.path, "utf8")).robot;
  assert.equal(exported.links.length, 2);
  assert.equal(exported.links[1]?.visuals.length, 2);
  assert.equal((await readdir(join(dirname(output.path), "meshes"))).length, 1);
  assert.doesNotMatch(await readFile(output.path, "utf8"), /sourceParts|sourceId|transparency/);
  const reimported = await app.request("scene.import", {
    projectId,
    path: output.path,
    expectedRevision: snapshot.document.revision,
  });
  assert.equal(reimported.document.robot?.links[1]?.visuals.length, 2);
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: reimported.document.revision,
    operation: { op: "undo" },
  });
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: snapshot.document.revision,
    operation: { op: "removeSubtree", linkId: joint.childId },
  });
  assert.equal(snapshot.document.robot?.links.length, 1);
  assert.deepEqual(snapshot.document.sourceRobot, source);
  const unchanged = await app.request("scene.apply", {
    projectId,
    expectedRevision: snapshot.document.revision,
    operation: { op: "unassignSource", sourceIds },
  });
  assert.deepEqual(unchanged, snapshot);
  snapshot = await app.request("scene.apply", {
    projectId,
    expectedRevision: snapshot.document.revision,
    operation: { op: "undo" },
  });
  assert.deepEqual(snapshot.document.robot, assembled);
});
