import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openApplication } from "../../../src/backend/application.ts";
import { stepWorkerAvailable, writeStepFixture } from "../../support/step_fixture.ts";

test("真实 STEP 导入、取消、版本冲突与 URDF 回读", {
  skip: !stepWorkerAvailable && "先运行 npm run build:scene",
  timeout: 25_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dai-step-workflow-"));
  const app = await openApplication({ dataRoot: join(root, "data"), publish: () => {} });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const { id: projectId } = await app.request("project.create", {
    name: "场景",
    mode: "scene",
    path: root,
  });
  const path = join(root, "robot.STEP");
  await writeStepFixture(path);
  const load = (expectedRevision: number, source = path) =>
    app.request("scene.importStep", { projectId, expectedRevision, path: source });
  const imported = await load(0);
  const robot = imported.document.sourceRobot;
  assert.ok(robot);
  assert.deepEqual(imported.document.robot, { ...robot, links: [robot.links[0]], joints: [] });
  assert.deepEqual(imported.document.warnings, []);
  assert.equal(imported.document.revision, 1);
  assert.equal(robot.links.length, 8);
  assert.equal(robot.joints.length, 7);
  const meshes = robot.links.flatMap((link) => link.visuals.map((visual) => visual.geometry));
  assert.equal(meshes.length, 4);
  assert.ok(meshes.every((geometry) => geometry.type === "mesh"));
  assert.equal(
    new Set(meshes.map((geometry) => geometry.type === "mesh" && geometry.asset)).size,
    1,
  );
  const mesh = meshes[0];
  assert.ok(mesh?.type === "mesh");
  assert.deepEqual(mesh.scale, [0.001, 0.001, 0.001]);
  const stl = Buffer.from(
    await app.request("scene.asset", { projectId, asset: mesh.asset }),
    "base64",
  );
  assert.equal(stl.readUInt32LE(80), 12);
  assert.equal(stl.length, 84 + 12 * 50);
  const maxima = [0, 1, 2].map((axis) =>
    Math.max(
      ...Array.from({ length: 36 }, (_, vertex) =>
        stl.readFloatLE(96 + Math.floor(vertex / 3) * 50 + (vertex % 3) * 12 + axis * 4),
      ),
    ),
  );
  assert.deepEqual(maxima, [10, 20, 30]);
  assert.match(robot.links[1]?.name ?? "", /Root/);
  assert.ok(robot.joints.every((joint) => joint.type === "fixed"));
  assert.equal(robot.joints[1]?.origin.xyz[2], 0.08);
  assert.ok(Math.abs((robot.joints[1]?.origin.rpy[2] ?? 0) - Math.PI / 2) < 1e-8);
  assert.equal(robot.joints[2]?.origin.xyz[1], 0.04);
  assert.equal(robot.links[3]?.visuals[0]?.color?.[3], 1);

  const exported = await app.request("scene.export", {
    projectId,
    directory: root,
    expectedRevision: 1,
  });
  assert.deepEqual(await readdir(dirname(exported.path)), ["robot.urdf"]);
  const reloaded = await app.request("scene.import", {
    projectId,
    path: exported.path,
    expectedRevision: 1,
  });
  assert.deepEqual(reloaded.document.sourceRobot, robot);
  assert.deepEqual(reloaded.document.sourceWarnings, imported.document.sourceWarnings);
  assert.equal(reloaded.document.robot?.links.length, 1);
  assert.equal(reloaded.document.robot?.joints.length, 0);
  await assert.rejects(
    app.request("scene.export", { projectId, directory: root, expectedRevision: 1 }),
    /场景已更新/,
  );

  const cancelled = assert.rejects(load(2), /STEP 导入已取消/);
  // Let application.request dispatch the start command before sending the interruption.
  await app.request("workspace.get", {});
  await app.request("scene.cancelStep", { projectId });
  await cancelled;

  const invalid = join(root, "broken.stp");
  await writeFile(invalid, "broken STEP");
  await assert.rejects(load(2, invalid), /STEP 解析失败/);
  const withWireOnlyPart = fileURLToPath(
    new URL("../../fixtures/scene/assembly-plate-and-wire.step", import.meta.url),
  );
  await assert.rejects(load(2, withWireOnlyPart), /STEP 零件没有可导出的三角面/);
  assert.deepEqual(await app.request("scene.get", { projectId }), reloaded);

  const stale = assert.rejects(load(2), /场景已更新/);
  const current = await app.request("scene.apply", {
    projectId,
    expectedRevision: 2,
    operation: {
      op: "rename",
      entity: "link",
      id: reloaded.document.robot?.rootLinkId ?? "",
      name: "edited_base",
    },
  });
  await stale;
  assert.equal(current.document.revision, 3);
  assert.equal(
    (await app.request("scene.get", { projectId })).document.robot?.links[0]?.name,
    "edited_base",
  );

  const inches = join(root, "英寸装配.step");
  await writeStepFixture(inches, "inch");
  const gbkName = Buffer.from("b2e2cad4d7b0c5e4", "hex").toString("latin1");
  const stepText = (await readFile(inches, "latin1"))
    .replace("'Open CASCADE Shape Model'", `'${gbkName}'`)
    .replaceAll("'SubAssembly'", `'${gbkName}'`)
    .replace("'SubInstance'", "'NAUO56'");
  await writeFile(inches, stepText, "latin1");
  assert.ok(await app.request("scene.asset", { projectId, asset: mesh.asset }));
  const inchRobot = (await load(3, inches)).document.sourceRobot;
  assert.ok(inchRobot);
  assert.equal(inchRobot.links[2]?.name, "测试装配");
  assert.ok(Math.abs((inchRobot.joints[1]?.origin.xyz[2] ?? 0) - 2.032) < 1e-8);
  assert.ok(Math.abs((inchRobot.joints[2]?.origin.xyz[1] ?? 0) - 1.016) < 1e-8);
  await assert.rejects(
    app.request("scene.asset", { projectId, asset: mesh.asset }),
    /网格不在当前场景中/,
  );
  await app.request("scene.apply", {
    projectId,
    expectedRevision: 4,
    operation: { op: "rename", entity: "link", id: "cad-root", name: "edited_base" },
  });
  const edited = await app.request("scene.get", { projectId });
  assert.equal(edited.document.robot?.links.length, 1);
  assert.deepEqual(edited.document.sourceRobot, inchRobot);
  const sourceMesh = inchRobot.links
    .flatMap(({ visuals }) => visuals)
    .find(({ geometry }) => geometry.type === "mesh")?.geometry;
  assert.ok(sourceMesh?.type === "mesh");
  assert.ok(await app.request("scene.asset", { projectId, asset: sourceMesh.asset }));
  for (const expectedRevision of [5, 6]) {
    await app.request("scene.apply", { projectId, expectedRevision, operation: { op: "undo" } });
  }
  assert.ok(await app.request("scene.asset", { projectId, asset: mesh.asset }));
  await assert.rejects(
    app.request("scene.asset", { projectId, asset: sourceMesh.asset }),
    /网格不在当前场景中/,
  );
});
