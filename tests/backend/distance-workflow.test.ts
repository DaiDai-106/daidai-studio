import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../src/backend/application.ts";
import { createSceneService } from "../../src/backend/projects/sceneService.ts";
import { openProjectStore } from "../../src/backend/projects/store.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
const exec = promisify(execFile);

test("真实 BRep 距离使用授权源及当前项目位姿，失败不改变场景", {
  skip: !python,
  timeout: 90_000,
}, async () => {
  if (!python) return;
  const root = await mkdtemp(join(tmpdir(), "dai-distance-workflow-"));
  const dataRoot = join(root, "data");
  const step = join(root, "external.step");
  await exec(
    python,
    [
      "-c",
      "import sys; sys.path.insert(0,'tests/python'); from assembly_fixture import write_assembly; write_assembly(sys.argv[1], False, False)",
      step,
    ],
    { cwd: resolve(".") },
  );
  const original = await readFile(step);
  const options = {
    dataRoot,
    pythonExecutable: python,
    workerPath: resolve("packages/scene/python/worker.py"),

    publish: () => {},
  };
  const app = await openApplication(options);
  const store = openProjectStore(dataRoot);
  const scenes = createSceneService({
    dataRoot,
    store,
    pythonExecutable: python,
    workerPath: options.workerPath,
  });
  try {
    const project = await app.request("project.create", { name: "A", mode: "scene", path: root });
    const other = await app.request("project.create", { name: "B", mode: "scene", path: root });
    const imported = await app.request("scene.import", {
      projectId: project.id,
      path: step,
      operation: "replace",
      revision: 0,
    });
    const model = imported.models[0];
    const first = model?.objects.find((item) => item.name === "FirstBlock");
    const second = model?.objects.find((item) => item.name === "SecondBlock");
    assert.ok(model && first && second);
    const input = {
      projectId: project.id,
      revision: imported.revision,
      first: { modelId: model.id, objectId: first.id },
      second: { modelId: model.id, objectId: second.id },
    };
    const result = await scenes.measureDistance(input);
    assert.equal(result.unit, "m");
    assert.equal(result.space, "world-z-up");
    assert.equal(result.method, "occt-brep");
    assert.equal(result.surfaceDistanceM, null);
    assert.equal(result.collision, "unknown");
    assert.equal(result.innerSolution, false);
    assert.ok(result.firstPoint && result.secondPoint);
    assert.ok(Math.abs(result.shapeDistanceM - Math.hypot(0.03, 0.03)) < 1e-7);
    assert.ok(
      Math.abs(
        Math.hypot(
          result.firstPoint[0] - result.secondPoint[0],
          result.firstPoint[1] - result.secondPoint[1],
          result.firstPoint[2] - result.secondPoint[2],
        ) - result.shapeDistanceM,
      ) < 1e-7,
    );
    assert.deepEqual(await app.request("scene.get", { projectId: project.id }), imported);
    await assert.rejects(scenes.measureDistance({ ...input, projectId: other.id }), /不存在|为空/);
    const moved = await app.request("scene.setTransform", {
      projectId: project.id,
      modelId: model.id,
      objectId: first.id,
      revision: imported.revision,
      transform: { position: [0, 0.07, 0], rotation: [0, 0, 0, 1] },
    });
    await assert.rejects(scenes.measureDistance(input), /版本/);
    const movedDistance = await scenes.measureDistance({ ...input, revision: moved.revision });
    assert.ok(Math.abs(movedDistance.shapeDistanceM - Math.hypot(0.03, 0.06)) < 1e-7);
    assert.deepEqual(await app.request("scene.get", { projectId: project.id }), moved);
    const relocatedPath = join(root, "relocated.step");
    await rename(step, relocatedPath);
    await assert.rejects(
      scenes.measureDistance({ ...input, revision: moved.revision }),
      /不存在|不可读取/,
    );
    const relocated = await app.request("scene.relocateSource", {
      projectId: project.id,
      modelId: model.id,
      revision: moved.revision,
      path: relocatedPath,
    });
    const restoredDistance = await scenes.measureDistance({
      ...input,
      revision: relocated.revision,
    });
    assert.ok(Math.abs(restoredDistance.shapeDistanceM - movedDistance.shapeDistanceM) < 1e-7);
    assert.equal(relocated.models[0]?.id, model.id);
    await appendFile(relocatedPath, "\nchanged");
    await assert.rejects(
      scenes.measureDistance({ ...input, revision: relocated.revision }),
      /变化|哈希|匹配/i,
    );
    assert.equal(
      (await app.request("scene.get", { projectId: project.id })).revision,
      relocated.revision,
    );
    assert.ok((await readFile(relocatedPath)).length > original.length);
  } finally {
    await scenes.dispose();
    store.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
