import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { validateScene } from "../../../src/backend/module/scene/document.ts";
import { parseUrdf, writeUrdf } from "../../../src/backend/module/scene/urdf.ts";
import { type ApplicationEvent, validEvent } from "../../../src/contracts/application.ts";
import { normalizeStl } from "../../../src/shared/node/stl.ts";
import { testRobot } from "../../support/scene_fixture.ts";

test("场景操作校验拓扑、支持版本冲突与重启恢复，导出时随 URDF 保存 STL", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-"));
  const dataRoot = join(root, "data");
  const events: ApplicationEvent[] = [];
  let app = await openApplication({ dataRoot, publish: (event) => events.push(event) });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.request("project.create", { name: "场景", path: root, mode: "scene" });
  const coding = await app.request("project.create", { name: "代码", path: root, mode: "coding" });
  const projectId = project.id;
  assert.equal((await app.request("scene.get", { projectId })).document.robot, null);
  await assert.rejects(app.request("scene.get", { projectId: coding.id }), /场景项目不存在/);
  await assert.rejects(
    app.request("coding.list", { projectId, path: "", offset: 0 }),
    /Coding 项目不存在/,
  );

  const stl = Buffer.alloc(134);
  stl.writeUInt32LE(1, 80);
  stl.writeFloatLE(1, 92);
  stl.writeFloatLE(1, 108);
  stl.writeFloatLE(1, 124);
  await mkdir(join(root, "meshes"));
  await writeFile(join(root, "meshes", "arm.stl"), stl);
  const path = join(root, "model.urdf");
  const source = testRobot.replace(
    '<cylinder radius="0.1" length="0.6"/>',
    '<mesh filename="./meshes/arm.stl" scale="2 2 2"/>',
  );
  await writeFile(path, source);
  const imported = await app.request("scene.import", { projectId, path, expectedRevision: 0 });
  assert.equal(imported.document.revision, 1);
  const shape = imported.document.robot?.links[1]?.visuals[0]?.geometry;
  assert.ok(shape?.type === "mesh");
  assert.deepEqual(
    Buffer.from(await app.request("scene.asset", { projectId, asset: shape.asset }), "base64"),
    stl,
  );

  const joint = imported.document.robot?.joints[0];
  assert.ok(joint?.limit);
  const jointId = joint.id;
  const apply = (expectedRevision: number, position: number) =>
    app.request("scene.apply", {
      projectId,
      expectedRevision,
      operation: { op: "setJointPosition", jointId, position },
    });
  const first = apply(1, 0.5);
  const stale = assert.rejects(apply(1, 1), /场景已更新/);
  assert.equal((await first).document.robot?.joints[0]?.position, 0.5);
  await stale;
  await assert.rejects(apply(2, 3), /限位/);
  assert.equal((await apply(2, 0.5)).document.revision, 2);
  const unchanged = await app.request("scene.apply", {
    projectId,
    expectedRevision: 2,
    operation: {
      op: "updateJoint",
      jointId,
      name: ` ${joint.name} `,
      parentId: joint.parentId,
      jointType: joint.type,
      origin: joint.origin,
      axis: joint.axis,
      limit: joint.limit,
    },
  });
  assert.deepEqual(unchanged, await first);

  const meshPath = join(root, "meshes", "arm.stl");
  await writeFile(meshPath, "solid bad\nendfacet\nendsolid bad\n");
  await assert.rejects(
    app.request("scene.import", { projectId, path, expectedRevision: 2 }),
    /STL 网格格式无效/,
  );
  await writeFile(meshPath, stl);
  await writeFile(path, source.replace("./meshes/arm.stl", "../arm.stl"));
  await assert.rejects(
    app.request("scene.import", { projectId, path, expectedRevision: 2 }),
    /网格必须/,
  );
  const manyVisuals = '<visual><geometry><box size="1 1 1"/></geometry></visual>'.repeat(32);
  const largeUrdf = `<robot name="large">${Array.from(
    { length: 320 },
    (_, index) =>
      `<link name="L${index}">${manyVisuals}</link>${
        index === 0
          ? ""
          : `<joint name="J${index}" type="fixed"><parent link="L0"/><child link="L${index}"/></joint>`
      }`,
  ).join("")}</robot>`;
  await writeFile(path, largeUrdf);
  await assert.rejects(
    app.request("scene.import", { projectId, path, expectedRevision: 2 }),
    /导出的 URDF 超过/,
  );
  assert.equal((await app.request("scene.get", { projectId })).document.revision, 2);

  const undone = await app.request("scene.apply", {
    projectId,
    expectedRevision: 2,
    operation: { op: "undo" },
  });
  assert.equal(undone.document.revision, 3);
  assert.equal(undone.document.robot?.joints[0]?.position, 0);
  await apply(3, 1);
  await app.close();
  app = await openApplication({ dataRoot, publish: () => {} });
  const restored = await app.request("scene.get", { projectId });
  assert.equal(restored.document.revision, 4);
  assert.equal(restored.document.robot?.joints[0]?.position, 1);
  assert.equal(restored.canUndo, false);
  const exported = await app.request("scene.export", {
    projectId,
    directory: root,
    expectedRevision: restored.document.revision,
  });
  assert.deepEqual(await readFile(join(dirname(exported.path), "meshes", shape.asset)), stl);
  const roundtrip = await app.request("scene.import", {
    projectId,
    path: exported.path,
    expectedRevision: 4,
  });
  assert.equal(roundtrip.document.robot?.name, "bench & arm");
  assert.equal(roundtrip.document.robot?.joints[0]?.position, 0);
  assert.deepEqual(roundtrip.document.robot?.links[1]?.visuals[0]?.geometry, shape);
  const documents = events.filter((event) => event.type === "scene.document");
  assert.deepEqual(
    documents.map(({ snapshot }) => snapshot.document.revision),
    [1, 2, 3, 4],
  );
  assert.ok(documents.every(validEvent));
});

