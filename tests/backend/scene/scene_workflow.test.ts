import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../../src/backend/application.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { createSceneService } from "../../../src/backend/scene/scene_service.ts";
import { readSceneResource } from "../../support/scene_resource.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
const exec = promisify(execFile);

test("真实 STEP 导入、重复追加、对象变换和重启后资源恢复", {
  skip: !python,
  timeout: 90_000,
}, async () => {
  if (!python) return;
  const root = await mkdtemp(join(tmpdir(), "dai-full-scene-"));
  const cwd = join(root, "workspace");
  const step = join(root, "external.step");
  const dataRoot = join(root, "data");
  await mkdir(cwd);
  await exec(
    python,
    [
      "-c",
      "import sys; sys.path.insert(0,'tests/python'); from assembly_fixture import write_assembly; write_assembly(sys.argv[1], True)",
      step,
    ],
    { cwd: resolve(".") },
  );
  const source = await readFile(step);
  const events: string[] = [];
  const options = {
    dataRoot,
    workerPath: resolve("packages/scene/python/worker.py"),
    pythonExecutable: python,
    sceneSkillPath: resolve("packages/scene/skills/scene"),

    publish: (event: { type: string }) => {
      events.push(event.type);
    },
  };
  let app = await openApplication(options);
  try {
    assert.equal((await app.request("scene.pythonStatus", {})).state, "ready");
    const project = await app.request("project.create", { name: "场景", mode: "scene", path: cwd });
    const empty = await app.request("scene.get", { projectId: project.id });
    assert.equal(empty.revision, 0);
    const first = await app.request("scene.import", {
      projectId: project.id,
      path: step,
      operation: "replace",
      revision: 0,
    });
    assert.equal(first.models.length, 1);
    assert.ok(first.models[0]?.objects.length);
    assert.ok(first.models[0]?.objects[0]?.baseTransform);
    const second = await app.request("scene.import", {
      projectId: project.id,
      path: step,
      operation: "append",
      revision: 1,
    });
    assert.equal(second.models.length, 2);
    assert.notEqual(second.models[0]?.id, second.models[1]?.id);
    const model = second.models[0];
    const other = second.models[1];
    assert.ok(model && other);
    const object = model.objects[0];
    assert.ok(object);
    const updated = await app.request("scene.setTransform", {
      projectId: project.id,
      modelId: model.id,
      objectId: object.id,
      revision: 2,
      transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1] },
    });
    assert.deepEqual(updated.models[0]?.objects[0]?.transform?.position, [1, 2, 3]);
    assert.equal(updated.models[1]?.objects[0]?.transform, undefined);
    await assert.rejects(
      app.request("scene.setTransform", {
        projectId: project.id,
        modelId: model.id,
        objectId: object.id,
        revision: 2,
        transform: { position: [9, 9, 9], rotation: [0, 0, 0, 1] },
      }),
      /其他会话更新/,
    );
    const leaf = updated.models[0]?.objects.find(
      (item) => item.geometryBounds && item.rigidTransform,
    );
    assert.ok(leaf);
    const secondStore = openProjectStore(dataRoot);
    const sceneService = createSceneService({ dataRoot, store: secondStore });
    let aligned = updated;
    try {
      const bounds = sceneService.bounds({
        projectId: project.id,
        modelId: model.id,
        objectId: leaf.id,
      });
      assert.equal(bounds.bounds.space, "world-z-up");
      assert.equal(bounds.bounds.accuracy, "conservative");
      aligned = sceneService.alignOrigin({
        projectId: project.id,
        modelId: model.id,
        objectId: leaf.id,
        revision: updated.revision,
      });
      const after = sceneService.bounds({
        projectId: project.id,
        modelId: model.id,
        objectId: leaf.id,
      });
      assert.ok(after.bounds.min.every((value) => Math.abs(value) < 1e-8));
      assert.deepEqual(aligned.models[1], updated.models[1]);
      assert.throws(
        () =>
          sceneService.alignOrigin({
            projectId: project.id,
            modelId: model.id,
            objectId: leaf.id,
            revision: updated.revision,
          }),
        /其他会话更新/,
      );
      aligned = await app.request("scene.deleteObject", {
        projectId: project.id,
        modelId: model.id,
        objectId: leaf.id,
        revision: aligned.revision,
      });
      assert.equal(aligned.models[0]?.objects.find((item) => item.id === leaf.id)?.deleted, true);
      assert.equal(
        aligned.models[1]?.objects.find((item) => item.id === leaf.id)?.deleted,
        undefined,
      );
      assert.throws(
        () => sceneService.bounds({ projectId: project.id, modelId: model.id, objectId: leaf.id }),
        /删除/,
      );
    } finally {
      await sceneService.dispose();
      secondStore.close();
    }
    const resourceUrl = new URL(model.resource.url);
    const resource = await app.resolveResource(resourceUrl.hostname, resourceUrl.pathname.slice(1));
    assert.equal(
      (await readSceneResource(dataRoot, resource, resourceUrl.pathname.slice(1)))
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
    assert.deepEqual(await readFile(step), source);
    assert.ok(events.includes("scene.changed"));
    const invalid = join(root, "invalid.step");
    await writeFile(invalid, "this is not STEP");
    await assert.rejects(
      app.request("scene.import", {
        projectId: project.id,
        path: invalid,
        operation: "replace",
        revision: aligned.revision,
      }),
    );
    assert.deepEqual(await app.request("scene.get", { projectId: project.id }), aligned);
    await app.close();
    app = await openApplication(options);
    assert.deepEqual(await app.request("scene.get", { projectId: project.id }), aligned);
    const reopened = await app.resolveResource(resourceUrl.hostname, resourceUrl.pathname.slice(1));
    assert.equal(
      (await readSceneResource(dataRoot, reopened, resourceUrl.pathname.slice(1)))
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
    await appendFile(step, "\nchanged");
    assert.equal(
      (await app.request("scene.get", { projectId: project.id })).models[0]?.sourceStatus,
      "changed",
    );
    await rename(step, `${step}.moved`);
    assert.equal(
      (await app.request("scene.get", { projectId: project.id })).models[0]?.sourceStatus,
      "missing",
    );
    assert.equal(
      (await readSceneResource(dataRoot, reopened, resourceUrl.pathname.slice(1)))
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