test("URDF 导出和回读保留导入说明，零件名中的符号不破坏 XML 注释", () => {
  const { robot } = parseUrdf(testRobot);
  const notes = ["零件「A---B <!DOCTYPE robot>」已跳过 3 个无法网格化的曲面。"];
  const exported = writeUrdf(robot, notes);
  assert.deepEqual(parseUrdf(exported), { robot, warnings: notes });
});

test("URDF 拒绝断开的关节、非法 XML 和与根不连通的闭环", () => {
  assert.throws(
    () => parseUrdf(testRobot.replace('child link="arm"', 'child link="unknown"')),
    /不存在/,
  );
  assert.throws(() => parseUrdf("<!DOCTYPE robot><robot/>"), /文档类型/);
  assert.throws(() => parseUrdf('<robot name="broken"><link name="a"></robot>'));
  const { robot, warnings } = parseUrdf(`<robot name="cycle">
    <link name="root"/><link name="b"/><link name="c"/>
    <joint name="one" type="fixed"><parent link="b"/><child link="c"/></joint>
    <joint name="two" type="fixed"><parent link="c"/><child link="b"/></joint>
  </robot>`);
  assert.throws(() => validateScene({ schemaVersion: 1, revision: 1, robot, warnings }), /循环/);
});

test("URDF 1.0 使用默认下限；ASCII STL 必须有完整且有限的三角面", () => {
  const { robot } = parseUrdf(testRobot.replace('lower="-2" ', ""));
  assert.equal(robot.joints[0]?.limit?.lower, 0);
  const triangle = `solid arm
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid arm
`;
  assert.equal(normalizeStl(Buffer.from(`  \n  ${triangle}`)).toString(), triangle);
  assert.throws(() => normalizeStl(Buffer.from(triangle.replace("vertex 0 1 0", ""))), /格式无效/);
  assert.throws(
    () => normalizeStl(Buffer.from(triangle.replace("vertex 0 1 0", "vertex 1e99 1 0"))),
    /格式无效/,
  );
});
